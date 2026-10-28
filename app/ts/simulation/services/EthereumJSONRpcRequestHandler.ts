import { EthereumJsonRpcRequest, type JsonRpcErrorResponse, ProviderJsonRpcErrorResponse, ProviderJsonRpcResponse } from '../../types/JsonRpc-types.js'
import { ErrorWithData, JsonRpcResponseError } from '../../utils/errors.js'
import { EthereumQuantity, serialize } from '../../types/wire-types.js'
import { stringToBytes, keccak256 } from '../../utils/ethereumPrimitives.js'
import { fetchWithTimeout } from '../../utils/requests.js'
import { recordBenchmarkRpcRequest } from '../../utils/benchmarking.js'
import { HTTP_STATUS_REQUEST_TIMEOUT, HTTP_STATUS_SERVER_ERROR_RANGE_START, HTTP_STATUS_TOO_EARLY, HTTP_STATUS_TOO_MANY_REQUESTS, JSON_RPC_ERROR_CODE_INTERNAL_ERROR, JSON_RPC_ERROR_CODE_LIMIT_EXCEEDED, JSON_RPC_ERROR_CODE_RESOURCE_UNAVAILABLE, TIME_BETWEEN_BLOCKS } from '../../utils/constants.js'

type ResolvedResponse = { responseState: 'failed', status: number, response: unknown } | { responseState: 'success', response: unknown }
export type SlowRpcRequest = {
	requestId: number
	rpcUrl: string
	method: string
	startedAt: Date
}
export type RpcRequestLifecycleCallbackName = 'onSlowRequest' | 'onSlowRequestSettled'

export type RpcRequestLifecycleCallbacks = {
	expectedDurationMs?: number
	onSlowRequest?: (request: SlowRpcRequest) => void | Promise<void>
	onSlowRequestSettled?: (request: SlowRpcRequest) => void | Promise<void>
	onLifecycleCallbackError?: (error: unknown, request: SlowRpcRequest, callbackName: RpcRequestLifecycleCallbackName) => void | Promise<void>
}

const TRANSIENT_HTTP_STATUS_CODES = new Set([
	HTTP_STATUS_REQUEST_TIMEOUT,
	HTTP_STATUS_TOO_EARLY,
	HTTP_STATUS_TOO_MANY_REQUESTS,
])

const TRANSIENT_JSON_RPC_ERROR_CODES = new Set([
	JSON_RPC_ERROR_CODE_INTERNAL_ERROR,
	JSON_RPC_ERROR_CODE_RESOURCE_UNAVAILABLE,
	JSON_RPC_ERROR_CODE_LIMIT_EXCEEDED,
])

// Only string error data (revert data) leaves the request boundary, so websites, popups and stored state receive the string-typed JsonRpcErrorResponse; other provider shapes, such as rate-limit objects, are dropped here.
const toJsonRpcErrorResponse = (response: ProviderJsonRpcErrorResponse): JsonRpcErrorResponse => {
	const { data, ...error } = response.error
	return { ...response, error: typeof data === 'string' ? { ...error, data } : error }
}

function isNonCacheableHttpStatus(status: number) {
	return status >= HTTP_STATUS_SERVER_ERROR_RANGE_START || TRANSIENT_HTTP_STATUS_CODES.has(status)
}

function isNonCacheableJsonRpcError(response: unknown) {
	const jsonRpcError = ProviderJsonRpcErrorResponse.safeParse(response)
	if (!jsonRpcError.success) return false
	return TRANSIENT_JSON_RPC_ERROR_CODES.has(jsonRpcError.value.error.code)
}

function shouldCacheResponse(response: ResolvedResponse) {
	if (response.responseState === 'failed') {
		if (isNonCacheableHttpStatus(response.status)) return false
		return !isNonCacheableJsonRpcError(response.response)
	}
	return !isNonCacheableJsonRpcError(response.response)
}

function assertMatchingJsonRpcResponseId(response: ResolvedResponse, requestId: number) {
	const rawResponse = response.response
	if (typeof rawResponse !== 'object' || rawResponse === null || !('id' in rawResponse) || rawResponse.id === requestId) return
	throw new ErrorWithData(`RPC response ID ${ String(rawResponse.id) } did not match request ID ${ requestId }.`, {
		requestId,
		responseId: rawResponse.id,
	})
}

const DEFAULT_RPC_QUERY_EXPECTED_DURATION_MS = TIME_BETWEEN_BLOCKS * 1000

