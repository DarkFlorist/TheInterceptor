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

export function preserveClearedCodeOverrides(source: StateOverrides, target: StateOverrides): StateOverrides {
	let result = target
	for (const [address, override] of Object.entries(source)) {
		if (override?.code?.length !== 0) continue
		result = { ...result, [address]: { ...result[address], code: new Uint8Array() } }
	}
	return result
}

export function isDelegateClearedForBlock(block: Pick<SimulationStateInputBlock, 'stateOverrides'>, address: bigint) {
	return block.stateOverrides[addressString(address)]?.code?.length === 0
}
