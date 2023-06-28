import { RpcNetwork } from '../../utils/visualizer-types.js'
import { assertIsObject } from '../../utils/typescript.js'
import { EthereumJsonRpcRequest, JsonRpcResponse } from '../../utils/wire-types.js'
import { FetchResponseError, JsonRpcResponseError } from '../../utils/errors.js'

export type IEthereumJSONRpcRequestHandler = Pick<EthereumJSONRpcRequestHandler, keyof EthereumJSONRpcRequestHandler>
export class EthereumJSONRpcRequestHandler {
	private nextRequestId: number = 1
	private rpcNetwork: RpcNetwork

	constructor(rpcNetwork: RpcNetwork) {
		this.rpcNetwork = rpcNetwork
    }
	public readonly getRpcNetwork = () => this.rpcNetwork

	public readonly jsonRpcRequest = async (rpcRequest: EthereumJsonRpcRequest) => {
		const serialized = EthereumJsonRpcRequest.serialize(rpcRequest)
		assertIsObject(serialized)
		const requestBodyJson = {
			jsonrpc: '2.0',
			id: ++this.nextRequestId,
			...serialized,
		}
		const response = await fetch(`${ this.rpcNetwork.httpsRpc }`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(requestBodyJson)
		})
		if (!response.ok) throw new FetchResponseError(response, requestBodyJson.id)
		const jsonRpcResponse = JsonRpcResponse.parse(await response.json())
		if ('error' in jsonRpcResponse) throw new JsonRpcResponseError(jsonRpcResponse)
		return jsonRpcResponse.result
	}
}
