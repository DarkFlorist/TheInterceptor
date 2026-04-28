import { EthereumJsonRpcRequest } from '../app/ts/types/JsonRpc-types.js'

export interface MockRequestHandler {
	readonly rpcUrl: string
	jsonRpcRequest(rpcEntry: EthereumJsonRpcRequest): Promise<string>
	clearCache(): void
	getChainId(): Promise<bigint>
}

export function MockRequestHandler(): MockRequestHandler {
	return {
		rpcUrl: 'https://rpc-goerli.dark.florist/flipcardtrustone',
		async jsonRpcRequest(rpcEntry: EthereumJsonRpcRequest) {
			if (rpcEntry.method === 'eth_getCode') return '0x'
			throw new Error('should not be called')
		},
		clearCache() {},
		async getChainId() { return 5n },
	}
}
