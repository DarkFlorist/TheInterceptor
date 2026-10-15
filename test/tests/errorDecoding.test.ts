import { describe, expect, test } from 'bun:test'
import { encodeErrorString, encodePanic } from './errorDataFixtures.js'
import { decodeEthereumError, ErrorType, needsAbiToDecodeError } from '../../app/ts/utils/errorDecoding.js'

const errorDataCases = [
	{ name: 'missing data', data: undefined },
	{ name: 'empty data', data: '0x' },
	{ name: 'Error(string)', data: encodeErrorString('STF') },
	{ name: 'Panic(uint256)', data: encodePanic(0x11n) },
	{ name: 'custom error selector', data: '0x12345678' },
	{ name: 'non-hex data', data: 'not hex' },
]

describe('needsAbiToDecodeError', () => {
	test.each(errorDataCases)('agrees with decodeEthereumError for $name', ({ data }) => {
		const decodedError = decodeEthereumError([], { code: 3, message: 'execution reverted', data })
		expect(needsAbiToDecodeError(data)).toBe(decodedError.type === ErrorType.CustomError && data?.startsWith('0x') === true)
	})

	test('only requires an ABI for custom error selectors', () => {
		expect(errorDataCases.filter(({ data }) => needsAbiToDecodeError(data)).map(({ name }) => name)).toEqual(['custom error selector'])
	})
})
