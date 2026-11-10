import { EthereumJsonRpcRequest } from '../app/ts/types/JsonRpc-types.js'
import type { IEthereumJSONRpcRequestHandler } from '../app/ts/simulation/services/EthereumJSONRpcRequestHandler.js'
import { EthereumClientService } from '../app/ts/simulation/services/EthereumClientService.js'
import { serialize } from '../app/ts/types/wire-types.js'
import type { SimulationStateInput } from '../app/ts/types/visualizer-types.js'
import { mockSignTransaction } from '../app/ts/simulation/services/simulationTransactionSigning.js'
import { DEFAULT_BLOCK_MANIPULATION } from '../app/ts/config/defaults.js'

// One JSON-RPC request the governance preview sent to a node, in its wire form, and the node's result.
export type RecordedExchange = { readonly request: unknown, readonly result: unknown }
export type GovernanceFixture = { readonly description: string, readonly governor: string, readonly proposalId: string, readonly exchanges: readonly RecordedExchange[] }

const FIXTURE_RPC_URL = 'https://recorded.governance.fixture.invalid'

const requestKey = (request: EthereumJsonRpcRequest) => JSON.stringify(serialize(EthereumJsonRpcRequest, request))

const createEthereumClientService = (requestHandler: IEthereumJSONRpcRequestHandler) => new EthereumClientService(requestHandler, async () => undefined, async () => undefined, { name: 'Ethereum Mainnet', chainId: 1n, httpsRpc: requestHandler.rpcUrl, currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: true })

// Answers each request with the result a real node gave to the same request when the fixture was recorded, and keeps every request so a test can inspect what was sent.
export const createReplayingEthereumClientService = (fixture: GovernanceFixture) => {
	const results = new Map(fixture.exchanges.map((exchange) => [JSON.stringify(exchange.request), exchange.result]))
	const requests: EthereumJsonRpcRequest[] = []
	const requestHandler: IEthereumJSONRpcRequestHandler = {
		rpcUrl: FIXTURE_RPC_URL,
		clearCache: () => undefined,
		jsonRpcRequest: async (request: EthereumJsonRpcRequest) => {
			requests.push(request)
			const key = requestKey(request)
			if (!results.has(key)) throw new Error(`The fixture "${ fixture.description }" has no recorded result for ${ key.slice(0, 300) }`)
			return results.get(key)
		},
	}
	return { ethereum: createEthereumClientService(requestHandler), requests }
}

// The preview reads only block headers, so a recorded block keeps no transactions, which would make up most of a fixture.
const withoutBlockTransactions = (request: EthereumJsonRpcRequest, result: unknown) => {
	if (request.method !== 'eth_getBlockByNumber' || typeof result !== 'object' || result === null) return result
	return { ...result, transactions: [] }
}

// Forwards every request to a real node and keeps each distinct request with the node's result.
export const createRecordingEthereumClientService = (forwardTo: IEthereumJSONRpcRequestHandler) => {
	const exchanges = new Map<string, RecordedExchange>()
	const requestHandler: IEthereumJSONRpcRequestHandler = {
		rpcUrl: forwardTo.rpcUrl,
		clearCache: forwardTo.clearCache,
		jsonRpcRequest: async (request: EthereumJsonRpcRequest, requestAbortController?: AbortController) => {
			const result = await forwardTo.jsonRpcRequest(request, requestAbortController)
			exchanges.set(requestKey(request), { request: serialize(EthereumJsonRpcRequest, request), result: withoutBlockTransactions(request, result) })
			return result
		},
	}
	return { ethereum: createEthereumClientService(requestHandler), exchanges: () => Array.from(exchanges.values()) }
}

// A simulation stack of one block in which vitalik.eth sends 1 ether to 0x…dEaD, for recording and replaying a preview that runs after the stack.
export const EXAMPLE_STACK_SENDER = 0xd8da6bf26964af9d7eed9e03e53415d37aa96045n
export const createExampleSimulationStack = (): SimulationStateInput => {
	const transaction = { type: '1559' as const, from: EXAMPLE_STACK_SENDER, to: 0xdeadn, value: 10n ** 18n, input: new Uint8Array(), gas: 21_000n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, accessList: [], chainId: 1n, nonce: 0n }
	return [{
		stateOverrides: {},
		transactions: [{ signedTransaction: mockSignTransaction(transaction), website: { websiteOrigin: 'https://stack.fixture', icon: undefined, title: undefined }, created: new Date(0), originalRequestParameters: { method: 'eth_sendTransaction', params: [transaction] }, transactionIdentifier: 1n }],
		signedMessages: [],
		blockTimeManipulation: DEFAULT_BLOCK_MANIPULATION,
		simulateWithZeroBaseFee: true,
	}]
}
