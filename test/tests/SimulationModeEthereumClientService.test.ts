// The last test here covers the state-based getSimulatedBlock, which simulateEstimateGas still uses; the simulated-block fix moves simulateEstimateGas to the input-based path, removes that function and deletes this file.
import { describe, test } from 'bun:test'
import * as assert from 'assert'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import { addressString, bytes32String, dataStringWith0xStart } from '../../app/ts/utils/bigint.js'
import { createSimulationState, getSimulatedBlock, mockSignTransaction } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import { type EthereumJsonRpcRequest, JsonRpcResponse } from '../../app/ts/types/JsonRpc-types.js'
import type { EthSimulateV1BlockTag, EthSimulateV1Params, EthSimulateV1Result } from '../../app/ts/types/ethSimulate-types.js'
import { toResolvedSimulationState } from '../../app/ts/types/visualizer-types.js'
import { Multicall3ABI } from '../../app/ts/utils/constants.js'
import { decodeFunctionDataStrict, encodeAbiValues, encodeFunctionCall, encodeFunctionReturn } from '../../app/ts/utils/abiRuntime.js'
import { eth_getBlockByNumber_goerli_8443561_false, eth_getBlockByNumber_goerli_8443561_true, eth_simulateV1_dummy_call_result, eth_simulateV1_dummy_call_result_2calls, eth_simulateV1_get_eth_balance_multicall } from '../RPCResponses.js'
import { JsonRpcResponseError } from '../../app/ts/utils/errors.js'
import { STORAGE_READER_ABI } from '../../app/ts/simulation/storageReader.js'
import { getStorageReaderByteCode } from '../../app/ts/utils/ethereumByteCodes.js'
import { areEqualUint8Arrays } from '../../app/ts/utils/typed-arrays.js'

function parseRequest<T>(data: string): T {
	const jsonRpcResponse = JsonRpcResponse.parse(JSON.parse(data))
	if ('error' in jsonRpcResponse) throw Error(`Ethereum Client Error: ${ jsonRpcResponse.error.message }`)
	return jsonRpcResponse.result as T
}

const ethSimulateSingleBlockResult = parseRequest<EthSimulateV1Result>(eth_simulateV1_dummy_call_result)
const ethSimulateSplitBlocksResult = parseRequest<EthSimulateV1Result>(eth_simulateV1_dummy_call_result_2calls)
const ethSimulateAggregate3Result = parseRequest<EthSimulateV1Result>(eth_simulateV1_get_eth_balance_multicall)
const getCodeAbi = [{
	type: 'function',
	name: 'at',
	stateMutability: 'view',
	inputs: [{ name: 'target', type: 'address' }],
	outputs: [{ name: 'code', type: 'bytes' }],
}] as const
const getCodeSelector = encodeFunctionCall(getCodeAbi, 'at', ['0x0000000000000000000000000000000000000000']).slice(0, 10)
const SHA256_PRECOMPILE_ADDRESS = 0x2n
const activePrecompileAddresses = new Set([SHA256_PRECOMPILE_ADDRESS])

function buildAggregate3BalanceBlock(balanceQueryCount: number) {
	const aggregate3BalanceBlock = ethSimulateAggregate3Result[ethSimulateAggregate3Result.length - 1]
	const aggregate3Call = aggregate3BalanceBlock?.calls[0]
	if (aggregate3BalanceBlock === undefined) throw new Error('missing aggregate3 simulation fixture block')
	if (aggregate3Call === undefined) throw new Error('missing aggregate3 simulation fixture call')
	return {
		...aggregate3BalanceBlock,
		calls: [{
			...aggregate3Call,
			returnData: encodeFunctionReturn(Multicall3ABI, 'aggregate3', [Array.from({ length: balanceQueryCount }, (_, index) => ({
				success: true,
				returnData: encodeAbiValues(['uint256'], [BigInt(index + 1)]),
			}))]),
		}],
	}
}

