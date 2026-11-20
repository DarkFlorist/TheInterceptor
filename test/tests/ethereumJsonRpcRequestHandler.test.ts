import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { EthereumJSONRpcRequestHandler, type SlowRpcRequest } from '../../app/ts/simulation/services/EthereumJSONRpcRequestHandler.js'
import { HTTP_STATUS_TOO_MANY_REQUESTS, JSON_RPC_ERROR_CODE_INTERNAL_ERROR, JSON_RPC_ERROR_CODE_INVALID_PARAMS, JSON_RPC_ERROR_CODE_LIMIT_EXCEEDED, NEW_BLOCK_ABORT } from '../../app/ts/utils/constants.js'
import { JsonRpcResponseError, isNewBlockAbort } from '../../app/ts/utils/errors.js'
import { waitFor } from '../harness/async.js'
import { replaceGlobal, replaceProperty } from '../harness/globals.js'

const responseHeaders = { 'Content-Type': 'application/json' }
const testAddress = 0x0000000000000000000000000000000000000001n
const HTTP_STATUS_OK = 200
const HTTP_STATUS_BAD_REQUEST = 400
type LifecycleCallbackError = {
	error: unknown
	request: SlowRpcRequest
	callbackName: string
}

function installFetchMock(responses: Response[]) {
	let calls = 0
	const restore = replaceGlobal('fetch', async () => {
		const response = responses[calls]
		calls += 1
		if (response === undefined) throw new Error(`Unexpected fetch call ${ calls }`)
		return response
	})
	return {
		getCalls: () => calls,
		restore,
	}
}

function installDeferredFetchMock() {
	let calls = 0
	let resolveResponse: ((response: Response) => void) | undefined
	const restore = replaceGlobal('fetch', async () => {
		calls += 1
		return await new Promise<Response>((resolve) => {
			resolveResponse = resolve
		})
	})
	return {
		getCalls: () => calls,
		resolve(response: Response) {
			if (resolveResponse === undefined) throw new Error('Fetch was not called')
			resolveResponse(response)
		},
		restore,
	}
}

type QueuedFetchCall = {
	readonly signal: AbortSignal | undefined
	readonly respondWithResult: (result: string) => void
	readonly failWith: (error: Error) => void
}

// Holds every fetch until the test answers it, echoing the JSON-RPC request ID so responses pass ID validation.
function installQueuedFetchMock() {
	const calls: QueuedFetchCall[] = []
	const restore = replaceGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
		const body: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}')
		const id = typeof body === 'object' && body !== null && 'id' in body ? body.id : undefined
		const signal = init?.signal ?? undefined
		return await new Promise<Response>((resolve, reject) => {
			signal?.addEventListener('abort', () => reject(signal.reason))
			calls.push({
				signal,
				respondWithResult: (result: string) => resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status: HTTP_STATUS_OK, headers: responseHeaders })),
				failWith: reject,
			})
		})
	})
	return {
		calls,
		getCall(index: number) {
			const call = calls[index]
			if (call === undefined) throw new Error(`Fetch call ${ index } was not made`)
			return call
		},
		restore,
	}
}

// Tracks the abort listeners registered on a caller's signal. Removing a listener that was never added is a no-op for the signal, so it is not counted as a removal.
function trackAbortListeners(signal: AbortSignal) {
	const registeredListeners = new Set<unknown>()
	const counts = { added: 0, removed: 0 }
	const addEventListener = signal.addEventListener.bind(signal)
	const removeEventListener = signal.removeEventListener.bind(signal)
	replaceProperty(signal, 'addEventListener', (...args: Parameters<typeof addEventListener>) => {
		const [type, listener] = args
		if (type === 'abort' && !registeredListeners.has(listener)) {
			registeredListeners.add(listener)
			counts.added += 1
		}
		addEventListener(...args)
	})
	replaceProperty(signal, 'removeEventListener', (...args: Parameters<typeof removeEventListener>) => {
		const [type, listener] = args
		if (type === 'abort' && registeredListeners.delete(listener)) counts.removed += 1
		removeEventListener(...args)
	})
	return counts
}

async function withCapturedConsoleWarn<T>(runWithCapturedWarn: (warnings: unknown[][]) => Promise<T>) {
	const warnings: unknown[][] = []
	const restoreWarn = replaceProperty(console, 'warn', (...args: unknown[]) => { warnings.push(args) })
	try {
		return await runWithCapturedWarn(warnings)
	} finally {
		restoreWarn()
	}
}

