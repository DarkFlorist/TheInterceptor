import { describe, test } from 'bun:test'
import * as assert from 'node:assert'
import { decodeEthereumError } from '../../app/ts/utils/errorDecoding.js'
import { encodeAbiValues } from '../../app/ts/utils/abiRuntime.js'

const ERROR_STRING_SELECTOR = '0x08c379a0'
const PANIC_SELECTOR = '0x4e487b71'

describe('decodeEthereumError', () => {
	test('decodes Error(string) revert data', () => {
		const data = `${ ERROR_STRING_SELECTOR }${ encodeAbiValues(['string'], ['insufficient allowance']).slice(2) }`
		const decoded = decodeEthereumError([], { code: 3, message: 'execution reverted', data })

		assert.equal(decoded.type, 'RevertError')
		assert.equal(decoded.reason, 'insufficient allowance')
		assert.equal(decoded.data, data)
	})

	test('decodes Panic(uint256) revert data', () => {
		const data = `${ PANIC_SELECTOR }${ encodeAbiValues(['uint256'], [0x11n]).slice(2) }`
		const decoded = decodeEthereumError([], { code: 3, message: 'execution reverted', data })

		assert.equal(decoded.type, 'PanicError')
		assert.equal(decoded.reason, 'Arithmetic operation underflowed or overflowed outside of an unchecked block')
	})
})
