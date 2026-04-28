import { EthereumJsonRpcRequest, JsonRpcErrorResponse, JsonRpcResponse } from '../../types/JsonRpc-types.js'
import { ErrorWithData, JsonRpcResponseError } from '../../utils/errors.js'
import { EthereumQuantity, serialize } from '../../types/wire-types.js'
import { keccak256, toUtf8Bytes } from 'ethers'
import { fetchWithTimeout } from '../../utils/requests.js'
import { Future } from '../../utils/future.js'
import { recordBenchmarkRpcRequest } from '../../utils/benchmarking.js'

type ResolvedResponse = { responseState: 'failed', response: Response } | { responseState: 'success', response: unknown }

export interface EthereumJSONRpcRequestHandler {
	readonly rpcUrl: string
	clearCache(): void
	getChainId(): Promise<bigint>
	jsonRpcRequest(rpcRequest: EthereumJsonRpcRequest, requestAbortController?: AbortController | undefined, bypassCache?: boolean, timeoutMs?: number): Promise<unknown>
}

export type IEthereumJSONRpcRequestHandler = Pick<EthereumJSONRpcRequestHandler, keyof EthereumJSONRpcRequestHandler>

export function EthereumJSONRpcRequestHandler(rpcUrl: string, caching = false): EthereumJSONRpcRequestHandler {
	let nextRequestId = 1
	const pendingCache = new Map<string, Future<ResolvedResponse>>()
	let cache = new Map<string, ResolvedResponse>()

	const clearCache = () => {
		cache = new Map()
	}

	const queryCached = async (
		request: EthereumJsonRpcRequest,
		requestId: number,
		bypassCache: boolean,
		timeoutMs: number,
		requestAbortController: AbortController | undefined = undefined,
	) => {
		const serialized = serialize(EthereumJsonRpcRequest, request)
		const payload = {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: requestId, ...serialized })
		}
		if (!caching) {
			const startedAt = performance.now()
			try {
				const response = await fetchWithTimeout(rpcUrl, payload, timeoutMs, requestAbortController)
				return response.ok ? { responseState: 'success' as const, response: await response.json() } : { responseState: 'failed' as const, response }
			} finally {
				recordBenchmarkRpcRequest(request.method, performance.now() - startedAt)
			}
		}
		const hash = keccak256(toUtf8Bytes(JSON.stringify(serialized)))
		if (bypassCache === false) {
			const cacheValue = cache.get(hash)
			if (cacheValue !== undefined) return cacheValue
			const pendingCacheValue = pendingCache.get(hash)
			if (pendingCacheValue !== undefined) return await pendingCacheValue
		}
		const future = new Future<ResolvedResponse>()
		pendingCache.set(hash, future)
		const startedAt = performance.now()
		try {
			const response = await fetchWithTimeout(rpcUrl, payload, timeoutMs, requestAbortController)
			const responseObject = response.ok ? { responseState: 'success' as const, response: await response.json() } : { responseState: 'failed' as const, response }
			cache.set(hash, responseObject)
			future.resolve(responseObject)
		} catch(error: unknown) {
			if (requestAbortController?.signal.aborted) {
				future.reject(new Error(requestAbortController.signal.reason))
			} else if (error instanceof Error) {
				future.reject(error)
			} else {
				future.reject(ErrorWithData('Unknown error', error))
			}
		} finally {
			recordBenchmarkRpcRequest(request.method, performance.now() - startedAt)
			pendingCache.delete(hash)
		}
		return await future
	}

	const jsonRpcRequest = async (
		rpcRequest: EthereumJsonRpcRequest,
		requestAbortController: AbortController | undefined = undefined,
		bypassCache = false,
		timeoutMs = 60000,
	) => {
		const requestId = ++nextRequestId
		const responseObject = await queryCached(rpcRequest, requestId, bypassCache, timeoutMs, requestAbortController)
		if (responseObject.responseState === 'failed') {
			// biome-ignore lint/suspicious/noConsoleLog: <Used for support debugging>
			console.log({ rpcRequest, response: responseObject.response })
			const errorResponse = JsonRpcErrorResponse.safeParse(await responseObject.response.json())
			if (errorResponse.success) throw JsonRpcResponseError(errorResponse.value)
			throw new Error(`Query to RPC server ${ rpcUrl } failed with error code: ${ responseObject.response?.status } while quering for ${ rpcRequest.method }.`)
		}
		const jsonRpcResponse = JsonRpcResponse.parse(responseObject.response)
		if ('error' in jsonRpcResponse) throw JsonRpcResponseError(jsonRpcResponse)
		return jsonRpcResponse.result
	}

	const getChainId = async () => {
		const response = await jsonRpcRequest({ method: 'eth_chainId' })
		return EthereumQuantity.parse(response)
	}

	return {
		rpcUrl,
		clearCache,
		getChainId,
		jsonRpcRequest,
	}
}
