// Shared execution layer for popup visualization refreshes; the optional interactive queue adds caller-local scheduling, not global ordering. See docs/popup-simulation-refresh.md.
import type { SimulationServices } from '../simulation/serviceLifecycle.js'
import { getActiveStackContext, type ActiveStackContext } from '../utils/activeStackContext.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import type { CompleteVisualizedSimulation, SimulationState } from '../types/visualizer-types.js'
import { createPassthroughCompleteVisualizedSimulation, toResolvedSimulationState } from '../types/visualizer-types.js'
import { NEW_BLOCK_ABORT, TIME_BETWEEN_BLOCKS } from '../utils/constants.js'
import { reportUnexpectedError, isExpectedInfrastructureError, isFailedToFetchError, isNewBlockAbort } from '../utils/errors.js'
import { silenceChromeUnCaughtPromise } from '../utils/requests.js'
import { Semaphore } from '../utils/semaphore.js'
import { buildSimulationInput, captureSimulationSnapshot, getSimulationProviderForSnapshot, type BuiltSimulationInput, type SimulationSnapshot, getUpdatedSimulationState } from './simulationUpdating.js'
import { selectionShowsStack, selectionChanged, type SimulationSelection } from '../utils/simulationSelection.js'
import { requestIsSimulationDataConsumerOpen, sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { getPopupVisualisationFingerprint } from './popupSimulationFingerprint.js'
import { retainPreviousVisualisation } from '../utils/popupVisualisationLifecycle.js'
import { visualizeSimulatorState } from './simulationUpdating.js'
import { getPopupVisualisationState, setPopupVisualisationState, updatePopupVisualisationWithCallBack } from './storageVariables.js'
import { getSettings } from './settings.js'

let abortController = new AbortController()
// Local invalidation retires every execution path, including direct consumer/bootstrap refreshes.
let publicationGeneration = 0

function invalidatePopupVisualisation() {
	abortController.abort(NEW_BLOCK_ABORT)
	return ++publicationGeneration
}

// The one rule for acting on a refresh, asked of the authority for each half: the client it was handed must report that its owner still has it installed, and any snapshot it would execute must not have changed from the current settings, because a queued snapshot only says what was selected at enqueue time. Whatever replaces services or changes the selection queues the refresh it needs (activeSettings.ts by selectionChanged, simulationServiceRefresh.ts after a replacement), so a refresh failing this rule returns without invalidating, cancelling or publishing. It is synchronous, so callers read the settings before calling it and nothing can install other services between the owner's answer and the step it guards.
const refreshStillApplies = (ethereum: EthereumClientService, snapshot: SimulationSnapshot | undefined, selection: SimulationSelection) => (
	(snapshot === undefined || !selectionChanged(snapshot, selection)) && ethereum.isCurrent()
)

function buildPassthroughVisualizedState(
	simulationId: number,
	numberOfAddressesMadeRich: number,
	simulationResultState: 'done' | 'corrupted' = 'done',
): CompleteVisualizedSimulation {
	return createPassthroughCompleteVisualizedSimulation(simulationId, simulationResultState, numberOfAddressesMadeRich)
}

function buildDefinedEmptyVisualizedState(
	simulationState: Extract<SimulationState, { success: true }>,
	simulationId: number,
	numberOfAddressesMadeRich: number,
): CompleteVisualizedSimulation {
	return {
		simulationUpdatingState: 'done',
		simulationResultState: 'done',
		simulationId,
		simulationState: toResolvedSimulationState(simulationState),
		addressBookEntries: [],
		tokenPriceEstimates: [],
		tokenPriceQuoteToken: undefined,
		namedTokenIds: [],
		visualizedSimulationState: {
			success: true,
			visualizedBlocks: simulationState.simulationStateInput.map((block) => ({
				simulatedAndVisualizedTransactions: [],
				visualizedPersonalSignRequests: [],
				blockTimeManipulation: block.blockTimeManipulation,
			})),
		},
		numberOfAddressesMadeRich,
	}
}

const hasSimulationInputOperations = (simulationState: SimulationState) => (
	simulationState.simulationStateInput.some((block) => block.transactions.length > 0 || block.signedMessages.length > 0)
)

export type PopupVisualisationOptions = {
	readonly invalidateOldState?: boolean
	readonly onlyIfNotAlreadyUpdating?: boolean
	readonly skipIfUnchanged?: boolean
	readonly snapshot?: SimulationSnapshot
}

// The simulation id of an updating state a background refresh published before it was queued, so its execution can finish that state if it steps aside.
type PreparedUpdatingPublication = { readonly preparedUpdatingSimulationId?: number }

// Visibility/throttle-aware execution: callers such as block updates can replace obsolete work without entering the interactive queue.
export const updatePopupVisualisationIfNeeded = async (ethereum: EthereumClientService, tokenPriceService: TokenPriceService, options: PopupVisualisationOptions = {}) =>
	await executePopupVisualisationIfNeeded(ethereum, tokenPriceService, options, publicationGeneration)

async function executePopupVisualisationIfNeeded(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, { invalidateOldState = false, onlyIfNotAlreadyUpdating = false, skipIfUnchanged = false, snapshot, preparedUpdatingSimulationId }: PopupVisualisationOptions & PreparedUpdatingPublication, expectedGeneration: number) {
	let generation = expectedGeneration
	const isCurrent = () => generation === publicationGeneration
	try {
		const popupVisualisation = await getPopupVisualisationState()
		if (onlyIfNotAlreadyUpdating && updateSimulationVisualisationSemaphore.getPermits() === 0) return popupVisualisation
		if (onlyIfNotAlreadyUpdating && popupVisualisation.simulationState.kind === 'simulated') {
			const ageSeconds = (Date.now()- popupVisualisation.simulationState.value.simulationConductedTimestamp.getTime()) / 1000
			if (ageSeconds < TIME_BETWEEN_BLOCKS) return popupVisualisation
		}
		const isSimulationDataConsumerOpenReply = await requestIsSimulationDataConsumerOpen()
		if (!isCurrent()) return await getPopupVisualisationState()
		if (!(isSimulationDataConsumerOpenReply?.data.isOpen === true)) return popupVisualisation
		const checkedSnapshot = snapshot ?? await captureSimulationSnapshot()
		// Only decides whether to skip, because the stack can change while this check awaits. It is built even when nothing can skip, so an unreadable stack stops the refresh before it cancels or invalidates anything.
		const checkedInput = await buildSimulationInput(checkedSnapshot)
		const provider = getSimulationProviderForSnapshot(ethereum, checkedInput)
		if (skipIfUnchanged && popupVisualisation.simulationState.kind === 'simulated' && provider !== undefined) {
			const currentSimulationInput = await getCurrentSimulationStateInput(provider, checkedInput)
			if (!isCurrent()) return await getPopupVisualisationState()
			const currentFingerprint = getPopupVisualisationFingerprint(currentSimulationInput.simulationStateInput, currentSimulationInput.rpcNetwork, currentSimulationInput.blockNumber)
			const cachedFingerprint = getPopupVisualisationFingerprint(
				popupVisualisation.simulationState.value.simulationStateInput,
				popupVisualisation.simulationState.value.rpcNetwork,
				popupVisualisation.simulationState.value.blockNumber,
			)
			if (currentFingerprint === cachedFingerprint && (checkedSnapshot.richAddresses.length === popupVisualisation.numberOfAddressesMadeRich)) return popupVisualisation
		}
		const selection = await getSettings()
		// Nothing awaits between this check and the invalidation or abort, so a refresh left behind by a selection change or service replacement never retires the current selection's refresh. Only a supplied snapshot is checked: without one, execution reads the selection itself.
		if (!isCurrent() || !refreshStillApplies(ethereum, snapshot, selection)) {
			await finishUpdatingStateForHiddenStack(generation, abortController, preparedUpdatingSimulationId)
			return await getPopupVisualisationState()
		}
		let updatingSimulationId = preparedUpdatingSimulationId
		if (invalidateOldState) {
			generation = invalidatePopupVisualisation()
			updatingSimulationId = (await publishUpdatingPopupVisualisation(true, generation))?.simulationId
		}
		if (!isCurrent()) return await getPopupVisualisationState()
		abortController.abort(NEW_BLOCK_ABORT)
		abortController = new AbortController()
		const thisAbortController = abortController
		// Execution builds its input inside the semaphore; a supplied snapshot (the interactive queue) fixes only the selection and rich addresses. Executions run one at a time, so a later one never reads an older stack than an earlier one published, and a refresh that cancels another then runs the current stack itself.
		await executePopupVisualisationState(ethereum, tokenPriceService, thisAbortController, false, snapshot, generation)
		await finishUpdatingStateForHiddenStack(generation, thisAbortController, updatingSimulationId)
	} catch(error: unknown) {
		if (isExpectedInfrastructureError(error)) return await getPopupVisualisationState()
		await reportUnexpectedError(error)
	}
	return await getPopupVisualisationState()
}

export type OpenConsumerVisualisationDependencies = {
	readonly update?: typeof updatePopupVisualisationState
	readonly getStored?: typeof getPopupVisualisationState
	readonly reportError?: typeof reportUnexpectedError
}

// Bootstrap already knows a consumer is open; refresh without the visibility probe and retain the stored fallback on reported errors.
export async function refreshPopupVisualisationForOpenConsumer(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, dependencies: OpenConsumerVisualisationDependencies = {}) {
	try {
		await (dependencies.update ?? updatePopupVisualisationState)(ethereum, tokenPriceService, { throwOnUnexpectedError: true })
	} catch (error) {
		if (!isExpectedInfrastructureError(error)) await (dependencies.reportError ?? reportUnexpectedError)(error)
	}
	return await (dependencies.getStored ?? getPopupVisualisationState)()
}

// Publish progress using the storage lock, without waiting for an in-flight RPC simulation.
export async function publishPendingPopupVisualisation(invalidateOldState: boolean) {
	await publishUpdatingPopupVisualisation(invalidateOldState, invalidatePopupVisualisation())
}

// Returns the published state, or undefined when newer work retired this generation first.
async function publishUpdatingPopupVisualisation(invalidateOldState: boolean, generation: number) {
	const pending = await updatePopupVisualisationWithCallBack(async previous => generation !== publicationGeneration ? undefined : retainPreviousVisualisation(previous, {
		simulationId: previous.simulationId + 1,
		simulationUpdatingState: 'updating',
		simulationResultState: invalidateOldState ? 'invalid' : undefined,
	}))
	if (generation !== publicationGeneration) return undefined
	await sendPopupMessageToOpenWindows({ method: 'popup_simulation_state_changed', data: { visualizedSimulatorState: pending } })
	return pending
}

// Finish only this workflow's still-owned updating state when the current selection hides the stack, because no refresh is queued for a selection that shows none. Empty passthrough needs no provider, so retiring its client does not revoke this cleanup; the id, generation, abort signal and publication lock protect newer work.
async function finishUpdatingStateForHiddenStack(generation: number, controller: AbortController, updatingSimulationId: number | undefined) {
	if (updatingSimulationId === undefined) return
	await updateSimulationVisualisationSemaphore.execute(async () => {
		const current = await getPopupVisualisationState()
		const selection = await getSettings()
		if (current.simulationId !== updatingSimulationId || generation !== publicationGeneration || controller.signal.aborted || selectionShowsStack(selection)) return
		const terminal = await setPopupVisualisationState(buildPassthroughVisualizedState(current.simulationId + 1, 0))
		await sendPopupMessageToOpenWindows({ method: 'popup_simulation_state_changed', data: { visualizedSimulatorState: terminal } })
	})
}

// What a prepared refresh would compute, as plain data; the queue in popupSimulationRefreshQueue.ts decides from it which requests are equivalent.
export type PopupVisualisationRefreshTarget = {
	readonly visualisationFingerprint: string
	readonly blockHash: bigint
	readonly numberOfAddressesMadeRich: number
	readonly activeStackContext: ActiveStackContext
	readonly publicationGeneration: number
}

// A target of undefined cannot be proven equivalent to any other request. Services, snapshot and the publication generation guard stay in the execute closure, so the queue cannot bypass the guard.
export type PopupVisualisationRefreshRequest = {
	readonly target: PopupVisualisationRefreshTarget | undefined
	readonly execute: (invalidateOldState: boolean) => Promise<boolean>
}

export type PopupVisualisationPreparationDependencies = {
	// Whether the owner still has this client installed. Tests that hand a handler a stand-in client with no owner say so explicitly.
	readonly isClientCurrent?: (ethereum: EthereumClientService) => boolean
}

// Captures the snapshot and, for background edits, publishes the updating state; the caller decides invalidation once and passes it to the queue, which hands it to execute. A handler can reach this with services it captured before the owner replaced them; that request returns before invalidating anything, because execution would reject the replaced client and leave any published progress unfinished. The queue then hands the refresh to the installed services (popupSimulationRefreshQueue.ts).
export async function preparePopupVisualisationRefresh(services: SimulationServices, invalidateOldState: boolean, publishUpdatingState = false, { isClientCurrent = (ethereum) => ethereum.isCurrent() }: PopupVisualisationPreparationDependencies = {}): Promise<PopupVisualisationRefreshRequest | undefined> {
	if (!isClientCurrent(services.ethereum)) return undefined
	const generation = publishUpdatingState ? invalidatePopupVisualisation() : publicationGeneration
	const snapshot = await captureSimulationSnapshot()
	// The services can be replaced while the snapshot is read; checked again before publishing progress.
	if (generation !== publicationGeneration || !isClientCurrent(services.ethereum)) return undefined
	const preparedUpdatingSimulationId = publishUpdatingState ? (await publishUpdatingPopupVisualisation(invalidateOldState, generation))?.simulationId : undefined
	if (generation !== publicationGeneration) return undefined
	const provider = getSimulationProviderForSnapshot(services.ethereum, snapshot)
	const block = publishUpdatingState ? undefined : provider?.getCachedBlock()
	// Identifies this request only; the queued entry keeps the snapshot, and its execution builds its own input from the stack stored then.
	const target = block === undefined ? undefined : {
		visualisationFingerprint: getPopupVisualisationFingerprint((await buildSimulationInput(snapshot)).simulationStateInput, services.ethereum.getRpcEntry(), block.number),
		blockHash: block.hash,
		numberOfAddressesMadeRich: snapshot.richAddresses.length,
		activeStackContext: getActiveStackContext(snapshot),
		publicationGeneration: generation,
	}
	return {
		target,
		execute: async invalidateOldState => {
			const result = await executePopupVisualisationIfNeeded(services.ethereum, services.tokenPriceService, {
				// Scheduled edits already published their invalidation before acknowledgement.
				invalidateOldState: invalidateOldState && !publishUpdatingState,
				skipIfUnchanged: !invalidateOldState,
				snapshot,
				preparedUpdatingSimulationId,
			}, generation)
			return result.simulationUpdatingState !== 'failed' && result.simulationResultState !== 'invalid'
		},
	}
}

const updateSimulationVisualisationSemaphore = new Semaphore(1)
// Failed provider preparation must retire old results without executing the retained provider. A failure observed for services that were since replaced leaves the replacement's results alone.
export async function publishFailedPopupVisualisation({ isCurrent = () => true }: { readonly isCurrent?: () => boolean } = {}) {
	if (!isCurrent()) return
	invalidatePopupVisualisation()
	await updateSimulationVisualisationSemaphore.execute(async () => {
		const previous = await getPopupVisualisationState()
		if (!isCurrent()) return
		const failed = await setPopupVisualisationState({
			...createPassthroughCompleteVisualizedSimulation(previous.simulationId + 1, 'invalid'),
			simulationUpdatingState: 'failed',
		})
		await sendPopupMessageToOpenWindows({ method: 'popup_simulation_state_changed', data: { visualizedSimulatorState: failed } })
	})
}

export type PopupVisualisationExecutionDependencies = {
	readonly getUpdatedState?: typeof getUpdatedSimulationState
	readonly visualize?: typeof visualizeSimulatorState
}

export type PopupVisualisationExecutionOptions = {
	readonly abortController?: AbortController
	readonly throwOnUnexpectedError?: boolean
	readonly snapshot?: SimulationSnapshot
	readonly dependencies?: PopupVisualisationExecutionDependencies
}

// Serialized execution without a visibility probe; persistence callers can require unexpected errors to propagate.
export async function updatePopupVisualisationState(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, { abortController, throwOnUnexpectedError = false, snapshot, dependencies = {} }: PopupVisualisationExecutionOptions = {}) {
	return await executePopupVisualisationState(ethereum, tokenPriceService, abortController, throwOnUnexpectedError, snapshot, publicationGeneration, dependencies)
}

async function executePopupVisualisationState(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, abortController: AbortController | undefined, throwOnUnexpectedError: boolean, snapshot: SimulationSnapshot | undefined, generation: number, dependencies: PopupVisualisationExecutionDependencies = {}) {
	const isCurrent = () => generation === publicationGeneration && !abortController?.signal.aborted
	// Check inside the storage lock as well as after remote work: invalidation can arrive while a write waits.
	const storeCurrentState = async (state: CompleteVisualizedSimulation) => {
		await updatePopupVisualisationWithCallBack(async () => isCurrent() ? state : undefined)
		return isCurrent() ? state : undefined
	}
	const publishCurrentState = async (state: CompleteVisualizedSimulation | undefined) => {
		if (state !== undefined && isCurrent()) await sendPopupMessageToOpenWindows({ method: 'popup_simulation_state_changed', data: { visualizedSimulatorState: state } })
	}
	try {
		return await updateSimulationVisualisationSemaphore.execute(async () => {
			if (!isCurrent()) return
			const popupVisualisation = await getPopupVisualisationState()
			const simulationId = popupVisualisation.simulationId + 1
			// The stack can change while a refresh waits, including after a supplied snapshot was captured: stack edits refresh directly, and onlyIfNotAlreadyUpdating edits skip their refresh while this one runs.
			const capturedSnapshot = snapshot ?? await captureSimulationSnapshot()
			const builtInput = await buildSimulationInput(capturedSnapshot)
			// The selection can change after this refresh committed, including between the reads above and this check.
			const currentSelection = await getSettings()
			if (!isCurrent() || !refreshStillApplies(ethereum, capturedSnapshot, currentSelection)) return
			const simulationState = await (dependencies.getUpdatedState ?? getUpdatedSimulationState)(ethereum, builtInput)
			if (!isCurrent()) return
			const doneState = { simulationUpdatingState: 'done' as const, simulationResultState: 'done' as const, simulationId }
			const numberOfAddressesMadeRich = capturedSnapshot.richAddresses.length
			if (simulationState.kind === 'passthrough') {
				const newState = buildPassthroughVisualizedState(simulationId, numberOfAddressesMadeRich)
				await storeCurrentState(newState)
				await publishCurrentState(newState)
				return
			}
			if (!hasSimulationInputOperations(simulationState.value)) {
				const newState = simulationState.value.success
					? buildDefinedEmptyVisualizedState(simulationState.value, simulationId, numberOfAddressesMadeRich)
					: buildPassthroughVisualizedState(simulationId, numberOfAddressesMadeRich)
				await storeCurrentState(newState)
				await publishCurrentState(newState)
				return
			}
			const visualizedSimulatorState = await storeCurrentState(retainPreviousVisualisation(popupVisualisation, { simulationId, simulationUpdatingState: 'updating' }))
			const changedMessagePromise = silenceChromeUnCaughtPromise(publishCurrentState(visualizedSimulatorState))
			try {
				const getUpdatedState = async () => {
					if (ethereum.getChainId() === simulationState.value.rpcNetwork.chainId) {
						const refreshed = await (dependencies.visualize ?? visualizeSimulatorState)(simulationState.value, ethereum, tokenPriceService, abortController)
						if (!isCurrent()) return undefined
						return await storeCurrentState({ ...refreshed, ...doneState, simulationState: toResolvedSimulationState(refreshed.simulationState), numberOfAddressesMadeRich })
					}
					return await storeCurrentState(buildPassthroughVisualizedState(simulationId, numberOfAddressesMadeRich, 'corrupted'))
				}
				const newVisualizedState = await getUpdatedState()
				await changedMessagePromise
				if (newVisualizedState === undefined || !isCurrent()) return
				await publishCurrentState(newVisualizedState)
			} catch (error) {
				if (isNewBlockAbort(error)) return
				if (isFailedToFetchError(error)) {
					const state = await storeCurrentState(retainPreviousVisualisation(popupVisualisation, { simulationId, simulationUpdatingState: 'updating' }))
					await publishCurrentState(state)
					return
				}
				if (throwOnUnexpectedError) throw error
				const state = await storeCurrentState(retainPreviousVisualisation(popupVisualisation, { simulationId, simulationUpdatingState: 'failed' }))
				await publishCurrentState(state)
				await reportUnexpectedError(error)
			}
		})
	} catch (error) {
		if (throwOnUnexpectedError) throw error
		if (isExpectedInfrastructureError(error)) return
		await reportUnexpectedError(error)
	}
}

async function getCurrentSimulationStateInput(ethereum: EthereumClientService, builtInput: BuiltSimulationInput) {
	return {
		simulationStateInput: builtInput.simulationStateInput,
		rpcNetwork: ethereum.getRpcEntry(),
		blockNumber: await ethereum.getBlockNumber(undefined),
	}
}
