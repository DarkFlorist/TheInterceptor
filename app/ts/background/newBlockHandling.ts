import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
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

// Read client identity and generation together after any transition finishes; polling a retained fallback client on a signer-only network must not publish active-network events.
export async function readCurrentPollingNetwork(getSimulationServices: () => SimulationServices, ethereumClientService: EthereumClientService) {
	const services = getSimulationServices()
	if (ethereumClientService !== services.ethereum) return undefined
	const network = await readNetworkSnapshotForServices(services)
	const isCurrent = () => ethereumClientService === getSimulationServices().ethereum && snapshotNetworkIsActive(network.simulation)
	if (network.simulation.kind === 'replaced' || network.settings.activeRpcNetwork.httpsRpc === undefined || !isCurrent()) return undefined
	return { network, isCurrent }
}

export const createNewBlockAttemptCallback = ({ getSimulationServices, publishRpcConnectionStatus, websiteTabConnections }: NewBlockHandlerDependencies): NewBlockAttemptCallback => async (blockheader, ethereumClientService, isNewBlock) => {
	if (ethereumClientService !== getSimulationServices().ethereum) return
	if (blockheader === null) throw new Error('The latest block is null')
	try {
		const current = await readCurrentPollingNetwork(getSimulationServices, ethereumClientService)
		if (current === undefined) return
		const { network: callbackNetwork, isCurrent: networkIsCurrent } = current
		const callbackServices = callbackNetwork.services
		const rpcConnectionStatus = {
			isConnected: true,
			lastConnnectionAttempt: new Date(),
			latestBlock: blockheader,
			rpcNetwork: ethereumClientService.getRpcEntry(),
			retrying: ethereumClientService.isBlockPolling(),
		}
		await publishRpcConnectionStatus('popup_new_block_arrived', rpcConnectionStatus, networkIsCurrent)
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
