// Shared execution layer for popup visualization refreshes; the optional interactive queue adds caller-local scheduling, not global ordering. See docs/popup-simulation-refresh.md.
import type { SimulationServices } from '../simulation/serviceLifecycle.js'
import type { ActiveStackContext } from '../utils/activeStackContext.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { RpcNetwork } from '../types/rpc.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import type { CompleteVisualizedSimulation, SimulationState, StoredCompleteVisualizedSimulation } from '../types/visualizer-types.js'
import { createPassthroughCompleteVisualizedSimulation, toResolvedSimulationState } from '../types/visualizer-types.js'
import { NEW_BLOCK_ABORT, TIME_BETWEEN_BLOCKS } from '../utils/constants.js'
import { reportUnexpectedError, isExpectedInfrastructureError, isFailedToFetchError, isNewBlockAbort } from '../utils/errors.js'
import { silenceChromeUnCaughtPromise } from '../utils/requests.js'
import { Semaphore } from '../utils/semaphore.js'
import { captureSimulationSnapshot, getSimulationProviderForSnapshot, type SimulationSnapshot, getUpdatedSimulationState } from './simulationUpdating.js'
import { requestIsSimulationDataConsumerOpen, sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { getPopupVisualisationFingerprint } from './popupSimulationFingerprint.js'
import { retainPreviousVisualisation } from '../utils/popupVisualisationLifecycle.js'
import { visualizeSimulatorStateAndRecordLookups } from './simulationUpdating.js'
import { relabelStoredSimulation, type SimulationRunToRelabel } from './simulationRelabel.js'
import { getPopupVisualisationState, setPopupVisualisationState, updatePopupVisualisationWithCallBack } from './storageVariables.js'

let abortController = new AbortController()
// Local invalidation retires every execution path, including direct consumer/bootstrap refreshes.
let publicationGeneration = 0

function invalidatePopupVisualisation() {
	abortController.abort(NEW_BLOCK_ABORT)
	return ++publicationGeneration
}

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

// Visibility/throttle-aware execution: callers such as block updates can replace obsolete work without entering the interactive queue.
export const updatePopupVisualisationIfNeeded = async (ethereum: EthereumClientService, tokenPriceService: TokenPriceService, options: PopupVisualisationOptions = {}) =>
	await executePopupVisualisationIfNeeded(ethereum, tokenPriceService, options, publicationGeneration)

async function executePopupVisualisationIfNeeded(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, { invalidateOldState = false, onlyIfNotAlreadyUpdating = false, skipIfUnchanged = false, snapshot }: PopupVisualisationOptions, expectedGeneration: number) {
	let generation = expectedGeneration
	const isCurrent = () => generation === publicationGeneration
	try {
		const popupVisualisation = await getPopupVisualisationState()
		if (onlyIfNotAlreadyUpdating && runningSimulations > 0) return popupVisualisation
		if (onlyIfNotAlreadyUpdating && popupVisualisation.simulationState.kind === 'simulated') {
			const ageSeconds = (Date.now()- popupVisualisation.simulationState.value.simulationConductedTimestamp.getTime()) / 1000
			if (ageSeconds < TIME_BETWEEN_BLOCKS) return popupVisualisation
		}
		const isSimulationDataConsumerOpenReply = await requestIsSimulationDataConsumerOpen()
		if (!isCurrent()) return await getPopupVisualisationState()
		if (!(isSimulationDataConsumerOpenReply?.data.isOpen === true)) return popupVisualisation
		const capturedSnapshot = snapshot ?? await captureSimulationSnapshot()
		const provider = getSimulationProviderForSnapshot(ethereum, capturedSnapshot)
		if (skipIfUnchanged && popupVisualisation.simulationState.kind === 'simulated' && provider !== undefined) {
			const currentSimulationInput = await getCurrentSimulationStateInput(provider, capturedSnapshot)
			if (!isCurrent()) return await getPopupVisualisationState()
			const currentFingerprint = getPopupVisualisationFingerprint(currentSimulationInput.simulationStateInput, currentSimulationInput.rpcNetwork, currentSimulationInput.blockNumber)
			const cachedFingerprint = getPopupVisualisationFingerprint(
				popupVisualisation.simulationState.value.simulationStateInput,
				popupVisualisation.simulationState.value.rpcNetwork,
				popupVisualisation.simulationState.value.blockNumber,
			)
			if (currentFingerprint === cachedFingerprint && (capturedSnapshot.numberOfAddressesMadeRich === popupVisualisation.numberOfAddressesMadeRich)) return popupVisualisation
		}
		if (!isCurrent()) return await getPopupVisualisationState()
		if (invalidateOldState) {
			generation = invalidatePopupVisualisation()
			await publishUpdatingPopupVisualisation(true, generation)
		}
		if (!isCurrent()) return await getPopupVisualisationState()
		abortController.abort(NEW_BLOCK_ABORT)
		abortController = new AbortController()
		const thisAbortController = abortController
		await executePopupVisualisationState(ethereum, tokenPriceService, thisAbortController, false, capturedSnapshot, generation)
	} catch(error: unknown) {
		if (isExpectedInfrastructureError(error)) return await getPopupVisualisationState()
		await reportUnexpectedError(error)
	}
	return await getPopupVisualisationState()
}

const updateSimulationVisualisationSemaphore = new Semaphore(1)

// Counts only real simulations running under the semaphore. Metadata re-labels and the failure write in publishFailedPopupVisualisation hold the semaphore too but are not counted, so onlyIfNotAlreadyUpdating callers still refresh while only those run, queueing behind them; a queued refresh leaves a re-label running, as re-labels are not cancellable.
let runningSimulations = 0
async function countAsRunningSimulation(simulate: () => Promise<void>) {
	runningSimulations += 1
	try {
		await simulate()
	} finally {
		runningSimulations -= 1
	}
}

// Publish progress using the storage lock, without waiting for an in-flight RPC simulation.
export async function publishPendingPopupVisualisation(invalidateOldState: boolean) {
	await publishUpdatingPopupVisualisation(invalidateOldState, invalidatePopupVisualisation())
}

async function publishUpdatingPopupVisualisation(invalidateOldState: boolean, generation: number) {
	const pending = await updatePopupVisualisationWithCallBack(async previous => generation !== publicationGeneration ? undefined : retainPreviousVisualisation(previous, {
		simulationId: previous.simulationId + 1,
		simulationUpdatingState: 'updating',
		simulationResultState: invalidateOldState ? 'invalid' : undefined,
	}))
	if (generation === publicationGeneration) await sendPopupMessageToOpenWindows({ method: 'popup_simulation_state_changed', data: { visualizedSimulatorState: pending } })
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

// Captures the snapshot and, for background edits, publishes the updating state; the caller decides invalidation once and passes it to the queue, which hands it to execute.
export async function preparePopupVisualisationRefresh(services: SimulationServices, invalidateOldState: boolean, publishUpdatingState = false): Promise<PopupVisualisationRefreshRequest | undefined> {
	const generation = publishUpdatingState ? invalidatePopupVisualisation() : publicationGeneration
	const snapshot = await captureSimulationSnapshot()
	if (generation !== publicationGeneration) return undefined
	if (publishUpdatingState) await publishUpdatingPopupVisualisation(invalidateOldState, generation)
	if (generation !== publicationGeneration) return undefined
	const provider = getSimulationProviderForSnapshot(services.ethereum, snapshot)
	const block = publishUpdatingState ? undefined : provider?.getCachedBlock()
	// Without a cached head we cannot prove equivalence; keep the follow-up refresh.
	const target = block === undefined ? undefined : {
		visualisationFingerprint: getPopupVisualisationFingerprint(snapshot.simulationStateInput, services.ethereum.getRpcEntry(), block.number),
		blockHash: block.hash,
		numberOfAddressesMadeRich: snapshot.numberOfAddressesMadeRich,
		activeStackContext: snapshot.activeStackContext,
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
			}, generation)
			return result.simulationUpdatingState !== 'failed' && result.simulationResultState !== 'invalid'
		},
	}
}

