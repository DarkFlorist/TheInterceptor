import type { NewBlockAttemptCallback, SimulationServices } from '../simulation/serviceLifecycle.js'
import { sendSubscriptionMessagesForNewBlock } from '../simulation/services/EthereumSubscriptionService.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { isExpectedInfrastructureError, reportUnexpectedError } from '../utils/errors.js'
import { silenceChromeUnCaughtPromise } from '../utils/requests.js'
import { readNetworkSnapshotForServices } from './networkTransitionLock.js'
import { updatePopupVisualisationIfNeeded } from './popupVisualisationUpdater.js'
import type { PublishRpcConnectionStatus } from './rpcSlowRequestTracking.js'
import { getUpdatedSimulationState, requireSimulationSnapshot } from './simulationUpdating.js'
import { snapshotNetworkIsActive } from './networkChangeGeneration.js'
import { PASSTHROUGH_STATE } from '../types/visualizer-types.js'

type NewBlockHandlerDependencies = {
	readonly getSimulationServices: () => SimulationServices
	readonly publishRpcConnectionStatus: PublishRpcConnectionStatus
	readonly websiteTabConnections: WebsiteTabConnections
}

// Read the callback client and generation under the transition lock, so a callback starting between retirement and installation cannot adopt the replacement network's generation.
export const createNewBlockAttemptCallback = ({ getSimulationServices, publishRpcConnectionStatus, websiteTabConnections }: NewBlockHandlerDependencies): NewBlockAttemptCallback => async (blockheader, ethereumClientService, isNewBlock) => {
	const callbackServices = getSimulationServices()
	if (ethereumClientService !== callbackServices.ethereum) return
	if (blockheader === null) throw new Error('The latest block is null')
	try {
		const callbackNetwork = await readNetworkSnapshotForServices(callbackServices)
		if (callbackNetwork.simulation.kind === 'replaced') return
		const networkIsCurrent = () => ethereumClientService === getSimulationServices().ethereum && snapshotNetworkIsActive(callbackNetwork.simulation)
		if (!networkIsCurrent()) return
		const rpcConnectionStatus = {
			isConnected: true,
			lastConnnectionAttempt: new Date(),
			latestBlock: blockheader,
			rpcNetwork: ethereumClientService.getRpcEntry(),
			retrying: ethereumClientService.isBlockPolling(),
		}
		await publishRpcConnectionStatus('popup_new_block_arrived', rpcConnectionStatus)
		if (isNewBlock && networkIsCurrent()) {
			// Replaced services have no stack to simulate. A read can only say so after a change committed since this callback started, so networkIsCurrent already keeps the result from being published.
			const simulateCurrentStack = async () => {
				const { simulation } = await readNetworkSnapshotForServices(callbackServices)
				return simulation.kind === 'replaced' ? PASSTHROUGH_STATE : await getUpdatedSimulationState(requireSimulationSnapshot(simulation))
			}
			const settings = callbackNetwork.settings
			if (settings.simulationMode) {
				const { ethereum, tokenPriceService } = callbackServices
				const updatePopupVisualisationPromise = updatePopupVisualisationIfNeeded(ethereum, tokenPriceService)
				silenceChromeUnCaughtPromise(updatePopupVisualisationPromise)
				return await sendSubscriptionMessagesForNewBlock(blockheader.number, ethereumClientService, settings.simulationMode, websiteTabConnections, simulateCurrentStack, networkIsCurrent)
			}
			return await sendSubscriptionMessagesForNewBlock(blockheader.number, ethereumClientService, settings.simulationMode, websiteTabConnections, simulateCurrentStack, networkIsCurrent)
		}
	} catch(error) {
		if (isExpectedInfrastructureError(error)) return
		await reportUnexpectedError(error)
	}
}
