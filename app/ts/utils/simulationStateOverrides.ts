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

/** Initial overrides describe state before the first simulated block. Later blocks inherit its result. */
export function getEffectiveStateOverrides(blockOverrides: StateOverrides, initialOverrides: StateOverrides, precedingSimulatedBlockCount: number): StateOverrides {
	return precedingSimulatedBlockCount === 0 ? mergeStateOverrides(blockOverrides, initialOverrides) : blockOverrides
}
