import type { SimulationExecutionInput } from '../types/visualizer-types.js'
import type { StateOverrides } from '../types/ethSimulate-types.js'

/** Merge account fields, letting the second set win when both specify the same field. */
export function mergeStateOverrides(baseOverrides: StateOverrides, overridingOverrides: StateOverrides): StateOverrides {
	if (Object.keys(overridingOverrides).length === 0) return baseOverrides
	const merged: Record<string, StateOverrides[string]> = { ...baseOverrides }
	for (const [address, accountOverride] of Object.entries(overridingOverrides)) {
		merged[address] = { ...merged[address], ...accountOverride }
	}
	return merged
}

// SimulatedExecutionInput.simulationOverrides is the canonical initial account state; every block-level view of it must be derived through the two helpers below.
const getStateOverridesForBlockAt = (blockIndex: number, blockOverrides: StateOverrides, initialOverrides: StateOverrides): StateOverrides => {
	// Initial overrides describe state before the first simulated block, so only that block applies them and later blocks inherit its result.
	return blockIndex === 0 ? mergeStateOverrides(blockOverrides, initialOverrides) : blockOverrides
}

/** Effective overrides for a block that runs after `precedingBlockCount` blocks of the same eth_simulateV1 request; it is that block's index, so only a count of 0 applies the initial overrides. */
export function getAppendedBlockStateOverrides(precedingBlockCount: number, blockOverrides: StateOverrides, initialOverrides: StateOverrides): StateOverrides {
	return getStateOverridesForBlockAt(precedingBlockCount, blockOverrides, initialOverrides)
}

/** Maps every block of a simulated block sequence together with its effective overrides. */
export function mapBlocksWithEffectiveStateOverrides<TBlock, TResult>(
	blocks: readonly TBlock[],
	initialOverrides: StateOverrides,
	getBlockOverrides: (block: TBlock) => StateOverrides,
	mapBlock: (block: TBlock, effectiveStateOverrides: StateOverrides, blockIndex: number) => TResult,
): TResult[] {
	return blocks.map((block, blockIndex) => mapBlock(block, getStateOverridesForBlockAt(blockIndex, getBlockOverrides(block), initialOverrides), blockIndex))
}


// Uniform derived account-state views, including a stack with no executed blocks. Nothing stores a second copy of the initial state.
export function getEffectiveSimulationOverrides(input: SimulationExecutionInput): readonly StateOverrides[] {
	return input.value.length === 0 ? [input.simulationOverrides] : input.value.map((block, index) => getStateOverridesForBlockAt(index, block.stateOverrides, input.simulationOverrides))
}

export function getEffectiveSimulationBlockOverrides(input: SimulationExecutionInput, index: number): StateOverrides {
	return getStateOverridesForBlockAt(index, input.value[index]?.stateOverrides ?? {}, input.simulationOverrides)
}