// Serializes visualisation work with every other refresh. Work whose captured abort controller was aborted while it waited is skipped, because the refresh that aborted it stores its own result.
async function executeVisualisationUpdate(capturedAbortController: AbortController | undefined, update: () => Promise<void>) {
	await updateSimulationVisualisationSemaphore.execute(async () => {
		if (capturedAbortController?.signal.aborted) return
		await update()
	})
}

// A stored simulation result that is still valid, with operations on the services' chain, can be re-labelled: empty states show no operations, another chain's simulation must not get this chain's metadata, and an invalidated result is about to be replaced by a simulation that resolves the current metadata itself. That includes a previous result a refresh kept ('updating' while the node cannot be reached, or 'failed'): it stays shown until a refresh succeeds, so it must show the current names too. Re-labels run under the simulation semaphore, so no refresh is in progress when one reads the stored state.
function getStackRunToRelabel(visualisation: StoredCompleteVisualizedSimulation, chainId: bigint): SimulationRunToRelabel<StoredCompleteVisualizedSimulation> | undefined {
	if (visualisation.simulationResultState !== 'done') return undefined
	if (visualisation.simulationState.kind !== 'simulated') return undefined
	const simulationState = visualisation.simulationState.value
	if (simulationState.rpcNetwork.chainId !== chainId || !hasSimulationInputOperations(simulationState)) return undefined
	// The re-labelled state keeps the simulation id and raises the metadata revision, so a view orders it after the result it replaces (predatesVisualisation).
	return { runId: visualisation.simulationId, simulationState, storedMetadata: visualisation, withMetadata: (metadata) => ({ ...visualisation, ...metadata, metadataRevision: (visualisation.metadataRevision ?? 0) + 1 }) }
}

