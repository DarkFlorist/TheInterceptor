import { describe, expect, test } from 'bun:test'
import { Erc721ABI } from '../../app/ts/utils/abi.js'
import { decodeFunctionOutputSafely, encodeFunctionReturn } from '../../app/ts/utils/abiRuntime.js'
import { decodeAbiParameters, isAbiDataDecodeError } from '../../app/ts/utils/ethereumPrimitives.js'

describe('ABI runtime', () => {
	test('decodeFunctionOutputSafely propagates type guard errors', () => {
		const encodedBooleanReturn = encodeFunctionReturn(Erc721ABI, 'supportsInterface', [true])
		const throwingGuard = (_value: unknown): _value is boolean => {
			throw new Error('guard failed')
		}

		expect(() => decodeFunctionOutputSafely(Erc721ABI, 'supportsInterface', encodedBooleanReturn, throwingGuard)).toThrow('guard failed')
	})

	test('malformed ABI payloads use the stable adapter error tag', () => {
		try {
			decodeAbiParameters([{ type: 'bool' }], `0x${ '0'.repeat(63) }2`)
			throw new Error('expected malformed ABI payload to throw')
		} catch (error) {
			expect(isAbiDataDecodeError(error)).toBe(true)
		}
	})
})