// Identical requests share one fetch only within a cache generation (clearCache starts a new one on every block). The shared fetch has its own AbortController: each caller races it against the caller's own abort signal, so one caller's abort ends only that caller's wait, never fails another caller, and the fetch is cancelled once every waiter has aborted. The fetch is sent with the first caller's request id and timeout, so its response id is checked against that id; later callers only wait for the response.
type SharedRpcRequest = {
	readonly response: Promise<ResolvedResponse>
	readonly fetchAbortController: AbortController
	waiterCount: number
}

type RpcCacheGeneration = {
	readonly responses: Map<string, ResolvedResponse>
	readonly pendingRequests: Map<string, SharedRpcRequest>
}

const createRpcCacheGeneration = (): RpcCacheGeneration => ({ responses: new Map(), pendingRequests: new Map() })

const forgetPendingRequest = (generation: RpcCacheGeneration, hash: string, sharedRequest: SharedRpcRequest) => {
	if (generation.pendingRequests.get(hash) === sharedRequest) generation.pendingRequests.delete(hash)
}

const createRequestAbortError = (signal: AbortSignal) => new Error(signal.reason)

const toRequestError = (error: unknown) => error instanceof Error ? error : new ErrorWithData('Unknown error', error)

const waitForSharedRequest = async (generation: RpcCacheGeneration, hash: string, sharedRequest: SharedRpcRequest, abortSignal: AbortSignal | undefined) => await new Promise<ResolvedResponse>((resolve, reject) => {
	let isWaiting = true
	const stopWaiting = () => {
		if (!isWaiting) return false
		isWaiting = false
		sharedRequest.waiterCount -= 1
		abortSignal?.removeEventListener('abort', abortWaiting)
		return true
	}
	const abortWaiting = () => {
		if (abortSignal === undefined || !stopWaiting()) return
		if (sharedRequest.waiterCount === 0) {
			forgetPendingRequest(generation, hash, sharedRequest)
			sharedRequest.fetchAbortController.abort(abortSignal.reason)
		}
		reject(createRequestAbortError(abortSignal))
	}
	sharedRequest.waiterCount += 1
	if (abortSignal?.aborted === true) {
		abortWaiting()
		return
	}
	abortSignal?.addEventListener('abort', abortWaiting)
	sharedRequest.response.then((response) => {
		if (stopWaiting()) resolve(response)
	}, (error: unknown) => {
		if (stopWaiting()) reject(toRequestError(error))
	})
})

export type IEthereumJSONRpcRequestHandler = Pick<EthereumJSONRpcRequestHandler, keyof EthereumJSONRpcRequestHandler>
export class EthereumJSONRpcRequestHandler {
	private nextRequestId = 1
	private caching: boolean
	private cacheGeneration: RpcCacheGeneration
	private rpcRequestLifecycleCallbacks: RpcRequestLifecycleCallbacks
	public rpcUrl: string

	constructor(rpcUrl: string, caching = false, rpcRequestLifecycleCallbacks: RpcRequestLifecycleCallbacks = {}) {
		this.rpcUrl = rpcUrl
		this.caching = caching
		this.cacheGeneration = createRpcCacheGeneration()
		this.rpcRequestLifecycleCallbacks = rpcRequestLifecycleCallbacks
	}

	public readonly clearCache = () => { this.cacheGeneration = createRpcCacheGeneration() }

	private readonly resolveResponse = async (response: Response): Promise<ResolvedResponse> => {
		if (response.ok) return { responseState: 'success', response: await response.json() }
		return {
			responseState: 'failed',
			status: response.status,
			response: await response.json().catch(() => undefined),
		}
	}

	private readonly reportLifecycleCallbackError = (error: unknown, request: SlowRpcRequest, callbackName: RpcRequestLifecycleCallbackName) => {
		const errorReporter = this.rpcRequestLifecycleCallbacks.onLifecycleCallbackError
		if (errorReporter === undefined) return
		try {
			void Promise.resolve(errorReporter(error, request, callbackName)).catch((reportingError: unknown) => {
				console.warn('RPC request lifecycle error reporter failed.')
				console.warn(reportingError)
			})
		} catch(reportingError: unknown) {
			console.warn('RPC request lifecycle error reporter failed.')
			console.warn(reportingError)
		}
	}

	private readonly callRpcRequestLifecycleCallback = (callbackName: RpcRequestLifecycleCallbackName, request: SlowRpcRequest) => {
		const callback = this.rpcRequestLifecycleCallbacks[callbackName]
		if (callback === undefined) return
		try {
			void Promise.resolve(callback(request)).catch((error: unknown) => {
				this.reportLifecycleCallbackError(error, request, callbackName)
			})
		} catch(error: unknown) {
			this.reportLifecycleCallbackError(error, request, callbackName)
		}
	}

