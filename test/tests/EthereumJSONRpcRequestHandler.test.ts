import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { EthereumJSONRpcRequestHandler } from '../../app/ts/simulation/services/EthereumJSONRpcRequestHandler.js'
import { JsonRpcResponseError } from '../../app/ts/utils/errors.js'

const responseHeaders = { 'Content-Type': 'application/json' }
const testAddress = 0x0000000000000000000000000000000000000001n

function installFetchMock(responses: Response[]) {
	const previousFetch = globalThis.fetch
	let calls = 0
	globalThis.fetch = async () => {
		const response = responses[calls]
		calls += 1
		if (response === undefined) throw new Error(`Unexpected fetch call ${ calls }`)
		return response
	}
	return {
		getCalls: () => calls,
		restore() {
			globalThis.fetch = previousFetch
		},
	}
}

describe('EthereumJSONRpcRequestHandler caching', () => {
	test('does not cache transient HTTP failures', async () => {
		const fetchMock = installFetchMock([
			new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'rate limited' } }), { status: 429, headers: responseHeaders }),
			new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: -32005, message: 'rate limited' } }), { status: 429, headers: responseHeaders }),
		])
		const requestHandler = new EthereumJSONRpcRequestHandler('https://example.invalid', true)

		try {
			await assert.rejects(requestHandler.jsonRpcRequest({ method: 'eth_chainId' }), JsonRpcResponseError)
			await assert.rejects(requestHandler.jsonRpcRequest({ method: 'eth_chainId' }), JsonRpcResponseError)
			assert.equal(fetchMock.getCalls(), 2)
		} finally {
			fetchMock.restore()
		}
	})

	test('caches deterministic non-ok JSON-RPC failures', async () => {
		const fetchMock = installFetchMock([
			new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'invalid params' } }), { status: 400, headers: responseHeaders }),
		])
		const requestHandler = new EthereumJSONRpcRequestHandler('https://example.invalid', true)

		try {
			await assert.rejects(requestHandler.jsonRpcRequest({ method: 'eth_getBalance', params: [testAddress, 'latest'] }), JsonRpcResponseError)
			await assert.rejects(requestHandler.jsonRpcRequest({ method: 'eth_getBalance', params: [testAddress, 'latest'] }), JsonRpcResponseError)
			assert.equal(fetchMock.getCalls(), 1)
		} finally {
			fetchMock.restore()
		}
	})

	test('does not cache transient JSON-RPC server errors returned with ok responses', async () => {
		const fetchMock = installFetchMock([
			new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'internal error' } }), { status: 200, headers: responseHeaders }),
			new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: -32603, message: 'internal error' } }), { status: 200, headers: responseHeaders }),
		])
		const requestHandler = new EthereumJSONRpcRequestHandler('https://example.invalid', true)

		try {
			await assert.rejects(requestHandler.jsonRpcRequest({ method: 'eth_getBalance', params: [testAddress, 'latest'] }), JsonRpcResponseError)
			await assert.rejects(requestHandler.jsonRpcRequest({ method: 'eth_getBalance', params: [testAddress, 'latest'] }), JsonRpcResponseError)
			assert.equal(fetchMock.getCalls(), 2)
		} finally {
			fetchMock.restore()
		}
	})
})
