import { EthereumJsonRpcRequest } from '../app/ts/types/JsonRpc-types.js'
import type { IEthereumJSONRpcRequestHandler } from '../app/ts/simulation/services/EthereumJSONRpcRequestHandler.js'
import { EthereumClientService } from '../app/ts/simulation/services/EthereumClientService.js'
import { serialize } from '../app/ts/types/wire-types.js'
import type { SimulationStateInput, SimulationStateInputBlock } from '../app/ts/types/visualizer-types.js'
import { addressString, bytes32String } from '../app/ts/utils/bigint.js'
import { MAKE_YOU_RICH_TRANSACTION } from '../app/ts/utils/constants.js'
import { mockSignTransaction } from '../app/ts/simulation/services/simulationTransactionSigning.js'
import { DEFAULT_BLOCK_MANIPULATION } from '../app/ts/config/defaults.js'

// One JSON-RPC request the governance preview sent to a node, in its wire form, and the node's result.
export type RecordedExchange = { readonly request: unknown, readonly result: unknown }
export type GovernanceFixture = { readonly description: string, readonly governor: string, readonly proposalId: string, readonly stack?: string, readonly exchanges: readonly RecordedExchange[] }

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

// Example simulation stacks for recording and replaying a preview that runs after the user's own simulation. Each is a stack as prepareSafeExecutionsForRpc hands it to the preview, with the overrides the extension's own preparation gives such a stack.
export const EXAMPLE_STACK_SENDER = 0xd8da6bf26964af9d7eed9e03e53415d37aa96045n
const EXAMPLE_SAFE = 0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afen
const EXAMPLE_SAFE_EXECUTOR = 0xe8ec0e8ec0e8ec0e8ec0e8ec0e8ec0e8ec0e8ec0n
const STACK_WEBSITE = { websiteOrigin: 'https://stack.fixture', icon: undefined, title: undefined }

const exampleTransfer = (from: bigint) => {
	const transaction = { type: '1559' as const, from, to: 0xdeadn, value: 10n ** 18n, input: new Uint8Array(), gas: 21_000n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, accessList: [], chainId: 1n, nonce: 0n }
	return { signedTransaction: mockSignTransaction(transaction), website: STACK_WEBSITE, created: new Date(0), originalRequestParameters: { method: 'eth_sendTransaction' as const, params: [transaction] as const }, transactionIdentifier: 1n }
}

const stackBlock = (block: Partial<SimulationStateInputBlock>): SimulationStateInputBlock => ({ stateOverrides: {}, transactions: [], signedMessages: [], blockTimeManipulation: DEFAULT_BLOCK_MANIPULATION, simulateWithZeroBaseFee: true, ...block })

export const EXAMPLE_STACKS = {
	// vitalik.eth sends 1 ether to 0x…dEaD.
	transfer: (): SimulationStateInput => [stackBlock({ transactions: [exampleTransfer(EXAMPLE_STACK_SENDER)] })],
	// The same, with vitalik.eth made rich, as getCurrentSimulationInput does in simulation mode.
	makeRich: (): SimulationStateInput => [stackBlock({ stateOverrides: { [addressString(EXAMPLE_STACK_SENDER)]: { balance: MAKE_YOU_RICH_TRANSACTION.transaction.value } }, transactions: [exampleTransfer(EXAMPLE_STACK_SENDER)] })],
	// A message vitalik.eth signed in the simulation, which EthereumClientService runs with a replaced ecrecover.
	signedMessage: (): SimulationStateInput => [stackBlock({ signedMessages: [{
		website: STACK_WEBSITE,
		created: new Date(0),
		fakeSignedFor: EXAMPLE_STACK_SENDER,
		originalRequestParameters: { method: 'personal_sign', params: ['0x48656c6c6f', EXAMPLE_STACK_SENDER] },
		request: { method: 'personal_sign', params: ['0x48656c6c6f', addressString(EXAMPLE_STACK_SENDER)], interceptorRequest: true, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier: { requestId: 1, requestSocket: { tabId: 1, connectionName: 1n } } },
		simulationMode: true,
		messageIdentifier: 1n,
	}] })],
	// A Gnosis Safe's call as prepareSafeExecutionSimulationInput leaves it: an executor runs it, the Safe's approvedHashes are set and the executor is funded.
	safeExecution: (): SimulationStateInput => {
		const safeCall = exampleTransfer(EXAMPLE_SAFE)
		const executedTransaction = { ...safeCall.signedTransaction, from: EXAMPLE_SAFE_EXECUTOR, to: EXAMPLE_SAFE, value: 0n, gas: 1_100_000n }
		return [stackBlock({
			stateOverrides: {
				[addressString(EXAMPLE_SAFE)]: { stateDiff: { [bytes32String(0x1234n)]: 1n } },
				[addressString(EXAMPLE_SAFE_EXECUTOR)]: { balance: 10n ** 18n },
			},
			transactions: [{ ...safeCall, simulationOptions: { requiredChainId: 1n, simulateWithZeroBaseFee: true, executeThroughSafe: true }, executedTransaction }],
		})]
	},
} as const
export type ExampleStackName = keyof typeof EXAMPLE_STACKS
export const isExampleStackName = (name: string): name is ExampleStackName => name in EXAMPLE_STACKS
