import type { NewBlockAttemptCallback, SimulationServices } from '../simulation/serviceLifecycle.js'
import { sendSubscriptionMessagesForNewBlock } from '../simulation/services/EthereumSubscriptionService.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { isExpectedInfrastructureError, reportUnexpectedError } from '../utils/errors.js'
import { silenceChromeUnCaughtPromise } from '../utils/requests.js'
import { readNetworkSnapshotForServices } from './networkTransitionLock.js'
import { updatePopupVisualisationIfNeeded } from './popupVisualisationUpdater.js'
import type { PublishRpcConnectionStatus } from './rpcSlowRequestTracking.js'
import { getSettings } from './settings.js'
import { getUpdatedSimulationState, requireSimulationSnapshot } from './simulationUpdating.js'

type NewBlockHandlerDependencies = {
	readonly getSimulationServices: () => SimulationServices
	readonly publishRpcConnectionStatus: PublishRpcConnectionStatus
	readonly websiteTabConnections: WebsiteTabConnections
}

// A network change can commit while this callback is suspended, so the client it was called with may no longer be installed when it reads the stack. The read then says these services were replaced, so no stack is simulated, and sendSubscriptionMessagesForNewBlock stops publishing once the client is retired. The installed client's next block carries on.
export const createNewBlockAttemptCallback = ({ getSimulationServices, publishRpcConnectionStatus, websiteTabConnections }: NewBlockHandlerDependencies): NewBlockAttemptCallback => async (blockheader, ethereumClientService, isNewBlock) => {
	const callbackServices = getSimulationServices()
	if (ethereumClientService !== callbackServices.ethereum) return
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
			// Replaced services have no stack to simulate, so their subscribers get no simulated blocks.
			const simulateCurrentStack = async () => {
				const { simulation } = await readNetworkSnapshotForServices(callbackServices)
				return simulation.kind === 'replaced' ? undefined : await getUpdatedSimulationState(requireSimulationSnapshot(simulation))
			}
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
