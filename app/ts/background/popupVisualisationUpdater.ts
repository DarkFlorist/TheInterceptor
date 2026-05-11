
import { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { TokenPriceService } from '../simulation/services/priceEstimator.js'
import type { CompleteVisualizedSimulation, SimulationState } from '../types/visualizer-types.js'
import { createPassthroughCompleteVisualizedSimulation, toResolvedSimulationState } from '../types/visualizer-types.js'
import { NEW_BLOCK_ABORT, TIME_BETWEEN_BLOCKS } from '../utils/constants.js'
import { handleUnexpectedError, isFailedToFetchError, isNewBlockAbort } from '../utils/errors.js'
import { silenceChromeUnCaughtPromise } from '../utils/requests.js'
import { Semaphore } from '../utils/semaphore.js'
import { modifyObject } from '../utils/typescript.js'
import { getUpdatedSimulationState } from './background.js'
import { requestIsMainPopupWindowOpen, sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { getPopupVisualisationFingerprint } from './popupSimulationFingerprint.js'
import { getAddressesbeingMadeRich, getCurrentSimulationInput, visualizeSimulatorState } from './simulationUpdating.js'
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

export const updatePopupVisualisationIfNeeded = async (ethereum: EthereumClientService, tokenPriceService: TokenPriceService, invalidateOldState: boolean = false, onlyIfNotAlreadyUpdating = false, skipIfUnchanged = false) => {
	try {
		const popupVisualisation = await getPopupVisualisationState()
		if (onlyIfNotAlreadyUpdating && updateSimulationVisualisationSemaphore.getPermits() === 0) return popupVisualisation
		if (onlyIfNotAlreadyUpdating && popupVisualisation.simulationState.kind === 'simulated') {
			const ageSeconds = (new Date().getTime() - popupVisualisation.simulationState.value.simulationConductedTimestamp.getTime()) / 1000
			if (ageSeconds < TIME_BETWEEN_BLOCKS) return popupVisualisation
		}
		const isMainPopupWindowOpenReply = await requestIsMainPopupWindowOpen()
		if (!(isMainPopupWindowOpenReply?.data.isOpen === true)) return popupVisualisation
		if (skipIfUnchanged && popupVisualisation.simulationState.kind === 'simulated') {
			const currentSimulationInput = await getCurrentSimulationStateInput(ethereum)
			const currentFingerprint = getPopupVisualisationFingerprint(currentSimulationInput.simulationStateInput, currentSimulationInput.rpcNetwork, currentSimulationInput.blockNumber)
			const cachedFingerprint = getPopupVisualisationFingerprint(
				popupVisualisation.simulationState.value.simulationStateInput,
				popupVisualisation.simulationState.value.rpcNetwork,
				popupVisualisation.simulationState.value.blockNumber,
			)
			if (currentFingerprint === cachedFingerprint) return popupVisualisation
		}
		abortController.abort(NEW_BLOCK_ABORT)
		abortController = new AbortController()
		const thisAbortController = abortController
		if (invalidateOldState) {
			const simulationId = popupVisualisation.simulationId + 1
				const visualizedSimulatorState = await setPopupVisualisationState(modifyObject(popupVisualisation, { simulationId, simulationResultState: 'invalid', simulationUpdatingState: 'updating' }))
				await sendPopupMessageToOpenWindows({ method: 'popup_simulation_state_changed', data: { visualizedSimulatorState } })
			}
			await updatePopupVisualisationState(ethereum, tokenPriceService, thisAbortController)
		} catch(error: unknown) {
			if (error instanceof Error && (isNewBlockAbort(error) || isFailedToFetchError(error))) return await getPopupVisualisationState()
			await handleUnexpectedError(error)
	}
	return await getPopupVisualisationState()
}

const updateSimulationVisualisationSemaphore = new Semaphore(1)
export async function updatePopupVisualisationState(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, abortController: AbortController | undefined, throwOnUnexpectedError = false) {
	return await updateSimulationVisualisationSemaphore.execute(async () => {
		if (abortController?.signal.aborted) return
		const popupVisualisation = await getPopupVisualisationState()
		const simulationId = popupVisualisation.simulationId + 1
		const simulationState = await getUpdatedSimulationState(ethereum)
		const doneState = { simulationUpdatingState: 'done' as const, simulationResultState: 'done' as const, simulationId }
		const numberOfAddressesMadeRich = (await getAddressesbeingMadeRich()).length
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
			if (error instanceof Error && isNewBlockAbort(error)) return
			if (error instanceof Error && isFailedToFetchError(error)) {
				const state = await setPopupVisualisationState(modifyObject(popupVisualisation, { simulationId, simulationUpdatingState: 'updating' }))
				await sendPopupMessageToOpenWindows({ method: 'popup_simulation_state_changed', data: { visualizedSimulatorState: state }  })
				return
			}
			if (throwOnUnexpectedError) throw error
			const state = await setPopupVisualisationState(modifyObject(popupVisualisation, { simulationId, simulationUpdatingState: 'failed' }))
			await sendPopupMessageToOpenWindows({ method: 'popup_simulation_state_changed', data: { visualizedSimulatorState: state }  })
			handleUnexpectedError(error)
		}
	}).catch((error) => {
		if (throwOnUnexpectedError) throw error
	})
}

async function getCurrentSimulationStateInput(ethereum: EthereumClientService) {
	return {
		simulationStateInput: await getCurrentSimulationInput(),
		rpcNetwork: ethereum.getRpcEntry(),
		blockNumber: await ethereum.getBlockNumber(undefined),
	}
}
