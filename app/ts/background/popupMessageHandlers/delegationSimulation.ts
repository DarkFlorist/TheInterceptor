import type { EthereumClientService } from '../../simulation/services/EthereumClientService.js'
import type { SimulationServices } from '../../simulation/serviceLifecycle.js'
import type { Settings } from '../../types/interceptor-messages.js'
import { getCachedDelegationHint } from '../delegationHintCache.js'
import { isExpectedInfrastructureError, reportLocalRecovery } from '../../utils/errors.js'
import { sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { bumpPopupRefreshGeneration } from '../popupRefreshGeneration.js'
import { queuePopupSimulationRefresh } from '../popupSimulationRefreshQueue.js'
import { getSettings, setDelegateClearingEnabled } from '../settings.js'

export async function requestDelegationSimulation(settings: Settings, ethereum: EthereumClientService, address: bigint, chainId: bigint) {
	const network = settings.activeRpcNetwork
	const providerNetwork = ethereum.getRpcEntry()
	if (!settings.simulationMode || settings.activeSimulationAddress !== address || network.chainId !== chainId
		|| network.httpsRpc === undefined || providerNetwork.chainId !== chainId || providerNetwork.httpsRpc !== network.httpsRpc) {
		return { method: 'popup_requestDelegationSimulation' as const, data: { address, chainId, status: { type: 'unknown' as const } } }
	}
	try {
		const delegate = await getCachedDelegationHint(ethereum, address)
		return { method: 'popup_requestDelegationSimulation' as const, data: { address, chainId, status: delegate === undefined ? { type: 'none' as const } : { type: 'delegated' as const, delegate } } }
	} catch (error) {
		if (!isExpectedInfrastructureError(error)) await reportLocalRecovery(error, { code: 'active_delegation_lookup_failed' })
		return { method: 'popup_requestDelegationSimulation' as const, data: { address, chainId, status: { type: 'unknown' as const } } }
	}
}

export async function setDelegationSimulation(settings: Settings, services: SimulationServices, address: bigint, chainId: bigint, enabled: boolean) {
	const network = settings.activeRpcNetwork
	const affectsActiveSimulation = settings.simulationMode && settings.activeSimulationAddress === address && network.chainId === chainId
	if (enabled && !affectsActiveSimulation) {
		return { method: 'popup_setDelegationSimulation' as const, data: { ok: false as const, message: 'The active simulation account or network changed. Please try again.' } }
	}
	// The popup hint gates the option; saving the choice needs no RPC lookup.
	const changed = await setDelegateClearingEnabled(address, chainId, enabled)
	if (changed) {
		await sendPopupMessageToOpenWindows({ method: 'popup_settingsUpdated', data: await getSettings(), popupRefreshGeneration: bumpPopupRefreshGeneration() })
		if (affectsActiveSimulation) await queuePopupSimulationRefresh({ ...services, invalidateOldState: true })
	}
	return { method: 'popup_setDelegationSimulation' as const, data: { ok: true as const, address, chainId, enabled } }
}
