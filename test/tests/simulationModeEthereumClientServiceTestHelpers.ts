// Shared fixtures and a mock Goerli RPC node for the simulationMode*.test.ts files, which test app/ts/simulation/services/SimulationModeEthereumClientService.ts.
//
// Usage:
//   const { requestHandler, ethereum } = createSimulationModeTestContext()   // one mock node and EthereumClientService per test file
//   requestHandler.balance = 50n                                              // tests tune the mock node through its mutable fields
//   assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.lastCallGas, undefined)
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import type { IEthereumJSONRpcRequestHandler } from '../../app/ts/simulation/services/EthereumJSONRpcRequestHandler.js'
import { getSimulatedBlockFromInput, getSimulatedBlockNumberFromInput, getSimulatedLogs, getSimulatedTransactionByHashFromInput, getSimulatedTransactionReceipt, mockSignTransaction } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import { STORAGE_READER_ABI } from '../../app/ts/simulation/storageReader.js'
import { type EthSimulateV1BlockTag, type EthSimulateV1CallResult, type EthSimulateV1Params, EthSimulateV1Result } from '../../app/ts/types/ethSimulate-types.js'
import type { EthereumJsonRpcRequest } from '../../app/ts/types/JsonRpc-types.js'
import { toResolvedExecutionSimulationState, toResolvedSimulationInput } from '../../app/ts/types/visualizer-types.js'
import { serialize } from '../../app/ts/types/wire-types.js'
import { decodeFunctionDataStrict, encodeFunctionCall, encodeFunctionReturn } from '../../app/ts/utils/abiRuntime.js'
import { addressString, bytes32String, dataStringWith0xStart, stringToUint8Array } from '../../app/ts/utils/bigint.js'
import { getStorageReaderByteCode } from '../../app/ts/utils/ethereumByteCodes.js'
import { JsonRpcResponseError } from '../../app/ts/utils/errors.js'
import { areEqualUint8Arrays } from '../../app/ts/utils/typed-arrays.js'
import { eth_getBlockByNumber_goerli_8443561_false, eth_getBlockByNumber_goerli_8443561_true } from '../RPCResponses.js'
import { createMockEthSimulateV1Result, createMockEthSimulateV1ResultWithCustomLastBlock, ethSimulateSingleBlockResult, getAggregate3BalanceQueryCount } from './ethSimulateV1MockResults.js'
import { readJsonRpcResult } from './rpcResponseParsing.js'

const getCodeAbi = [{
	type: 'function',
	name: 'at',
	stateMutability: 'view',
	inputs: [{ name: 'target', type: 'address' }],
	outputs: [{ name: 'code', type: 'bytes' }],
}] as const
const getCodeSelector = encodeFunctionCall(getCodeAbi, 'at', ['0x0000000000000000000000000000000000000000']).slice(0, 10)
const GET_CODE_HELPER_ADDRESS = 0x1ce438391307f908756fefe0fe220c0f0d51508an
const SHA256_PRECOMPILE_ADDRESS = 0x2n
const activePrecompileAddresses = new Set([SHA256_PRECOMPILE_ADDRESS])

export function testBytes32(suffix: string) {
	return `0x${suffix.padStart(64, '0')}`
}

export const zeroBytes256 = `0x${'0'.repeat(512)}`

export const blockNumber = 8443561n
const rpcNetwork = {
	name: 'Goerli',
	chainId: 5n,
	httpsRpc: 'https://rpc.dark.florist/flipcardtrustone',
	currencyName: 'Goerli Testnet ETH',
	currencyTicker: 'GÖETH',
	primary: true,
	minimized: true,
	weth: 0xb4fbf271143f4fbf7b91a5ded31805e42b2208d6n,
}

type EthereumJsonRpcRequestWithMethod<Method extends EthereumJsonRpcRequest['method']> = Extract<EthereumJsonRpcRequest, { readonly method: Method }>

type RecordedEthSimulateV1Call = {
	readonly blockStateCallCount: number
	readonly aggregate3BalanceQueryCount: number | undefined
	readonly lastCallGas: bigint | undefined
	readonly lastCallNonce: bigint | undefined
	readonly lastCallAuthorizationList: readonly { chainId: bigint, address: bigint, nonce: bigint, r?: bigint, s?: bigint, yParity?: 'even' | 'odd' }[] | undefined
	readonly hasGetCodeOverride: boolean
	readonly traceTransfers: boolean | undefined
	readonly validation: boolean | undefined
	readonly parentBlockTag: EthSimulateV1BlockTag | undefined
}

