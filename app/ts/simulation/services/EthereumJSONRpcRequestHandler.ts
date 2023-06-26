import { assertIsObject } from '../../utils/typescript.js'
import { EthereumJsonRpcRequest, JsonRpcResponse } from '../../utils/wire-types.js'

export type IEthereumJSONRpcRequestHandler = Pick<EthereumJSONRpcRequestHandler, keyof EthereumJSONRpcRequestHandler>
export class EthereumJSONRpcRequestHandler {
	private nextRequestId: number = 1
	private endpoint: string

	constructor(endpoint: string) {
		this.endpoint = endpoint
    }
	public readonly getRPCUrl = () => this.endpoint

	public readonly jsonRpcRequest = async (rpcRequest: EthereumJsonRpcRequest) => {
		const serialized = EthereumJsonRpcRequest.serialize(rpcRequest)
		assertIsObject(serialized)
		const requestBodyJson = JSON.stringify({
			jsonrpc: '2.0',
			id: ++this.nextRequestId,
			...serialized,
		})
		const response = await fetch(`${ this.endpoint }`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: requestBodyJson
		})
		if (!response.ok) throw new Error(`Ethereum Client Error: ${ response.status }: ${ response.statusText }`)
		const jsonRpcResponse = JsonRpcResponse.parse(await response.json())
		if ('error' in jsonRpcResponse) throw Error(`Ethereum Client Error: ${ jsonRpcResponse.error.message }`)
		return jsonRpcResponse.result
	}
}