describe('EthereumJSONRpcRequestHandler caching', () => {
	test('does not cache transient HTTP failures', async () => {
		const fetchMock = installFetchMock([
			new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: JSON_RPC_ERROR_CODE_LIMIT_EXCEEDED, message: 'rate limited' } }), { status: HTTP_STATUS_TOO_MANY_REQUESTS, headers: responseHeaders }),
			new Response(JSON.stringify({ jsonrpc: '2.0', id: 3, error: { code: JSON_RPC_ERROR_CODE_LIMIT_EXCEEDED, message: 'rate limited' } }), { status: HTTP_STATUS_TOO_MANY_REQUESTS, headers: responseHeaders }),
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
			new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: JSON_RPC_ERROR_CODE_INVALID_PARAMS, message: 'invalid params' } }), { status: HTTP_STATUS_BAD_REQUEST, headers: responseHeaders }),
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
			new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: JSON_RPC_ERROR_CODE_INTERNAL_ERROR, message: 'internal error' } }), { status: HTTP_STATUS_OK, headers: responseHeaders }),
			new Response(JSON.stringify({ jsonrpc: '2.0', id: 3, error: { code: JSON_RPC_ERROR_CODE_INTERNAL_ERROR, message: 'internal error' } }), { status: HTTP_STATUS_OK, headers: responseHeaders }),
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

	test('surfaces a rate-limit error with object-shaped data as an uncached JSON-RPC error and drops that data', async () => {
		const rateLimitData = { rate: { allowed_rps: 1, backoff_seconds: 30, current_rps: 1.4 }, see: 'https://infura.io/dashboard' }
		const fetchMock = installFetchMock([
			new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: JSON_RPC_ERROR_CODE_LIMIT_EXCEEDED, message: 'project ID request rate exceeded', data: rateLimitData } }), { status: HTTP_STATUS_OK, headers: responseHeaders }),
			new Response(JSON.stringify({ jsonrpc: '2.0', id: 3, result: '0x10' }), { status: HTTP_STATUS_OK, headers: responseHeaders }),
		])
		const requestHandler = new EthereumJSONRpcRequestHandler('https://example.invalid', true)

		try {
			await assert.rejects(requestHandler.jsonRpcRequest({ method: 'eth_getBalance', params: [testAddress, 'latest'] }), (error: unknown) => {
				if (!(error instanceof JsonRpcResponseError)) return false
				assert.equal(error.code, JSON_RPC_ERROR_CODE_LIMIT_EXCEEDED)
				assert.equal(error.message, 'project ID request rate exceeded')
				// Websites, popups and stored state only receive string error data.
				assert.equal(error.data, undefined)
				assert.equal('data' in error.serialize().error, false)
				return true
			})
			assert.equal(await requestHandler.jsonRpcRequest({ method: 'eth_getBalance', params: [testAddress, 'latest'] }), '0x10')
			assert.equal(fetchMock.getCalls(), 2)
		} finally {
			fetchMock.restore()
		}
	})

	test('surfaces object-shaped error data on failed HTTP responses as a JSON-RPC error', async () => {
		const fetchMock = installFetchMock([
			new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: JSON_RPC_ERROR_CODE_LIMIT_EXCEEDED, message: 'rate limited', data: { backoff_seconds: 30 } } }), { status: HTTP_STATUS_TOO_MANY_REQUESTS, headers: responseHeaders }),
		])
		const requestHandler = new EthereumJSONRpcRequestHandler('https://example.invalid', true)

		try {
			await withCapturedConsoleWarn(async () => {
				await assert.rejects(requestHandler.jsonRpcRequest({ method: 'eth_chainId' }), JsonRpcResponseError)
			})
		} finally {
			fetchMock.restore()
		}
	})

	test('rejects a response whose ID does not match the request', async () => {
		const fetchMock = installFetchMock([
			new Response(JSON.stringify({ jsonrpc: '2.0', id: 999, result: '0x1' }), { status: HTTP_STATUS_OK, headers: responseHeaders }),
		])
		const requestHandler = new EthereumJSONRpcRequestHandler('https://example.invalid')

		try {
			await assert.rejects(requestHandler.jsonRpcRequest({ method: 'eth_chainId' }), /did not match request ID 2/)
		} finally {
			fetchMock.restore()
		}
	})

	test('rejects and does not cache a response with a null ID', async () => {
		const fetchMock = installFetchMock([
			new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: JSON_RPC_ERROR_CODE_INTERNAL_ERROR, message: 'unknown request' } }), { status: HTTP_STATUS_OK, headers: responseHeaders }),
			new Response(JSON.stringify({ jsonrpc: '2.0', id: 3, result: '0x1' }), { status: HTTP_STATUS_OK, headers: responseHeaders }),
		])
		const requestHandler = new EthereumJSONRpcRequestHandler('https://example.invalid', true)

		try {
			await assert.rejects(requestHandler.jsonRpcRequest({ method: 'eth_chainId' }), /RPC response ID null did not match request ID 2/)
			assert.equal(await requestHandler.jsonRpcRequest({ method: 'eth_chainId' }), '0x1')
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
			onSlowRequest: (request) => { slowRequests.push(request) },
			onSlowRequestSettled: (request) => { settledRequests.push(request) },
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

	test('keeps RPC result stable when the slow request callback fails', async () => {
		const fetchMock = installDeferredFetchMock()
		const callbackErrors: LifecycleCallbackError[] = []
		const requestHandler = new EthereumJSONRpcRequestHandler('https://example.invalid', false, {
			expectedDurationMs: 1,
			onSlowRequest: () => { throw new Error('slow request callback failed') },
			onLifecycleCallbackError: (error, request, callbackName) => { callbackErrors.push({ error, request, callbackName }) },
		})

		try {
			const requestPromise = requestHandler.jsonRpcRequest({ method: 'eth_chainId' })
			await waitFor(() => callbackErrors.length === 1)
			fetchMock.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, result: '0x1' }), { status: HTTP_STATUS_OK, headers: responseHeaders }))

			assert.equal(await requestPromise, '0x1')
			assert.equal(fetchMock.getCalls(), 1)
			assert.equal(callbackErrors[0]?.callbackName, 'onSlowRequest')
			assert.equal(callbackErrors[0]?.request.method, 'eth_chainId')
			assert.match(callbackErrors[0]?.error instanceof Error ? callbackErrors[0].error.message : '', /slow request callback failed/)
		} finally {
			fetchMock.restore()
		}
	})

	test('keeps RPC result stable when the slow request settle callback fails', async () => {
		const fetchMock = installDeferredFetchMock()
		const slowRequests: SlowRpcRequest[] = []
		const callbackErrors: LifecycleCallbackError[] = []
		const requestHandler = new EthereumJSONRpcRequestHandler('https://example.invalid', false, {
			expectedDurationMs: 1,
			onSlowRequest: (request) => { slowRequests.push(request) },
			onSlowRequestSettled: () => { throw new Error('slow request settle callback failed') },
			onLifecycleCallbackError: (error, request, callbackName) => { callbackErrors.push({ error, request, callbackName }) },
		})

		try {
			const requestPromise = requestHandler.jsonRpcRequest({ method: 'eth_chainId' })
			await waitFor(() => slowRequests.length === 1)
			fetchMock.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, result: '0x1' }), { status: HTTP_STATUS_OK, headers: responseHeaders }))

			assert.equal(await requestPromise, '0x1')
			assert.equal(fetchMock.getCalls(), 1)
			assert.equal(callbackErrors.length, 1)
			assert.equal(callbackErrors[0]?.callbackName, 'onSlowRequestSettled')
			assert.equal(callbackErrors[0]?.request, slowRequests[0])
			assert.match(callbackErrors[0]?.error instanceof Error ? callbackErrors[0].error.message : '', /slow request settle callback failed/)
		} finally {
			fetchMock.restore()
		}
	})

	test('keeps RPC result stable when the async slow request callback rejects', async () => {
		const fetchMock = installDeferredFetchMock()
		const callbackErrors: LifecycleCallbackError[] = []
		const requestHandler = new EthereumJSONRpcRequestHandler('https://example.invalid', false, {
			expectedDurationMs: 1,
			onSlowRequest: async () => { throw new Error('async slow request callback failed') },
			onLifecycleCallbackError: async (error, request, callbackName) => {
				callbackErrors.push({ error, request, callbackName })
			},
		})

		try {
			const requestPromise = requestHandler.jsonRpcRequest({ method: 'eth_chainId' })
			await waitFor(() => callbackErrors.length === 1)
			fetchMock.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, result: '0x1' }), { status: HTTP_STATUS_OK, headers: responseHeaders }))

			assert.equal(await requestPromise, '0x1')
			assert.equal(fetchMock.getCalls(), 1)
			assert.equal(callbackErrors[0]?.callbackName, 'onSlowRequest')
			assert.equal(callbackErrors[0]?.request.method, 'eth_chainId')
			assert.match(callbackErrors[0]?.error instanceof Error ? callbackErrors[0].error.message : '', /async slow request callback failed/)
		} finally {
			fetchMock.restore()
		}
	})

	test('keeps RPC result stable when the async slow request settle callback rejects', async () => {
		const fetchMock = installDeferredFetchMock()
		const slowRequests: SlowRpcRequest[] = []
		const callbackErrors: LifecycleCallbackError[] = []
		const requestHandler = new EthereumJSONRpcRequestHandler('https://example.invalid', false, {
			expectedDurationMs: 1,
			onSlowRequest: async (request) => {
				slowRequests.push(request)
			},
			onSlowRequestSettled: async () => { throw new Error('async slow request settle callback failed') },
			onLifecycleCallbackError: async (error, request, callbackName) => {
				callbackErrors.push({ error, request, callbackName })
			},
		})

		try {
			const requestPromise = requestHandler.jsonRpcRequest({ method: 'eth_chainId' })
			await waitFor(() => slowRequests.length === 1)
			fetchMock.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, result: '0x1' }), { status: HTTP_STATUS_OK, headers: responseHeaders }))

			assert.equal(await requestPromise, '0x1')
			assert.equal(fetchMock.getCalls(), 1)
			await waitFor(() => callbackErrors.length === 1)
			assert.equal(callbackErrors[0]?.callbackName, 'onSlowRequestSettled')
			assert.equal(callbackErrors[0]?.request, slowRequests[0])
			assert.match(callbackErrors[0]?.error instanceof Error ? callbackErrors[0].error.message : '', /async slow request settle callback failed/)
		} finally {
			fetchMock.restore()
		}
	})

	test('keeps RPC result stable when the lifecycle error reporter rejects', async () => {
		await withCapturedConsoleWarn(async (warnings) => {
			const fetchMock = installDeferredFetchMock()
			const requestHandler = new EthereumJSONRpcRequestHandler('https://example.invalid', false, {
				expectedDurationMs: 1,
				onSlowRequest: async () => { throw new Error('async slow request callback failed') },
				onLifecycleCallbackError: async () => { throw new Error('lifecycle error reporter failed') },
			})

			try {
				const requestPromise = requestHandler.jsonRpcRequest({ method: 'eth_chainId' })
				await waitFor(() => warnings.some((warning) => warning[0] === 'RPC request lifecycle error reporter failed.'))
				fetchMock.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, result: '0x1' }), { status: HTTP_STATUS_OK, headers: responseHeaders }))

				assert.equal(await requestPromise, '0x1')
				assert.equal(fetchMock.getCalls(), 1)
				assert.equal(warnings.some((warning) => warning[0] instanceof Error && warning[0].message === 'lifecycle error reporter failed'), true)
			} finally {
				fetchMock.restore()
			}
		})
	})
})

