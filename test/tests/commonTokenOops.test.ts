import { describe, test } from 'bun:test'
import * as assert from 'node:assert'
import type { Abi } from '../../app/ts/utils/ethereumPrimitives.js'
import { commonTokenOops } from '../../app/ts/simulation/protectors/commonTokenOops.js'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import type { IEthereumJSONRpcRequestHandler } from '../../app/ts/simulation/services/EthereumJSONRpcRequestHandler.js'
import { UNISWAP_V2_ROUTER_ADDRESS } from '../../app/ts/utils/constants.js'
import { addressString } from '../../app/ts/utils/bigint.js'
import { encodeFunctionCall } from '../../app/ts/utils/abiRuntime.js'
import { EthereumUnsignedTransaction } from '../../app/ts/types/wire-types.js'
import type { EthereumJsonRpcRequest } from '../../app/ts/types/JsonRpc-types.js'
import { installBrowserMock } from '../harness/browserMock.js'
import { failedSimulationState, mainnetRpcEntry } from './protectorTestHarness.js'

installBrowserMock()

const transferAbi = [
	{
		type: 'function',
		name: 'transfer',
		stateMutability: 'nonpayable',
		inputs: [
			{ name: 'to', type: 'address' },
			{ name: 'value', type: 'uint256' },
		],
		outputs: [{ name: 'success', type: 'bool' }],
	},
] as const satisfies Abi

const requestHandler: IEthereumJSONRpcRequestHandler = {
	rpcUrl: mainnetRpcEntry.httpsRpc,
	clearCache() {
		return undefined
	},
	async getChainId() {
		return mainnetRpcEntry.chainId
	},
	async jsonRpcRequest(request: EthereumJsonRpcRequest) {
		throw new Error(`Unexpected RPC method: ${ request.method }`)
	},
}

const ethereum = new EthereumClientService(requestHandler, async () => undefined, async () => undefined, mainnetRpcEntry)

describe('commonTokenOops', () => {
	test('warns when a known token is transferred directly to a router contract', async () => {
		const transaction = EthereumUnsignedTransaction.parse({
			type: undefined,
			from: '0x0000000000000000000000000000000000000001',
			nonce: '0x0',
			gasPrice: '0x1',
			gas: '0x5208',
			to: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
			value: '0x0',
			input: encodeFunctionCall(transferAbi, 'transfer', [addressString(UNISWAP_V2_ROUTER_ADDRESS), 1n]),
		})

		const result = await commonTokenOops(transaction, ethereum, undefined, failedSimulationState)

		assert.equal(result, 'Attempt to send tokens to a contract (Uniswap V2 Router 02) that cannot receive such tokens')
	})
})
