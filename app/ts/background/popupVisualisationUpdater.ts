
import { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { TokenPriceService } from '../simulation/services/priceEstimator.js'
import { Simulator } from '../simulation/simulator.js'
import type { CompleteVisualizedSimulation } from '../types/visualizer-types.js'
import { NEW_BLOCK_ABORT, TIME_BETWEEN_BLOCKS } from '../utils/constants.js'
import { handleUnexpectedError, isFailedToFetchError, isNewBlockAbort } from '../utils/errors.js'
import { silenceChromeUnCaughtPromise } from '../utils/requests.js'
import { Semaphore } from '../utils/semaphore.js'
import { modifyObject } from '../utils/typescript.js'
import { getUpdatedSimulationState } from './background.js'
import { isMainUiOpen, publishPopupMessageToOpenUiPorts } from './backgroundUtils.js'
import { getPopupVisualisationFingerprint } from './popupSimulationFingerprint.js'
import { getAddressesbeingMadeRich, getCurrentSimulationInput, visualizeSimulatorState } from './simulationUpdating.js'
import { getPopupVisualisationState, setPopupVisualisationState } from './storageVariables.js'

let abortController = new AbortController()

function buildEmptyVisualizedState(
	simulationId: number,
	numberOfAddressesMadeRich: number,
	simulationResultState: 'done' | 'corrupted' = 'done',
): CompleteVisualizedSimulation {
	return {
		simulationUpdatingState: 'done',
		simulationResultState,
		simulationId,
		simulationState: undefined,
		addressBookEntries: [],
		tokenPriceEstimates: [],
		tokenPriceQuoteToken: undefined,
		namedTokenIds: [],
		visualizedSimulationState: { success: true, visualizedBlocks: [] },
		numberOfAddressesMadeRich,
	}
}

export const updatePopupVisualisationIfNeeded = async (simulator: Simulator, invalidateOldState: boolean = false, onlyIfNotAlreadyUpdating = false, skipIfUnchanged = false) => {
	try {
		const popupVisualisation = await getPopupVisualisationState()
		if (onlyIfNotAlreadyUpdating && updateSimulationVisualisationSemaphore.getPermits() === 0) return popupVisualisation
		if (onlyIfNotAlreadyUpdating && popupVisualisation.simulationState !== undefined) {
			const ageSeconds = (new Date().getTime() - popupVisualisation.simulationState.simulationConductedTimestamp.getTime()) / 1000
			if (ageSeconds < TIME_BETWEEN_BLOCKS) return popupVisualisation
		}
		if (!(await isMainUiOpen())) return popupVisualisation
		if (skipIfUnchanged && popupVisualisation.simulationState !== undefined) {
			const currentSimulationInput = await getCurrentSimulationStateInput(simulator)
			const currentFingerprint = getPopupVisualisationFingerprint(currentSimulationInput.simulationStateInput, currentSimulationInput.rpcNetwork, currentSimulationInput.blockNumber)
			const cachedFingerprint = getPopupVisualisationFingerprint(popupVisualisation.simulationState.simulationStateInput, popupVisualisation.simulationState.rpcNetwork, popupVisualisation.simulationState.blockNumber)
			if (currentFingerprint === cachedFingerprint) return popupVisualisation
		}
		abortController.abort(NEW_BLOCK_ABORT)
		abortController = new AbortController()
		const thisAbortController = abortController
		if (invalidateOldState) {
			const simulationId = popupVisualisation.simulationId + 1
			const visualizedSimulatorState = await setPopupVisualisationState(modifyObject(popupVisualisation, { simulationId, simulationResultState: 'invalid', simulationUpdatingState: 'updating' }))
			await publishPopupMessageToOpenUiPorts({ method: 'popup_simulation_state_changed', data: { visualizedSimulatorState } })
		}
		await updatePopupVisualisationState(simulator.ethereum, simulator.tokenPriceService, thisAbortController)
	} catch(error: unknown) {
		if (error instanceof Error && (isNewBlockAbort(error) || isFailedToFetchError(error))) return await getPopupVisualisationState()
		await handleUnexpectedError(error)
	}
	return await getPopupVisualisationState()
}

const updateSimulationVisualisationSemaphore = new Semaphore(1)
export async function updatePopupVisualisationState(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, abortController: AbortController | undefined) {
	return await updateSimulationVisualisationSemaphore.execute(async () => {
		if (abortController?.signal.aborted) return
		const popupVisualisation = await getPopupVisualisationState()
		const simulationId = popupVisualisation.simulationId + 1
		const simulationState = await getUpdatedSimulationState(ethereum)
		const doneState = { simulationUpdatingState: 'done' as const, simulationResultState: 'done' as const, simulationId }
		if (simulationState?.simulationStateInput === undefined || simulationState.simulationStateInput.filter((x) => x.transactions.length > 0).length === 0) {
			const newState = buildEmptyVisualizedState(simulationId, (await getAddressesbeingMadeRich()).length)
			await setPopupVisualisationState(newState)
			await publishPopupMessageToOpenUiPorts({ method: 'popup_simulation_state_changed', data: { visualizedSimulatorState: newState } })
			return
		}
		const visualizedSimulatorState = await setPopupVisualisationState(modifyObject(popupVisualisation, { simulationId, simulationUpdatingState: 'updating' }))
		const changedMessagePromise = silenceChromeUnCaughtPromise(publishPopupMessageToOpenUiPorts({ method: 'popup_simulation_state_changed', data: { visualizedSimulatorState } }))
		try {
			const numberOfAddressesMadeRich =  (await getAddressesbeingMadeRich()).length
			const getUpdatedState = async () => {
				if (simulationState !== undefined && ethereum.getChainId() === simulationState.rpcNetwork.chainId) {
					const refreshed = await visualizeSimulatorState(simulationState, ethereum, tokenPriceService, abortController)
					return await setPopupVisualisationState({ ...refreshed, ...doneState, numberOfAddressesMadeRich })
				}
				return await setPopupVisualisationState(buildEmptyVisualizedState(simulationId, numberOfAddressesMadeRich, 'corrupted'))
			}
			const newVisualizedState = await getUpdatedState()
			await changedMessagePromise
			await publishPopupMessageToOpenUiPorts({ method: 'popup_simulation_state_changed', data: { visualizedSimulatorState: newVisualizedState } })
		} catch (error) {
			if (error instanceof Error && isNewBlockAbort(error)) return
			if (error instanceof Error && isFailedToFetchError(error)) {
				const state = await setPopupVisualisationState(modifyObject(popupVisualisation, { simulationId, simulationUpdatingState: 'updating' }))
				await publishPopupMessageToOpenUiPorts({ method: 'popup_simulation_state_changed', data: { visualizedSimulatorState: state }  })
				return
			}
			const state = await setPopupVisualisationState(modifyObject(popupVisualisation, { simulationId, simulationUpdatingState: 'failed' }))
			await publishPopupMessageToOpenUiPorts({ method: 'popup_simulation_state_changed', data: { visualizedSimulatorState: state }  })
			handleUnexpectedError(error)
		}
	}).catch(() => {})
}

async function getCurrentSimulationStateInput(simulator: Simulator) {
	return {
		simulationStateInput: await getCurrentSimulationInput(),
		rpcNetwork: simulator.ethereum.getRpcEntry(),
		blockNumber: await simulator.ethereum.getBlockNumber(undefined),
	}
}
