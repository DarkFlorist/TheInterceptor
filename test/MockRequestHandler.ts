import type { EthereumJsonRpcRequest } from '../app/ts/types/JsonRpc-types.js'
import type { IEthereumJSONRpcRequestHandler } from '../app/ts/simulation/services/EthereumJSONRpcRequestHandler.js'

// Goerli request handler that answers eth_getCode with empty code and fails every other RPC request.
export const createMockRequestHandler = (): IEthereumJSONRpcRequestHandler => ({
	rpcUrl: 'https://rpc-goerli.dark.florist/flipcardtrustone',
	jsonRpcRequest: async (rpcEntry: EthereumJsonRpcRequest) => {
		if (rpcEntry.method === 'eth_getCode') return '0x'
		throw new Error('should not be called')
	},
	clearCache: () => undefined,
	getChainId: async () => 5n,
})
