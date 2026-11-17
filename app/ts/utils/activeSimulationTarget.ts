import type { Settings } from '../types/interceptor-messages.js'

// One identity for simulation-only preferences, hints, and applied what-if state.
export function getActiveSimulationTarget(settings: Pick<Settings, 'simulationMode' | 'activeSimulationAddress' | 'activeRpcNetwork'>) {
	return settings.simulationMode && settings.activeSimulationAddress !== undefined
		? { address: settings.activeSimulationAddress, chainId: settings.activeRpcNetwork.chainId }
		: undefined
}

export function isActiveSimulationTarget(settings: Pick<Settings, 'simulationMode' | 'activeSimulationAddress' | 'activeRpcNetwork'>, address: bigint, chainId: bigint) {
	const target = getActiveSimulationTarget(settings)
	return target !== undefined && target.address === address && target.chainId === chainId
}
