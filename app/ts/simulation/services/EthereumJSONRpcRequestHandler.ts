import { RpcEntry } from '../../types/rpc.js'
import { EthereumJsonRpcRequest, JsonRpcResponse } from '../../types/JsonRpc-types.js'
import { FetchResponseError, JsonRpcResponseError } from '../../utils/errors.js'
import { serialize } from '../../types/wire-types.js'
import { keccak256, toUtf8Bytes } from 'ethers'
import { fetchWithTimeout } from '../../utils/requests.js'
import { Future } from '../../utils/future.js'

type ResolvedResponse = { responseState: 'failed', response: Response } | { responseState: 'success', response: unknown }

export type IEthereumJSONRpcRequestHandler = Pick<EthereumJSONRpcRequestHandler, keyof EthereumJSONRpcRequestHandler>
export class EthereumJSONRpcRequestHandler {
	private nextRequestId = 1
	private rpcEntry: RpcEntry
	private caching: boolean
	private pendingCache: Map<string, Future<ResolvedResponse>>
	private cache: Map<string, ResolvedResponse>

	constructor(rpcEntry: RpcEntry, caching = false) {
		this.rpcEntry = rpcEntry
		this.caching = caching
		this.cache = new Map()
		this.pendingCache = new Map()
	}
	public readonly getRpcEntry = () => this.rpcEntry

	public readonly clearCache = () => { this.cache = new Map() }

	private queryCached = async (request: EthereumJsonRpcRequest, requestId: number, bypassCache: boolean, timeoutMs = 60000) => {
		const serialized = serialize(EthereumJsonRpcRequest, request)
		const payload = {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: requestId, ...serialized })
		}
		if (!this.caching) {
			const response = await fetchWithTimeout(this.rpcEntry.httpsRpc, payload, timeoutMs)
			const responseObject = response.ok ? { responseState: 'success' as const, response: await response.json() } : { responseState: 'failed' as const, response }
			return responseObject
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
		const response = await fetchWithTimeout(this.rpcEntry.httpsRpc, payload, timeoutMs)
		const responseObject = response.ok ? { responseState: 'success' as const, response: await response.json() } : { responseState: 'failed' as const, response }
		this.cache.set(hash, responseObject)
		this.pendingCache.delete(hash)
		future.resolve(responseObject)
		return responseObject
	}

	public readonly jsonRpcRequest = async (rpcRequest: EthereumJsonRpcRequest, bypassCache = false, timeoutMs = 60000) => {
		const requestId = ++this.nextRequestId
		const responseObject = await this.queryCached(rpcRequest, requestId, bypassCache, timeoutMs)
		if (responseObject.responseState === 'failed') {
			console.error('RPC Request Failed')
			// biome-ignore lint/suspicious/noConsoleLog: <Used for support debugging>
			console.log({ rpcRequest, response: responseObject.response })
			throw new FetchResponseError(responseObject.response, requestId)
		}
		const jsonRpcResponse = JsonRpcResponse.parse(responseObject.response)
		if ('error' in jsonRpcResponse) throw new JsonRpcResponseError(jsonRpcResponse)
		return jsonRpcResponse.result
	}
}
