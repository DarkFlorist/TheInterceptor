import { EthereumJsonRpcRequest, JsonRpcErrorResponse, JsonRpcResponse } from '../../types/JsonRpc-types.js'
import { ErrorWithData, JsonRpcResponseError } from '../../utils/errors.js'
import { EthereumQuantity, serialize } from '../../types/wire-types.js'
import { stringToBytes, keccak256 } from '../../utils/ethereumPrimitives.js'
import { fetchWithTimeout } from '../../utils/requests.js'
import { Future } from '../../utils/future.js'
import { recordBenchmarkRpcRequest } from '../../utils/benchmarking.js'
import {
	HTTP_STATUS_REQUEST_TIMEOUT,
	HTTP_STATUS_SERVER_ERROR_RANGE_START,
	HTTP_STATUS_TOO_EARLY,
	HTTP_STATUS_TOO_MANY_REQUESTS,
	JSON_RPC_ERROR_CODE_INTERNAL_ERROR,
	JSON_RPC_ERROR_CODE_LIMIT_EXCEEDED,
	JSON_RPC_ERROR_CODE_RESOURCE_UNAVAILABLE,
	TIME_BETWEEN_BLOCKS,
} from '../../utils/constants.js'

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

function isNonCacheableHttpStatus(status: number) {
	return status >= HTTP_STATUS_SERVER_ERROR_RANGE_START || TRANSIENT_HTTP_STATUS_CODES.has(status)
}

function isNonCacheableJsonRpcError(response: unknown) {
	const jsonRpcError = JsonRpcErrorResponse.safeParse(response)
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

const DEFAULT_RPC_QUERY_EXPECTED_DURATION_MS = TIME_BETWEEN_BLOCKS * 1000

export type IEthereumJSONRpcRequestHandler = Pick<EthereumJSONRpcRequestHandler, keyof EthereumJSONRpcRequestHandler>
export class EthereumJSONRpcRequestHandler {
	private nextRequestId = 1
	private caching: boolean
	private pendingCache: Map<string, Future<ResolvedResponse>>
	private cache: Map<string, ResolvedResponse>
	private rpcRequestLifecycleCallbacks: RpcRequestLifecycleCallbacks
	public rpcUrl: string

	constructor(rpcUrl: string, caching = false, rpcRequestLifecycleCallbacks: RpcRequestLifecycleCallbacks = {}) {
		this.rpcUrl = rpcUrl
		this.caching = caching
		this.cache = new Map()
		this.pendingCache = new Map()
		this.rpcRequestLifecycleCallbacks = rpcRequestLifecycleCallbacks
	}

	public readonly clearCache = () => { this.cache = new Map() }

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
				return await this.resolveResponse(response)
			} finally {
				recordBenchmarkRpcRequest(request.method, performance.now() - startedAt)
			}
		}
		const hash = keccak256(stringToBytes(JSON.stringify(serialized)))
		if (bypassCache === false) {
			const cacheValue = this.cache.get(hash)
			if (cacheValue !== undefined) return cacheValue
			const pendingCacheValue = this.pendingCache.get(hash)
			// we have already requested this, wait for it to resolve and then resolve this as well
			if (pendingCacheValue !== undefined) return await pendingCacheValue
		}
		const future = new Future<ResolvedResponse>()
		this.pendingCache.set(hash, future)
		const startedAt = performance.now()
		try {
			const response = await this.fetchWithSlowRequestWarning(request, requestId, payload, timeoutMs, requestAbortController)
			const responseObject = await this.resolveResponse(response)
			if (shouldCacheResponse(responseObject)) this.cache.set(hash, responseObject)
			future.resolve(responseObject)
		} catch(error: unknown) {
			if (requestAbortController?.signal.aborted) {
				future.reject(new Error(requestAbortController.signal.reason))
			}
			else if (error instanceof Error) {
				future.reject(error)
			} else {
				future.reject(new ErrorWithData('Unknown error', error))
			}
		} finally {
			recordBenchmarkRpcRequest(request.method, performance.now() - startedAt)
			this.pendingCache.delete(hash)
		}
		return await future
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
			const errorResponse = JsonRpcErrorResponse.safeParse(responseObject.response)
			if (errorResponse.success) throw new JsonRpcResponseError(errorResponse.value)
			throw new Error(`Query to RPC server ${ this.rpcUrl } failed with error code: ${ responseObject.status } while quering for ${ rpcRequest.method }.`)
		}
		const jsonRpcResponse = JsonRpcResponse.parse(responseObject.response)
		if ('error' in jsonRpcResponse) throw new JsonRpcResponseError(jsonRpcResponse)
		return jsonRpcResponse.result
	}
}