describe('EthereumJSONRpcRequestHandler shared in-flight requests', () => {
	const blockNumberRequest = { method: 'eth_blockNumber' } as const

	test('an aborted caller does not fail another caller waiting for the same request', async () => {
		const fetchMock = installQueuedFetchMock()
		const requestHandler = new EthereumJSONRpcRequestHandler('https://example.invalid', true)
		try {
			const abortingCaller = new AbortController()
			const abortingRequest = requestHandler.jsonRpcRequest(blockNumberRequest, abortingCaller)
			const nonAbortableRequest = requestHandler.jsonRpcRequest(blockNumberRequest)
			const abortableRequest = requestHandler.jsonRpcRequest(blockNumberRequest, new AbortController())
			await waitFor(() => fetchMock.calls.length === 1)

			abortingCaller.abort(NEW_BLOCK_ABORT)
			await assert.rejects(abortingRequest, isNewBlockAbort)
			assert.equal(fetchMock.getCall(0).signal?.aborted, false)
			fetchMock.getCall(0).respondWithResult('0x1')

			assert.equal(await nonAbortableRequest, '0x1')
			assert.equal(await abortableRequest, '0x1')
			assert.equal(fetchMock.calls.length, 1)
		} finally {
			fetchMock.restore()
		}
	})

	test('a waiter keeps the shared fetch alive after the caller that started it aborts', async () => {
		const fetchMock = installQueuedFetchMock()
		const requestHandler = new EthereumJSONRpcRequestHandler('https://example.invalid', true)
		try {
			const startingCaller = new AbortController()
			const startingRequest = requestHandler.jsonRpcRequest(blockNumberRequest, startingCaller)
			await waitFor(() => fetchMock.calls.length === 1)
			const joiningRequest = requestHandler.jsonRpcRequest(blockNumberRequest)

			startingCaller.abort(NEW_BLOCK_ABORT)
			await assert.rejects(startingRequest, isNewBlockAbort)
			fetchMock.getCall(0).respondWithResult('0x2')

			assert.equal(await joiningRequest, '0x2')
			assert.equal(fetchMock.calls.length, 1)
		} finally {
			fetchMock.restore()
		}
	})

	test('cancels the shared fetch once every waiter has aborted and does not let new callers join it', async () => {
		const fetchMock = installQueuedFetchMock()
		const requestHandler = new EthereumJSONRpcRequestHandler('https://example.invalid', true)
		try {
			const firstCaller = new AbortController()
			const secondCaller = new AbortController()
			const firstRequest = requestHandler.jsonRpcRequest(blockNumberRequest, firstCaller)
			const secondRequest = requestHandler.jsonRpcRequest(blockNumberRequest, secondCaller)
			await waitFor(() => fetchMock.calls.length === 1)

			firstCaller.abort(NEW_BLOCK_ABORT)
			await assert.rejects(firstRequest, isNewBlockAbort)
			assert.equal(fetchMock.getCall(0).signal?.aborted, false)
			secondCaller.abort(NEW_BLOCK_ABORT)
			await assert.rejects(secondRequest, isNewBlockAbort)
			assert.equal(fetchMock.getCall(0).signal?.aborted, true)

			const laterRequest = requestHandler.jsonRpcRequest(blockNumberRequest)
			await waitFor(() => fetchMock.calls.length === 2)
			fetchMock.getCall(1).respondWithResult('0x3')
			assert.equal(await laterRequest, '0x3')
		} finally {
			fetchMock.restore()
		}
	})

	test('a request after clearCache does not join a pending request from the previous cache generation', async () => {
		const fetchMock = installQueuedFetchMock()
		const requestHandler = new EthereumJSONRpcRequestHandler('https://example.invalid', true)
		try {
			const previousBlockRequest = requestHandler.jsonRpcRequest(blockNumberRequest)
			await waitFor(() => fetchMock.calls.length === 1)
			requestHandler.clearCache()
			const newBlockRequest = requestHandler.jsonRpcRequest(blockNumberRequest)
			await waitFor(() => fetchMock.calls.length === 2)

			fetchMock.getCall(0).respondWithResult('0x10')
			fetchMock.getCall(1).respondWithResult('0x11')
			assert.equal(await previousBlockRequest, '0x10')
			assert.equal(await newBlockRequest, '0x11')
			assert.equal(await requestHandler.jsonRpcRequest(blockNumberRequest), '0x11')
			assert.equal(fetchMock.calls.length, 2)
		} finally {
			fetchMock.restore()
		}
	})

	test('a response from the previous cache generation is not cached into the new generation', async () => {
		const fetchMock = installQueuedFetchMock()
		const requestHandler = new EthereumJSONRpcRequestHandler('https://example.invalid', true)
		try {
			const previousBlockRequest = requestHandler.jsonRpcRequest(blockNumberRequest)
			await waitFor(() => fetchMock.calls.length === 1)
			requestHandler.clearCache()
			fetchMock.getCall(0).respondWithResult('0x10')
			assert.equal(await previousBlockRequest, '0x10')

			const newBlockRequest = requestHandler.jsonRpcRequest(blockNumberRequest)
			await waitFor(() => fetchMock.calls.length === 2)
			fetchMock.getCall(1).respondWithResult('0x11')
			assert.equal(await newBlockRequest, '0x11')
		} finally {
			fetchMock.restore()
		}
	})

	test('a caller whose signal is already aborted rejects without disturbing the caller it would have joined', async () => {
		const fetchMock = installQueuedFetchMock()
		const requestHandler = new EthereumJSONRpcRequestHandler('https://example.invalid', true)
		try {
			const waitingRequest = requestHandler.jsonRpcRequest(blockNumberRequest)
			await waitFor(() => fetchMock.calls.length === 1)
			const abortedCaller = new AbortController()
			abortedCaller.abort(NEW_BLOCK_ABORT)

			await assert.rejects(requestHandler.jsonRpcRequest(blockNumberRequest, abortedCaller), isNewBlockAbort)
			assert.equal(fetchMock.getCall(0).signal?.aborted, false)
			fetchMock.getCall(0).respondWithResult('0x4')

			assert.equal(await waitingRequest, '0x4')
			assert.equal(fetchMock.calls.length, 1)
		} finally {
			fetchMock.restore()
		}
	})

	test('a caller whose signal is already aborted does not start a fetch for later callers to join', async () => {
		const fetchMock = installQueuedFetchMock()
		const requestHandler = new EthereumJSONRpcRequestHandler('https://example.invalid', true)
		try {
			const abortedCaller = new AbortController()
			abortedCaller.abort(NEW_BLOCK_ABORT)

			await assert.rejects(requestHandler.jsonRpcRequest(blockNumberRequest, abortedCaller), isNewBlockAbort)
			assert.equal(fetchMock.calls.length, 0)

			const laterRequest = requestHandler.jsonRpcRequest(blockNumberRequest)
			await waitFor(() => fetchMock.calls.length === 1)
			fetchMock.getCall(0).respondWithResult('0x5')
			assert.equal(await laterRequest, '0x5')
		} finally {
			fetchMock.restore()
		}
	})

	test('a fetch error reaches every waiter and the next call fetches again', async () => {
		const fetchMock = installQueuedFetchMock()
		const requestHandler = new EthereumJSONRpcRequestHandler('https://example.invalid', true)
		try {
			const firstRequest = requestHandler.jsonRpcRequest(blockNumberRequest)
			const secondRequest = requestHandler.jsonRpcRequest(blockNumberRequest, new AbortController())
			await waitFor(() => fetchMock.calls.length === 1)

			fetchMock.getCall(0).failWith(new Error('RPC node unreachable'))
			await assert.rejects(firstRequest, /RPC node unreachable/)
			await assert.rejects(secondRequest, /RPC node unreachable/)

			const retriedRequest = requestHandler.jsonRpcRequest(blockNumberRequest)
			await waitFor(() => fetchMock.calls.length === 2)
			fetchMock.getCall(1).respondWithResult('0x6')
			assert.equal(await retriedRequest, '0x6')
			assert.equal(await requestHandler.jsonRpcRequest(blockNumberRequest), '0x6')
			assert.equal(fetchMock.calls.length, 2)
		} finally {
			fetchMock.restore()
		}
	})

	test('every abort listener a waiter adds to its caller signal is removed once it stops waiting', async () => {
		const fetchMock = installQueuedFetchMock()
		const requestHandler = new EthereumJSONRpcRequestHandler('https://example.invalid', true)
		try {
			const answeredCaller = new AbortController()
			const answeredListeners = trackAbortListeners(answeredCaller.signal)
			const abortingCaller = new AbortController()
			const abortingListeners = trackAbortListeners(abortingCaller.signal)
			const failedCaller = new AbortController()
			const failedListeners = trackAbortListeners(failedCaller.signal)
			const alreadyAbortedCaller = new AbortController()
			alreadyAbortedCaller.abort(NEW_BLOCK_ABORT)
			const alreadyAbortedListeners = trackAbortListeners(alreadyAbortedCaller.signal)

			const answeredRequest = requestHandler.jsonRpcRequest(blockNumberRequest, answeredCaller)
			const abortingRequest = requestHandler.jsonRpcRequest(blockNumberRequest, abortingCaller)
			await waitFor(() => fetchMock.calls.length === 1)
			await assert.rejects(requestHandler.jsonRpcRequest(blockNumberRequest, alreadyAbortedCaller), isNewBlockAbort)
			abortingCaller.abort(NEW_BLOCK_ABORT)
			await assert.rejects(abortingRequest, isNewBlockAbort)
			fetchMock.getCall(0).respondWithResult('0x7')
			assert.equal(await answeredRequest, '0x7')

			const failedRequest = requestHandler.jsonRpcRequest({ method: 'eth_chainId' }, failedCaller)
			await waitFor(() => fetchMock.calls.length === 2)
			fetchMock.getCall(1).failWith(new Error('RPC node unreachable'))
			await assert.rejects(failedRequest, /RPC node unreachable/)

			assert.deepEqual(answeredListeners, { added: 1, removed: 1 })
			assert.deepEqual(abortingListeners, { added: 1, removed: 1 })
			assert.deepEqual(failedListeners, { added: 1, removed: 1 })
			assert.deepEqual(alreadyAbortedListeners, { added: 0, removed: 0 })
		} finally {
			fetchMock.restore()
		}
	})
})
