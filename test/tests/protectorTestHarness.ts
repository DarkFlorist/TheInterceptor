import { beforeEach } from 'bun:test'
import type { RpcEntry } from '../../app/ts/types/rpc.js'
import type { SimulationState } from '../../app/ts/types/visualizer-types.js'
import type { EthereumAddress, EthereumUnsignedTransaction } from '../../app/ts/types/wire-types.js'
import { stringToUint8Array } from '../../app/ts/utils/bigint.js'
import { createPerTestBrowserMockInstaller } from '../harness/perTest.js'
import { createStubEthereumClient, rejectRpcRequest } from './stubEthereumClient.js'

export const NANOETH = 10n ** 9n

export const SENDER_ADDRESS = 0x1111111111111111111111111111111111111111n
export const TOKEN_ADDRESS = 0x2222222222222222222222222222222222222222n
export const EOA_ADDRESS = 0x3333333333333333333333333333333333333333n

export const mainnetRpcEntry: RpcEntry = {
	name: 'Ethereum Mainnet',
	chainId: 1n,
	httpsRpc: 'https://ethereum.dark.florist',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: true,
}

// Protectors cache token metadata in browser.storage.local, so every test starts from a fresh, empty shared browser mock.
export function installFreshBrowserMockForEachTest() {
	const installBrowserMock = createPerTestBrowserMockInstaller()
	beforeEach(() => { installBrowserMock() })
}

type MockNode = {
	readonly codeByAddress?: ReadonlyMap<EthereumAddress, `0x${ string }`>
	readonly gasPrice?: bigint
}

// A mainnet stub client that answers only the node lookups protectors make (eth_getCode and eth_gasPrice) and records every requested method.
export const createMockEthereumClient = ({ codeByAddress = new Map(), gasPrice = NANOETH }: MockNode = {}) => {
	const requestedMethods: string[] = []
	const ethereum = createStubEthereumClient(async (request) => {
		requestedMethods.push(request.method)
		if (request.method === 'eth_getCode') return codeByAddress.get(request.params[0]) ?? '0x'
		if (request.method === 'eth_gasPrice') return `0x${ gasPrice.toString(16) }`
		return await rejectRpcRequest(request)
	}, mainnetRpcEntry)
	return { ethereum, requestedMethods }
}

const simulationTimestamp = new Date('2024-01-01T00:00:00.000Z')

// With no simulated blocks, code lookups are answered directly by the node
export const nodeBackedSimulationState: SimulationState = {
	success: true,
	simulationStateInput: [],
	simulatedBlocks: [],
	blockNumber: 1n,
	blockTimestamp: simulationTimestamp,
	baseFeePerGas: 1n,
	simulationConductedTimestamp: simulationTimestamp,
	rpcNetwork: mainnetRpcEntry,
}

// A failed simulation cannot answer code lookups, so protectors report that verification failed
export const failedSimulationState: SimulationState = {
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
	blockTimestamp: simulationTimestamp,
	baseFeePerGas: 1n,
	simulationConductedTimestamp: simulationTimestamp,
	rpcNetwork: mainnetRpcEntry,
}

export const createTransaction = ({ to = TOKEN_ADDRESS, input = '0x', value = 0n }: {
	readonly to?: EthereumAddress | null
	readonly input?: `0x${ string }`
	readonly value?: bigint
} = {}): EthereumUnsignedTransaction => ({
	type: '1559',
	from: SENDER_ADDRESS,
	nonce: 0n,
	maxFeePerGas: 100n * NANOETH,
	maxPriorityFeePerGas: NANOETH,
	gas: 100_000n,
	to,
	value,
	input: stringToUint8Array(input),
	chainId: mainnetRpcEntry.chainId,
})
