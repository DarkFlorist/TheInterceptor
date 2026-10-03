import type { StateOverrides } from '../types/ethSimulate-types.js'
import type { DelegateClearingPreferences } from '../types/delegationSimulation.js'
import type { SimulationStateInput, SimulationStateInputBlock, SimulationStateInputMinimalData } from '../types/visualizer-types.js'
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

// Carry the clearing choice when creating a derived simulation block.
export function carryDelegateClearing(source: Pick<SimulationStateInputBlock, 'delegateClearedAddress'>, stateOverrides: StateOverrides) {
	return {
		stateOverrides,
		delegateClearedAddress: source.delegateClearedAddress,
	}
}

export function isDelegateClearedForBlock(block: Pick<SimulationStateInputBlock, 'delegateClearedAddress'>, address: bigint) {
	return block.delegateClearedAddress === address
}

export function isDelegateClearingOnlyInput(input: SimulationStateInput | SimulationStateInputMinimalData): boolean {
	const block = input[0]
	return input.length === 1 && block?.delegateClearedAddress !== undefined && block.transactions.length === 0 && block.signedMessages.length === 0 && Object.keys(block.stateOverrides).length === 0
}
