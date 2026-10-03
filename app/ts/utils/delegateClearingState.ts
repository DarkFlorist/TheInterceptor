import type { StateOverrides } from '../types/ethSimulate-types.js'
import type { DelegateClearingPreferences } from '../types/delegationSimulation.js'
import type { SimulationStateInputBlock } from '../types/visualizer-types.js'
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

// Keep effective overrides and clearing intent together so RPC preparation can restore the override after a transformation.
export function carryDelegateClearing(source: Pick<SimulationStateInputBlock, 'delegateClearedAddress'>, stateOverrides: StateOverrides) {
	return {
		stateOverrides: withDelegateCleared(stateOverrides, source.delegateClearedAddress),
		delegateClearedAddress: source.delegateClearedAddress,
	}
}

export function isDelegateClearedForBlock(block: Pick<SimulationStateInputBlock, 'delegateClearedAddress'>, address: bigint) {
	return block.delegateClearedAddress === address
}
