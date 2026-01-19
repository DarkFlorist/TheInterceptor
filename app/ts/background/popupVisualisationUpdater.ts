
import { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { TokenPriceService } from '../simulation/services/priceEstimator.js'
import { Simulator } from '../simulation/simulator.js'
import { NEW_BLOCK_ABORT, TIME_BETWEEN_BLOCKS } from '../utils/constants.js'
import { handleUnexpectedError, isFailedToFetchError, isNewBlockAbort } from '../utils/errors.js'
import { silenceChromeUnCaughtPromise } from '../utils/requests.js'
import { Semaphore } from '../utils/semaphore.js'
import { modifyObject } from '../utils/typescript.js'
import { getUpdatedSimulationState } from './background.js'
import { sendPopupMessageWithReply, sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { getSettings } from './settings.js'
import { getAddressesbeingMadeRich, visualizeSimulatorState } from './simulationUpdating.js'
import { getPopupVisualisationState, setPopupVisualisationState } from './storageVariables.js'

let abortController = new AbortController()

export const updatePopupVisualisationIfNeeded = async (simulator: Simulator, invalidateOldState: boolean = false, onlyIfNotAlreadyUpdating = false) => {
	try {
		const popupVisualisation = await getPopupVisualisationState()
		if (onlyIfNotAlreadyUpdating && updateSimulationVisualisationSemaphore.getPermits() === 0) return popupVisualisation
		if (invalidateOldState) {
			const simulationId = popupVisualisation.simulationId + 1
			await setPopupVisualisationState(modifyObject(popupVisualisation, { simulationId, simulationResultState: 'invalid', simulationUpdatingState: 'updating' }))
		} else if (onlyIfNotAlreadyUpdating && popupVisualisation.simulationState !== undefined) {
			const lastUpdate = (popupVisualisation.simulationState.simulationConductedTimestamp.getTime() - new Date().getTime()) / 1000
			if (lastUpdate < TIME_BETWEEN_BLOCKS) return popupVisualisation
		}
		abortController.abort(NEW_BLOCK_ABORT)
		abortController = new AbortController()
		const thisAbortController = abortController
		if (!((await sendPopupMessageWithReply({ method: 'popup_isMainPopupWindowOpen' }))?.data.isOpen === true)) return await getPopupVisualisationState()
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
		await setPopupVisualisationState(modifyObject(popupVisualisation, { simulationId, simulationUpdatingState: 'updating' }))
		const simulationState = await getUpdatedSimulationState(ethereum)
		const changedMessagePromise = silenceChromeUnCaughtPromise(sendPopupMessageToOpenWindows({ method: 'popup_simulation_state_changed', data: { simulationId } }))
		const doneState = { simulationUpdatingState: 'done' as const, simulationResultState: 'done' as const, simulationId, activeAddress: (await getSettings()).activeSimulationAddress }
		try {
			const numberOfAddressesMadeRich =  (await getAddressesbeingMadeRich()).length
			if (simulationState !== undefined && ethereum.getChainId() === simulationState.rpcNetwork.chainId) {
				await setPopupVisualisationState({ ...await visualizeSimulatorState(simulationState, ethereum, tokenPriceService, abortController), ...doneState, numberOfAddressesMadeRich })
			} else {
				await setPopupVisualisationState({
					...doneState,
					addressBookEntries: [],
					tokenPriceEstimates: [],
					tokenPriceQuoteToken: undefined,
					namedTokenIds: [],
					simulationState: undefined,
					visualizedSimulationState: { success: true, visualizedBlocks: [] },
					numberOfAddressesMadeRich,
					simulationResultState: 'corrupted' as const
				})
			}
			await changedMessagePromise
			await sendPopupMessageToOpenWindows({ method: 'popup_simulation_state_changed', data: { simulationId } })
		} catch (error) {
			if (error instanceof Error && isNewBlockAbort(error)) return
			if (error instanceof Error && isFailedToFetchError(error)) {
				// if we fail because of connectivity issue, keep the old block results, but try again later
				await setPopupVisualisationState(modifyObject(popupVisualisation, { simulationId, simulationUpdatingState: 'updating' }))
				await sendPopupMessageToOpenWindows({ method: 'popup_simulation_state_changed', data: { simulationId }  })
				return
			}
			handleUnexpectedError(error)
		}
	}).catch(() => {})
}
