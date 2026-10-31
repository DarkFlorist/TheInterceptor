import type { Settings } from '../types/interceptor-messages.js'
import type { StateOverrides } from '../types/ethSimulate-types.js'
import { hasDelegateClearingPreference, withDelegateCleared } from '../utils/delegateClearingState.js'

// 'what-if' previews the simulated stack, where nothing is signed; 'signing-or-execution' previews something that will be signed or executed on-chain.
export type SimulationPreviewPurpose = 'what-if' | 'signing-or-execution'

// The single boundary for the opt-in delegate-clearing state: it never reaches a signing-or-execution preview and applies only in simulation mode.
export function getSimulationOverridesForPurpose(purpose: SimulationPreviewPurpose, settings: Settings): StateOverrides {
	if (purpose === 'signing-or-execution' || !settings.simulationMode) return {}
	const address = hasDelegateClearingPreference(settings.delegateClearingPreferences, settings.activeSimulationAddress, settings.activeRpcNetwork.chainId)
		? settings.activeSimulationAddress : undefined
	return withDelegateCleared({}, address)
}
