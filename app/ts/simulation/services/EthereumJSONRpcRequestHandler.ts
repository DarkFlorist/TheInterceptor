import { RpcEntry } from '../../types/rpc.js'
import { assertIsObject } from '../../utils/typescript.js'
import { EthereumJsonRpcRequest, JsonRpcResponse } from '../../types/JsonRpc-types.js'
import { FetchResponseError, JsonRpcResponseError } from '../../utils/errors.js'
import { serialize } from '../../types/wire-types.js'
import { keccak256, toUtf8Bytes } from 'ethers'
import { fetchWithTimeout } from '../../utils/requests.js'

export type IEthereumJSONRpcRequestHandler = Pick<EthereumJSONRpcRequestHandler, keyof EthereumJSONRpcRequestHandler>
export class EthereumJSONRpcRequestHandler {
	private nextRequestId: number = 1
	private rpcEntry: RpcEntry
	private caching: boolean
	private cache: Map<string, { responseOk: false, response: Response } | { responseOk: true, responseString: string }>

	constructor(rpcEntry: RpcEntry, caching: boolean = false) {
		this.rpcEntry = rpcEntry
		this.caching = caching
		this.cache = new Map()
    }
	public readonly getRpcEntry = () => this.rpcEntry

	public readonly clearCache = () => { this.cache = new Map() }

	private queryCached = async (request: EthereumJsonRpcRequest, requestId: number, bypassCache: boolean, timeoutS: number = 60000) => {
		const serialized = serialize(EthereumJsonRpcRequest, request)
		assertIsObject(serialized)
		const payload = {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: requestId, ...serialized })
		}
		const hash = this.caching ? keccak256(toUtf8Bytes(JSON.stringify(serialized))) : ''
		if (this.caching) {
			const hash = keccak256(toUtf8Bytes(JSON.stringify(serialized)))
			if (bypassCache === false) {
				const cacheValue = this.cache.get(hash)
				if (cacheValue !== undefined) return cacheValue
			}
		}
		const response = await fetchWithTimeout(this.rpcEntry.httpsRpc, payload, timeoutS)
		const responseObject = response.ok ? { responseOk: true as const, responseString: await response.json() } : { responseOk: false as const, response }
		if (this.caching) this.cache.set(hash, responseObject)
		return responseObject
	}

	public readonly jsonRpcRequest = async (rpcRequest: EthereumJsonRpcRequest, bypassCache: boolean = false, timeoutS: number = 60000) => {
		const requestId = ++this.nextRequestId
		const responseObject = await this.queryCached(rpcRequest, requestId, bypassCache, timeoutS)
		if (!responseObject.responseOk) {
			console.log('req failed')
			console.log(responseObject.response)
			console.log(rpcRequest)
			throw new FetchResponseError(responseObject.response, requestId)
		}
		const jsonRpcResponse = JsonRpcResponse.parse(responseObject.responseString)
		if ('error' in jsonRpcResponse) {
			console.log('req failed')
			console.log(responseObject)
			console.log(rpcRequest)
			throw new JsonRpcResponseError(jsonRpcResponse)
		}
		return jsonRpcResponse.result
	}
}
