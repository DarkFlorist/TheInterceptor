import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import { JsonRpcResponse } from '../../app/ts/types/JsonRpc-types.js'
import { TIME_BETWEEN_BLOCKS, MAX_BLOCK_CACHE } from '../../app/ts/utils/constants.js'
import { eth_getBlockByNumber_goerli_8443561_true } from '../RPCResponses.js'

function parseRequest<T>(data: string): T {
	const jsonRpcResponse = JsonRpcResponse.parse(JSON.parse(data))
	if ('error' in jsonRpcResponse) throw Error(`Ethereum Client Error: ${ jsonRpcResponse.error.message }`)
	return jsonRpcResponse.result as T
}

const rpcNetwork = {
	name: 'Goerli',
	chainId: 5n,
	httpsRpc: 'https://rpc.dark.florist/flipcardtrustone',
	currencyName: 'Goerli Testnet ETH',
	currencyTicker: 'GÖETH',
	primary: true,
	minimized: true,
	weth: 0xb4fbf271143f4fbf7b91a5ded31805e42b2208d6n,
} as const

describe('EthereumClientService cache expiry', () => {
	test('invalidates cached blocks once they are older than the configured TTL', () => {
		const service = new EthereumClientService(
			{
				rpcUrl: rpcNetwork.httpsRpc,
				clearCache: () => undefined,
				getChainId: async () => rpcNetwork.chainId,
				jsonRpcRequest: async () => parseRequest(eth_getBlockByNumber_goerli_8443561_true),
			},
			async () => undefined,
			async () => undefined,
			rpcNetwork,
		)

		const block = parseRequest<NonNullable<ReturnType<typeof service.getCachedBlock>>>(eth_getBlockByNumber_goerli_8443561_true)
		Reflect.set(service, 'cachedBlock', {
			...block,
			timestamp: new Date(Date.now() - (TIME_BETWEEN_BLOCKS * MAX_BLOCK_CACHE + 1) * 1000),
		})

		assert.equal(service.getCachedBlock(), undefined)
	})
})