function createMockEthSimulateV1Result(blockStateCallCount: number, aggregate3BalanceQueryCount: number | undefined) {
	const singleTransactionBlock = ethSimulateSingleBlockResult[0]
	const followupTransactionBlock = ethSimulateSplitBlocksResult[1]
	if (singleTransactionBlock === undefined) throw new Error('missing single transaction simulation fixture')
	if (followupTransactionBlock === undefined) throw new Error('missing followup simulation fixture block')

	const includesAggregate3BalanceCall = aggregate3BalanceQueryCount !== undefined
	const nonAggregateBlockCount = includesAggregate3BalanceCall ? Math.max(blockStateCallCount - 1, 0) : blockStateCallCount
	const nonAggregateBlocks = Array.from({ length: nonAggregateBlockCount }, (_, blockIndex) => blockIndex === 0 ? singleTransactionBlock : followupTransactionBlock)
	if (!includesAggregate3BalanceCall) return nonAggregateBlocks
	return [...nonAggregateBlocks, buildAggregate3BalanceBlock(aggregate3BalanceQueryCount)]
}

function createMockEthSimulateV1ResultWithCustomLastBlock(blockStateCallCount: number, customLastBlock: EthSimulateV1Result[number]) {
	if (blockStateCallCount <= 1) return [customLastBlock]
	const precedingBlocks = createMockEthSimulateV1Result(blockStateCallCount - 1, undefined)
	return [...precedingBlocks, customLastBlock]
}

function testBytes32(suffix: string) {
	return `0x${suffix.padStart(64, '0')}`
}

const blockNumber = 8443561n
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

class MockEthereumJSONRpcRequestHandler {
	public rpcUrl = 'https://rpc.dark.florist/flipcardtrustone'
	public rejectOmittedGas = false
	public omitMaxUsedGas = false
	public simulatedCallGasUsed: bigint | undefined = undefined
	public simulatedCallMaxUsedGas: bigint | undefined = undefined
	public minimumSuccessfulGasLimit: bigint | undefined = undefined
	public malformedGetCodeReturn = false
	public balance = 0n
	public storageResponse = testBytes32('beef')
	public maxPriorityFeePerGasResponse = '0x3b9aca00'
	public ethFeeHistoryCalls: EthereumJsonRpcRequest[] = []
	public ethGetBalanceCalls: EthereumJsonRpcRequest[] = []
	public ethGetStorageAtCalls: EthereumJsonRpcRequest[] = []
	public ethGetBlockByHashErrorsByHash = new Map<bigint, Error>()
	public readonly ethSimulateV1Calls: { blockStateCallCount: number, aggregate3BalanceQueryCount: number | undefined, lastCallGas: bigint | undefined, lastCallNonce: bigint | undefined, lastCallAuthorizationList: readonly { chainId: bigint, address: bigint, nonce: bigint, r?: bigint, s?: bigint, yParity?: 'even' | 'odd' }[] | undefined, hasGetCodeOverride: boolean, traceTransfers: boolean | undefined, validation: boolean | undefined, parentBlockTag: EthSimulateV1BlockTag | undefined }[] = []
	public readonly ethSimulateV1Requests: EthSimulateV1Params[] = []

	public clearCache = () => undefined

	public getChainId = async () => 5n

