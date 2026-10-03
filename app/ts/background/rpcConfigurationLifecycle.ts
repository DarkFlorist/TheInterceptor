import type { SimulationServicesOwner } from '../simulation/serviceLifecycle.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { InterceptedRequest } from '../utils/requests.js'
import { replyToInterceptedRequest } from './messageSending.js'
import type { RpcConfigurationState } from './storageVariables.js'
import { getRpcConfigurationState, setRpcConfiguration, setRpcList } from './storageVariables.js'
import type { RpcEntry, RpcNetwork } from '../types/rpc.js'
import { RPC_CONFIGURATION_UNAVAILABLE_ERROR } from '../types/interceptor-reply-messages.js'

export function rpcConfigurationIsReady(rpcConfiguration: RpcConfigurationState): rpcConfiguration is Extract<RpcConfigurationState, { status: 'ready' }> {
	return rpcConfiguration.status === 'ready'
}

export function resolveRpcServicesTarget(configuration: RpcConfigurationState): RpcEntry | undefined {
	if (!rpcConfigurationIsReady(configuration)) return undefined
	if (configuration.activeRpcNetwork.httpsRpc !== undefined) return configuration.activeRpcNetwork
	return configuration.rpcEntries.find((rpc) => rpc.chainId === configuration.activeRpcNetwork.chainId && rpc.primary)
		?? configuration.rpcEntries.find((rpc) => rpc.primary)
		?? configuration.rpcEntries[0]
}

export function rpcServicesAreOptional(rpcConfiguration: RpcConfigurationState) {
	return rpcConfigurationIsReady(rpcConfiguration) && rpcConfiguration.activeRpcNetwork.httpsRpc === undefined
}

export function rpcServicesAreAvailable(rpcConfiguration: RpcConfigurationState, simulationServicesOwner: SimulationServicesOwner) {
	return rpcConfigurationIsReady(rpcConfiguration) && simulationServicesOwner.isAvailable()
}

export function rpcConfigurationIsUsable(rpcConfiguration: RpcConfigurationState, simulationServicesOwner: SimulationServicesOwner) {
	return rpcServicesAreOptional(rpcConfiguration) || rpcServicesAreAvailable(rpcConfiguration, simulationServicesOwner)
}

export function replyIfRpcConfigurationIsUnavailable(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, request: InterceptedRequest | undefined, rpcConfiguration: RpcConfigurationState) {
	if (request === undefined || rpcConfigurationIsUsable(rpcConfiguration, simulationServicesOwner)) return false
	replyToInterceptedRequest(websiteTabConnections, {
		type: 'result',
		...request,
		error: RPC_CONFIGURATION_UNAVAILABLE_ERROR,
	})
	return true
}

type RpcListTransitionMode = 'edit' | 'restore-defaults'

export type RpcListTransitionResult = {
	readonly activeRpcNetwork: RpcNetwork
	readonly rpcConfigurationAvailable: boolean
	readonly publishRecovery: boolean
	readonly forceChainChanged: boolean
}

function selectRestoredActiveNetwork(previousConfiguration: RpcConfigurationState, rpcEntries: readonly RpcEntry[]) {
	if ('activeRpcNetwork' in previousConfiguration && previousConfiguration.activeRpcNetwork !== undefined) return previousConfiguration.activeRpcNetwork
	return rpcEntries.find((rpc) => rpc.primary) ?? rpcEntries[0]
}

// This single RPC-list transition boundary owns persistence and service recovery; callers only validate input and publish its result.
export async function transitionRpcList(
	simulationServicesOwner: SimulationServicesOwner,
	rpcEntries: readonly RpcEntry[],
	mode: RpcListTransitionMode,
): Promise<RpcListTransitionResult> {
	const previousConfiguration = await getRpcConfigurationState()
	if (mode === 'restore-defaults') {
		const activeRpcNetwork = selectRestoredActiveNetwork(previousConfiguration, rpcEntries)
		if (activeRpcNetwork === undefined) throw new Error('Bundled RPC configuration is empty.')
		if (previousConfiguration.status === 'ready') {
			await setRpcList(rpcEntries)
			const shouldRecoverServices = activeRpcNetwork.httpsRpc !== undefined && !simulationServicesOwner.isAvailable()
			if (shouldRecoverServices) simulationServicesOwner.recover(activeRpcNetwork)
			return { activeRpcNetwork, rpcConfigurationAvailable: true, publishRecovery: shouldRecoverServices, forceChainChanged: false }
		}
		await setRpcConfiguration(rpcEntries, activeRpcNetwork)
		if (activeRpcNetwork.httpsRpc === undefined) simulationServicesOwner.clear()
		else simulationServicesOwner.recover(activeRpcNetwork)
		const previousActiveRpcNetwork = 'activeRpcNetwork' in previousConfiguration ? previousConfiguration.activeRpcNetwork : undefined
		return {
			activeRpcNetwork,
			rpcConfigurationAvailable: true,
			publishRecovery: previousConfiguration.status === 'unavailable',
			forceChainChanged: previousActiveRpcNetwork === undefined,
		}
	}

	if (previousConfiguration.status === 'unavailable') {
		simulationServicesOwner.clear()
		const activeRpcNetwork = rpcEntries.find((rpc) => rpc.primary) ?? rpcEntries[0]
		if (previousConfiguration.reason !== 'empty' || activeRpcNetwork === undefined) throw new Error('RPC configuration is unavailable. Restore it before editing RPC connections.')
		await setRpcConfiguration(rpcEntries, activeRpcNetwork)
		simulationServicesOwner.recover(activeRpcNetwork)
		return { activeRpcNetwork, rpcConfigurationAvailable: true, publishRecovery: true, forceChainChanged: false }
	}

	const activeRpcNetwork = previousConfiguration.activeRpcNetwork
	if (activeRpcNetwork.httpsRpc === undefined && !simulationServicesOwner.isAvailable()) {
		await setRpcList(rpcEntries)
		return { activeRpcNetwork, rpcConfigurationAvailable: true, publishRecovery: false, forceChainChanged: false }
	}
	if (!simulationServicesOwner.isAvailable()) throw new Error('RPC configuration is unavailable. Restore it before editing RPC connections.')
	await setRpcList(rpcEntries)
	if (rpcEntries.length === 0) {
		simulationServicesOwner.clear()
		return { activeRpcNetwork, rpcConfigurationAvailable: activeRpcNetwork.httpsRpc === undefined, publishRecovery: false, forceChainChanged: false }
	}
	if (!simulationServicesOwner.isAvailable()) throw new Error('RPC configuration became unavailable while saving RPC connections.')
	const primary = rpcEntries.find((rpc) => rpc.chainId === activeRpcNetwork.chainId && rpc.primary)
	if (primary !== undefined) simulationServicesOwner.reset(primary)
	return { activeRpcNetwork, rpcConfigurationAvailable: true, publishRecovery: false, forceChainChanged: false }
}
