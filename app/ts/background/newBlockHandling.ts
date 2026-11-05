import type { NewBlockAttemptCallback, SimulationServices } from '../simulation/serviceLifecycle.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { sendSubscriptionMessagesForNewBlock } from '../simulation/services/EthereumSubscriptionService.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { isExpectedInfrastructureError, reportUnexpectedError } from '../utils/errors.js'
import { silenceChromeUnCaughtPromise } from '../utils/requests.js'
import { readNetworkState } from './networkTransitionLock.js'
import { updatePopupVisualisationIfNeeded } from './popupVisualisationUpdater.js'
import type { PublishRpcConnectionStatus } from './rpcSlowRequestTracking.js'
import { getSettings } from './settings.js'
import { getUpdatedSimulationState } from './simulationUpdating.js'

type NewBlockHandlerDependencies = {
	readonly getSimulationServices: () => SimulationServices
	readonly publishRpcConnectionStatus: PublishRpcConnectionStatus
	readonly websiteTabConnections: WebsiteTabConnections
}

// A network change can commit while this callback is suspended, so the client it was called with may no longer be installed when it reads the stack. The stack is then another network's: getUpdatedSimulationState refuses to run it on this client, and sendSubscriptionMessagesForNewBlock stops publishing once the client is retired. The installed client's next block carries on.
export const createNewBlockAttemptCallback = ({ getSimulationServices, publishRpcConnectionStatus, websiteTabConnections }: NewBlockHandlerDependencies): NewBlockAttemptCallback => async (blockheader, ethereumClientService, isNewBlock) => {
	if (ethereumClientService !== getSimulationServices().ethereum) return
	if (blockheader === null) throw new Error('The latest block is null')
	try {
		const rpcConnectionStatus = {
			isConnected: true,
			lastConnnectionAttempt: new Date(),
			latestBlock: blockheader,
			rpcNetwork: ethereumClientService.getRpcEntry(),
			retrying: ethereumClientService.isBlockPolling(),
		}
		await publishRpcConnectionStatus('popup_new_block_arrived', rpcConnectionStatus)
		if (isNewBlock) {
			const simulateCurrentStack = async (ethereum: EthereumClientService) => await getUpdatedSimulationState(ethereum, (await readNetworkState()).simulation)
			const settings = await getSettings()
			if (settings.simulationMode) {
				const { ethereum, tokenPriceService } = getSimulationServices()
				const updatePopupVisualisationPromise = updatePopupVisualisationIfNeeded(ethereum, tokenPriceService)
				silenceChromeUnCaughtPromise(updatePopupVisualisationPromise)
				return await sendSubscriptionMessagesForNewBlock(blockheader.number, ethereumClientService, settings.simulationMode, websiteTabConnections, simulateCurrentStack)
			}
			return await sendSubscriptionMessagesForNewBlock(blockheader.number, ethereumClientService, settings.simulationMode, websiteTabConnections, simulateCurrentStack)
		}
	} catch(error) {
		if (isExpectedInfrastructureError(error)) return
		await reportUnexpectedError(error)
	}
}