// A mock Goerli node at block 8443561: tests change the mutable fields to shape its answers and read the recorded requests.
type MockSimulationModeRequestHandler = IEthereumJSONRpcRequestHandler & {
	rejectOmittedGas: boolean
	omitMaxUsedGas: boolean
	simulatedCallGasUsed: bigint | undefined
	simulatedCallMaxUsedGas: bigint | undefined
	minimumSuccessfulGasLimit: bigint | undefined
	malformedGetCodeReturn: boolean
	balance: bigint
	storageResponse: string
	maxPriorityFeePerGasResponse: string
	readonly ethFeeHistoryCalls: EthereumJsonRpcRequestWithMethod<'eth_feeHistory'>[]
	readonly ethGetBalanceCalls: EthereumJsonRpcRequestWithMethod<'eth_getBalance'>[]
	readonly ethGetStorageAtCalls: EthereumJsonRpcRequestWithMethod<'eth_getStorageAt'>[]
	readonly ethGetBlockByHashErrorsByHash: Map<bigint, Error>
	readonly ethSimulateV1Calls: RecordedEthSimulateV1Call[]
	readonly ethSimulateV1Requests: EthSimulateV1Params[]
}

type SuccessfulEthSimulateV1CallResult = Extract<EthSimulateV1CallResult, { readonly status: 'success' }>

const toOutOfGasFailure = (successfulCall: SuccessfulEthSimulateV1CallResult, gasLimit: bigint): EthSimulateV1CallResult => {
	const { logs: _logs, maxUsedGas: _maxUsedGas, ...failedCallBase } = successfulCall
	return {
		...failedCallBase,
		status: 'failure',
		gasUsed: gasLimit,
		error: { code: -32000, message: 'out of gas' },
	}
}

const withoutMaxUsedGas = (callResult: EthSimulateV1CallResult): EthSimulateV1CallResult => {
	const { maxUsedGas: _maxUsedGas, ...callWithoutMaxUsedGas } = callResult
	return callWithoutMaxUsedGas
}

function getSingleTransactionFixture() {
	const singleTransactionBlock = ethSimulateSingleBlockResult[0]
	const singleCall = singleTransactionBlock?.calls[0]
	if (singleTransactionBlock === undefined || singleCall === undefined) throw new Error('missing single transaction simulation fixture')
	return { singleTransactionBlock, singleCall }
}

