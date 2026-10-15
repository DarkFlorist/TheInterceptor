// Shared execution layer for popup visualization refreshes; the optional interactive queue adds caller-local scheduling, not global ordering. See docs/popup-simulation-refresh.md.
import type { SimulationServices } from '../simulation/serviceLifecycle.js'
import { stringifyJSONWithBigInts } from '../utils/bigint.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import type { CompleteVisualizedSimulation, SimulationState } from '../types/visualizer-types.js'
import { createPassthroughCompleteVisualizedSimulation, toResolvedSimulationState } from '../types/visualizer-types.js'
import { NEW_BLOCK_ABORT, TIME_BETWEEN_BLOCKS } from '../utils/constants.js'
import { reportUnexpectedError, isExpectedInfrastructureError, isFailedToFetchError, isNewBlockAbort } from '../utils/errors.js'
import { silenceChromeUnCaughtPromise } from '../utils/requests.js'
import { Semaphore } from '../utils/semaphore.js'
import { modifyObject } from '../utils/typescript.js'
import { captureSimulationSnapshot, getSimulationProviderForSnapshot, type SimulationSnapshot, getUpdatedSimulationState } from './simulationUpdating.js'
import { requestIsSimulationDataConsumerOpen, sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { getPopupVisualisationFingerprint } from './popupSimulationFingerprint.js'
import { visualizeSimulatorState } from './simulationUpdating.js'
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
		if (onlyIfNotAlreadyUpdating && updateSimulationVisualisationSemaphore.getPermits() === 0) return popupVisualisation
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

// Publish progress using the storage lock, without waiting for an in-flight RPC simulation.
export async function publishPendingPopupVisualisation(invalidateOldState: boolean) {
	await publishUpdatingPopupVisualisation(invalidateOldState, invalidatePopupVisualisation())
}

async function publishUpdatingPopupVisualisation(invalidateOldState: boolean, generation: number) {
	const pending = await updatePopupVisualisationWithCallBack(async previous => generation !== publicationGeneration ? undefined : ({
		...previous,
		simulationId: previous.simulationId + 1,
		simulationUpdatingState: 'updating',
		simulationResultState: invalidateOldState ? 'invalid' : previous.simulationResultState,
	}))
	if (generation === publicationGeneration) await sendPopupMessageToOpenWindows({ method: 'popup_simulation_state_changed', data: { visualizedSimulatorState: pending } })
}

export type PopupVisualisationRefreshRequest = SimulationServices & {
	readonly revision: string | symbol
	readonly invalidateOldState?: boolean
	readonly execute: (invalidateOldState: boolean) => Promise<boolean>
}

// The queue receives only an identity and executable request; validity and snapshot ownership stay here.
export async function preparePopupVisualisationRefresh(services: SimulationServices & { readonly invalidateOldState?: boolean }, publishUpdatingState = false): Promise<PopupVisualisationRefreshRequest | undefined> {
	const generation = publishUpdatingState ? invalidatePopupVisualisation() : publicationGeneration
	const snapshot = await captureSimulationSnapshot()
	if (generation !== publicationGeneration) return undefined
	const invalidateOldState = services.invalidateOldState ?? publishUpdatingState
	if (publishUpdatingState) await publishUpdatingPopupVisualisation(invalidateOldState, generation)
	if (generation !== publicationGeneration) return undefined
	const provider = getSimulationProviderForSnapshot(services.ethereum, snapshot)
	const block = publishUpdatingState ? undefined : provider?.getCachedBlock()
	// Without a cached head we cannot prove equivalence; keep the follow-up refresh.
	const revision = publishUpdatingState || block === undefined ? Symbol('UI simulation refresh') : stringifyJSONWithBigInts([
		getPopupVisualisationFingerprint(snapshot.simulationStateInput, services.ethereum.getRpcEntry(), block.number),
		block.hash,
		snapshot.numberOfAddressesMadeRich,
		snapshot.activeStackContext,
		generation,
	])
	return {
		...services, invalidateOldState, revision,
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

const updateSimulationVisualisationSemaphore = new Semaphore(1)
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
	readonly visualize?: typeof visualizeSimulatorState
}

// Serialized execution without a visibility probe; persistence callers can require unexpected errors to propagate.
export async function updatePopupVisualisationState(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, abortController: AbortController | undefined, throwOnUnexpectedError = false, snapshot?: SimulationSnapshot, dependencies: PopupVisualisationExecutionDependencies = {}) {
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
			const visualizedSimulatorState = await storeCurrentState(modifyObject(popupVisualisation, { simulationId, simulationUpdatingState: 'updating' }))
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
					const state = await storeCurrentState(modifyObject(popupVisualisation, { simulationId, simulationUpdatingState: 'updating' }))
					await publishCurrentState(state)
					return
				}
				if (throwOnUnexpectedError) throw error
				const state = await storeCurrentState(modifyObject(popupVisualisation, { simulationId, simulationUpdatingState: 'failed' }))
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

async function getCurrentSimulationStateInput(ethereum: EthereumClientService, snapshot: SimulationSnapshot) {
	return {
		simulationStateInput: snapshot.simulationStateInput,
		rpcNetwork: ethereum.getRpcEntry(),
		blockNumber: await ethereum.getBlockNumber(undefined),
	}
}
