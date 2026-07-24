import { describe, test } from 'bun:test'
import * as assert from 'assert'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import type { EthereumJsonRpcRequest } from '../../app/ts/types/JsonRpc-types.js'
import type { RpcEntry } from '../../app/ts/types/rpc.js'
import { toResolvedSimulationInput } from '../../app/ts/types/visualizer-types.js'
import { bytes32String } from '../../app/ts/utils/bigint.js'

Object.defineProperty(globalThis, 'chrome', {
	value: { runtime: { id: 'test-extension' } },
	configurable: true,
	writable: true,
})

const { getStorageAt } = await import('../../app/ts/background/simulationModeHanders.js')

const rpcEntry = {
	name: 'Handler test RPC',
	chainId: 1n,
	httpsRpc: 'https://rpc.example.test',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: false,
} satisfies RpcEntry

describe('simulation mode handlers', () => {
	test('getStorageAt uses its Ethereum client parameter', async () => {
		const rpcRequests: EthereumJsonRpcRequest[] = []
		const ethereumClientService = new EthereumClientService({
			rpcUrl: rpcEntry.httpsRpc,
			clearCache: () => undefined,
			getChainId: async () => rpcEntry.chainId,
			jsonRpcRequest: async (request) => {
				rpcRequests.push(request)
				if (request.method !== 'eth_getStorageAt') throw new Error(`Unexpected RPC request: ${ request.method }`)
				return bytes32String(0x1234n)
			},
		}, async () => undefined, async () => undefined, rpcEntry)
		const request = {
			method: 'eth_getStorageAt',
			params: [0x1234n, 0x42n, 'latest'],
		} as const

		const reply = await getStorageAt(
			ethereumClientService,
			toResolvedSimulationInput([]),
			request,
		)

		assert.deepEqual(reply, {
			type: 'result',
			method: 'eth_getStorageAt',
			result: 0x1234n,
		})
		assert.deepEqual(rpcRequests, [request])
	})
})
