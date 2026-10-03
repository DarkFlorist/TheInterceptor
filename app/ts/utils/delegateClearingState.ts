import type { StateOverrides } from '../types/ethSimulate-types.js'
import type { SimulationStateInputBlock } from '../types/visualizer-types.js'
import { addressString } from './bigint.js'

export function withDelegateCleared(stateOverrides: StateOverrides, address: bigint | undefined): StateOverrides {
	if (address === undefined) return stateOverrides
	const key = addressString(address)
	return { ...stateOverrides, [key]: { ...stateOverrides[key], code: new Uint8Array() } }
}

export function createDelegateClearingBlockState(stateOverrides: StateOverrides, address: bigint | undefined) {
	return { stateOverrides, ...address === undefined ? {} : { delegateClearedAddress: address } }
}

export function getEffectiveStateOverrides(block: Pick<SimulationStateInputBlock, 'stateOverrides' | 'delegateClearedAddress'>): StateOverrides {
	return withDelegateCleared(block.stateOverrides, block.delegateClearedAddress)
}

export function isDelegateClearedForBlock(block: Pick<SimulationStateInputBlock, 'delegateClearedAddress'>, address: bigint) {
	return block.delegateClearedAddress === address
}
