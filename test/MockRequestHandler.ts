import { EthereumJsonRpcRequest } from '../app/ts/types/JsonRpc-types.js'

export class MockRequestHandler {
	public rpcUrl = 'https://rpc-goerli.dark.florist/flipcardtrustone'

	public readonly jsonRpcRequest = async (rpcEntry: EthereumJsonRpcRequest) => {
		if (rpcEntry.method === 'eth_getCode') return '0x'
		throw new Error('should not be called')
	}

	public clearCache = () => {}

	public getChainId = async () => 5n
}
