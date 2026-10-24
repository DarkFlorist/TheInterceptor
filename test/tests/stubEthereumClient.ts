// A real EthereumClientService over an in-memory request handler, for tests whose code under test takes a client but must never reach a node.
//
// Usage:
//   const ethereum = createStubEthereumClient()                                    // every RPC request rejects
//   const ethereum = createStubEthereumClient(async (request) => request.method === 'eth_getCode' ? '0x' : rejectRpcRequest(request))
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import type { IEthereumJSONRpcRequestHandler } from '../../app/ts/simulation/services/EthereumJSONRpcRequestHandler.js'
import type { EthereumJsonRpcRequest } from '../../app/ts/types/JsonRpc-types.js'
import type { RpcEntry } from '../../app/ts/types/rpc.js'

export const stubRpcNetwork: RpcEntry = {
	name: 'Test Chain',
	chainId: 1337n,
	httpsRpc: 'https://example.invalid',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: true,
}

export const rejectRpcRequest = async (request: EthereumJsonRpcRequest): Promise<never> => {
	throw new Error(`Unexpected RPC method: ${ request.method }`)
}

export function createStubEthereumClient(jsonRpcRequest: IEthereumJSONRpcRequestHandler['jsonRpcRequest'] = rejectRpcRequest, rpcNetwork: RpcEntry = stubRpcNetwork) {
	const requestHandler: IEthereumJSONRpcRequestHandler = {
		rpcUrl: rpcNetwork.httpsRpc,
		clearCache: () => undefined,
		getChainId: async () => rpcNetwork.chainId,
		jsonRpcRequest,
	}
	return new EthereumClientService(requestHandler, async () => undefined, async () => undefined, rpcNetwork)
}