	private readonly fetchWithSlowRequestWarning = async (request: EthereumJsonRpcRequest, requestId: number, payload: RequestInit, timeoutMs: number, requestAbortController: AbortController | undefined) => {
		const startedAt = new Date()
		const slowRequest = {
			requestId,
			rpcUrl: this.rpcUrl,
			method: request.method,
			startedAt,
		}
		let wasSlowRequestReported = false
		const expectedDurationMs = this.rpcRequestLifecycleCallbacks.expectedDurationMs ?? DEFAULT_RPC_QUERY_EXPECTED_DURATION_MS
		const warningTimeoutId = setTimeout(() => {
			wasSlowRequestReported = true
			this.callRpcRequestLifecycleCallback('onSlowRequest', slowRequest)
		}, expectedDurationMs)
		try {
			return await fetchWithTimeout(this.rpcUrl, payload, timeoutMs, requestAbortController)
		} finally {
			clearTimeout(warningTimeoutId)
			if (wasSlowRequestReported) this.callRpcRequestLifecycleCallback('onSlowRequestSettled', slowRequest)
		}
	}

	private queryCached = async (request: EthereumJsonRpcRequest, requestId: number, bypassCache: boolean, timeoutMs: number, requestAbortController: AbortController | undefined = undefined) => {
		const serialized = serialize(EthereumJsonRpcRequest, request)
		const payload = {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: requestId, ...serialized })
		}
		if (!this.caching) {
			const startedAt = performance.now()
			try {
				const response = await this.fetchWithSlowRequestWarning(request, requestId, payload, timeoutMs, requestAbortController)
				const responseObject = await this.resolveResponse(response)
				assertMatchingJsonRpcResponseId(responseObject, requestId)
				return responseObject
			} finally {
				recordBenchmarkRpcRequest(request.method, performance.now() - startedAt)
			}
		}
		const hash = keccak256(stringToBytes(JSON.stringify(serialized)))
		const generation = this.cacheGeneration
		if (bypassCache === false) {
			const cacheValue = generation.responses.get(hash)
			if (cacheValue !== undefined) return cacheValue
			const pendingRequest = generation.pendingRequests.get(hash)
			if (pendingRequest !== undefined) return await waitForSharedRequest(generation, hash, pendingRequest, requestAbortController?.signal)
		}
		if (requestAbortController?.signal.aborted === true) throw createRequestAbortError(requestAbortController.signal)
		const fetchAbortController = new AbortController()
		const fetchResponse = async () => {
			const startedAt = performance.now()
			try {
				const response = await this.fetchWithSlowRequestWarning(request, requestId, payload, timeoutMs, fetchAbortController)
				const responseObject = await this.resolveResponse(response)
				assertMatchingJsonRpcResponseId(responseObject, requestId)
				if (shouldCacheResponse(responseObject)) generation.responses.set(hash, responseObject)
				return responseObject
			} finally {
				recordBenchmarkRpcRequest(request.method, performance.now() - startedAt)
			}
		}
		const sharedRequest: SharedRpcRequest = { response: fetchResponse(), fetchAbortController, waiterCount: 0 }
		generation.pendingRequests.set(hash, sharedRequest)
		const forgetSettledRequest = () => forgetPendingRequest(generation, hash, sharedRequest)
		void sharedRequest.response.then(forgetSettledRequest, forgetSettledRequest)
		return await waitForSharedRequest(generation, hash, sharedRequest, requestAbortController?.signal)
	}

	public getChainId = async () => {
		const response = await this.jsonRpcRequest({ method: 'eth_chainId' })
		return EthereumQuantity.parse(response)
	}

	public readonly jsonRpcRequest = async (rpcRequest: EthereumJsonRpcRequest, requestAbortController: AbortController | undefined = undefined, bypassCache = false, timeoutMs = 60000) => {
		const requestId = ++this.nextRequestId
		const responseObject = await this.queryCached(rpcRequest, requestId, bypassCache, timeoutMs, requestAbortController)
		if (responseObject.responseState === 'failed') {
			console.warn({ rpcRequest, response: responseObject.response })
			const errorResponse = ProviderJsonRpcErrorResponse.safeParse(responseObject.response)
			if (errorResponse.success) throw new JsonRpcResponseError(toJsonRpcErrorResponse(errorResponse.value))
			throw new Error(`Query to RPC server ${ this.rpcUrl } failed with error code: ${ responseObject.status } while quering for ${ rpcRequest.method }.`)
		}
		const jsonRpcResponse = ProviderJsonRpcResponse.parse(responseObject.response)
		if ('error' in jsonRpcResponse) throw new JsonRpcResponseError(toJsonRpcErrorResponse(jsonRpcResponse))
		return jsonRpcResponse.result
	}
}
