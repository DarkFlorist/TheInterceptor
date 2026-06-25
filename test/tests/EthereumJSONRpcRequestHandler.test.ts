import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { EthereumJSONRpcRequestHandler, type SlowRpcRequest } from '../../app/ts/simulation/services/EthereumJSONRpcRequestHandler.js'
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

function installDeferredFetchMock() {
	const previousFetch = globalThis.fetch
	let calls = 0
	let resolveResponse: ((response: Response) => void) | undefined
	globalThis.fetch = async () => {
		calls += 1
		return await new Promise<Response>((resolve) => {
			resolveResponse = resolve
		})
	}
	return {
		getCalls: () => calls,
		resolve(response: Response) {
			if (resolveResponse === undefined) throw new Error('Fetch was not called')
			resolveResponse(response)
		},
		restore() {
			globalThis.fetch = previousFetch
		},
	}
}

async function waitFor(condition: () => boolean, timeoutMs = 1000) {
	const startedAt = Date.now()
	while (!condition()) {
		if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for condition')
		await new Promise((resolve) => setTimeout(resolve, 5))
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

	test('reports and settles slow requests that exceed the expected duration', async () => {
		const fetchMock = installDeferredFetchMock()
		const slowRequests: SlowRpcRequest[] = []
		const settledRequests: SlowRpcRequest[] = []
		const requestHandler = new EthereumJSONRpcRequestHandler('https://example.invalid', false, {
			expectedDurationMs: 1,
			onSlowRequest: (request) => slowRequests.push(request),
			onSlowRequestSettled: (request) => settledRequests.push(request),
		})

		try {
			const requestPromise = requestHandler.jsonRpcRequest({ method: 'eth_chainId' })
			await waitFor(() => slowRequests.length === 1)
			fetchMock.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, result: '0x1' }), { status: HTTP_STATUS_OK, headers: responseHeaders }))
			assert.equal(await requestPromise, '0x1')
			assert.equal(fetchMock.getCalls(), 1)
			assert.equal(slowRequests[0]?.method, 'eth_chainId')
			assert.equal(slowRequests[0]?.rpcUrl, 'https://example.invalid')
			assert.equal(settledRequests.length, 1)
			assert.equal(settledRequests[0], slowRequests[0])
		} finally {
			fetchMock.restore()
		}
	})
})