function answerEthSimulateV1(handler: MockSimulationModeRequestHandler, rpcRequest: EthSimulateV1Params): EthSimulateV1Result {
	handler.ethSimulateV1Requests.push(rpcRequest)
	const lastBlockStateCall = rpcRequest.params[0]?.blockStateCalls.at(-1)
	const lastCall = lastBlockStateCall?.calls[0]
	const lastCallInput = lastCall?.input
	const lastCallGas = lastCall?.gas
	const lastCallNonce = lastCall?.nonce
	const lastCallAuthorizationList = lastCall?.authorizationList
	const hasGetCodeOverride = lastBlockStateCall?.stateOverrides?.[addressString(GET_CODE_HELPER_ADDRESS)]?.code !== undefined
	const aggregate3BalanceQueryCount = getAggregate3BalanceQueryCount(lastCallInput)
	const blockStateCallCount = rpcRequest.params[0]?.blockStateCalls.length ?? 0
	handler.ethSimulateV1Calls.push({ blockStateCallCount, aggregate3BalanceQueryCount, lastCallGas, lastCallNonce, lastCallAuthorizationList, hasGetCodeOverride, traceTransfers: rpcRequest.params[0].traceTransfers, validation: rpcRequest.params[0].validation, parentBlockTag: rpcRequest.params[1] })
	if (handler.rejectOmittedGas && lastCallGas === undefined) {
		throw new JsonRpcResponseError({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'gas required' } })
	}
	if (lastCallInput !== undefined && dataStringWith0xStart(lastCallInput).startsWith(getCodeSelector)) {
		const { singleTransactionBlock, singleCall } = getSingleTransactionFixture()
		return createMockEthSimulateV1ResultWithCustomLastBlock(blockStateCallCount, {
			...singleTransactionBlock,
			calls: [{
				...singleCall,
				returnData: stringToUint8Array(handler.malformedGetCodeReturn ? '0x' : encodeFunctionReturn(getCodeAbi, 'at', ['0x1234'])),
			}],
		})
	}
	const storageReaderAccountOverride = lastCall?.to === undefined || lastCall.to === null
		? undefined
		: lastBlockStateCall?.stateOverrides?.[addressString(lastCall.to)]
	if (storageReaderAccountOverride?.code !== undefined && areEqualUint8Arrays(storageReaderAccountOverride.code, getStorageReaderByteCode())) {
		const { singleTransactionBlock, singleCall } = getSingleTransactionFixture()
		if (lastCall?.to === undefined || lastCall.to === null || lastCall.input === undefined) throw new Error('storage reader call is incomplete')
		const decodedStorageCall = decodeFunctionDataStrict(STORAGE_READER_ABI, dataStringWith0xStart(lastCall.input))
		if (decodedStorageCall.functionName !== 'readSlot') throw new Error('expected storage reader call')
		const isActivePrecompile = activePrecompileAddresses.has(lastCall.to)
		if (!isActivePrecompile && storageReaderAccountOverride.movePrecompileToAddress !== undefined) {
			throw new JsonRpcResponseError({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: `account ${ addressString(lastCall.to) } is not a precompile` } })
		}
		const requestedAddress = addressString(lastCall.to)
		const [requestedSlot] = decodedStorageCall.args
		if (typeof requestedSlot !== 'string') throw new Error('expected a bytes32 storage slot')
		let storageValue = 0n
		for (const prefixBlock of rpcRequest.params[0].blockStateCalls.slice(0, -1)) {
			const accountOverride = prefixBlock.stateOverrides?.[requestedAddress]
			if (accountOverride?.state !== undefined) storageValue = accountOverride.state[requestedSlot] ?? 0n
			storageValue = accountOverride?.stateDiff?.[requestedSlot] ?? storageValue
		}
		return createMockEthSimulateV1ResultWithCustomLastBlock(blockStateCallCount, {
			...singleTransactionBlock,
			calls: [{
				...singleCall,
				// Without relocation, precompile execution wins over injected account code.
				returnData: stringToUint8Array(encodeFunctionReturn(STORAGE_READER_ABI, 'readSlot', [
					bytes32String(isActivePrecompile && storageReaderAccountOverride.movePrecompileToAddress === undefined ? 0xbadn : storageValue),
				])),
			}],
		})
	}
	const result = createMockEthSimulateV1Result(blockStateCallCount, aggregate3BalanceQueryCount)
	if (aggregate3BalanceQueryCount !== undefined) return result
	const lastBlock = result.at(-1)
	const lastResult = lastBlock?.calls[0]
	if (lastBlock === undefined || lastResult === undefined) return result
	if (lastResult.status !== 'success') throw new Error('the simulation fixture call is expected to succeed')
	const gasUsed = handler.simulatedCallGasUsed === undefined ? lastResult.gasUsed : handler.simulatedCallGasUsed
	const maxUsedGas = handler.simulatedCallMaxUsedGas === undefined ? lastResult.maxUsedGas ?? gasUsed : handler.simulatedCallMaxUsedGas
	const successfulCall = {
		...lastResult,
		gasUsed,
		maxUsedGas,
	}
	const callResult = lastCallGas !== undefined && handler.minimumSuccessfulGasLimit !== undefined && lastCallGas < handler.minimumSuccessfulGasLimit
		? toOutOfGasFailure(successfulCall, lastCallGas)
		: successfulCall
	const customCall = handler.omitMaxUsedGas ? withoutMaxUsedGas(callResult) : callResult
	return createMockEthSimulateV1ResultWithCustomLastBlock(blockStateCallCount, { ...lastBlock, calls: [customCall] })
}