// Re-labels the stored stack simulation without simulating, and publishes the re-labelled state; see "Address-book re-labels" in docs/popup-simulation-refresh.md.
export async function relabelPopupVisualisation(rpcNetwork: RpcNetwork) {
	// Not cancellable: a newer refresh may store no fresh names (it keeps the previous result while the node cannot be reached), so the re-label runs in semaphore order instead. Running before a refresh, its names are what the refresh keeps or replaces; running after one, it re-labels the stored result, which costs no RPC request.
	await executeVisualisationUpdate(undefined, async () => {
		let relabelledState: StoredCompleteVisualizedSimulation | undefined
		await relabelStoredSimulation(rpcNetwork, {
			stored: await getPopupVisualisationState(),
			getRunToRelabel: (visualisation) => getStackRunToRelabel(visualisation, rpcNetwork.chainId),
			updateStored: async (relabel) => await updatePopupVisualisationWithCallBack(async (current) => {
				relabelledState = relabel(current)
				return relabelledState
			}),
		})
		// Views that render publications, such as the FetchSimulationStack sharing dialog, get the new names this way. Published under the semaphore, as every refresh's result is, so it reaches views in order with them; views render a publication without requesting a simulation (components/simulationStatePublications.ts).
		if (relabelledState !== undefined) await sendPopupMessageToOpenWindows({ method: 'popup_simulation_state_changed', data: { visualizedSimulatorState: relabelledState } })
	})
}

// Failed provider preparation must retire old results without executing the retained provider.
export async function publishFailedPopupVisualisation() {
	invalidatePopupVisualisation()
	await updateSimulationVisualisationSemaphore.execute(async () => {
		const previous = await getPopupVisualisationState()
		const failed = await setPopupVisualisationState({
			...createPassthroughCompleteVisualizedSimulation(previous.simulationId + 1, 'invalid'),
			simulationUpdatingState: 'failed',
		})
		await sendPopupMessageToOpenWindows({ method: 'popup_simulation_state_changed', data: { visualizedSimulatorState: failed } })
	})
}

