import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import type { EthereumJsonRpcRequest } from '../../app/ts/types/JsonRpc-types.js'

const rpcNetwork = {
	name: 'Ethereum Mainnet',
	chainId: 1n,
	httpsRpc: 'https://ethereum.dark.florist',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: true,
} as const

describe('EthereumClientService eth_call request shaping', () => {
	test('preserves EIP-1559 fee fields without synthesizing gasPrice', async () => {
		let capturedRequest: EthereumJsonRpcRequest | undefined
		const service = new EthereumClientService(
			{
				rpcUrl: rpcNetwork.httpsRpc,
				clearCache: () => undefined,
				getChainId: async () => rpcNetwork.chainId,
				jsonRpcRequest: async (request) => {
					capturedRequest = request
					return '0x'
				},
			},
			async () => undefined,
			async () => undefined,
			rpcNetwork,
		)

		await service.call({
			to: 0x1111111111111111111111111111111111111111n,
			from: 0x2222222222222222222222222222222222222222n,
			maxFeePerGas: 15n,
			maxPriorityFeePerGas: 3n,
		}, 'latest', undefined)

		assert.deepEqual(capturedRequest, {
			method: 'eth_call',
			params: [{
				to: 0x1111111111111111111111111111111111111111n,
				from: 0x2222222222222222222222222222222222222222n,
				maxFeePerGas: 15n,
				maxPriorityFeePerGas: 3n,
			}, 'latest']
		})
	})
})
