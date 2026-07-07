import { describe, expect, test } from 'bun:test'
import { Erc721ABI } from '../../app/ts/utils/abi.js'
import { decodeFunctionOutputSafely, encodeFunctionReturn } from '../../app/ts/utils/abiRuntime.js'

describe('ABI runtime', () => {
	test('decodeFunctionOutputSafely propagates type guard errors that look like viem decode errors', () => {
		const encodedBooleanReturn = encodeFunctionReturn(Erc721ABI, 'supportsInterface', [true])
		const throwingGuard = (_value: unknown): _value is boolean => {
			const error = new Error('guard failed')
			error.name = 'AbiDecodingZeroDataError'
			throw error
		}

		expect(() => decodeFunctionOutputSafely(Erc721ABI, 'supportsInterface', encodedBooleanReturn, throwingGuard)).toThrow('guard failed')
	})
})
