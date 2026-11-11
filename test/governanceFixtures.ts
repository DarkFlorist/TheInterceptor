import { EthereumJsonRpcRequest } from '../app/ts/types/JsonRpc-types.js'
import type { IEthereumJSONRpcRequestHandler } from '../app/ts/simulation/services/EthereumJSONRpcRequestHandler.js'
import { EthereumClientService } from '../app/ts/simulation/services/EthereumClientService.js'
import { serialize } from '../app/ts/types/wire-types.js'
import type { SimulationStateInput, SimulationStateInputBlock } from '../app/ts/types/visualizer-types.js'
import { addressString, stringToUint8Array } from '../app/ts/utils/bigint.js'
import { encodeFunctionCall } from '../app/ts/utils/abiRuntime.js'
import { MAKE_YOU_RICH_TRANSACTION } from '../app/ts/utils/constants.js'
import { mockSignTransaction } from '../app/ts/simulation/services/simulationTransactionSigning.js'
import { DEFAULT_BLOCK_MANIPULATION } from '../app/ts/config/defaults.js'
import { prepareSafeExecutionSimulationInput, SAFE_EXECUTION_SIMULATION_EXECUTOR } from '../app/ts/safe/safeExecutionSimulation.js'
import { getSimulatedBlockBaseFeePerGas } from '../app/ts/simulation/services/simulationBlockParameters.js'

// One JSON-RPC request the governance preview sent to a node, in its wire form, and the node's result.
export type RecordedExchange = { readonly request: unknown, readonly result: unknown }
// safeExecutionExecutor is the executor account prepareSafeExecutionSimulationInput used when the fixture was recorded. It is random for each session, so a replay maps the session's executor to it.
export type GovernanceFixture = { readonly description: string, readonly governor: string, readonly proposalId: string, readonly stack?: string, readonly safeExecutionExecutor?: string, readonly exchanges: readonly RecordedExchange[] }

const FIXTURE_RPC_URL = 'https://recorded.governance.fixture.invalid'

const requestKey = (request: EthereumJsonRpcRequest) => JSON.stringify(serialize(EthereumJsonRpcRequest, request))

const createEthereumClientService = (requestHandler: IEthereumJSONRpcRequestHandler) => new EthereumClientService(requestHandler, async () => undefined, async () => undefined, { name: 'Ethereum Mainnet', chainId: 1n, httpsRpc: requestHandler.rpcUrl, currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: true })

