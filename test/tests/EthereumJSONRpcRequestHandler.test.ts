import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { EthereumJSONRpcRequestHandler, type SlowRpcRequest } from '../../app/ts/simulation/services/EthereumJSONRpcRequestHandler.js'
import { EthSimulateV1Result } from '../../app/ts/types/ethSimulate-types.js'
import { HTTP_STATUS_TOO_MANY_REQUESTS, JSON_RPC_ERROR_CODE_INTERNAL_ERROR, JSON_RPC_ERROR_CODE_INVALID_PARAMS, JSON_RPC_ERROR_CODE_LIMIT_EXCEEDED } from '../../app/ts/utils/constants.js'
import { JsonRpcResponseError } from '../../app/ts/utils/errors.js'

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

function installBodyCapturingFetchMock(response: Response) {
	const previousFetch = globalThis.fetch
	const bodies: unknown[] = []
	globalThis.fetch = async (_input, init) => {
		bodies.push(init?.body)
		return response
	}
	return {
		bodies,
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

async function withCapturedConsoleWarn<T>(runWithCapturedWarn: (warnings: unknown[][]) => Promise<T>) {
	const previousWarn = console.warn
	const warnings: unknown[][] = []
	console.warn = (...args: unknown[]) => { warnings.push(args) }
	try {
		return await runWithCapturedWarn(warnings)
	} finally {
		console.warn = previousWarn
	}
}

describe('EthereumJSONRpcRequestHandler caching', () => {
	test('serializes typed BigInts before fetching and caching', async () => {
		const fetchMock = installBodyCapturingFetchMock(new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, result: [] }), { status: HTTP_STATUS_OK, headers: responseHeaders }))
		const requestHandler = new EthereumJSONRpcRequestHandler('https://example.invalid', true)

		try {
			const result = await requestHandler.jsonRpcRequest({
				method: 'eth_simulateV1',
				params: [{
					blockStateCalls: [{
						calls: [{
							from: testAddress,
							to: testAddress,
							value: 1n,
							input: new Uint8Array(),
						}],
					}],
				}],
			})

			assert.deepEqual(result, [])
			assert.equal(fetchMock.bodies.length, 1)
			assert.equal(fetchMock.bodies[0], '{"jsonrpc":"2.0","id":2,"method":"eth_simulateV1","params":[{"blockStateCalls":[{"calls":[{"from":"0x0000000000000000000000000000000000000001","to":"0x0000000000000000000000000000000000000001","value":"0x1","input":"0x"}]}]}]}')
		} finally {
			fetchMock.restore()
		}
	})

	test('rejects unserialized BigInts in RPC request extension fields', async () => {
		const fetchMock = installBodyCapturingFetchMock(new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, result: [] }), { status: HTTP_STATUS_OK, headers: responseHeaders }))
		const requestHandler = new EthereumJSONRpcRequestHandler('https://example.invalid', true)

		try {
			await assert.rejects(
				async () => await requestHandler.jsonRpcRequest({
					method: 'eth_simulateV1',
					params: [{
						blockStateCalls: [{
							calls: [{
								from: testAddress,
								to: testAddress,
								metadataNonce: 2n,
							}],
						}],
					}],
				}),
				(error) => error instanceof Error && error.message.includes('Additional property metadataNonce must be JSON encodeable.'),
			)
			assert.equal(fetchMock.bodies.length, 0)
		} finally {
			fetchMock.restore()
		}
	})

	test('rejects non-finite numbers in RPC request extension fields', async () => {
		const fetchMock = installBodyCapturingFetchMock(new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, result: [] }), { status: HTTP_STATUS_OK, headers: responseHeaders }))
		const requestHandler = new EthereumJSONRpcRequestHandler('https://example.invalid', true)

		try {
			for (const metadata of [Number.NaN, Number.POSITIVE_INFINITY, { nested: Number.NEGATIVE_INFINITY }]) {
				await assert.rejects(
					async () => await requestHandler.jsonRpcRequest({
						method: 'eth_simulateV1',
						params: [{
							blockStateCalls: [{
								calls: [{
									from: testAddress,
									to: testAddress,
									metadata,
								}],
							}],
						}],
					}),
					(error) => error instanceof Error && error.message.includes('Additional property metadata must be JSON encodeable.'),
				)
			}
			assert.equal(fetchMock.bodies.length, 0)
		} finally {
			fetchMock.restore()
		}
	})

	test('allows shared acyclic objects in RPC request extension fields', async () => {
		const fetchMock = installBodyCapturingFetchMock(new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, result: [] }), { status: HTTP_STATUS_OK, headers: responseHeaders }))
		const requestHandler = new EthereumJSONRpcRequestHandler('https://example.invalid', true)
		const sharedMetadata = { keep: true }

		try {
			const result = await requestHandler.jsonRpcRequest({
				method: 'eth_simulateV1',
				params: [{
					blockStateCalls: [{
						calls: [{
							from: testAddress,
							to: testAddress,
							metadataA: sharedMetadata,
							metadataB: sharedMetadata,
						}],
					}],
				}],
			})

			assert.deepEqual(result, [])
			assert.equal(fetchMock.bodies.length, 1)
			assert.equal(fetchMock.bodies[0], '{"jsonrpc":"2.0","id":2,"method":"eth_simulateV1","params":[{"blockStateCalls":[{"calls":[{"from":"0x0000000000000000000000000000000000000001","to":"0x0000000000000000000000000000000000000001","metadataA":{"keep":true},"metadataB":{"keep":true}}]}]}]}')
		} finally {
			fetchMock.restore()
		}
	})

	test('rejects cyclic RPC payload objects before fetching', async () => {
		const fetchMock = installBodyCapturingFetchMock(new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, result: [] }), { status: HTTP_STATUS_OK, headers: responseHeaders }))
		const requestHandler = new EthereumJSONRpcRequestHandler('https://example.invalid', true)
		const metadata: { self?: unknown } = {}
		metadata.self = metadata

		try {
			await assert.rejects(
				async () => await requestHandler.jsonRpcRequest({
					method: 'eth_simulateV1',
					params: [{
						blockStateCalls: [{
							calls: [{
								from: testAddress,
								to: testAddress,
								metadata,
							}],
						}],
					}],
				}),
				(error) => error instanceof Error && error.message.includes('Additional property metadata must be JSON encodeable.'),
			)
			assert.equal(fetchMock.bodies.length, 0)
		} finally {
			fetchMock.restore()
		}
	})

	test('rejects symbol-keyed RPC extension data before fetching', async () => {
		const fetchMock = installBodyCapturingFetchMock(new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, result: [] }), { status: HTTP_STATUS_OK, headers: responseHeaders }))
		const requestHandler = new EthereumJSONRpcRequestHandler('https://example.invalid', true)
		const metadata = { [Symbol('unsafe')]: 1n }

		try {
			await assert.rejects(
				async () => await requestHandler.jsonRpcRequest({
					method: 'eth_simulateV1',
					params: [{
						blockStateCalls: [{
							calls: [{
								from: testAddress,
								to: testAddress,
								metadata,
							}],
						}],
					}],
				}),
				(error) => error instanceof Error && error.message.includes('Additional property metadata must be JSON encodeable.'),
			)
			assert.equal(fetchMock.bodies.length, 0)
		} finally {
			fetchMock.restore()
		}
	})

	test('rejects array extension data with silently dropped own properties before fetching', async () => {
		const fetchMock = installBodyCapturingFetchMock(new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, result: [] }), { status: HTTP_STATUS_OK, headers: responseHeaders }))
		const requestHandler = new EthereumJSONRpcRequestHandler('https://example.invalid', true)

		try {
			for (const key of ['extra', Symbol('unsafe')]) {
				const metadata = [true]
				Object.defineProperty(metadata, key, { value: 1n, enumerable: true })
				await assert.rejects(
					async () => await requestHandler.jsonRpcRequest({
						method: 'eth_simulateV1',
						params: [{
							blockStateCalls: [{
								calls: [{
									from: testAddress,
									to: testAddress,
									metadata,
								}],
							}],
						}],
					}),
					(error) => error instanceof Error && error.message.includes('Additional property metadata must be JSON encodeable.'),
				)
			}
			assert.equal(fetchMock.bodies.length, 0)
		} finally {
			fetchMock.restore()
		}
	})

	test('rejects non-enumerable RPC extension fields before fetching', async () => {
		const fetchMock = installBodyCapturingFetchMock(new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, result: [] }), { status: HTTP_STATUS_OK, headers: responseHeaders }))
		const requestHandler = new EthereumJSONRpcRequestHandler('https://example.invalid', true)
		const call: Record<string, unknown> = { from: testAddress, to: testAddress }
		Object.defineProperty(call, 'metadata', { value: 1n, enumerable: false })

		try {
			await assert.rejects(
				async () => await requestHandler.jsonRpcRequest({
					method: 'eth_simulateV1',
					params: [{
						blockStateCalls: [{
							calls: [call],
						}],
					}],
				}),
				(error) => error instanceof Error && error.message.includes('Additional property metadata must be JSON encodeable.'),
			)
			assert.equal(fetchMock.bodies.length, 0)
		} finally {
			fetchMock.restore()
		}
	})

	test('serializes eth_simulateV1 block author as an address', () => {
		const serialized = EthSimulateV1Result.serialize([{
			number: 1n,
			hash: 2n,
			timestamp: 3n,
			gasLimit: 4n,
			gasUsed: 5n,
			baseFeePerGas: 6n,
			author: testAddress,
			calls: [],
		}])

		assert.equal(serialized[0]?.author, '0x0000000000000000000000000000000000000001')
	})

	test('serializes eth_simulateV1 transaction block fields before JSON stringification', () => {
		const serialized = EthSimulateV1Result.serialize([{
			number: 1n,
			hash: 2n,
			timestamp: 3n,
			gasLimit: 4n,
			gasUsed: 5n,
			baseFeePerGas: 6n,
			calls: [],
			transactions: [{
				type: '1559',
				hash: 7n,
				from: testAddress,
				nonce: 8n,
				maxFeePerGas: 9n,
				maxPriorityFeePerGas: 10n,
				gas: 11n,
				to: testAddress,
				value: 12n,
				input: new Uint8Array([1]),
				chainId: 13n,
				r: 14n,
				s: 15n,
				yParity: 'even',
				data: new Uint8Array([2]),
				gasPrice: 16n,
				blockHash: 17n,
				blockNumber: 18n,
				transactionIndex: 19n,
			}],
		}])

		const transaction = serialized[0]?.transactions?.[0]
		assert.equal(typeof transaction, 'object')
		if (typeof transaction !== 'object') throw new Error('Serialized transaction must be an object.')
		assert.equal(transaction.blockHash, '0x0000000000000000000000000000000000000000000000000000000000000011')
		assert.equal(transaction.blockNumber, '0x12')
		assert.equal(transaction.transactionIndex, '0x13')
		assert.equal(transaction.gasPrice, '0x10')
		assert.equal(transaction.data, '0x02')
		assert.doesNotThrow(() => JSON.stringify(serialized))
	})

	test('rejects branch-only call result fields with non-JSON extension values', () => {
		assert.throws(
			() => EthSimulateV1Result.serialize([{
				number: 1n,
				hash: 2n,
				timestamp: 3n,
				gasLimit: 4n,
				gasUsed: 5n,
				baseFeePerGas: 6n,
				calls: [{
					status: 'success',
					returnData: new Uint8Array(),
					gasUsed: 7n,
					logs: [],
					error: 1n,
				}],
			}]),
			/error must be JSON encodeable/,
		)
		assert.throws(
			() => EthSimulateV1Result.serialize([{
				number: 1n,
				hash: 2n,
				timestamp: 3n,
				gasLimit: 4n,
				gasUsed: 5n,
				baseFeePerGas: 6n,
				calls: [{
					status: 'failure',
					returnData: new Uint8Array(),
					gasUsed: 7n,
					error: { code: 1, message: 'failed' },
					logs: [1n],
				}],
			}]),
			/logs must be JSON encodeable/,
		)
	})

	test('rejects unknown eth_simulateV1 transactions with non-JSON extension values', () => {
		for (const extensionField of ['maxFeePerGas', 'from', 'blobs']) {
			const transaction: Record<string, unknown> = {
				type: '0x99',
				hash: 7n,
			}
			transaction[extensionField] = extensionField === 'blobs' ? [1n] : 1n

			assert.throws(
				() => EthSimulateV1Result.serialize([{
					number: 1n,
					hash: 2n,
					timestamp: 3n,
					gasLimit: 4n,
					gasUsed: 5n,
					baseFeePerGas: 6n,
					calls: [],
					transactions: [transaction],
				}]),
				new RegExp(`${ extensionField } must be JSON encodeable`),
			)
		}
	})

	test('rejects signed eth_simulateV1 transactions with wrong-branch non-JSON extension values', () => {
		assert.throws(
			() => EthSimulateV1Result.serialize([{
				number: 1n,
				hash: 2n,
				timestamp: 3n,
				gasLimit: 4n,
				gasUsed: 5n,
				baseFeePerGas: 6n,
				calls: [],
				transactions: [{
					type: 'legacy',
					hash: 7n,
					from: testAddress,
					nonce: 8n,
					gasPrice: 9n,
					gas: 10n,
					to: testAddress,
					value: 11n,
					input: new Uint8Array(),
					r: 12n,
					s: 13n,
					v: 14n,
					maxFeePerGas: 15n,
				}],
			}]),
			/maxFeePerGas must be JSON encodeable/,
		)
		assert.throws(
			() => EthSimulateV1Result.serialize([{
				number: 1n,
				hash: 2n,
				timestamp: 3n,
				gasLimit: 4n,
				gasUsed: 5n,
				baseFeePerGas: 6n,
				calls: [],
				transactions: [{
					type: '1559',
					hash: 7n,
					from: testAddress,
					nonce: 8n,
					maxFeePerGas: 9n,
					maxPriorityFeePerGas: 10n,
					gas: 11n,
					to: testAddress,
					value: 12n,
					input: new Uint8Array(),
					chainId: 13n,
					r: 14n,
					s: 15n,
					yParity: 'even',
					sourceHash: 16n,
				}],
			}]),
			/sourceHash must be JSON encodeable/,
		)
	})

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

	test('keeps RPC result stable when the slow request callback fails', async () => {
		const fetchMock = installDeferredFetchMock()
		const callbackErrors: LifecycleCallbackError[] = []
		const requestHandler = new EthereumJSONRpcRequestHandler('https://example.invalid', false, {
			expectedDurationMs: 1,
			onSlowRequest: () => { throw new Error('slow request callback failed') },
			onLifecycleCallbackError: (error, request, callbackName) => callbackErrors.push({ error, request, callbackName }),
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
			onSlowRequest: (request) => slowRequests.push(request),
			onSlowRequestSettled: () => { throw new Error('slow request settle callback failed') },
			onLifecycleCallbackError: (error, request, callbackName) => callbackErrors.push({ error, request, callbackName }),
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
