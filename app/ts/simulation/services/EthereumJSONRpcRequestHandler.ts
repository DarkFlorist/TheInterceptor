import { EthereumJsonRpcRequest, JsonRpcErrorResponse, JsonRpcResponse } from '../../types/JsonRpc-types.js'
import { ErrorWithData, JsonRpcResponseError } from '../../utils/errors.js'
import { EthereumQuantity, serialize } from '../../types/wire-types.js'
import { keccak256, toUtf8Bytes } from 'ethers'
import { fetchWithTimeout } from '../../utils/requests.js'
import { Future } from '../../utils/future.js'

type ResolvedResponse = { responseState: 'failed', response: Response } | { responseState: 'success', response: unknown }

export type IEthereumJSONRpcRequestHandler = Pick<EthereumJSONRpcRequestHandler, keyof EthereumJSONRpcRequestHandler>
export class EthereumJSONRpcRequestHandler {
	private nextRequestId = 1
	private caching: boolean
	private pendingCache: Map<string, Future<ResolvedResponse>>
	private cache: Map<string, ResolvedResponse>
	public rpcUrl: string

	constructor(rpcUrl: string, caching = false) {
		this.rpcUrl = rpcUrl
		this.caching = caching
		this.cache = new Map()
		this.pendingCache = new Map()
	}

	public readonly clearCache = () => { this.cache = new Map() }

	private queryCached = async (request: EthereumJsonRpcRequest, requestId: number, bypassCache: boolean, timeoutMs: number, requestAbortController: AbortController | undefined = undefined) => {
		const serialized = serialize(EthereumJsonRpcRequest, request)
		const payload = {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: requestId, ...serialized })
		}
		if (!this.caching) {
			const response = await fetchWithTimeout(this.rpcUrl, payload, timeoutMs, requestAbortController)
			return response.ok ? { responseState: 'success' as const, response: await response.json() } : { responseState: 'failed' as const, response }
		}
		const hash = keccak256(toUtf8Bytes(JSON.stringify(serialized)))
		if (bypassCache === false) {
			const cacheValue = this.cache.get(hash)
			if (cacheValue !== undefined) return cacheValue
			const pendingCacheValue = this.pendingCache.get(hash)
			// we have already requested this, wait for it to resolve and then resolve this as well
			if (pendingCacheValue !== undefined) return await pendingCacheValue
		}
		const future = new Future<ResolvedResponse>()
		this.pendingCache.set(hash, future)
		try {
			const response = await fetchWithTimeout(this.rpcUrl, payload, timeoutMs, requestAbortController)
			const responseObject = response.ok ? { responseState: 'success' as const, response: await response.json() } : { responseState: 'failed' as const, response }
			this.cache.set(hash, responseObject)
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
			// biome-ignore lint/suspicious/noConsoleLog: <Used for support debugging>
			console.log({ rpcRequest, response: responseObject.response })
			const errorResponse = JsonRpcErrorResponse.safeParse(await responseObject.response.json())
			if (errorResponse.success) throw new JsonRpcResponseError(errorResponse.value)
			throw new Error(`Query to RPC server ${ this.rpcUrl } failed with error code: ${ responseObject.response?.status } while quering for ${ rpcRequest.method }.`)
		}
		const jsonRpcResponse = JsonRpcResponse.parse(responseObject.response)
		if ('error' in jsonRpcResponse) throw new JsonRpcResponseError(jsonRpcResponse)
		return jsonRpcResponse.result
	}
}
