import { describe, test } from 'bun:test'
import * as assert from 'assert'
import type { Abi } from '../../app/ts/utils/ethereumPrimitives.js'
import { commonTokenOops } from '../../app/ts/simulation/protectors/commonTokenOops.js'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import type { IEthereumJSONRpcRequestHandler } from '../../app/ts/simulation/services/EthereumJSONRpcRequestHandler.js'
import { UNISWAP_V2_ROUTER_ADDRESS } from '../../app/ts/utils/constants.js'
import { addressString } from '../../app/ts/utils/bigint.js'
import { encodeFunctionCall } from '../../app/ts/utils/abiRuntime.js'
import type { SimulationState } from '../../app/ts/types/visualizer-types.js'
import { EthereumUnsignedTransaction } from '../../app/ts/types/wire-types.js'
import type { EthereumJsonRpcRequest } from '../../app/ts/types/JsonRpc-types.js'

const storageState: Record<string, unknown> = {}

const installBrowserMock = () => {
	const browser = {
		storage: {
			local: {
				async get(keys?: string | readonly string[] | Record<string, unknown>) {
					if (keys === undefined) return { ...storageState }
					if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, storageState[key]]))
					if (typeof keys === 'string') return { [keys]: storageState[keys] }
					return Object.fromEntries(Object.entries(keys).map(([key, defaultValue]) => [key, key in storageState ? storageState[key] : defaultValue]))
				},
				async set(items: Record<string, unknown>) {
					Object.assign(storageState, items)
				},
				async remove(keys: string | readonly string[]) {
					for (const key of Array.isArray(keys) ? keys : [keys]) delete storageState[key]
				},
			},
		},
	}
	Reflect.set(globalThis, 'browser', browser)
	Reflect.set(globalThis, 'chrome', { runtime: { id: 'test-extension' } })
}

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

const rpcEntry = {
	name: 'Ethereum Mainnet',
	chainId: 1n,
	httpsRpc: 'https://ethereum.dark.florist',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: true,
}

const requestHandler: IEthereumJSONRpcRequestHandler = {
	rpcUrl: rpcEntry.httpsRpc,
	clearCache() {
		return undefined
	},
	async getChainId() {
		return rpcEntry.chainId
	},
	async jsonRpcRequest(request: EthereumJsonRpcRequest) {
		throw new Error(`Unexpected RPC method: ${ request.method }`)
	},
}

const ethereum = new EthereumClientService(requestHandler, async () => undefined, async () => undefined, rpcEntry)

const simulationState: SimulationState = {
	success: false,
	simulationStateInput: [],
	jsonRpcError: {
		jsonrpc: '2.0',
		id: 1,
		error: {
			code: -32000,
			message: 'simulation unavailable',
		},
	},
	blockNumber: 1n,
	blockTimestamp: new Date('2024-01-01T00:00:00.000Z'),
	baseFeePerGas: 1n,
	simulationConductedTimestamp: new Date('2024-01-01T00:00:00.000Z'),
	rpcNetwork: rpcEntry,
}

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

		const result = await commonTokenOops(transaction, ethereum, undefined, simulationState)

		assert.equal(result, 'Attempt to send tokens to a contract (Uniswap V2 Router 02) that cannot receive such tokens')
	})
})