export type PopupVisualisationExecutionDependencies = {
	readonly getUpdatedState?: typeof getUpdatedSimulationState
	readonly visualize?: typeof visualizeSimulatorStateAndRecordLookups
}

// Serialized execution without a visibility probe; persistence callers can require unexpected errors to propagate.
export async function updatePopupVisualisationState(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, abortController: AbortController | undefined, throwOnUnexpectedError = false, snapshot?: SimulationSnapshot, dependencies: PopupVisualisationExecutionDependencies = {}) {
	return await executePopupVisualisationState(ethereum, tokenPriceService, abortController, throwOnUnexpectedError, snapshot, publicationGeneration, dependencies)
}

async function executePopupVisualisationState(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, abortController: AbortController | undefined, throwOnUnexpectedError: boolean, snapshot: SimulationSnapshot | undefined, generation: number, dependencies: PopupVisualisationExecutionDependencies = {}) {
	const isCurrent = () => generation === publicationGeneration && !abortController?.signal.aborted
	// Check inside the storage lock as well as after remote work: invalidation can arrive while a write waits.
	const storeCurrentState = async (state: StoredCompleteVisualizedSimulation) => {
		await updatePopupVisualisationWithCallBack(async () => isCurrent() ? state : undefined)
		return isCurrent() ? state : undefined
	}
	const publishCurrentState = async (state: CompleteVisualizedSimulation | undefined) => {
		if (state !== undefined && isCurrent()) await sendPopupMessageToOpenWindows({ method: 'popup_simulation_state_changed', data: { visualizedSimulatorState: state } })
	}
	try {
		return await updateSimulationVisualisationSemaphore.execute(async () => await countAsRunningSimulation(async () => {
			if (!isCurrent()) return
			const popupVisualisation = await getPopupVisualisationState()
			const simulationId = popupVisualisation.simulationId + 1
			const capturedSnapshot = snapshot ?? await captureSimulationSnapshot()
			const simulationState = await (dependencies.getUpdatedState ?? getUpdatedSimulationState)(ethereum, capturedSnapshot)
			if (!isCurrent()) return
			const doneState = { simulationUpdatingState: 'done' as const, simulationResultState: 'done' as const, simulationId }
			const numberOfAddressesMadeRich = capturedSnapshot.numberOfAddressesMadeRich
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
						const refreshed = await (dependencies.visualize ?? visualizeSimulatorStateAndRecordLookups)(simulationState.value, ethereum, tokenPriceService, abortController)
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
		}))
	} catch (error) {
		if (throwOnUnexpectedError) throw error
		if (isExpectedInfrastructureError(error)) return
		await reportUnexpectedError(error)
	}
}

async function getCurrentSimulationStateInput(ethereum: EthereumClientService, snapshot: SimulationSnapshot) {
	return {
		simulationStateInput: snapshot.simulationStateInput,
		rpcNetwork: ethereum.getRpcEntry(),
		blockNumber: await ethereum.getBlockNumber(undefined),
	}
}

export type OpenConsumerVisualisationDependencies = {
	readonly update?: typeof updatePopupVisualisationState
	readonly getStored?: typeof getPopupVisualisationState
	readonly reportError?: typeof reportUnexpectedError
}

// Bootstrap already knows a consumer is open; refresh without the visibility probe and retain the stored fallback on reported errors.
export async function refreshPopupVisualisationForOpenConsumer(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, dependencies: OpenConsumerVisualisationDependencies = {}) {
	try {
		await (dependencies.update ?? updatePopupVisualisationState)(ethereum, tokenPriceService, undefined, true)
	} catch (error) {
		if (!isExpectedInfrastructureError(error)) await (dependencies.reportError ?? reportUnexpectedError)(error)
	}
	return await (dependencies.getStored ?? getPopupVisualisationState)()
}
