// Shared execution layer for popup visualization refreshes; the optional interactive queue adds caller-local scheduling, not global ordering. See docs/popup-simulation-refresh.md.
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import type { CompleteVisualizedSimulation, ResolvedSimulationState, SimulationState } from '../types/visualizer-types.js'
import { createPassthroughCompleteVisualizedSimulation, toResolvedSimulationState } from '../types/visualizer-types.js'
import { NEW_BLOCK_ABORT, TIME_BETWEEN_BLOCKS } from '../utils/constants.js'
import { reportUnexpectedError, isExpectedInfrastructureError, isFailedToFetchError, isNewBlockAbort } from '../utils/errors.js'
import { silenceChromeUnCaughtPromise } from '../utils/requests.js'
import { getRpcNetworkChange, isSignerOnlyNetwork } from '../utils/rpcNetworkChange.js'
import { Semaphore } from '../utils/semaphore.js'
import { modifyObject } from '../utils/typescript.js'
import { captureSimulationSnapshot, getSimulationProviderForSnapshot, type SimulationSnapshot, getUpdatedSimulationState } from './simulationUpdating.js'
import { requestIsSimulationDataConsumerOpen, sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { getPopupVisualisationFingerprint } from './popupSimulationFingerprint.js'
import { visualizeSimulatorState } from './simulationUpdating.js'
import { getPopupVisualisationState, setPopupVisualisationState } from './storageVariables.js'

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

// What a caller with its own snapshot shows when that snapshot has no visualisation; the stored result is shared by every refresh and may describe another network or stack.
export const createUnavailableVisualisation = (): CompleteVisualizedSimulation => ({ ...createPassthroughCompleteVisualizedSimulation(0, 'invalid'), simulationUpdatingState: 'failed' })

// Signer-only networks are not simulated, so they keep the previous network's services.
const servesSnapshotNetwork = (ethereum: EthereumClientService, snapshot: SimulationSnapshot) => (
	isSignerOnlyNetwork(snapshot.activeRpcNetwork) || !getRpcNetworkChange(snapshot.activeRpcNetwork, ethereum.getRpcEntry()).endpointChanged
)

export type PopupVisualisationOptions = {
	readonly invalidateOldState?: boolean
	readonly onlyIfNotAlreadyUpdating?: boolean
	readonly skipIfUnchanged?: boolean
	// The interactive queue refreshes the shared visualisation with the snapshot its revision was computed from.
	readonly snapshot?: SimulationSnapshot
}

// Visibility/throttle-aware refresh of the shared visualisation: callers such as block updates can replace obsolete work without entering the interactive queue. Callers get the stored result; the queue, which supplies a snapshot, gets the result computed for it, or the unavailable state.
export const updatePopupVisualisationIfNeeded = async (ethereum: EthereumClientService, tokenPriceService: TokenPriceService, { invalidateOldState = false, onlyIfNotAlreadyUpdating = false, skipIfUnchanged = false, snapshot }: PopupVisualisationOptions = {}) => {
	try {
		const popupVisualisation = await getPopupVisualisationState()
		// A caller that supplies a snapshot needs the visualisation of exactly that snapshot, so only global refreshes may reuse the stored result.
		const mayReuseStoredResult = onlyIfNotAlreadyUpdating && snapshot === undefined
		if (mayReuseStoredResult && updateSimulationVisualisationSemaphore.getPermits() === 0) return popupVisualisation
		if (mayReuseStoredResult && popupVisualisation.simulationState.kind === 'simulated') {
			const ageSeconds = (Date.now()- popupVisualisation.simulationState.value.simulationConductedTimestamp.getTime()) / 1000
			if (ageSeconds < TIME_BETWEEN_BLOCKS) return popupVisualisation
		}
		const isSimulationDataConsumerOpenReply = await requestIsSimulationDataConsumerOpen()
		if (!(isSimulationDataConsumerOpenReply?.data.isOpen === true)) return snapshot === undefined ? popupVisualisation : createUnavailableVisualisation()
		const capturedSnapshot = snapshot ?? await captureSimulationSnapshot()
		// Services captured before a network change must neither simulate the later network's stack nor cancel or invalidate that network's own refresh.
		if (!servesSnapshotNetwork(ethereum, capturedSnapshot)) return snapshot === undefined ? popupVisualisation : createUnavailableVisualisation()
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
		const computed = await updatePopupVisualisationState(ethereum, tokenPriceService, thisAbortController, false, capturedSnapshot)
		// A superseded or failed refresh leaves another refresh's result in storage, which is not this snapshot's.
		if (snapshot !== undefined) return computed ?? createUnavailableVisualisation()
	} catch(error: unknown) {
		if (!isExpectedInfrastructureError(error)) await reportUnexpectedError(error)
		if (snapshot !== undefined) return createUnavailableVisualisation()
	}
	return await getPopupVisualisationState()
}

export type ConfirmationVisualisationDependencies = {
	readonly compute?: typeof computeSnapshotVisualisation
	readonly reportError?: typeof reportUnexpectedError
}

// A confirmation window shows the visualisation of its own snapshot, so it is computed for that window and never stored or broadcast as the shared visualisation, which follows the latest stack. A failed computation shows the unavailable state, so the rest of the dialog still updates.
export async function computeConfirmationVisualisation(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, simulation: SimulationSnapshot, dependencies: ConfirmationVisualisationDependencies = {}) {
	try {
		return await (dependencies.compute ?? computeSnapshotVisualisation)(ethereum, tokenPriceService, simulation) ?? createUnavailableVisualisation()
	} catch (error) {
		if (!isExpectedInfrastructureError(error)) await (dependencies.reportError ?? reportUnexpectedError)(error)
		return createUnavailableVisualisation()
	}
}

const updateSimulationVisualisationSemaphore = new Semaphore(1)
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

// Builds the visualisation of one simulation without storing it. Visualising operations queries the services, so abort and fetch errors propagate to the caller.
async function visualiseSimulationState(simulationState: ResolvedSimulationState, ethereum: EthereumClientService, tokenPriceService: TokenPriceService, abortController: AbortController | undefined, simulationId: number, numberOfAddressesMadeRich: number): Promise<CompleteVisualizedSimulation> {
	if (simulationState.kind === 'passthrough') return buildPassthroughVisualizedState(simulationId, numberOfAddressesMadeRich)
	if (!hasSimulationInputOperations(simulationState.value)) {
		return simulationState.value.success
			? buildDefinedEmptyVisualizedState(simulationState.value, simulationId, numberOfAddressesMadeRich)
			: buildPassthroughVisualizedState(simulationId, numberOfAddressesMadeRich)
	}
	if (ethereum.getChainId() !== simulationState.value.rpcNetwork.chainId) return buildPassthroughVisualizedState(simulationId, numberOfAddressesMadeRich, 'corrupted')
	const refreshed = await visualizeSimulatorState(simulationState.value, ethereum, tokenPriceService, abortController)
	return { ...refreshed, simulationUpdatingState: 'done', simulationResultState: 'done', simulationId, simulationState: toResolvedSimulationState(refreshed.simulationState), numberOfAddressesMadeRich }
}

// Only the shared stored visualisation is ordered by its simulation id; a confirmation's own visualisation is never stored.
const CONFIRMATION_VISUALISATION_ID = 0

// Serialized with the shared refreshes, but neither cancellable by them nor stored. Returns undefined when the services serve another network or the visualisation could not be fetched; unexpected errors propagate.
export async function computeSnapshotVisualisation(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, snapshot: SimulationSnapshot) {
	return await updateSimulationVisualisationSemaphore.execute(async () => {
		if (!servesSnapshotNetwork(ethereum, snapshot)) return undefined
		const simulationState = await getUpdatedSimulationState(ethereum, snapshot)
		try {
			return await visualiseSimulationState(simulationState, ethereum, tokenPriceService, undefined, CONFIRMATION_VISUALISATION_ID, snapshot.numberOfAddressesMadeRich)
		} catch (error) {
			if (isNewBlockAbort(error) || isFailedToFetchError(error)) return undefined
			throw error
		}
	})
}

// Serialized refresh of the shared visualisation without a visibility probe; persistence callers can require unexpected errors to propagate. Returns the visualisation built for the snapshot, not the stored one, which a newer refresh may have written; undefined when the update was aborted or failed.
export async function updatePopupVisualisationState(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, abortController: AbortController | undefined, throwOnUnexpectedError = false, snapshot?: SimulationSnapshot) {
	try {
		return await updateSimulationVisualisationSemaphore.execute(async () => {
			if (abortController?.signal.aborted) return undefined
			const popupVisualisation = await getPopupVisualisationState()
			const simulationId = popupVisualisation.simulationId + 1
			const capturedSnapshot = snapshot ?? await captureSimulationSnapshot()
			// Services captured before a network change cannot simulate a later network's stack; the refresh that follows the change publishes that network's result.
			if (!servesSnapshotNetwork(ethereum, capturedSnapshot)) return undefined
			const simulationState = await getUpdatedSimulationState(ethereum, capturedSnapshot)
			const numberOfAddressesMadeRich = capturedSnapshot.numberOfAddressesMadeRich
			if (simulationState.kind === 'passthrough' || !hasSimulationInputOperations(simulationState.value)) {
				const newState = await visualiseSimulationState(simulationState, ethereum, tokenPriceService, abortController, simulationId, numberOfAddressesMadeRich)
				await setPopupVisualisationState(newState)
				await sendPopupMessageToOpenWindows({ method: 'popup_simulation_state_changed', data: { visualizedSimulatorState: newState } })
				return newState
			}
			const visualizedSimulatorState = await setPopupVisualisationState(modifyObject(popupVisualisation, { simulationId, simulationUpdatingState: 'updating' }))
			const changedMessagePromise = silenceChromeUnCaughtPromise(sendPopupMessageToOpenWindows({ method: 'popup_simulation_state_changed', data: { visualizedSimulatorState } }))
			try {
				const newVisualizedState = await visualiseSimulationState(simulationState, ethereum, tokenPriceService, abortController, simulationId, numberOfAddressesMadeRich)
				const storedVisualizedState = await setPopupVisualisationState(newVisualizedState)
				await changedMessagePromise
				await sendPopupMessageToOpenWindows({ method: 'popup_simulation_state_changed', data: { visualizedSimulatorState: storedVisualizedState } })
				return newVisualizedState
			} catch (error) {
				if (isNewBlockAbort(error)) return undefined
				if (isFailedToFetchError(error)) {
					const state = await setPopupVisualisationState(modifyObject(popupVisualisation, { simulationId, simulationUpdatingState: 'updating' }))
					await sendPopupMessageToOpenWindows({ method: 'popup_simulation_state_changed', data: { visualizedSimulatorState: state }  })
					return undefined
				}
				if (throwOnUnexpectedError) throw error
				const state = await setPopupVisualisationState(modifyObject(popupVisualisation, { simulationId, simulationUpdatingState: 'failed' }))
				await sendPopupMessageToOpenWindows({ method: 'popup_simulation_state_changed', data: { visualizedSimulatorState: state }  })
				await reportUnexpectedError(error)
				return undefined
			}
		})
	} catch (error) {
		if (throwOnUnexpectedError) throw error
		if (isExpectedInfrastructureError(error)) return undefined
		await reportUnexpectedError(error)
	}
	return undefined
}

async function getCurrentSimulationStateInput(ethereum: EthereumClientService, snapshot: SimulationSnapshot) {
	return {
		simulationStateInput: snapshot.simulationStateInput,
		rpcNetwork: ethereum.getRpcEntry(),
		blockNumber: await ethereum.getBlockNumber(undefined),
	}
}