// Answers each request with the result a real node gave to the same request when the fixture was recorded, and keeps every request so a test can inspect what was sent. resultOf gives the recorded result of a request, and answer lets a test change what the chain answers, for example a later latest block or another block at a height.
export const createReplayingEthereumClientService = (fixture: GovernanceFixture, options: { readonly answer?: (request: EthereumJsonRpcRequest, recordedResult: () => unknown, earlierRequests: readonly EthereumJsonRpcRequest[]) => unknown } = {}) => {
	const results = new Map(fixture.exchanges.map((exchange) => [JSON.stringify(exchange.request), exchange.result]))
	const recordedExecutor = fixture.safeExecutionExecutor?.slice(2).toLowerCase()
	const sessionExecutor = addressString(SAFE_EXECUTION_SIMULATION_EXECUTOR).slice(2)
	const keyOf = (request: EthereumJsonRpcRequest) => recordedExecutor === undefined ? requestKey(request) : requestKey(request).replaceAll(sessionExecutor, recordedExecutor)
	const requests: EthereumJsonRpcRequest[] = []
	const resultOf = (request: EthereumJsonRpcRequest) => {
		const key = keyOf(request)
		if (!results.has(key)) throw new Error(`The fixture "${ fixture.description }" has no recorded result for ${ key.slice(0, 300) }`)
		return results.get(key)
	}
	const requestHandler: IEthereumJSONRpcRequestHandler = {
		rpcUrl: FIXTURE_RPC_URL,
		clearCache: () => undefined,
		jsonRpcRequest: async (request: EthereumJsonRpcRequest) => {
			const earlierRequests = [...requests]
			requests.push(request)
			return options.answer === undefined ? resultOf(request) : options.answer(request, () => resultOf(request), earlierRequests)
		},
	}
	return { ethereum: createEthereumClientService(requestHandler), requests, resultOf }
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
const UNISWAP_PROPOSAL_102_PROPOSER = 0x927c7fd078fc406059957a691c21f6e0fc4a959cn
const GOVERNOR_CANCEL_ABI = [{ type: 'function', name: 'cancel', stateMutability: 'nonpayable', inputs: [{ name: 'proposalId', type: 'uint256' }], outputs: [] }] as const
// A Gnosis Safe 1.3.0 that scripts/record-governance-fixtures.mts deploys through the canonical proxy factory with salt nonce 20261111, one owner (0x1111…1111) and threshold 1.
export const EXAMPLE_SAFE = 0x452d3cca824174106e1975cdb8d9276402cf8e02n
const STACK_WEBSITE = { websiteOrigin: 'https://stack.fixture', icon: undefined, title: undefined }

const exampleTransfer = (from: bigint, to = 0xdeadn, value = 10n ** 18n, gas = 21_000n) => {
	const transaction = { type: '1559' as const, from, to, value, input: new Uint8Array(), gas, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, accessList: [], chainId: 1n, nonce: 0n }
	return { signedTransaction: mockSignTransaction(transaction), website: STACK_WEBSITE, created: new Date(0), originalRequestParameters: { method: 'eth_sendTransaction' as const, params: [transaction] as const }, transactionIdentifier: 1n }
}

const stackBlock = (block: Partial<SimulationStateInputBlock>): SimulationStateInputBlock => ({ stateOverrides: {}, transactions: [], signedMessages: [], blockTimeManipulation: DEFAULT_BLOCK_MANIPULATION, simulateWithZeroBaseFee: true, ...block })

export const EXAMPLE_STACKS = {
	// vitalik.eth sends 1 ether to 0x…dEaD.
	transfer: (_governor: bigint): SimulationStateInput => [stackBlock({ transactions: [exampleTransfer(EXAMPLE_STACK_SENDER)] })],
	// The same, with vitalik.eth made rich, as getCurrentSimulationInput does in simulation mode.
	makeRich: (_governor: bigint): SimulationStateInput => [stackBlock({ stateOverrides: { [addressString(EXAMPLE_STACK_SENDER)]: { balance: MAKE_YOU_RICH_TRANSACTION.transaction.value } }, transactions: [exampleTransfer(EXAMPLE_STACK_SENDER)] })],
	// A message vitalik.eth signed in the simulation, which EthereumClientService runs with a replaced ecrecover.
	signedMessage: (_governor: bigint): SimulationStateInput => [stackBlock({ signedMessages: [{
		website: STACK_WEBSITE,
		created: new Date(0),
		fakeSignedFor: EXAMPLE_STACK_SENDER,
		originalRequestParameters: { method: 'personal_sign', params: ['0x48656c6c6f', EXAMPLE_STACK_SENDER] },
		request: { method: 'personal_sign', params: ['0x48656c6c6f', addressString(EXAMPLE_STACK_SENDER)], interceptorRequest: true, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier: { requestId: 1, requestSocket: { tabId: 1, connectionName: 1n } } },
		simulationMode: true,
		messageIdentifier: 1n,
	}] })],
	// 1 ether sent by EXAMPLE_SAFE, a Gnosis Safe 1.3.0 deployed on the fork the fixture was recorded on, as the simulation stack holds a Safe's own call before prepareExampleStack prepares it.
	safeExecution: (_governor: bigint): SimulationStateInput => [stackBlock({ transactions: [{ ...exampleTransfer(EXAMPLE_SAFE), simulationOptions: { requiredChainId: 1n, simulateWithZeroBaseFee: false, executeThroughSafe: true } }] })],
	// vitalik.eth sends the governor 2 ether earlier in the stack.
	fundsTheGovernor: (governor: bigint): SimulationStateInput => [stackBlock({ transactions: [exampleTransfer(EXAMPLE_STACK_SENDER, governor, 2n * 10n ** 18n, 100_000n)] })],
	// The user's rich list includes the governor, as getCurrentSimulationInput would make it rich.
	makesTheGovernorRich: (governor: bigint): SimulationStateInput => [stackBlock({ stateOverrides: { [addressString(governor)]: { balance: MAKE_YOU_RICH_TRANSACTION.transaction.value } } })],
	// The proposer of Uniswap GovernorBravo proposal 102 cancels it earlier in the stack.
	proposerCancelsUniswapProposal102: (governor: bigint): SimulationStateInput => {
		const transaction = { type: '1559' as const, from: UNISWAP_PROPOSAL_102_PROPOSER, to: governor, value: 0n, input: stringToUint8Array(encodeFunctionCall(GOVERNOR_CANCEL_ABI, 'cancel', [102n])), gas: 500_000n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, accessList: [], chainId: 1n, nonce: 0n }
		return [stackBlock({ transactions: [{ signedTransaction: mockSignTransaction(transaction), website: STACK_WEBSITE, created: new Date(0), originalRequestParameters: { method: 'eth_sendTransaction', params: [transaction] }, transactionIdentifier: 1n }] })]
	},
} as const
export type ExampleStackName = keyof typeof EXAMPLE_STACKS
export const isExampleStackName = (name: string): name is ExampleStackName => name in EXAMPLE_STACKS

// Prepares an example stack for the node as prepareSafeExecutionsForRpc prepares the user's stack, with the real Gnosis Safe preparation.
export const prepareExampleStack = async (ethereum: EthereumClientService, stack: SimulationStateInput) => {
	if (stack.every((block) => block.transactions.length === 0)) return stack
	const parentBlock = await ethereum.getBlock(undefined)
	if (parentBlock === null) throw new Error('The latest block is null')
	return await prepareSafeExecutionSimulationInput(stack, ethereum, parentBlock.number, getSimulatedBlockBaseFeePerGas(parentBlock))
}

// Pins a client to the latest block, as the governance handler does before it prepares the user's stack and runs the preview.
export const pinToLatestBlock = async (ethereum: EthereumClientService) => {
	const latestBlock = await ethereum.getBlock(undefined)
	if (latestBlock === null) throw new Error('The latest block is null')
	return ethereum.pinnedToBlock(latestBlock)
}
