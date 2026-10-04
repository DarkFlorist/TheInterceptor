import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { EthereumJsonRpcRequest } from '../../app/ts/types/JsonRpc-types.js'

const address = '0x0000000000000000000000000000000000000001'
const secondAddress = '0x0000000000000000000000000000000000000002'
const storageKey = `0x${ '42'.padStart(64, '0') }`

describe('JSON-RPC request compatibility', () => {
	test('accepts eth_call without an explicit block tag', () => {
		const request = EthereumJsonRpcRequest.parse({
			method: 'eth_call',
			params: [{ to: address, data: '0x' }],
		})

		assert.equal(request.method, 'eth_call')
		assert.equal(request.params.length, 1)
	})

	test('preserves transaction access lists at the request boundary', () => {
		const request = EthereumJsonRpcRequest.parse({
			method: 'eth_sendTransaction',
			params: [{
				from: address,
				to: secondAddress,
				accessList: [{ address: secondAddress, storageKeys: [storageKey] }],
			}],
		})

		assert.equal(request.method, 'eth_sendTransaction')
		assert.deepEqual(request.params[0].accessList, [{
			address: BigInt(secondAddress),
			storageKeys: [BigInt(storageKey)],
		}])
	})

	test('accepts address arrays and null addresses in eth_newFilter', () => {
		const arrayRequest = EthereumJsonRpcRequest.parse({
			method: 'eth_newFilter',
			params: [{ address: [address, secondAddress] }],
		})
		const nullRequest = EthereumJsonRpcRequest.parse({
			method: 'eth_newFilter',
			params: [{ address: null }],
		})

		assert.equal(arrayRequest.method, 'eth_newFilter')
		assert.deepEqual(arrayRequest.params[0].address, [BigInt(address), BigInt(secondAddress)])
		assert.equal(nullRequest.method, 'eth_newFilter')
		assert.equal(nullRequest.params[0].address, null)
	})

	test('accepts fractional eth_feeHistory reward percentiles', () => {
		const request = EthereumJsonRpcRequest.parse({
			method: 'eth_feeHistory',
			params: ['0x1', 'latest', [0.5, 25.25, 99.999]],
		})

		assert.equal(request.method, 'eth_feeHistory')
		assert.deepEqual(request.params[2], [0.5, 25.25, 99.999])
	})
})
