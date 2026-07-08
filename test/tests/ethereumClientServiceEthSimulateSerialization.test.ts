import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import { JsonRpcResponse } from '../../app/ts/types/JsonRpc-types.js'
import { EthSimulateV1Params } from '../../app/ts/types/ethSimulate-types.js'
import { serialize } from '../../app/ts/types/wire-types.js'
import { eth_getBlockByNumber_goerli_8443561_true } from '../RPCResponses.js'

const rpcEntry = {
	name: 'Testnet',
	chainId: 1n,
	httpsRpc: 'https://example.invalid',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: true,
} as const

function parseRpcResult<T>(data: string): T {
	const response = JsonRpcResponse.parse(JSON.parse(data))
	if ('error' in response) throw new Error(`Ethereum Client Error: ${ response.error.message }`)
	return response.result as T
}

describe('EthereumClientService eth_simulateV1 serialization', () => {
	test('builds a JSON-safe request without internal transaction hash fields', async () => {
		const service = new EthereumClientService(
			{
				rpcUrl: rpcEntry.httpsRpc,
				clearCache: () => undefined,
				async getChainId() { return rpcEntry.chainId },
				async jsonRpcRequest(request) {
					if (request.method !== 'eth_getBlockByNumber') throw new Error(`Unexpected RPC method: ${ request.method }`)
					return parseRpcResult(eth_getBlockByNumber_goerli_8443561_true)
				},
			},
			async () => undefined,
			async () => undefined,
			rpcEntry,
		)

		const prepared = await service.prepareEthSimulateV1Input([{
			stateOverrides: {},
			transactions: [{
				signedTransaction: {
					type: '1559',
					from: 0x1111111111111111111111111111111111111111n,
					nonce: 0n,
					maxFeePerGas: 2n,
					maxPriorityFeePerGas: 1n,
					gas: 21_000n,
					to: 0x2222222222222222222222222222222222222222n,
					value: 0n,
					input: new Uint8Array([0x12, 0x34]),
					chainId: 1n,
					r: 0n,
					s: 0n,
					v: 0n,
					yParity: 'even',
					hash: 0x1234n,
				},
			}],
			signedMessages: [],
			blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 0n, deltaUnit: 'Seconds' },
			simulateWithZeroBaseFee: false,
		}], 1n, undefined)

		const serializedRequest = serialize(EthSimulateV1Params, prepared.request)
		const serializedCall = serializedRequest.params[0].blockStateCalls[0]?.calls[0]
		if (serializedCall === undefined) throw new Error('missing serialized eth_simulateV1 call')
		assert.equal(serializedCall.yParity, '0x0')
		assert.equal(serializedCall.v, '0x0')
		const serialized = JSON.stringify(serializedRequest)
		assert.doesNotMatch(serialized, /"hash":/)
	})
})
