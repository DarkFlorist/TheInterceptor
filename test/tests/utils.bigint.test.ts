import { bigintToRoundedPrettyDecimalString, calculateWeightedPercentile } from '../../app/ts/utils/bigint.js'
import { describe, test } from 'bun:test'
import * as assert from 'assert'

describe('utils.bigint', () => {
	test('display 1 ETH', () => assert.equal(bigintToRoundedPrettyDecimalString(10n ** 18n, 18n, 4), '1'))
	test('display 0.2 ETH', () => assert.equal(bigintToRoundedPrettyDecimalString(2n * 10n ** 17n, 18n, 4), '0.2'))
	test('display 0.00000001 ETH', () => assert.equal(bigintToRoundedPrettyDecimalString(10n ** 10n, 18n, 4), '0.00000001'))
	test('display 10k ETH', () => assert.equal(bigintToRoundedPrettyDecimalString(10n ** 22n, 18n, 4), '10k'))
	test('display 100M ETH', () => assert.equal(bigintToRoundedPrettyDecimalString(10n ** 26n, 18n, 4), '100M'))
	test('display 10G ETH', () => assert.equal(bigintToRoundedPrettyDecimalString(10n ** 28n, 18n, 4), '10G'))
	test('display 2345.67 ETH', () => assert.equal(bigintToRoundedPrettyDecimalString(234567n * 10n ** 16n, 18n, 4), '2345.67'))
	test('display -2345.67 ETH', () => assert.equal(bigintToRoundedPrettyDecimalString(-234567n * 10n ** 16n, 18n, 4), '-2345.67'))
	test('display -0.2346 ETH', () => assert.equal(bigintToRoundedPrettyDecimalString(-234567n * 10n ** 12n, 18n, 4), '-0.2346'))
	test('display -10k ETH', () => assert.equal(bigintToRoundedPrettyDecimalString(-(10n ** 22n), 18n, 4), '-10k'))
	test('calculates the highest weighted percentile without indexing past the data', () => {
		assert.equal(calculateWeightedPercentile([{ dataPoint: 10n, weight: 1n }], 100), 10n)
		assert.equal(calculateWeightedPercentile([
			{ dataPoint: 10n, weight: 1n },
			{ dataPoint: 20n, weight: 3n },
		], 25), 10n)
		assert.equal(calculateWeightedPercentile([
			{ dataPoint: 10n, weight: 1n },
			{ dataPoint: 20n, weight: 3n },
		], 26), 20n)
	})

	test('calculates fractional weighted percentiles without rounding them to integers', () => {
		const data = [
			{ dataPoint: 10n, weight: 1n },
			{ dataPoint: 20n, weight: 199n },
		] as const
		assert.equal(calculateWeightedPercentile(data, 0.5), 10n)
		assert.equal(calculateWeightedPercentile(data, 0.5000000000000001), 20n)
	})
})
