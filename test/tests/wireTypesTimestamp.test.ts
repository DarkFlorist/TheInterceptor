import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { EthereumTimestamp } from '../../app/ts/types/wire-types.js'

describe('EthereumTimestamp', () => {
	test('rejects empty and out-of-range hexadecimal timestamps', () => {
		assert.equal(EthereumTimestamp.safeParse('0x').success, false)
		assert.equal(EthereumTimestamp.safeParse('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff').success, false)
	})

	test('rejects invalid and pre-epoch dates during serialization', () => {
		assert.throws(() => EthereumTimestamp.serialize(new Date(Number.NaN)))
		assert.throws(() => EthereumTimestamp.serialize(new Date(-1)))
	})

	test('round trips valid timestamps', () => {
		const date = new Date('2024-01-01T00:00:00.000Z')
		assert.deepEqual(EthereumTimestamp.parse(EthereumTimestamp.serialize(date)), date)
	})
})
