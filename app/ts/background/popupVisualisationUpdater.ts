// Shared execution layer for popup visualization refreshes; the optional interactive queue adds caller-local scheduling, not global ordering. See docs/popup-simulation-refresh.md.
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

// Visibility/throttle-aware execution: callers such as block updates can replace obsolete work without entering the interactive queue.
export const updatePopupVisualisationIfNeeded = async (ethereum: EthereumClientService, tokenPriceService: TokenPriceService, invalidateOldState = false, onlyIfNotAlreadyUpdating = false, skipIfUnchanged = false, snapshot?: SimulationSnapshot) => {
	try {
		const popupVisualisation = await getPopupVisualisationState()
		if (onlyIfNotAlreadyUpdating && updateSimulationVisualisationSemaphore.getPermits() === 0) return popupVisualisation
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

// Serialized execution without a visibility probe; persistence callers can require unexpected errors to propagate.
export async function updatePopupVisualisationState(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, abortController: AbortController | undefined, throwOnUnexpectedError = false, snapshot?: SimulationSnapshot) {
	try {
		return await updateSimulationVisualisationSemaphore.execute(async () => {
			if (abortController?.signal.aborted) return
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
						const refreshed = await visualizeSimulatorState(simulationState.value, ethereum, tokenPriceService, abortController)
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