	public readonly jsonRpcRequest = async (rpcRequest: EthereumJsonRpcRequest) => {
		switch (rpcRequest.method) {
			case 'eth_blockNumber': return `0x${ blockNumber.toString(16) }`
			case 'eth_getTransactionCount': return '0x0'
			case 'eth_getBalance':
				this.ethGetBalanceCalls.push(rpcRequest)
				return `0x${ this.balance.toString(16) }`
			case 'eth_getStorageAt':
				this.ethGetStorageAtCalls.push(rpcRequest)
				return this.storageResponse
			case 'eth_maxPriorityFeePerGas': return this.maxPriorityFeePerGasResponse
			case 'eth_feeHistory': {
				this.ethFeeHistoryCalls.push(rpcRequest)
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
				if (rpcRequest.params[1] === true) return parseRequest(eth_getBlockByNumber_goerli_8443561_true)
				return parseRequest(eth_getBlockByNumber_goerli_8443561_false)
			}
			case 'eth_getBlockByHash': {
				const requestedBlockHash = BigInt(rpcRequest.params[0])
				const lookupError = this.ethGetBlockByHashErrorsByHash.get(requestedBlockHash)
				if (lookupError !== undefined) throw lookupError
				if (requestedBlockHash !== BigInt(testBytes32('abcd'))) return null
				if (rpcRequest.params[1] === true) return parseRequest(eth_getBlockByNumber_goerli_8443561_true)
				return parseRequest(eth_getBlockByNumber_goerli_8443561_false)
			}
			case 'eth_simulateV1': {
				this.ethSimulateV1Requests.push(rpcRequest)
				const lastBlockStateCall = rpcRequest.params[0]?.blockStateCalls.at(-1)
				const lastCall = lastBlockStateCall?.calls[0]
				const lastCallInput = lastCall?.input
				const lastCallGas = lastCall?.gas
				const lastCallNonce = lastCall?.nonce
				const lastCallAuthorizationList = lastCall?.authorizationList
				const hasGetCodeOverride = lastBlockStateCall?.stateOverrides?.[addressString(0x1ce438391307f908756fefe0fe220c0f0d51508an)]?.code !== undefined
				const aggregate3BalanceQueryCount = lastCallInput !== undefined && dataStringWith0xStart(lastCallInput).startsWith('0x82ad56cb')
					? (() => {
						const decoded = decodeFunctionDataStrict(Multicall3ABI, dataStringWith0xStart(lastCallInput))
						if (decoded.functionName !== 'aggregate3') throw new Error('expected aggregate3 call')
						return decoded.args[0].length
					})()
					: undefined
				const blockStateCallCount = rpcRequest.params[0]?.blockStateCalls.length ?? 0
				this.ethSimulateV1Calls.push({ blockStateCallCount, aggregate3BalanceQueryCount, lastCallGas, lastCallNonce, lastCallAuthorizationList, hasGetCodeOverride, traceTransfers: rpcRequest.params[0].traceTransfers, validation: rpcRequest.params[0].validation, parentBlockTag: rpcRequest.params[1] })
				if (this.rejectOmittedGas && lastCallGas === undefined) {
					throw new JsonRpcResponseError({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'gas required' } })
				}
				if (lastCallInput !== undefined && dataStringWith0xStart(lastCallInput).startsWith(getCodeSelector)) {
					const singleTransactionBlock = ethSimulateSingleBlockResult[0]
					const singleCall = singleTransactionBlock?.calls[0]
					if (singleTransactionBlock === undefined || singleCall === undefined) throw new Error('missing single transaction simulation fixture')
					return createMockEthSimulateV1ResultWithCustomLastBlock(blockStateCallCount, {
						...singleTransactionBlock,
						calls: [{
							...singleCall,
							returnData: this.malformedGetCodeReturn ? '0x' : encodeFunctionReturn(getCodeAbi, 'at', ['0x1234']),
						}],
					})
				}
				const storageReaderAccountOverride = lastCall?.to === undefined || lastCall.to === null
					? undefined
					: lastBlockStateCall?.stateOverrides?.[addressString(lastCall.to)]
				const storageReaderOverride = storageReaderAccountOverride?.code
				if (storageReaderOverride !== undefined && areEqualUint8Arrays(storageReaderOverride, getStorageReaderByteCode())) {
					const singleTransactionBlock = ethSimulateSingleBlockResult[0]
					const singleCall = singleTransactionBlock?.calls[0]
					if (singleTransactionBlock === undefined || singleCall === undefined) throw new Error('missing single transaction simulation fixture')
					if (lastCall?.to === undefined || lastCall.to === null || lastCall.input === undefined) throw new Error('storage reader call is incomplete')
					const decodedStorageCall = decodeFunctionDataStrict(STORAGE_READER_ABI, dataStringWith0xStart(lastCall.input))
					if (decodedStorageCall.functionName !== 'readSlot') throw new Error('expected storage reader call')
					const isActivePrecompile = activePrecompileAddresses.has(lastCall.to)
					if (!isActivePrecompile && storageReaderAccountOverride.movePrecompileToAddress !== undefined) {
						throw new JsonRpcResponseError({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: `account ${ addressString(lastCall.to) } is not a precompile` } })
					}
					const requestedAddress = addressString(lastCall.to)
					const requestedSlot = decodedStorageCall.args[0]
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
							returnData: encodeFunctionReturn(STORAGE_READER_ABI, 'readSlot', [
								bytes32String(isActivePrecompile && storageReaderAccountOverride.movePrecompileToAddress === undefined ? 0xbadn : storageValue),
							]),
						}],
					})
				}
				const result = createMockEthSimulateV1Result(blockStateCallCount, aggregate3BalanceQueryCount)
				if (aggregate3BalanceQueryCount !== undefined) return result
				const lastBlock = result.at(-1)
				const lastResult = lastBlock?.calls[0]
				if (lastBlock === undefined || lastResult === undefined) return result
				const gasUsed = this.simulatedCallGasUsed === undefined ? lastResult.gasUsed : `0x${ this.simulatedCallGasUsed.toString(16) }`
				const maxUsedGas = this.simulatedCallMaxUsedGas === undefined ? lastResult.maxUsedGas ?? gasUsed : `0x${ this.simulatedCallMaxUsedGas.toString(16) }`
				const successfulCall = {
					...lastResult,
					gasUsed,
					maxUsedGas,
				}
				const callResult = lastCallGas !== undefined && this.minimumSuccessfulGasLimit !== undefined && lastCallGas < this.minimumSuccessfulGasLimit
					? (() => {
						const { logs: _logs, maxUsedGas: _maxUsedGas, ...failedCallBase } = successfulCall
						return {
						...failedCallBase,
						status: '0x0',
						gasUsed: `0x${ lastCallGas.toString(16) }`,
						error: { code: -32000, message: 'out of gas' },
					}
					})()
					: successfulCall
				const customCall = this.omitMaxUsedGas
					? (() => {
						const { maxUsedGas: _maxUsedGas, ...callWithoutMaxUsedGas } = callResult
						return callWithoutMaxUsedGas
					})()
					: callResult
				return createMockEthSimulateV1ResultWithCustomLastBlock(blockStateCallCount, { ...lastBlock, calls: [customCall] })
			}
			default: throw new Error(`unsupported method ${ rpcRequest.method }`)
		}
	}
}

