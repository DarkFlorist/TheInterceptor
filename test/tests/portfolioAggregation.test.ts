import * as assert from 'node:assert/strict'
import { test } from 'bun:test'
import { aggregatePortfolioGroup, applyPortfolioValueDelta, portfolioQuantityAmount, portfolioQuantityValue, portfolioValueDelta } from '../../app/inpage/ts/portfolioAggregation.js'

test('portfolio group aggregation rescales exact base units and excludes hidden quantities and values', () => {
	const total = aggregatePortfolioGroup([
		{ raw: 2_000_001n, decimals: 6, valueUsd: 4, isHidden: false },
		{ raw: 500_000_000_000_000_001n, decimals: 18, valueUsd: 1, isHidden: false },
		{ raw: 10n ** 255n, decimals: 255, valueUsd: 100, isHidden: true },
	])
	assert.deepEqual(total, { quantity: { raw: 2_500_001_000_000_000_001n, decimals: 18 }, valueUsd: 5 })
	assert.equal(portfolioQuantityAmount(total.quantity), 2.500001)
})

test('empty and fully hidden portfolio groups have zero base-unit and USD totals', () => {
	for (const rows of [[], [{ raw: 5n, decimals: 6, valueUsd: 10, isHidden: true }]]) {
		assert.deepEqual(aggregatePortfolioGroup(rows), { quantity: { raw: 0n, decimals: 0 }, valueUsd: 0 })
	}
})

test('portfolio value deltas include only visible selected-chain contributions and added holdings', () => {
	const unchanged = [
		{ chainId: 137, isHidden: false, valueUsd: 2000 },
		{ chainId: 1, isHidden: true, valueUsd: 1000 },
	]
	const previous = [...unchanged, { chainId: 1, isHidden: false, valueUsd: 2000 }]
	const updated = [...unchanged, { chainId: 1, isHidden: false, valueUsd: 4000 }, { chainId: 1, isHidden: false, valueUsd: 1000 }, { chainId: 1, isHidden: false, valueUsd: undefined }]
	const delta = portfolioValueDelta(1, previous, updated)
	assert.equal(delta, 3000)
	assert.equal(applyPortfolioValueDelta(4100, delta), 7100)
	assert.equal(applyPortfolioValueDelta(10, -20), 0)
})

test('portfolio valuations distinguish missing quotes from zero and reject overflowing USD values', () => {
	const fractional = { raw: 500_000n, decimals: 6 }
	assert.equal(portfolioQuantityValue(fractional, 2000), 1000)
	assert.equal(portfolioQuantityValue(fractional, undefined), undefined)
	assert.equal(portfolioQuantityValue(fractional, 0), 0)
	assert.equal(portfolioQuantityAmount({ raw: 7n, decimals: 0 }), 7)
	assert.throws(() => portfolioQuantityValue({ raw: 2n ** 256n - 1n, decimals: 0 }, Number.MAX_VALUE), /exceeds the indexed API number range/)
})
