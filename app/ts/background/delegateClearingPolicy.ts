import type { Settings } from '../types/interceptor-messages.js'
import type { StateOverrides } from '../types/ethSimulate-types.js'
import { hasDelegateClearingPreference, withDelegateCleared } from '../utils/delegateClearingState.js'

export function getWhatIfSimulationOverrides(settings: Settings): StateOverrides {
	const address = settings.simulationMode && hasDelegateClearingPreference(settings.delegateClearingPreferences, settings.activeSimulationAddress, settings.activeRpcNetwork.chainId)
		? settings.activeSimulationAddress : undefined
	return withDelegateCleared({}, address)
}
