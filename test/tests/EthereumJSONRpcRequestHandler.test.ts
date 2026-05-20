import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { EthereumJSONRpcRequestHandler } from '../../app/ts/simulation/services/EthereumJSONRpcRequestHandler.js'
import { HTTP_STATUS_TOO_MANY_REQUESTS, JSON_RPC_ERROR_CODE_INTERNAL_ERROR, JSON_RPC_ERROR_CODE_INVALID_PARAMS, JSON_RPC_ERROR_CODE_LIMIT_EXCEEDED } from '../../app/ts/utils/constants.js'
import { JsonRpcResponseError } from '../../app/ts/utils/errors.js'

const responseHeaders = { 'Content-Type': 'application/json' }
const testAddress = 0x0000000000000000000000000000000000000001n
const HTTP_STATUS_OK = 200
const HTTP_STATUS_BAD_REQUEST = 400

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
			new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: JSON_RPC_ERROR_CODE_LIMIT_EXCEEDED, message: 'rate limited' } }), { status: HTTP_STATUS_TOO_MANY_REQUESTS, headers: responseHeaders }),
			new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: JSON_RPC_ERROR_CODE_LIMIT_EXCEEDED, message: 'rate limited' } }), { status: HTTP_STATUS_TOO_MANY_REQUESTS, headers: responseHeaders }),
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
			new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: JSON_RPC_ERROR_CODE_INVALID_PARAMS, message: 'invalid params' } }), { status: HTTP_STATUS_BAD_REQUEST, headers: responseHeaders }),
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
			new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: JSON_RPC_ERROR_CODE_INTERNAL_ERROR, message: 'internal error' } }), { status: HTTP_STATUS_OK, headers: responseHeaders }),
			new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: JSON_RPC_ERROR_CODE_INTERNAL_ERROR, message: 'internal error' } }), { status: HTTP_STATUS_OK, headers: responseHeaders }),
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
