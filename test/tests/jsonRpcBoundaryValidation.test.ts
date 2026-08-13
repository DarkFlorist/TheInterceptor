import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { EthereumJsonRpcRequest, FeeHistory, EthGetLogsRequest, EthNewFilter } from '../../app/ts/types/JsonRpc-types.js'
import { CanonicalEthereumQuantity, EthereumAddress, EthereumBlockTag, EthereumBytes16, EthereumBytes256, EthereumBytes32, EthereumQuantity, serialize } from '../../app/ts/types/wire-types.js'

const blockHash = `0x${ '12'.repeat(32) }`

describe('JSON-RPC boundary validation', () => {
	test('accepts safe and earliest block tags', () => {
		assert.equal(EthereumBlockTag.parse('safe'), 'safe')
		assert.equal(EthereumBlockTag.parse('earliest'), 'earliest')
	})

	test('preserves the standard blockHash field on new filters', () => {
		const parsed = EthNewFilter.safeParse({ method: 'eth_newFilter', params: [{ blockHash }] })

		assert.equal(parsed.success, true)
		if (!parsed.success) throw new Error(parsed.message)
		assert.equal(parsed.value.params[0].blockHash, BigInt(blockHash))
	})

	test('rejects the non-standard lowercase blockhash field instead of stripping it', () => {
		assert.equal(EthereumJsonRpcRequest.safeParse({ method: 'eth_getLogs', params: [{ blockhash: blockHash }] }).success, false)
		assert.equal(EthereumJsonRpcRequest.safeParse({ method: 'eth_newFilter', params: [{ blockhash: blockHash }] }).success, false)
	})

	test('rejects blockHash combined with block range fields', () => {
		assert.equal(EthGetLogsRequest.safeParse({ blockHash, fromBlock: 'latest' }).success, false)
		assert.equal(EthGetLogsRequest.safeParse({ blockHash, toBlock: 'latest' }).success, false)
		assert.equal(EthNewFilter.safeParse({ method: 'eth_newFilter', params: [{ blockHash, fromBlock: 'latest' }] }).success, false)
	})

	test('rejects values that exceed fixed-width wire types', () => {
		assert.throws(() => serialize(EthereumAddress, 1n << 160n))
		assert.throws(() => serialize(EthereumBytes32, 1n << 256n))
		assert.throws(() => serialize(EthereumBytes256, 1n << 2048n))
		assert.throws(() => serialize(EthereumBytes16, 1n << 64n))
	})

	test('continues to serialize the largest fixed-width values', () => {
		assert.equal(serialize(EthereumAddress, (1n << 160n) - 1n).length, 42)
		assert.equal(serialize(EthereumBytes32, (1n << 256n) - 1n).length, 66)
		assert.equal(serialize(EthereumBytes256, (1n << 2048n) - 1n).length, 514)
		assert.equal(serialize(EthereumBytes16, (1n << 64n) - 1n).length, 18)
	})

	test('keeps Ethereum quantity serialization within the 256-bit parser boundary', () => {
		const largestQuantity = (1n << 256n) - 1n
		assert.equal(EthereumQuantity.parse(serialize(EthereumQuantity, largestQuantity)), largestQuantity)
		assert.equal(CanonicalEthereumQuantity.parse(serialize(CanonicalEthereumQuantity, largestQuantity)), largestQuantity)
		assert.throws(() => serialize(EthereumQuantity, 1n << 256n))
		assert.throws(() => serialize(CanonicalEthereumQuantity, 1n << 256n))
	})

	test('accepts valid fee history reward percentiles', () => {
		assert.equal(FeeHistory.safeParse({ method: 'eth_feeHistory', params: ['0x5', 'latest', [0, 25.5, 25.5, 100]] }).success, true)
	})

	test('rejects out-of-range and decreasing fee history reward percentiles', () => {
		assert.equal(FeeHistory.safeParse({ method: 'eth_feeHistory', params: ['0x5', 'latest', [-1]] }).success, false)
		assert.equal(FeeHistory.safeParse({ method: 'eth_feeHistory', params: ['0x5', 'latest', [101]] }).success, false)
		assert.equal(FeeHistory.safeParse({ method: 'eth_feeHistory', params: ['0x5', 'latest', [75, 25]] }).success, false)
	})
})