const requestHandler = new MockEthereumJSONRpcRequestHandler()
const ethereum = new EthereumClientService(requestHandler, async () => undefined, async () => undefined, rpcNetwork)

describe('SimulationModeEthereumClientService', () => {
	const exampleTransaction = {
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

	const createSimulationStateInput = () => [{
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

			test('state-based full blocks include transaction block data and realized gas price', async () => {
				const simulationState = await createSimulationState(ethereum, undefined, createSimulationStateInput())
				if (simulationState.success === false) throw new Error('simulation unexpectedly failed')
				const latestBlock = await getSimulatedBlock(ethereum, undefined, toResolvedSimulationState(simulationState), 'latest', true)
				if (latestBlock === null) throw new Error('latest simulated block missing')
				const transaction = latestBlock.transactions[0]
				if (transaction === undefined || !('blockHash' in transaction)) throw new Error('full simulated transaction data missing')

				assert.equal(transaction.blockHash, latestBlock.hash)
				assert.equal(transaction.blockNumber, latestBlock.number)
				assert.equal(transaction.transactionIndex, 0n)
				assert.deepEqual(transaction.data, transaction.input)
				assert.equal(transaction.gasPrice, simulationState.simulatedBlocks[0]?.simulatedTransactions[0]?.realizedGasPrice)
			})

		})
