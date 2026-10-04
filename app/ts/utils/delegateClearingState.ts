import type { StateOverrides } from '../types/ethSimulate-types.js'
import type { DelegateClearingPreferences } from '../types/delegateClearing.js'
import { addressString } from './bigint.js'

export function hasDelegateClearingPreference(preferences: DelegateClearingPreferences | undefined, address: bigint | undefined, chainId: bigint | undefined): boolean {
	if (address === undefined || chainId === undefined) return false
	return preferences?.some((entry) => entry.address === address && entry.chainId === chainId) ?? false
}

export function withDelegateCleared(stateOverrides: StateOverrides, address: bigint | undefined): StateOverrides {
	if (address === undefined) return stateOverrides
	const key = addressString(address)
	return { ...stateOverrides, [key]: { ...stateOverrides[key], code: new Uint8Array() } }
}

export function isCodeClearedBySimulationOverrides(simulationOverrides: StateOverrides, address: bigint) {
	return simulationOverrides[addressString(address)]?.code?.length === 0
}
