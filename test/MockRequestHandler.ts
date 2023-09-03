import { EthereumJsonRpcRequest } from '../app/ts/types/JsonRpc-types.js'

export class MockRequestHandler {
	public readonly jsonRpcRequest = async (rpcRequest: EthereumJsonRpcRequest) => {
		if (rpcRequest.method === 'eth_getCode') return '0x'
		console.log(rpcRequest)
		throw new Error(`should not be called`)
	}
	
	public readonly getRpcNetwork = () => ({
		name: 'Goerli',
		chainId: 5n,
		httpsRpc: 'https://rpc-goerli.dark.florist/flipcardtrustone',
		currencyName: 'Goerli Testnet ETH',
		currencyTicker: 'GÖETH',
		primary: true,
		minimized: true,
		weth: 0xb4fbf271143f4fbf7b91a5ded31805e42b2208d6n,
	})
}
