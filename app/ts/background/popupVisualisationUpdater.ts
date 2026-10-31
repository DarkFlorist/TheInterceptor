// Shared execution layer for popup visualization refreshes; the optional interactive queue adds caller-local scheduling, not global ordering. See docs/popup-simulation-refresh.md.
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { RpcNetwork } from '../types/rpc.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import type { CompleteVisualizedSimulation, SimulationState, StoredCompleteVisualizedSimulation } from '../types/visualizer-types.js'
import { createPassthroughCompleteVisualizedSimulation, toResolvedSimulationState } from '../types/visualizer-types.js'
import { NEW_BLOCK_ABORT, TIME_BETWEEN_BLOCKS } from '../utils/constants.js'
import { reportUnexpectedError, isExpectedInfrastructureError, isFailedToFetchError, isNewBlockAbort } from '../utils/errors.js'
import { silenceChromeUnCaughtPromise } from '../utils/requests.js'
import { Semaphore } from '../utils/semaphore.js'
import { modifyObject } from '../utils/typescript.js'
import { captureSimulationSnapshot, getSimulationProviderForSnapshot, type SimulationSnapshot, getUpdatedSimulationState } from './simulationUpdating.js'
import { requestIsSimulationDataConsumerOpen, sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { getPopupVisualisationFingerprint } from './popupSimulationFingerprint.js'
import { visualizeSimulatorStateAndRecordLookups } from './simulationUpdating.js'
import { relabelStoredSimulation, type SimulationRunToRelabel } from './simulationRelabel.js'
import { getPopupVisualisationState, setPopupVisualisationState, updatePopupVisualisationWithCallBack } from './storageVariables.js'

let abortController = new AbortController()

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
export const updatePopupVisualisationIfNeeded = async (ethereum: EthereumClientService, tokenPriceService: TokenPriceService, { invalidateOldState = false, onlyIfNotAlreadyUpdating = false, skipIfUnchanged = false, snapshot }: PopupVisualisationOptions = {}) => {
	try {
		const popupVisualisation = await getPopupVisualisationState()
		if (onlyIfNotAlreadyUpdating && runningSimulations > 0) return popupVisualisation
		if (onlyIfNotAlreadyUpdating && popupVisualisation.simulationState.kind === 'simulated') {
			const ageSeconds = (Date.now()- popupVisualisation.simulationState.value.simulationConductedTimestamp.getTime()) / 1000
			if (ageSeconds < TIME_BETWEEN_BLOCKS) return popupVisualisation
		}
		const isSimulationDataConsumerOpenReply = await requestIsSimulationDataConsumerOpen()
		if (!(isSimulationDataConsumerOpenReply?.data.isOpen === true)) return popupVisualisation
		const capturedSnapshot = snapshot ?? await captureSimulationSnapshot()
		const provider = getSimulationProviderForSnapshot(ethereum, capturedSnapshot)
		if (skipIfUnchanged && popupVisualisation.simulationState.kind === 'simulated' && provider !== undefined) {
			const currentSimulationInput = await getCurrentSimulationStateInput(provider, capturedSnapshot)
			const currentFingerprint = getPopupVisualisationFingerprint(currentSimulationInput.simulationStateInput, currentSimulationInput.rpcNetwork, currentSimulationInput.blockNumber)
			const cachedFingerprint = getPopupVisualisationFingerprint(
				popupVisualisation.simulationState.value.simulationStateInput,
				popupVisualisation.simulationState.value.rpcNetwork,
				popupVisualisation.simulationState.value.blockNumber,
			)
			if (currentFingerprint === cachedFingerprint && (capturedSnapshot.numberOfAddressesMadeRich === popupVisualisation.numberOfAddressesMadeRich)) return popupVisualisation
		}
		abortController.abort(NEW_BLOCK_ABORT)
		abortController = new AbortController()
		const thisAbortController = abortController
		if (invalidateOldState) {
			const simulationId = popupVisualisation.simulationId + 1
			const visualizedSimulatorState = await setPopupVisualisationState(modifyObject(popupVisualisation, { simulationId, simulationResultState: 'invalid', simulationUpdatingState: 'updating' }))
			await sendPopupMessageToOpenWindows({ method: 'popup_simulation_state_changed', data: { visualizedSimulatorState } })
		}
		await updatePopupVisualisationState(ethereum, tokenPriceService, thisAbortController, false, capturedSnapshot)
	} catch(error: unknown) {
		if (isExpectedInfrastructureError(error)) return await getPopupVisualisationState()
		await reportUnexpectedError(error)
	}
	return await getPopupVisualisationState()
}

const updateSimulationVisualisationSemaphore = new Semaphore(1)

// Counts only real simulations running under the semaphore. Metadata re-labels and the failure write in publishFailedPopupVisualisation hold the semaphore too but are not counted, so onlyIfNotAlreadyUpdating callers still refresh while only those run, queueing behind them (and aborting a re-label).
let runningSimulations = 0
async function countAsRunningSimulation(simulate: () => Promise<void>) {
	runningSimulations += 1
	try {
		await simulate()
	} finally {
		runningSimulations -= 1
	}
}

// Serializes visualisation work with every other refresh. Work whose captured abort controller was aborted while it waited is skipped, because the refresh that aborted it stores its own result.
async function executeVisualisationUpdate(capturedAbortController: AbortController | undefined, update: () => Promise<void>) {
	await updateSimulationVisualisationSemaphore.execute(async () => {
		if (capturedAbortController?.signal.aborted) return
		await update()
	})
}

// Only a finished simulation with operations on the services' chain can be re-labelled: empty states show no operations, another chain's simulation must not get this chain's metadata, and pending, invalidated or failed states are about to be replaced by a simulation that resolves the current metadata itself.
function getStackRunToRelabel(visualisation: StoredCompleteVisualizedSimulation, chainId: bigint): SimulationRunToRelabel<StoredCompleteVisualizedSimulation> | undefined {
	if (visualisation.simulationUpdatingState !== 'done' || visualisation.simulationResultState !== 'done') return undefined
	if (visualisation.simulationState.kind !== 'simulated') return undefined
	const simulationState = visualisation.simulationState.value
	if (simulationState.rpcNetwork.chainId !== chainId || !hasSimulationInputOperations(simulationState)) return undefined
	return { runId: visualisation.simulationId, simulationState, storedMetadata: visualisation, withMetadata: (metadata) => ({ ...visualisation, ...metadata }) }
}

// publishFailedPopupVisualisation aborts the shared controller without replacing it, and direct refreshes such as imports do not replace it either. A re-label requested afterwards must not inherit that stale cancellation, while any later refresh still aborts the controller returned here.
function getUncancelledAbortController() {
	if (abortController.signal.aborted) abortController = new AbortController()
	return abortController
}

// Re-labels the stored stack simulation without simulating or publishing popup_simulation_state_changed; see "Address-book re-labels" in docs/popup-simulation-refresh.md.
export async function relabelPopupVisualisation(rpcNetwork: RpcNetwork) {
	// Captured at request time, so a newer block, stack or failure refresh also cancels a re-label still waiting for the semaphore.
	const thisAbortController = getUncancelledAbortController()
	await executeVisualisationUpdate(thisAbortController, async () => {
		await relabelStoredSimulation(rpcNetwork, {
			stored: await getPopupVisualisationState(),
			getRunToRelabel: (visualisation) => getStackRunToRelabel(visualisation, rpcNetwork.chainId),
			updateStored: async (relabel) => await updatePopupVisualisationWithCallBack(async (current) => relabel(current)),
			abortController: thisAbortController,
		})
	})
}

// Failed provider preparation must retire old results without executing the retained provider.
export async function publishFailedPopupVisualisation() {
	abortController.abort(NEW_BLOCK_ABORT)
	await updateSimulationVisualisationSemaphore.execute(async () => {
		const previous = await getPopupVisualisationState()
		const failed = await setPopupVisualisationState({
			...createPassthroughCompleteVisualizedSimulation(previous.simulationId + 1, 'invalid'),
			simulationUpdatingState: 'failed',
		})
		await sendPopupMessageToOpenWindows({ method: 'popup_simulation_state_changed', data: { visualizedSimulatorState: failed } })
	})
}

// Serialized execution without a visibility probe; persistence callers can require unexpected errors to propagate.
export async function updatePopupVisualisationState(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, abortController: AbortController | undefined, throwOnUnexpectedError = false, snapshot?: SimulationSnapshot) {
	try {
		await executeVisualisationUpdate(abortController, async () => await countAsRunningSimulation(async () => {
			const popupVisualisation = await getPopupVisualisationState()
			const simulationId = popupVisualisation.simulationId + 1
			const capturedSnapshot = snapshot ?? await captureSimulationSnapshot()
			const simulationState = await getUpdatedSimulationState(ethereum, capturedSnapshot)
			const doneState = { simulationUpdatingState: 'done' as const, simulationResultState: 'done' as const, simulationId }
			const numberOfAddressesMadeRich = capturedSnapshot.numberOfAddressesMadeRich
			if (simulationState.kind === 'passthrough') {
				const newState = buildPassthroughVisualizedState(simulationId, numberOfAddressesMadeRich)
				await setPopupVisualisationState(newState)
				await sendPopupMessageToOpenWindows({ method: 'popup_simulation_state_changed', data: { visualizedSimulatorState: newState } })
				return
			}
			if (!hasSimulationInputOperations(simulationState.value)) {
				const newState = simulationState.value.success
					? buildDefinedEmptyVisualizedState(simulationState.value, simulationId, numberOfAddressesMadeRich)
					: buildPassthroughVisualizedState(simulationId, numberOfAddressesMadeRich)
				await setPopupVisualisationState(newState)
				await sendPopupMessageToOpenWindows({ method: 'popup_simulation_state_changed', data: { visualizedSimulatorState: newState } })
				return
			}
			const visualizedSimulatorState = await setPopupVisualisationState(modifyObject(popupVisualisation, { simulationId, simulationUpdatingState: 'updating' }))
			const changedMessagePromise = silenceChromeUnCaughtPromise(sendPopupMessageToOpenWindows({ method: 'popup_simulation_state_changed', data: { visualizedSimulatorState } }))
			try {
				const getUpdatedState = async () => {
					if (ethereum.getChainId() === simulationState.value.rpcNetwork.chainId) {
						const refreshed = await visualizeSimulatorStateAndRecordLookups(simulationState.value, ethereum, tokenPriceService, abortController)
						return await setPopupVisualisationState({ ...refreshed, ...doneState, simulationState: toResolvedSimulationState(refreshed.simulationState), numberOfAddressesMadeRich })
					}
					return await setPopupVisualisationState(buildPassthroughVisualizedState(simulationId, numberOfAddressesMadeRich, 'corrupted'))
				}
				const newVisualizedState = await getUpdatedState()
				await changedMessagePromise
				await sendPopupMessageToOpenWindows({ method: 'popup_simulation_state_changed', data: { visualizedSimulatorState: newVisualizedState } })
			} catch (error) {
				if (isNewBlockAbort(error)) return
				if (isFailedToFetchError(error)) {
					const state = await setPopupVisualisationState(modifyObject(popupVisualisation, { simulationId, simulationUpdatingState: 'updating' }))
					await sendPopupMessageToOpenWindows({ method: 'popup_simulation_state_changed', data: { visualizedSimulatorState: state }  })
					return
				}
				if (throwOnUnexpectedError) throw error
				const state = await setPopupVisualisationState(modifyObject(popupVisualisation, { simulationId, simulationUpdatingState: 'failed' }))
				await sendPopupMessageToOpenWindows({ method: 'popup_simulation_state_changed', data: { visualizedSimulatorState: state }  })
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
