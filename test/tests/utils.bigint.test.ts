import { bigintToRoundedPrettyDecimalString, bigintToUint8Array, calculateWeightedPercentile, stringToUint8Array } from '../../app/ts/utils/bigint.js'
import { describe, test } from 'bun:test'
import * as assert from 'assert'

// Copy of the per-byte BigInt shift conversion the linear decoder replaced, kept as the reference for equivalence.
function quadraticBigintToUint8Array(value: bigint, numberOfBytes: number) {
	if (value >= 2n ** BigInt(numberOfBytes * 8) || value < 0n) throw new Error(`Cannot fit ${ value } into a ${ numberOfBytes }-byte unsigned integer.`)
	const result = new Uint8Array(numberOfBytes)
	for (let i = 0; i < result.length; ++i) {
		result[i] = Number((value >> BigInt(numberOfBytes - i - 1) * 8n) & 0xffn)
	}
	return result
}

function quadraticStringToUint8Array(data: string) {
	const dataLength = (data.length - 2) / 2
	if (dataLength === 0) return new Uint8Array()
	return quadraticBigintToUint8Array(BigInt(data), dataLength)
}

// Only whether a conversion threw is compared: the fractional-size RangeError message changed, and no caller reads it.
type ConversionOutcome = { readonly bytes: readonly number[] } | { readonly threw: true }

function conversionOutcome(convert: () => Uint8Array): ConversionOutcome {
	try {
		return { bytes: Array.from(convert()) }
	} catch {
		return { threw: true }
	}
}

function assertSameStringConversion(data: string) {
	assert.deepEqual(conversionOutcome(() => stringToUint8Array(data)), conversionOutcome(() => quadraticStringToUint8Array(data)), `stringToUint8Array(${ JSON.stringify(data) })`)
}

function assertSameBigintConversion(value: bigint, numberOfBytes: number) {
	assert.deepEqual(conversionOutcome(() => bigintToUint8Array(value, numberOfBytes)), conversionOutcome(() => quadraticBigintToUint8Array(value, numberOfBytes)), `bigintToUint8Array(${ value }, ${ numberOfBytes })`)
}

// Seeded xorshift32 so a failing random case reproduces on every run; its shifts and xors on a uint32 state never leave the exact integer range.
function createRandom(seed: number) {
	let state = seed >>> 0
	return (limit: number) => {
		state ^= state << 13
		state >>>= 0
		state ^= state >>> 17
		state ^= state << 5
		state >>>= 0
		return state % limit
	}
}

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

	test('decodes hex strings to the same bytes as the per-byte BigInt conversion', () => {
		assert.deepEqual(Array.from(stringToUint8Array('0x')), [])
		assert.deepEqual(Array.from(stringToUint8Array('0x0000ff')), [0, 0, 255])
		assert.deepEqual(Array.from(stringToUint8Array('0xABcd')), [0xab, 0xcd])
		assert.deepEqual(Array.from(stringToUint8Array('0x1')), [])
		assert.throws(() => stringToUint8Array('0x123'))
		assert.throws(() => stringToUint8Array(''))
		assert.throws(() => stringToUint8Array('0xzz'))
		const edgeCases = ['', '0', '0x', '0X', 'ab', 'zz', '0x0', '0x1', '0xf', '0x00', '0x0000', '0x0001', '0x00ff00', '0xff', '0xFF', '0xABcd', '0xabcdef', '0x123', '0xfff', '0x12345', '0X12', '0Xabcd', '0xzz', '0x12zz', '1234', '0012', '12', ' 0x12', '0x12 ', '  0x12', '0b1111', '0o17', '-0x12', '0x-12']
		for (const data of edgeCases) assertSameStringConversion(data)
	})

	test('matches the per-byte BigInt conversion on random strings', () => {
		const random = createRandom(1)
		const prefixes = ['0x', '0X', '', ' 0x', '0x0', '00']
		const digits = '0123456789abcdefABCDEF'
		const maximumBodyLength = 69
		const usedPrefixes = new Set<string>()
		const usedBodyLengths = new Set<number>()
		const usedDigits = new Set<string>()
		for (let iteration = 0; iteration < 5_000; iteration++) {
			const prefix = prefixes[random(prefixes.length)] ?? '0x'
			const body = Array.from({ length: random(maximumBodyLength + 1) }, () => digits[random(digits.length)] ?? '0').join('')
			usedPrefixes.add(prefix)
			usedBodyLengths.add(body.length)
			for (const digit of body) usedDigits.add(digit)
			assertSameStringConversion(`${ prefix }${ body }`)
		}
		assert.equal(usedPrefixes.size, prefixes.length, 'every prefix variant is generated')
		assert.equal(usedBodyLengths.size, maximumBodyLength + 1, 'every body length from 0 to the maximum is generated')
		assert.equal(usedDigits.size, digits.length, 'every hex digit in both cases is generated')
	})

	test('matches the per-byte BigInt conversion when encoding bigints into a fixed number of bytes', () => {
		const random = createRandom(2)
		const maximumNumberOfBytes = 39
		const usedSizes = new Set<number>()
		const usedByteValues = new Set<number>()
		for (let iteration = 0; iteration < 5_000; iteration++) {
			const numberOfBytes = random(maximumNumberOfBytes + 1)
			const valueBytes = Array.from({ length: random(numberOfBytes + 2) }, () => random(256))
			usedSizes.add(numberOfBytes)
			for (const byte of valueBytes) usedByteValues.add(byte)
			const value = valueBytes.length === 0 ? 0n : BigInt(`0x${ valueBytes.map((byte) => byte.toString(16).padStart(2, '0')).join('') }`)
			assertSameBigintConversion(value, numberOfBytes)
			assertSameBigintConversion(value, numberOfBytes + 0.5)
		}
		assert.equal(usedSizes.size, maximumNumberOfBytes + 1, 'every size from 0 to the maximum is generated')
		assert.equal(usedByteValues.size, 256, 'every byte value is generated')
		assertSameBigintConversion(0n, 0)
		assertSameBigintConversion(1n, 0)
		assertSameBigintConversion(-1n, 32)
		assertSameBigintConversion(2n ** 256n, 32)
		assertSameBigintConversion(2n ** 256n - 1n, 32)
		assertSameBigintConversion(5n, -1)
	})

	test('converts a 1 MiB hex string in linear time', () => {
		const megabyteOfHex = `0x${ 'a5'.repeat(512 * 1024) }`
		const startedAt = performance.now()
		const bytes = stringToUint8Array(megabyteOfHex)
		const uppercasePrefixBytes = stringToUint8Array(`0X${ megabyteOfHex.slice(2) }`)
		const elapsedMs = performance.now() - startedAt
		assert.equal(bytes.length, 512 * 1024)
		assert.equal(uppercasePrefixBytes.length, 512 * 1024)
		assert.ok(bytes.every((byte) => byte === 0xa5))
		assert.ok(elapsedMs < 5_000, `converting took ${ elapsedMs } ms`)
	})
})
