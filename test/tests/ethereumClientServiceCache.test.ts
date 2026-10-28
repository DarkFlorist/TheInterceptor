import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import { EthereumBlockHeader } from '../../app/ts/types/wire-types.js'
import { TIME_BETWEEN_BLOCKS, MAX_BLOCK_CACHE } from '../../app/ts/utils/constants.js'
import { eth_getBlockByNumber_goerli_8443561_true } from '../RPCResponses.js'
import { parseJsonRpcResult, readJsonRpcResult } from './rpcResponseParsing.js'

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
				jsonRpcRequest: async () => readJsonRpcResult(eth_getBlockByNumber_goerli_8443561_true),
			},
			async () => undefined,
			async () => undefined,
			rpcNetwork,
		)

		const block = parseJsonRpcResult(eth_getBlockByNumber_goerli_8443561_true, EthereumBlockHeader)
		assert.ok(block !== null, 'the block fixture must contain a block')
		Reflect.set(service, 'cachedBlock', {
			...block,
			timestamp: new Date(Date.now() - (TIME_BETWEEN_BLOCKS * MAX_BLOCK_CACHE + 1) * 1000),
		})

		assert.equal(service.getCachedBlock(), undefined)
	})
})
