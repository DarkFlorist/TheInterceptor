import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { encodeFunctionCall } from '../../app/ts/utils/abiRuntime.js'
import { Erc20ABI } from '../../app/ts/utils/abi.js'
import { stringToUint8Array } from '../../app/ts/utils/bigint.js'
import { parseTransactionIfPossible } from '../../app/ts/utils/calldata.js'

describe('optional transaction calldata parsing', () => {
	test('returns undefined for malformed calldata with a recognized selector', () => {
		const malformedTransfer = stringToUint8Array(encodeFunctionCall(Erc20ABI, 'transfer', [
			'0x1111111111111111111111111111111111111111',
			1n,
		]).slice(0, 10))

		assert.equal(parseTransactionIfPossible({ input: malformedTransfer, from: 1n }), undefined)
	})

	test('does not hide unexpected parser failures', () => {
		const unexpectedFailure = new Error('unexpected parser failure')
		const throwingInput = new Proxy(new Uint8Array(4), {
			get(target, property, receiver) {
				if (property === 'length') throw unexpectedFailure
				return Reflect.get(target, property, receiver)
			},
		})

		assert.throws(
			() => parseTransactionIfPossible({ input: throwingInput, from: 1n }),
			(error) => error === unexpectedFailure,
		)
	})
})
