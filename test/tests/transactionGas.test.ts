import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { getMinimumTransactionGasLimit } from '../../app/ts/utils/transactionGas.js'

describe('minimum transaction gas limit', () => {
	test('includes base and calldata intrinsic gas', () => {
		assert.equal(getMinimumTransactionGasLimit(new Uint8Array(), false), 21_000n)
		assert.equal(getMinimumTransactionGasLimit(new Uint8Array(15).fill(1), false), 21_600n)
	})

	test('honors the calldata gas floor for data-heavy transactions', () => {
		assert.equal(getMinimumTransactionGasLimit(new Uint8Array(100).fill(1), false), 25_000n)
	})

	test('includes contract creation and initcode word gas', () => {
		assert.equal(getMinimumTransactionGasLimit(new Uint8Array([1]), true), 53_018n)
		assert.equal(getMinimumTransactionGasLimit(new Uint8Array(33), true), 53_136n)
	})
})
