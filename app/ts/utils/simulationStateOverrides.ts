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

// SimulatedInput.simulationOverrides is the canonical initial account state; every block-level view of it must be derived through the two helpers below.
const getStateOverridesForBlockAt = (blockIndex: number, blockOverrides: StateOverrides, initialOverrides: StateOverrides): StateOverrides => {
	// Initial overrides describe state before the first simulated block, so only that block applies them and later blocks inherit its result.
	return blockIndex === 0 ? mergeStateOverrides(blockOverrides, initialOverrides) : blockOverrides
}

/** Effective overrides for a block that runs right after `precedingBlocks` in the same simulated block sequence. */
export function getAppendedBlockStateOverrides(precedingBlocks: readonly unknown[], blockOverrides: StateOverrides, initialOverrides: StateOverrides): StateOverrides {
	return getStateOverridesForBlockAt(precedingBlocks.length, blockOverrides, initialOverrides)
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