// Answers like a JSON-RPC node: the returned values are wire JSON that EthereumClientService parses.
async function answerRpcRequest(handler: MockSimulationModeRequestHandler, rpcRequest: EthereumJsonRpcRequest): Promise<unknown> {
	switch (rpcRequest.method) {
		case 'eth_blockNumber': return `0x${ blockNumber.toString(16) }`
		case 'eth_getTransactionCount': return '0x0'
		case 'eth_getBalance':
			handler.ethGetBalanceCalls.push(rpcRequest)
			return `0x${ handler.balance.toString(16) }`
		case 'eth_getStorageAt':
			handler.ethGetStorageAtCalls.push(rpcRequest)
			return handler.storageResponse
		case 'eth_maxPriorityFeePerGas': return handler.maxPriorityFeePerGasResponse
		case 'eth_feeHistory': {
			handler.ethFeeHistoryCalls.push(rpcRequest)
			const blockCount = Number(rpcRequest.params[0])
			const rewardPercentiles = rpcRequest.params[2]
			return {
				baseFeePerGas: Array.from({ length: blockCount + 1 }, (_, index) => `0x${ (index + 1).toString(16) }`),
				gasUsedRatio: Array.from({ length: blockCount }, () => 0.5),
				oldestBlock: `0x${ (blockNumber - BigInt(blockCount) + 1n).toString(16) }`,
				...rewardPercentiles === undefined ? {} : {
					reward: Array.from({ length: blockCount }, () => rewardPercentiles.map((_percentile, index) => `0x${ (index + 1).toString(16) }`)),
				},
			}
		}
		case 'eth_getBlockByNumber': {
			if (rpcRequest.params[0] !== blockNumber && rpcRequest.params[0] !== 'latest') throw new Error('Unsupported block number')
			if (rpcRequest.params[1] === true) return readJsonRpcResult(eth_getBlockByNumber_goerli_8443561_true)
			return readJsonRpcResult(eth_getBlockByNumber_goerli_8443561_false)
		}
		case 'eth_getBlockByHash': {
			const requestedBlockHash = BigInt(rpcRequest.params[0])
			const lookupError = handler.ethGetBlockByHashErrorsByHash.get(requestedBlockHash)
			if (lookupError !== undefined) throw lookupError
			// JSON-RPC answers an unknown block hash with a null result.
			if (requestedBlockHash !== BigInt(testBytes32('abcd'))) return null
			if (rpcRequest.params[1] === true) return readJsonRpcResult(eth_getBlockByNumber_goerli_8443561_true)
			return readJsonRpcResult(eth_getBlockByNumber_goerli_8443561_false)
		}
		case 'eth_simulateV1': return serialize(EthSimulateV1Result, answerEthSimulateV1(handler, rpcRequest))
		default: throw new Error(`unsupported method ${ rpcRequest.method }`)
	}
}

function createMockSimulationModeRequestHandler(): MockSimulationModeRequestHandler {
	const handler: MockSimulationModeRequestHandler = {
		rpcUrl: rpcNetwork.httpsRpc,
		rejectOmittedGas: false,
		omitMaxUsedGas: false,
		simulatedCallGasUsed: undefined,
		simulatedCallMaxUsedGas: undefined,
		minimumSuccessfulGasLimit: undefined,
		malformedGetCodeReturn: false,
		balance: 0n,
		storageResponse: testBytes32('beef'),
		maxPriorityFeePerGasResponse: '0x3b9aca00',
		ethFeeHistoryCalls: [],
		ethGetBalanceCalls: [],
		ethGetStorageAtCalls: [],
		ethGetBlockByHashErrorsByHash: new Map(),
		ethSimulateV1Calls: [],
		ethSimulateV1Requests: [],
		clearCache: () => undefined,
		getChainId: async () => 5n,
		jsonRpcRequest: async (rpcRequest) => await answerRpcRequest(handler, rpcRequest),
	}
	return handler
}

type SimulationStateInputForTest = Parameters<typeof toResolvedSimulationInput>[0]
type ExecutionSimulationStateForTest = Parameters<typeof toResolvedExecutionSimulationState>[0]

// Creates the mock node, an EthereumClientService that talks to it, and shorthand readers bound to that service.
export function createSimulationModeTestContext() {
	const requestHandler = createMockSimulationModeRequestHandler()
	const ethereum = new EthereumClientService(requestHandler, async () => undefined, async () => undefined, rpcNetwork)
	const createEthereumWithThrowingSimulationPreparation = () => {
		let prepareCallCount = 0
		const throwingEthereum = new Proxy(ethereum, {
			get(target, property, receiver) {
				if (property === 'prepareEthSimulateV1Input') {
					return async () => {
						prepareCallCount += 1
						throw new Error('simulation preparation should not run')
					}
				}
				return Reflect.get(target, property, receiver)
			}
		})
		return { ethereum: throwingEthereum, getPrepareCallCount: () => prepareCallCount }
	}
	const getBlockNumberFromInput = async (simulationStateInput: SimulationStateInputForTest) => await getSimulatedBlockNumberFromInput(ethereum, undefined, toResolvedSimulationInput(simulationStateInput))
	const getBlockFromInput = async (simulationStateInput: SimulationStateInputForTest, blockTag: Parameters<typeof getSimulatedBlockFromInput>[3], includeTransactions = false) => await getSimulatedBlockFromInput(ethereum, undefined, toResolvedSimulationInput(simulationStateInput), blockTag, includeTransactions)
	const getTransactionByHashFromInput = async (simulationStateInput: SimulationStateInputForTest, hash: bigint) => await getSimulatedTransactionByHashFromInput(ethereum, undefined, toResolvedSimulationInput(simulationStateInput), hash)
	const getReceiptFromState = async (simulationState: ExecutionSimulationStateForTest, hash: bigint) => await getSimulatedTransactionReceipt(ethereum, undefined, toResolvedExecutionSimulationState(simulationState), hash)
	const getLogsFromState = async (simulationState: ExecutionSimulationStateForTest, filter: Parameters<typeof getSimulatedLogs>[3]) => await getSimulatedLogs(ethereum, undefined, toResolvedExecutionSimulationState(simulationState), filter)
	return {
		requestHandler,
		ethereum,
		createEthereumWithThrowingSimulationPreparation,
		getBlockNumberFromInput,
		getBlockFromInput,
		getTransactionByHashFromInput,
		getReceiptFromState,
		getLogsFromState,
	}
}

export const exampleTransaction = {
	type: '1559',
	from: 0xd8da6bf26964af9d7eed9e03e53415d37aa96045n,
	nonce: 0n,
	maxFeePerGas: 1n,
	maxPriorityFeePerGas: 1n,
	gas: 21000n,
	to: 0xda9dfa130df4de4673b89022ee50ff26f6ea73cfn,
	value: 10n,
	input: new Uint8Array(0),
	chainId: 1n,
} as const
export const example7702Transaction = {
	...exampleTransaction,
	type: '7702',
	authorizationList: [],
} as const

export const createSimulationStateInput = () => [{
	stateOverrides: {},
	transactions: [{
		signedTransaction: mockSignTransaction({
			...exampleTransaction,
			nonce: 0n,
		}),
		website: { websiteOrigin: 'test', icon: undefined, title: undefined },
		created: new Date(),
		originalRequestParameters: { method: 'eth_sendTransaction', params: [{}]},
		transactionIdentifier: 100n,
	}],
	signedMessages: [],
	blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
	simulateWithZeroBaseFee: false,
}] as const
export const createTwoBlockSimulationStateInput = () => [
	{
		stateOverrides: {},
		transactions: [{
			signedTransaction: mockSignTransaction({
				...exampleTransaction,
				nonce: 0n,
			}),
			website: { websiteOrigin: 'test', icon: undefined, title: undefined },
			created: new Date(),
			originalRequestParameters: { method: 'eth_sendTransaction', params: [{}]},
			transactionIdentifier: 101n,
		}],
		signedMessages: [],
		blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
		simulateWithZeroBaseFee: false,
	},
	{
		stateOverrides: {},
		transactions: [{
			signedTransaction: mockSignTransaction({
				...exampleTransaction,
				nonce: 1n,
			}),
			website: { websiteOrigin: 'test', icon: undefined, title: undefined },
			created: new Date(),
			originalRequestParameters: { method: 'eth_sendTransaction', params: [{}]},
			transactionIdentifier: 102n,
		}],
		signedMessages: [],
		blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
		simulateWithZeroBaseFee: false,
	},
] as const

const createDappEthSimulateV1Payload = (validation = false): EthSimulateV1Params['params'][0] => ({
	blockStateCalls: [{
		calls: [{
			type: '1559',
			from: exampleTransaction.from,
			nonce: 0n,
			maxFeePerGas: 1n,
			maxPriorityFeePerGas: 1n,
			gas: 21_000n,
			to: exampleTransaction.to,
			value: 0n,
			input: new Uint8Array(),
			chainId: exampleTransaction.chainId,
			accessList: [],
		}],
	}],
	traceTransfers: false,
	validation,
})

// An eth_simulateV1 request as a dapp sends it. Passing undefined explicitly still selects the 'latest' default.
export const createDappEthSimulateV1Request = (blockTag: EthSimulateV1BlockTag | undefined = 'latest', validation = false): EthSimulateV1Params => ({
	method: 'eth_simulateV1',
	params: blockTag === undefined ? [createDappEthSimulateV1Payload(validation)] : [createDappEthSimulateV1Payload(validation), blockTag],
})
