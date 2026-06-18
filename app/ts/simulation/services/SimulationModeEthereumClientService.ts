import { type EthereumClientService, getNextBlockTimeStampOverride } from './EthereumClientService.js'
import type { PreparedEthSimulateV1Input } from './EthereumClientService.js'
import { type EthereumUnsignedTransaction, type EthereumSignedTransactionWithBlockData, type EthereumBlockTag, EthereumAddress, type EthereumBlockHeader, type EthereumBlockHeaderWithTransactionHashes, EthereumData, EthereumQuantity, type EthereumBytes32, type EthereumSendableSignedTransaction, type EthereumBlockHeaderTransaction } from '../../types/wire-types.js'
import { addressString, bigintSecondsToDate, bigintToUint8Array, bytes32String, calculateWeightedPercentile, dataStringWith0xStart, dateToBigintSeconds, max, min, stringToUint8Array } from '../../utils/bigint.js'
import { CANNOT_SIMULATE_OFF_LEGACY_BLOCK, ERROR_INTERCEPTOR_GAS_ESTIMATION_FAILED, ETHEREUM_LOGS_LOGGER_ADDRESS, ETHEREUM_EIP1559_BASEFEECHANGEDENOMINATOR, ETHEREUM_EIP1559_ELASTICITY_MULTIPLIER, MOCK_ADDRESS, MULTICALL3, Multicall3ABI, DEFAULT_CALL_ADDRESS, GAS_PER_BLOB } from '../../utils/constants.js'
import type { SimulatedTransaction, SimulationState, TokenBalancesAfter, PreSimulationTransaction, SimulationStateBlock, SimulationStateInput, SimulationStateInputMinimalData, SimulationStateInputMinimalDataBlock, BlockTimeManipulationDeltaUnit, ExecutionSimulatedTransaction, ExecutionSimulationState, ResolvedExecutionSimulationState, ResolvedSimulationInput, ResolvedSimulationState } from '../../types/visualizer-types.js'
import type { Abi } from 'viem'
import { privateKeyToAccount, stringToBytes, keccak256, hashMessage, hashTypedData } from '../../utils/viem.js'
import { EthereumUnsignedTransactionToUnsignedTransaction, type IUnsignedTransaction1559, rlpEncode, serializeSignedTransactionToBytes } from '../../utils/ethereum.js'
import type { EthGetLogsResponse, EthGetLogsRequest, EthTransactionReceiptResponse, PartialEthereumTransaction, EthGetFeeHistoryResponse, FeeHistory } from '../../types/JsonRpc-types.js'
import { handleERC1155TransferBatch, handleERC1155TransferSingle } from '../logHandlers.js'
import { assertNever, modifyObject } from '../../utils/typescript.js'
import type { PersonalSignParams, SignMessageParams } from '../../types/jsonRpc-signing-types.js'
import type { EthSimulateV1BlockHeader, EthSimulateV1CallResult, EthSimulateV1Result, EthereumEvent, StateOverrides } from '../../types/ethSimulate-types.js'
import type { BlockCalls as SimulateBlockCalls } from '../../types/ethSimulate-types.js'
import { stripLeadingZeros } from '../../utils/typed-arrays.js'
import { getMakeCurrentAddressRich, getSettings } from '../../background/settings.js'
import { JsonRpcResponseError } from '../../utils/errors.js'
import { deduplicateByFunction, last } from '../../utils/array.js'
import { promiseAllMapAbortSafe } from '../../utils/requests.js'
import type { ErrorWithCodeAndOptionalData } from '../../types/error.js'
import { getSimulationInputHash } from '../../utils/simulationFingerprint.js'
import { decodeCallDataLoose, decodeEventLoose, decodeFunctionOutput, encodeFunctionCall, type AbiLike } from '../../utils/abiRuntime.js'
import { Erc20ABI, Erc1155ABI } from '../../utils/abi.js'
import { getDesiredMaxFeePerGasForBaseFee, getTransactionFeesForBaseFee, hasExplicitMaxFeePerGas } from '../../utils/transactionFees.js'

type SuccessfulExecutionSimulationState = Extract<ExecutionSimulationState, { success: true }>

const MOCK_PUBLIC_PRIVATE_KEY = 0x1n // key used to sign mock transactions
const MOCK_SIMULATION_PRIVATE_KEY = 0x2n // key used to sign simulated transatons
const ADDRESS_FOR_PRIVATE_KEY_ONE = 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdfn
const GET_CODE_CONTRACT = 0x1ce438391307f908756fefe0fe220c0f0d51508an
const getCodeAbi = [
	{
		type: 'function',
		name: 'at',
		stateMutability: 'view',
		inputs: [{ name: 'target', type: 'address' }],
		outputs: [{ name: 'code', type: 'bytes' }],
	},
] as const satisfies Abi

export const DEFAULT_BLOCK_MANIPULATION = { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' } as const

type GroupedEthSimulateV1BlockResult = {
	inputBlock: SimulationStateInputMinimalDataBlock
	baseFeePerGas: bigint
	timestamp: bigint
	blockHeader?: EthSimulateV1BlockHeader
	calls: readonly EthSimulateV1CallResult[]
}

type GroupedEthSimulateV1Result = readonly GroupedEthSimulateV1BlockResult[]

type PreparedSimulationExecutionBlock = {
	inputBlock: SimulationStateInputMinimalDataBlock
	blockNumber: bigint
	blockHash: bigint
	parentHash: bigint
	blockTimestamp: Date
	gasUsed: bigint
	baseFeePerGas: bigint | undefined
	totalDifficulty: bigint
}

type PreparedSimulationExecutionContext = {
	simulationStateInput: SimulationStateInputMinimalData
	parentBlock: NonNullable<EthereumBlockHeader>
	prepared: PreparedEthSimulateV1Input
	executionBlocks: readonly PreparedSimulationExecutionBlock[]
}

type SimulationInspectionBase = {
	simulationStateInput: SimulationStateInput
	blockNumber: bigint
	blockTimestamp: Date
	baseFeePerGas: bigint
	simulationConductedTimestamp: Date
	rpcNetwork: SimulationState['rpcNetwork']
}

type SimulationInputInspection = {
	success: true
	base: SimulationInspectionBase
	groupedEthSimulateV1CallResult: GroupedEthSimulateV1Result
} | {
	success: false
	base: SimulationInspectionBase
	jsonRpcError: ReturnType<JsonRpcResponseError['serialize']>
}

type PreparedSimulatedExecutionBlock = PreparedSimulationExecutionBlock & {
	simulatedTransactions: readonly ExecutionSimulatedTransaction[]
}

export const getWebsiteCreatedEthereumUnsignedTransactions = (simulatedTransactions: readonly SimulatedTransaction[]) => {
	return simulatedTransactions.map((simulatedTransaction) => ({
		transaction: simulatedTransaction.preSimulationTransaction.signedTransaction,
		website: simulatedTransaction.preSimulationTransaction.website,
		created: simulatedTransaction.preSimulationTransaction.created,
		originalRequestParameters: simulatedTransaction.preSimulationTransaction.originalRequestParameters,
		transactionIdentifier: simulatedTransaction.preSimulationTransaction.transactionIdentifier,
		success: true as const,
	}))
}

const transactionQueueTotalGasLimit = (simulatedTransactions: readonly SimulatedTransaction[]) => {
	return simulatedTransactions.reduce((a, b) => a + b.preSimulationTransaction.signedTransaction.gas, 0n)
}

const transactionQueueTotalGasUsed = (simulatedTransactions: readonly SimulatedTransaction[]) => {
	return simulatedTransactions.reduce((totalGasUsed, simulatedTransaction) => totalGasUsed + simulatedTransaction.ethSimulateV1CallResult.gasUsed, 0n)
}

const transactionQueueTotalGasLimitFromInput = (block: SimulationStateInputMinimalDataBlock | undefined) => {
	if (block === undefined) return 0n
	return block.transactions.reduce((totalGasUsed, transaction) => totalGasUsed + transaction.signedTransaction.gas, 0n)
}

const isEmptySimulationInput = (simulationStateInput: SimulationStateInput | SimulationStateInputMinimalData) => simulationStateInput.length === 0

const getSimulationBlockNumber = (simulationState: SimulationState, blockDelta: number) => simulationState.blockNumber + BigInt(blockDelta) + 1n

const getHashOfSimulatedBlockFromInput = (simulationStateInput: SimulationStateInput | SimulationStateInputMinimalData, blockDelta: number) => {
	return BigInt(keccak256(stringToBytes(`${ getSimulationInputHash(simulationStateInput) }:${ blockDelta }`)))
}

const createPreparedSimulationExecutionContext = async (
	ethereumClientService: EthereumClientService,
	requestAbortController: AbortController | undefined,
	simulationStateInput: ResolvedSimulationInput | SimulationStateInputMinimalData | undefined,
	baseBlockTag: EthereumBlockTag = 'latest',
): Promise<PreparedSimulationExecutionContext | undefined> => {
	if (simulationStateInput === undefined) return undefined
	const resolvedSimulationInput = 'kind' in simulationStateInput
		? simulationStateInput.kind === 'passthrough'
			? undefined
			: simulationStateInput.value
		: simulationStateInput
	if (resolvedSimulationInput === undefined) return undefined
	if (isEmptySimulationInput(resolvedSimulationInput)) return undefined
	const parentBlock = await ethereumClientService.getBlock(requestAbortController, baseBlockTag)
	if (parentBlock === null) throw new Error('The latest block is null')
	const prepared = await ethereumClientService.prepareEthSimulateV1Input(resolvedSimulationInput, parentBlock.number, requestAbortController)
	let previousBlockHash = parentBlock.hash
	let previousGasUsed = parentBlock.gasUsed
	let previousBaseFeePerGas = parentBlock.baseFeePerGas
	let previousBlockNumber = parentBlock.number
	let previousTotalDifficulty = parentBlock.totalDifficulty ?? 0n
	const executionBlocks = prepared.rpcBlocks.map((inputBlock, blockIndex) => {
		const blockOverride = prepared.blockOverrides[blockIndex]
		if (blockOverride === undefined) throw new Error('missing block override for prepared simulation block')
		if (blockOverride.time === undefined) throw new Error('missing timestamp for prepared simulation block')
		const gasUsed = transactionQueueTotalGasLimitFromInput(inputBlock)
		const baseFeePerGas = previousBaseFeePerGas === undefined ? undefined : getNextBaseFeePerGas(previousGasUsed, parentBlock.gasLimit, previousBaseFeePerGas)
		const blockHash = getHashOfSimulatedBlockFromInput(resolvedSimulationInput, blockIndex)
		const executionBlock = {
			inputBlock,
			blockNumber: previousBlockNumber + 1n,
			blockHash,
			parentHash: previousBlockHash,
			blockTimestamp: blockOverride.time,
			gasUsed,
			baseFeePerGas,
			totalDifficulty: previousTotalDifficulty + parentBlock.difficulty,
		}
		previousBlockHash = blockHash
		previousGasUsed = gasUsed
		previousBaseFeePerGas = baseFeePerGas
		previousBlockNumber = executionBlock.blockNumber
		previousTotalDifficulty = executionBlock.totalDifficulty
		return executionBlock
	})
	return {
		simulationStateInput: resolvedSimulationInput,
		parentBlock,
		prepared,
		executionBlocks,
	}
}

const resolveSimulationBlockTag = (
	baseBlockNumber: bigint,
	executionBlockCount: number,
	blockTag: EthereumBlockTag = 'latest',
) => {
	if (blockTag === 'latest' || blockTag === 'pending') return baseBlockNumber + BigInt(executionBlockCount)
	return blockTag
}

const canQueryNodeDirectlyFromInput = (
	baseBlockNumber: bigint,
	executionBlockCount: number,
	blockTag: EthereumBlockTag = 'latest',
) => {
	if (blockTag === 'finalized') return true
	if (executionBlockCount === 0) return true
	if (typeof blockTag === 'bigint' && blockTag <= baseBlockNumber) return true
	return false
}

const getExecutionBlockIndexForTag = (
	baseBlockNumber: bigint,
	executionBlockCount: number,
	blockTag: EthereumBlockTag = 'latest',
) => {
	const resolvedBlockTag = resolveSimulationBlockTag(baseBlockNumber, executionBlockCount, blockTag)
	if (typeof resolvedBlockTag !== 'bigint') return undefined
	if (resolvedBlockTag <= baseBlockNumber) return undefined
	if (resolvedBlockTag > baseBlockNumber + BigInt(executionBlockCount)) return undefined
	return Number(resolvedBlockTag - baseBlockNumber - 1n)
}

const getExecutionBlocksUpToTag = (
	context: PreparedSimulationExecutionContext,
	blockTag: EthereumBlockTag = 'latest',
) => {
	const resolvedBlockTag = resolveSimulationBlockTag(context.parentBlock.number, context.executionBlocks.length, blockTag)
	if (typeof resolvedBlockTag !== 'bigint' || resolvedBlockTag <= context.parentBlock.number) return []
	const includedBlockCount = min(
		BigInt(context.executionBlocks.length),
		resolvedBlockTag - context.parentBlock.number,
	)
	return context.executionBlocks.slice(0, Number(includedBlockCount))
}

export const simulationGasLeft = (simulationStateBlock: SimulationStateBlock | undefined, blockHeader: EthereumBlockHeader) => {
	if (blockHeader === null) throw new Error('The latest block is null')
	if (simulationStateBlock === undefined) return blockHeader.gasLimit * 1023n / 1024n
	return max(blockHeader.gasLimit * 1023n / 1024n - transactionQueueTotalGasLimit(simulationStateBlock.simulatedTransactions), 0n)
}

export function getInputFieldFromDataOrInput(request: { input?: Uint8Array} | { data?: Uint8Array } | {}) {
	if ('data' in request && request.data !== undefined) return request.data
	if ('input' in request && request.input !== undefined) return request.input
	return new Uint8Array()
}

export const getSimulatedTransactionCount = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: ResolvedSimulationState, address: bigint, blockTag: EthereumBlockTag = 'latest') => {
	if (blockTag === 'finalized' || simulationState.kind === 'passthrough') return await ethereumClientService.getTransactionCount(address, blockTag, requestAbortController)
	const currentState = simulationState.value
	if (currentState.success === false) throw new JsonRpcResponseError(currentState.jsonRpcError)
	const blockNumToUseForSim = blockTag === 'latest' || blockTag === 'pending' ? currentState.blockNumber + BigInt(currentState.simulatedBlocks.length) : blockTag
	const blockNumToUseForChain = blockTag === 'latest' || blockTag === 'pending' ? blockTag : min(blockTag, await ethereumClientService.getBlockNumber(requestAbortController))
	let addedTransactions = 0n
	if (blockTag === 'latest' || blockTag === 'pending' || blockTag > currentState.blockNumber) {
		// if we are on our simulated block, just count how many transactions we have sent in the simulation to increment transaction count
		let index = 0
		for (const block of currentState.simulatedBlocks) {
			const currBlockNum = currentState.blockNumber + BigInt(index) + 1n
			if (blockNumToUseForSim < currBlockNum) {
				break
			}
			for (const signed of block.simulatedTransactions) {
				if (signed.preSimulationTransaction.signedTransaction.from === address) addedTransactions += 1n
			}
			index++
		}
	}
	return (await ethereumClientService.getTransactionCount(address, blockNumToUseForChain, requestAbortController)) + addedTransactions
}

type Simulated1559BlockCall = Pick<IUnsignedTransaction1559, 'from' | 'chainId' | 'nonce' | 'maxFeePerGas' | 'maxPriorityFeePerGas' | 'to' | 'value' | 'input'> & Partial<Pick<IUnsignedTransaction1559, 'gasLimit' | 'accessList'>>

const createSimulated1559BlockCall = (transaction: Simulated1559BlockCall): SimulateBlockCalls['calls'][number] => {
	const { gasLimit, maxFeePerGas, accessList, ...transactionWithoutOptionalGasFields } = transaction
	return {
		type: '1559' as const,
		...transactionWithoutOptionalGasFields,
		accessList: accessList ?? [],
		...(maxFeePerGas === 0n ? {} : { maxFeePerGas }),
		...(gasLimit === undefined ? {} : { gas: gasLimit }),
	}
}

const simulateBlockCallWithPreparedInputContext = async (
	ethereumClientService: EthereumClientService,
	requestAbortController: AbortController | undefined,
	context: PreparedSimulationExecutionContext | undefined,
	transaction: Simulated1559BlockCall,
	extraOverrides: StateOverrides = {},
	simulateWithZeroBaseFee = false,
) => {
	const parentBlock = context?.parentBlock ?? await ethereumClientService.getBlock(requestAbortController)
	if (parentBlock === null) throw new Error('The latest block is null')
	const previousBlockOverride = context?.prepared.blockOverrides[context.prepared.blockOverrides.length - 1]
	const previousBlockTime = previousBlockOverride?.time ?? parentBlock.timestamp
	const baseFeePerGas = parentBlock.baseFeePerGas === undefined ? 15_000_000n : parentBlock.baseFeePerGas
	const blockStateCalls: readonly SimulateBlockCalls[] = [
		...(context?.prepared.request.params[0].blockStateCalls ?? []),
		{
			calls: [createSimulated1559BlockCall(transaction)],
			blockOverrides: {
				...(previousBlockOverride ?? { feeRecipient: parentBlock.miner }),
				baseFeePerGas: simulateWithZeroBaseFee ? 0n : baseFeePerGas,
				time: getNextBlockTimeStampOverride(previousBlockTime, DEFAULT_BLOCK_MANIPULATION),
			},
			stateOverrides: extraOverrides,
		},
	]
	const simulationResult = await ethereumClientService.ethSimulateV1(blockStateCalls, parentBlock.number, requestAbortController)
	const lastBlock = simulationResult[simulationResult.length - 1]
	return lastBlock?.calls[0]
}

const simulateBlockCallOnTopOfSimulationInput = async (
	ethereumClientService: EthereumClientService,
	requestAbortController: AbortController | undefined,
	simulationStateInput: SimulationStateInputMinimalData | undefined,
	transaction: Simulated1559BlockCall,
	extraOverrides: StateOverrides = {},
	simulateWithZeroBaseFee = false,
) => {
	return await simulateBlockCallWithPreparedInputContext(
		ethereumClientService,
		requestAbortController,
		await createPreparedSimulationExecutionContext(ethereumClientService, requestAbortController, simulationStateInput),
		transaction,
		extraOverrides,
		simulateWithZeroBaseFee,
	)
}

export const simulateEstimateGas = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: ResolvedSimulationState, data: PartialEthereumTransaction, blockDelta: number | undefined = undefined): Promise<{ error: ErrorWithCodeAndOptionalData } | { gas: bigint }> => {
	if (simulationState.kind === 'passthrough') return { gas: await ethereumClientService.estimateGas(data, requestAbortController) }
	const currentState = simulationState.value
	if (currentState.success === false) throw new JsonRpcResponseError(currentState.jsonRpcError)
	const sendAddress = data.from !== undefined ? data.from : MOCK_ADDRESS
	const transactionCount = getSimulatedTransactionCount(ethereumClientService, requestAbortController, simulationState, sendAddress)
	const block = await getSimulatedBlock(ethereumClientService, requestAbortController, simulationState)
	if (block === null) throw new Error('The latest block is null')
	const simulatedBlockIncrement = blockDelta === undefined ? currentState.simulatedBlocks.length || 0 : blockDelta
	const maxGas = simulationGasLeft(currentState.simulatedBlocks[simulatedBlockIncrement] || undefined, block)

	const estimateGasTransaction = {
		type: '1559' as const,
		from: sendAddress,
		chainId: ethereumClientService.getChainId(),
		nonce: await transactionCount,
		// Ideally, we would estimate using the correct base fee and priority fee values.
		// However, doing so would require the account to hold enough ETH to cover the gas cost of an entire block, which is not a reasonable expectation.
		maxFeePerGas: 0n,
		maxPriorityFeePerGas: 0n ,
		...(data.gas === undefined ? {} : { gasLimit: data.gas }),
		to: data.to === undefined ? null : data.to,
		value: data.value === undefined ? 0n : data.value,
		input: getInputFieldFromDataOrInput(data),
		accessList: []
	}
	try {
		const lastResult = await simulateBlockCallOnTopOfSimulationInput(ethereumClientService, requestAbortController, currentState.simulationStateInput, estimateGasTransaction, {}, true)
		if (lastResult === undefined) return { error: { code: ERROR_INTERCEPTOR_GAS_ESTIMATION_FAILED, message: 'ETH Simulate Failed to estimate gas', data: '0x' } }
		if (lastResult.status === 'failure') return { error: { ...lastResult.error, data: dataStringWith0xStart(lastResult.returnData) } }
		const gasSpent = lastResult.gasUsed * 125n * 64n / (100n * 63n) // add 25% * 64 / 63 extra  to account for gas savings <https://eips.ethereum.org/EIPS/eip-3529>
		return { gas: gasSpent < maxGas ? gasSpent : maxGas }
	} catch (error: unknown) {
		if (error instanceof JsonRpcResponseError) {
			const safeParsedData = EthereumData.safeParse(error.data)
			return { error: { code: error.code, message: error.message, data: safeParsedData.success ? dataStringWith0xStart(safeParsedData.value) : '0x' } }
		}
		throw error
	}
}

// calculates gas price for receipts
export const calculateRealizedEffectiveGasPrice = (transaction: EthereumUnsignedTransaction, blocksBaseFeePerGas: bigint) => {
	if ('gasPrice' in transaction) return transaction.gasPrice
	return min(blocksBaseFeePerGas + transaction.maxPriorityFeePerGas, transaction.maxFeePerGas)
}

export const mockSignTransaction = (transaction: EthereumUnsignedTransaction) : EthereumSendableSignedTransaction => {
	const unsignedTransaction = EthereumUnsignedTransactionToUnsignedTransaction(transaction)
	if (unsignedTransaction.type === 'legacy') {
		const signatureParams = { r: 0n, s: 0n, v: 0n }
		const hash = EthereumQuantity.parse(keccak256(serializeSignedTransactionToBytes({ ...unsignedTransaction, ...signatureParams })))
		if (transaction.type !== 'legacy') throw new Error('types do not match')
		return { ...transaction, ...signatureParams, hash }
	}
	if (unsignedTransaction.type === '7702') {
		const signatureParams = { r: 0n, s: 0n, yParity: 'even' as const }
		const authorizationList = unsignedTransaction.authorizationList.map((element) => ({ ...element, ...signatureParams }))
		const hash = EthereumQuantity.parse(keccak256(serializeSignedTransactionToBytes({ ...unsignedTransaction, ...signatureParams, authorizationList })))
		if (transaction.type !== '7702') throw new Error('types do not match')
		return { ...transaction, ...signatureParams, hash, authorizationList }
	}
	const signatureParams = { r: 0n, s: 0n, yParity: 'even' as const }
	const hash = EthereumQuantity.parse(keccak256(serializeSignedTransactionToBytes({ ...unsignedTransaction, ...signatureParams })))
	if (transaction.type === 'legacy' || transaction.type === '7702') throw new Error('types do not match')
	return { ...transaction, ...signatureParams, hash }
}

export const getAddressToMakeRich = async () => {
	const settings = await getSettings()
	if (!settings.simulationMode) return undefined
	return await getMakeCurrentAddressRich() ? settings.activeSimulationAddress : undefined
}

export const getBlockTimeManipulationSeconds = (deltaToAdd: EthereumQuantity, deltaUnit: BlockTimeManipulationDeltaUnit) => {
	switch(deltaUnit) {
		case 'Seconds': return deltaToAdd
		case 'Minutes': return deltaToAdd * 60n
		case 'Hours': return deltaToAdd * 60n * 60n
		case 'Days': return deltaToAdd * 60n * 60n * 24n
		case 'Weeks': return deltaToAdd * 60n * 60n * 24n * 7n
		case 'Months': return deltaToAdd * 60n * 60n * 24n * 30n
		case 'Years': return deltaToAdd * 60n * 60n * 24n * 365n
		default: assertNever(deltaUnit)
	}
}

export const groupEthSimulateV1ResultByInputBlocks = (prepared: PreparedEthSimulateV1Input, result: EthSimulateV1Result): GroupedEthSimulateV1Result => {
	let rpcBlockIndex = 0
	const groupedResults = prepared.inputBlocks.map((preparedInputBlock) => {
		const resultBlocks = result.slice(rpcBlockIndex, rpcBlockIndex + preparedInputBlock.rpcBlockCount)
		if (resultBlocks.length !== preparedInputBlock.rpcBlockCount) throw new Error('multicall length does not match in createSimulationState')
		rpcBlockIndex += preparedInputBlock.rpcBlockCount
		const firstResultBlock = resultBlocks[0]
		if (firstResultBlock === undefined) throw new Error('grouped result block was undefined')
		const blockHeader = preparedInputBlock.rpcBlockCount === 1 ? (() => {
			const { calls: _calls, ...header } = firstResultBlock
			return header
		})() : undefined
		return {
			inputBlock: preparedInputBlock.inputBlock,
			baseFeePerGas: firstResultBlock.baseFeePerGas,
			timestamp: firstResultBlock.timestamp,
			blockHeader,
			calls: resultBlocks.flatMap((block) => block.calls),
		}
	})
	if (rpcBlockIndex !== result.length) throw new Error('multicall length does not match in createSimulationState')
	return groupedResults
}

export const inspectSimulationInput = async (
	ethereumClientService: EthereumClientService,
	requestAbortController: AbortController | undefined,
	simulationStateInput: SimulationStateInput,
): Promise<SimulationInputInspection> => {
	const parentBlock = await ethereumClientService.getBlock(requestAbortController)
	if (parentBlock === null) throw new Error('The latest block is null')
	const base = {
		simulationStateInput,
		blockNumber: parentBlock.number,
		blockTimestamp: parentBlock.timestamp,
		baseFeePerGas: 0n,
		simulationConductedTimestamp: new Date(),
		rpcNetwork: ethereumClientService.getRpcEntry(),
	}
	if (isEmptySimulationInput(simulationStateInput)) {
		let previousTimestamp = parentBlock.timestamp
		return {
			success: true,
			base,
			groupedEthSimulateV1CallResult: simulationStateInput.map((inputBlock) => {
				previousTimestamp = getNextBlockTimeStampOverride(previousTimestamp, inputBlock.blockTimeManipulation || DEFAULT_BLOCK_MANIPULATION)
				return {
					inputBlock,
					baseFeePerGas: parentBlock.baseFeePerGas || 0n,
					timestamp: dateToBigintSeconds(previousTimestamp),
					calls: [],
				}
			}),
		}
	}
	try {
		const { prepared, result: ethSimulateV1CallResult } = await ethereumClientService.simulatePrepared(simulationStateInput, parentBlock.number, requestAbortController)
		const groupedEthSimulateV1CallResult = groupEthSimulateV1ResultByInputBlocks(prepared, ethSimulateV1CallResult)
		return {
			success: true,
			base: {
				...base,
				baseFeePerGas: groupedEthSimulateV1CallResult[0]?.baseFeePerGas ?? 0n,
			},
			groupedEthSimulateV1CallResult,
		}
	} catch(error: unknown) {
		if (error instanceof JsonRpcResponseError) return { success: false, base, jsonRpcError: error.serialize() }
		throw error
	}
}

const getExecutionSimulationStateBlockBase = (callResult: GroupedEthSimulateV1BlockResult) => ({
	signedMessages: callResult.inputBlock.signedMessages || [],
	stateOverrides: callResult.inputBlock.stateOverrides || {},
	blockTimestamp: bigintSecondsToDate(callResult.timestamp),
	blockTimeManipulation: callResult.inputBlock.blockTimeManipulation || DEFAULT_BLOCK_MANIPULATION,
	blockBaseFeePerGas: callResult.baseFeePerGas,
	blockHeader: callResult.blockHeader,
})

const createExecutionSimulationBlocks = (
	simulationStateInput: SimulationStateInput,
	groupedEthSimulateV1CallResult: GroupedEthSimulateV1Result,
): SuccessfulExecutionSimulationState['simulatedBlocks'] => {
	return groupedEthSimulateV1CallResult.map((callResult, blockIndex) => ({
		simulatedTransactions: callResult.calls.map((singleResult, transactionIndex) => {
			const signedTx = simulationStateInput[blockIndex]?.transactions[transactionIndex]
			if (signedTx === undefined) throw Error('invalid transaction index')
			return {
				ethSimulateV1CallResult: singleResult,
				realizedGasPrice: calculateRealizedEffectiveGasPrice(signedTx.signedTransaction, callResult.baseFeePerGas),
				preSimulationTransaction: signedTx,
			}
		}),
		...getExecutionSimulationStateBlockBase(callResult),
	}))
}

export const createExecutionSimulationState = async (
	ethereumClientService: EthereumClientService,
	requestAbortController: AbortController | undefined,
	simulationStateInput: SimulationStateInput,
): Promise<ExecutionSimulationState> => {
	const simulationInspection = await inspectSimulationInput(ethereumClientService, requestAbortController, simulationStateInput)
	if (simulationInspection.success === false) return { ...simulationInspection.base, success: false, jsonRpcError: simulationInspection.jsonRpcError }
	const { base, groupedEthSimulateV1CallResult } = simulationInspection
	return {
		success: true,
		simulatedBlocks: createExecutionSimulationBlocks(simulationStateInput, groupedEthSimulateV1CallResult),
		...base,
	}
}

export const createSimulationState = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationStateInput: SimulationStateInput): Promise<SimulationState> => {
	const executionSimulationState = await createExecutionSimulationState(ethereumClientService, requestAbortController, simulationStateInput)
	if (executionSimulationState.success === false) return executionSimulationState
	if (isEmptySimulationInput(simulationStateInput)) {
		return {
			...executionSimulationState,
			simulatedBlocks: executionSimulationState.simulatedBlocks.map((block) => ({ ...block, simulatedTransactions: [] })),
		}
	}
	const tokenBalancesAfter = await getTokenBalancesAfter(
		ethereumClientService,
		requestAbortController,
		executionSimulationState.simulatedBlocks.map((block) => ({
			inputBlock: {
				stateOverrides: block.stateOverrides,
				transactions: block.simulatedTransactions.map((transaction) => ({ signedTransaction: transaction.preSimulationTransaction.signedTransaction })),
				signedMessages: block.signedMessages,
				blockTimeManipulation: block.blockTimeManipulation,
				simulateWithZeroBaseFee: false,
			},
			baseFeePerGas: block.blockBaseFeePerGas,
			timestamp: dateToBigintSeconds(block.blockTimestamp),
			calls: block.simulatedTransactions.map((transaction) => transaction.ethSimulateV1CallResult),
		})),
		simulationStateInput,
	)
	return {
		...executionSimulationState,
		simulatedBlocks: executionSimulationState.simulatedBlocks.map((block, blockIndex) => ({
			...block,
			simulatedTransactions: block.simulatedTransactions.map((simulatedTransaction, transactionIndex) => {
				const tokenBalancesAfterForIndex = tokenBalancesAfter.blocks[blockIndex]?.transactions[transactionIndex]?.tokenBalancesAfter
				if (tokenBalancesAfterForIndex === undefined) throw Error('invalid tokenBalancesAfterForIndex index')
				return {
					...simulatedTransaction,
					tokenBalancesAfter: tokenBalancesAfterForIndex,
				}
			}),
		})),
	}
}

const createPreparedSimulatedExecutionBlocks = async (
	ethereumClientService: EthereumClientService,
	requestAbortController: AbortController | undefined,
	simulationState: SuccessfulExecutionSimulationState,
): Promise<readonly PreparedSimulatedExecutionBlock[]> => {
	const context = await createPreparedSimulationExecutionContext(
		ethereumClientService,
		requestAbortController,
		{ kind: 'simulated', value: simulationState.simulationStateInput },
		simulationState.blockNumber,
	)
	if (context === undefined) return []
	let executionBlockOffset = 0
	return context.prepared.inputBlocks.flatMap((preparedInputBlock, inputBlockIndex) => {
		const simulatedBlock = simulationState.simulatedBlocks[inputBlockIndex]
		if (simulatedBlock === undefined) throw new Error('missing simulated block while splitting execution blocks')
		let transactionOffset = 0
		const executionBlocksForInputBlock = Array.from({ length: preparedInputBlock.rpcBlockCount }, () => {
			const executionBlock = context.executionBlocks[executionBlockOffset]
			const rpcBlock = context.prepared.rpcBlocks[executionBlockOffset]
			executionBlockOffset += 1
			if (executionBlock === undefined) throw new Error('missing prepared execution block while splitting simulation results')
			if (rpcBlock === undefined) throw new Error('missing prepared rpc block while splitting simulation results')
			const transactionCount = rpcBlock.transactions.length
			const simulatedTransactions = simulatedBlock.simulatedTransactions.slice(transactionOffset, transactionOffset + transactionCount)
			if (simulatedTransactions.length !== transactionCount) throw new Error('prepared rpc block transaction count did not match simulated transactions')
			transactionOffset += transactionCount
			return {
				...executionBlock,
				simulatedTransactions,
			}
		})
		if (transactionOffset !== simulatedBlock.simulatedTransactions.length) throw new Error('simulated transactions remained after splitting execution blocks')
		return executionBlocksForInputBlock
	})
}

export const getPreSimulated = (simulatedTransactions: readonly SimulatedTransaction[]) => simulatedTransactions.map((transaction) => transaction.preSimulationTransaction)

export const appendTransactionsToInput = (simulationStateInput: SimulationStateInput, transactions: PreSimulationTransaction[], blockDelta: number | undefined = undefined, stateOverrides: StateOverrides = {}, simulateWithZeroBaseFee = false): SimulationStateInput => {
	const nonUndefinedBlockDelta = simulationStateInput.length
	const mergeStateSets = (oldOverrides: StateOverrides, newOverrides: StateOverrides) => {
		const copy = { ...oldOverrides }
		for (const [key, value] of Object.entries(newOverrides)) {
			copy[key] = value
		}
		return copy
	}
	const newTransactions = [...transactions]
	if (simulationStateInput[nonUndefinedBlockDelta] !== undefined) {
		return simulationStateInput.map((block, index) => ({
			stateOverrides: mergeStateSets(block.stateOverrides, stateOverrides),
			transactions: index === blockDelta ? [...block.transactions, ...newTransactions] : block.transactions,
			signedMessages: block.signedMessages,
			blockTimeManipulation: block.blockTimeManipulation,
			simulateWithZeroBaseFee: block.simulateWithZeroBaseFee,
		}))
	}
	const oldBlocks = simulationStateInput.map((block) => ({
		stateOverrides: mergeStateSets(block.stateOverrides, stateOverrides),
		transactions: block.transactions,
		signedMessages: block.signedMessages,
		blockTimeManipulation: block.blockTimeManipulation,
		simulateWithZeroBaseFee: block.simulateWithZeroBaseFee
	}))
	return [
		...oldBlocks,
		{ stateOverrides: {}, transactions: newTransactions, signedMessages: [], blockTimeManipulation: DEFAULT_BLOCK_MANIPULATION, simulateWithZeroBaseFee }
	]
}

export const appendTransactionToInputAndSimulate = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, oldSimulatedInput: SimulationStateInput, transactions: PreSimulationTransaction[], blockDelta: number | undefined = undefined, stateOverrides: StateOverrides = {}): Promise<SimulationState> => {
	const simulationStateInput = appendTransactionsToInput(oldSimulatedInput, transactions, blockDelta, stateOverrides)
	return await createSimulationState(ethereumClientService, requestAbortController, simulationStateInput)
}

export const getNonceFixedSimulationStateInput = async(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationStateInput: SimulationStateInput) => {
	const isFixableNonceError = (transaction: PreSimulationTransaction, callResult: EthSimulateV1CallResult) => {
		return callResult.status === 'failure'
		&& callResult.error.message === 'wrong transaction nonce' //TODO, change to error code
		&& transaction.originalRequestParameters.method === 'eth_sendTransaction'
	}
	const simulationInspection = await inspectSimulationInput(ethereumClientService, requestAbortController, simulationStateInput)
	if (simulationInspection.success === false) return { nonceFixed: false, simulationStateInput }
	const knownPreviousNonce = new Map<string, bigint>()
	const blocks = simulationInspection.groupedEthSimulateV1CallResult

	const areThereNonceIssues = () => {
		const nonceFixable = blocks.find((block, blockIndex) => block.calls.find((callResult, transactionIndex) => {
			const transaction = simulationStateInput[blockIndex]?.transactions[transactionIndex]
			if (transaction === undefined) return false
			return isFixableNonceError(transaction, callResult)
		}))
		return nonceFixable !== undefined
	}
	if (!areThereNonceIssues()) return { nonceFixed: false, simulationStateInput }
	const simulationInputBlocks = []
	for (const [blockIndex, block] of blocks.entries()) {
		const processedTransactions: PreSimulationTransaction[] = []
		for (const [transactionIndex, callResult] of block.calls.entries()) {
			const preSimulationTransaction = simulationStateInput[blockIndex]?.transactions[transactionIndex]
			if (preSimulationTransaction === undefined) throw new Error('missing transaction when checking for nonces')
			const fromString = addressString(preSimulationTransaction.signedTransaction.from)
			const fixTransaction = async () => {
				if (!isFixableNonceError(preSimulationTransaction, callResult)) return preSimulationTransaction
				const prevNonce = knownPreviousNonce.get(fromString)
				const newNonce = prevNonce === undefined ? await ethereumClientService.getTransactionCount(preSimulationTransaction.signedTransaction.from, 'latest', requestAbortController) : prevNonce + 1n
				return modifyObject(preSimulationTransaction, { signedTransaction: modifyObject(preSimulationTransaction.signedTransaction, { nonce: newNonce }) })
			}
			const fixedTransaction = await fixTransaction()
			processedTransactions.push(fixedTransaction)
			knownPreviousNonce.set(fromString, fixedTransaction.signedTransaction.nonce)
		}
		const oldBlock = simulationStateInput[blockIndex]
		if (oldBlock === undefined) throw new Error('missing block when checking for nonces')
		simulationInputBlocks.push({ ...oldBlock, transactions: processedTransactions })
	}
	return { nonceFixed: true, simulationStateInput: simulationInputBlocks }
}

const canAffordMaxGasCost = (balance: bigint, value: bigint, gasLimit: bigint, maxFeePerGas: bigint) => {
	return balance >= value + gasLimit * maxFeePerGas
}

const subtractMaxGasCost = (balance: bigint, value: bigint, gasLimit: bigint, maxFeePerGas: bigint) => {
	const maxCost = value + gasLimit * maxFeePerGas
	return balance > maxCost ? balance - maxCost : 0n
}

const usesInterceptorFilledMaxFeePerGas = (transaction: PreSimulationTransaction) => {
	return transaction.originalRequestParameters.method === 'eth_sendTransaction'
		&& transaction.signedTransaction.type === '1559'
		&& !hasExplicitMaxFeePerGas(transaction.originalRequestParameters.params[0].maxFeePerGas)
}

const getBaseFeeAdjustedTransaction = (
	transaction: PreSimulationTransaction,
	parentBaseFeePerGas: bigint,
	balance: bigint,
) => {
	if (!usesInterceptorFilledMaxFeePerGas(transaction)) return transaction
	if (transaction.signedTransaction.type !== '1559') return transaction
	const feePerGas = getTransactionFeesForBaseFee(
		parentBaseFeePerGas,
		transaction.signedTransaction.maxPriorityFeePerGas,
		undefined,
		balance,
		transaction.signedTransaction.value,
		transaction.signedTransaction.gas,
	)
	return modifyObject(transaction, { signedTransaction: modifyObject(transaction.signedTransaction, feePerGas) })
}

const getBalanceBeforeSimulationInputTransaction = async (
	ethereumClientService: EthereumClientService,
	requestAbortController: AbortController | undefined,
	parentBlock: NonNullable<EthereumBlockHeader>,
	simulationInputBeforeBlock: SimulationStateInput,
	currentBlock: SimulationStateInput[number],
	transactionsBefore: readonly PreSimulationTransaction[],
	address: bigint,
) => {
	const overrideBalance = currentBlock.stateOverrides[addressString(address)]?.balance
	if (transactionsBefore.length === 0 && overrideBalance !== undefined) return overrideBalance
	if (simulationInputBeforeBlock.length === 0 && transactionsBefore.length === 0) return await ethereumClientService.getBalance(address, parentBlock.number, requestAbortController)
	const simulationInputBeforeTransaction = [
		...simulationInputBeforeBlock,
		modifyObject(currentBlock, { transactions: transactionsBefore }),
	]
	return await getSimulatedBalanceFromInput(
		ethereumClientService,
		requestAbortController,
		{ kind: 'simulated', value: simulationInputBeforeTransaction },
		address,
		'latest',
		parentBlock.number,
	)
}

const getBaseFeeAdjustedTransactionWithBalances = (
	parentBlock: NonNullable<EthereumBlockHeader>,
	transaction: PreSimulationTransaction,
	balances: ReadonlyMap<EthereumQuantity, bigint>,
) => {
	const adjustedTransactions = getBaseFeeAdjustedTransactions(parentBlock, [transaction], balances)
	const adjustedTransaction = adjustedTransactions[0]
	if (adjustedTransaction === undefined) throw new Error('missing base fee adjusted transaction')
	return adjustedTransaction
}

export const getBaseFeeAdjustmentBalances = async (
	ethereumClientService: EthereumClientService,
	requestAbortController: AbortController | undefined,
	parentBlock: EthereumBlockHeader,
	simulationInputBeforeBlock: SimulationStateInput,
	currentBlock: SimulationStateInput[number],
): Promise<{ balances: ReadonlyMap<EthereumQuantity, bigint>, transactions: readonly PreSimulationTransaction[] }> => {
	const balances = new Map<EthereumQuantity, bigint>()
	if (parentBlock === null) return { balances, transactions: currentBlock.transactions }
	const parentBaseFeePerGas = parentBlock.baseFeePerGas
	if (parentBaseFeePerGas === undefined) return { balances, transactions: currentBlock.transactions }
	const adjustedTransactions: PreSimulationTransaction[] = []
	const conservativeBalances = new Map<bigint, bigint>()
	for (const transaction of currentBlock.transactions) {
		if (transaction.originalRequestParameters.method !== 'eth_sendTransaction') {
			conservativeBalances.delete(transaction.signedTransaction.from)
			adjustedTransactions.push(getBaseFeeAdjustedTransactionWithBalances(parentBlock, transaction, balances))
			continue
		}
		if (transaction.signedTransaction.type !== '1559') {
			conservativeBalances.delete(transaction.signedTransaction.from)
			adjustedTransactions.push(getBaseFeeAdjustedTransactionWithBalances(parentBlock, transaction, balances))
			continue
		}
		if (hasExplicitMaxFeePerGas(transaction.originalRequestParameters.params[0].maxFeePerGas)) {
			const conservativeBalance = conservativeBalances.get(transaction.signedTransaction.from)
			if (conservativeBalance !== undefined) {
				conservativeBalances.set(
					transaction.signedTransaction.from,
					subtractMaxGasCost(conservativeBalance, transaction.signedTransaction.value, transaction.signedTransaction.gas, transaction.originalRequestParameters.params[0].maxFeePerGas),
				)
			}
			adjustedTransactions.push(getBaseFeeAdjustedTransactionWithBalances(parentBlock, transaction, balances))
			continue
		}
		const desiredMaxFeePerGas = getDesiredMaxFeePerGasForBaseFee(parentBaseFeePerGas, transaction.signedTransaction.maxPriorityFeePerGas)
		const conservativeBalance = conservativeBalances.get(transaction.signedTransaction.from)
		const balance = conservativeBalance !== undefined && canAffordMaxGasCost(conservativeBalance, transaction.signedTransaction.value, transaction.signedTransaction.gas, desiredMaxFeePerGas)
			? conservativeBalance
			: await getBalanceBeforeSimulationInputTransaction(ethereumClientService, requestAbortController, parentBlock, simulationInputBeforeBlock, currentBlock, adjustedTransactions, transaction.signedTransaction.from)
		balances.set(transaction.transactionIdentifier, balance)
		const adjustedTransaction = getBaseFeeAdjustedTransactionWithBalances(parentBlock, transaction, balances)
		if (adjustedTransaction.signedTransaction.type !== '1559') throw new Error('Expected 1559 transaction after base fee adjustment')
		conservativeBalances.set(transaction.signedTransaction.from, subtractMaxGasCost(balance, transaction.signedTransaction.value, transaction.signedTransaction.gas, adjustedTransaction.signedTransaction.maxFeePerGas))
		adjustedTransactions.push(adjustedTransaction)
	}
	return { balances, transactions: adjustedTransactions }
}

export const getBaseFeeAdjustedTransactions = (
	parentBlock: EthereumBlockHeader,
	preSimulationTransactions: readonly PreSimulationTransaction[],
	balances: ReadonlyMap<EthereumQuantity, bigint>,
): readonly PreSimulationTransaction[] => {
	if (parentBlock === null) return preSimulationTransactions
	const parentBaseFeePerGas = parentBlock.baseFeePerGas
	if (parentBaseFeePerGas === undefined) return preSimulationTransactions
	return preSimulationTransactions.map((transaction) => {
		if (!usesInterceptorFilledMaxFeePerGas(transaction)) return transaction
		const balance = balances.get(transaction.transactionIdentifier)
		if (balance === undefined) throw new Error('missing balance for base fee adjusted transaction')
		return getBaseFeeAdjustedTransaction(transaction, parentBaseFeePerGas, balance)
	})
}

const canQueryNodeDirectly = async (simulationState: SimulationState, blockTag: EthereumBlockTag = 'latest') => {
	if (blockTag === 'finalized'
		|| (simulationState.success && simulationState.simulatedBlocks.length === 0)
		|| (simulationState.success && typeof blockTag === 'bigint' && blockTag <= simulationState.blockNumber)
	){
		return true
	}
	return false
}

export const getDeployedContractAddress = (from: EthereumAddress, nonce: EthereumQuantity): EthereumAddress => {
	return BigInt(`0x${ keccak256(rlpEncode([stripLeadingZeros(bigintToUint8Array(from, 20)), stripLeadingZeros(bigintToUint8Array(nonce, 32))])).slice(26) }`)
}

export const getSimulatedTransactionReceipt = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: ResolvedExecutionSimulationState, hash: bigint): Promise<EthTransactionReceiptResponse> => {
	if (simulationState.kind === 'passthrough') { return await ethereumClientService.getTransactionReceipt(hash, requestAbortController) }
	const currentState = simulationState.value
	if (currentState.success === false) throw new JsonRpcResponseError(currentState.jsonRpcError)
	const getTransactionSpecificFields = (signedTransaction: EthereumSendableSignedTransaction) => {
		switch(signedTransaction.type) {
			case 'legacy':
			case '1559':
			case '2930': return { type: signedTransaction.type }
			case '4844': return {
				type: signedTransaction.type,
				blobGasUsed: GAS_PER_BLOB * BigInt(signedTransaction.blobVersionedHashes.length),
				blobGasPrice: signedTransaction.maxFeePerBlobGas,
			}
			case '7702': return {
				type: signedTransaction.type,
				authorizationList: signedTransaction.authorizationList
			}
			default: assertNever(signedTransaction)
		}
	}

	const executionBlocks = await createPreparedSimulatedExecutionBlocks(ethereumClientService, requestAbortController, currentState)
	for (const executionBlock of executionBlocks) {
		let cumulativeGasUsed = 0n
		let currentLogIndex = 0
		for (const [transactionIndex, simulatedTransaction] of executionBlock.simulatedTransactions.entries()) {
			cumulativeGasUsed += simulatedTransaction.ethSimulateV1CallResult.gasUsed
			if (hash !== simulatedTransaction.preSimulationTransaction.signedTransaction.hash) {
				currentLogIndex += simulatedTransaction.ethSimulateV1CallResult.status === 'success' ? simulatedTransaction.ethSimulateV1CallResult.logs.length : 0
				continue
			}
			return {
				...getTransactionSpecificFields(simulatedTransaction.preSimulationTransaction.signedTransaction),
				blockHash: executionBlock.blockHash,
				blockNumber: executionBlock.blockNumber,
				transactionHash: simulatedTransaction.preSimulationTransaction.signedTransaction.hash,
				transactionIndex: BigInt(transactionIndex),
				contractAddress: simulatedTransaction.preSimulationTransaction.signedTransaction.to !== null ? null : getDeployedContractAddress(simulatedTransaction.preSimulationTransaction.signedTransaction.from, simulatedTransaction.preSimulationTransaction.signedTransaction.nonce),
				cumulativeGasUsed,
				gasUsed: simulatedTransaction.ethSimulateV1CallResult.gasUsed,
				effectiveGasPrice: calculateRealizedEffectiveGasPrice(simulatedTransaction.preSimulationTransaction.signedTransaction, executionBlock.baseFeePerGas || 0n),
				from: simulatedTransaction.preSimulationTransaction.signedTransaction.from,
				to: simulatedTransaction.preSimulationTransaction.signedTransaction.to,
				logs: simulatedTransaction.ethSimulateV1CallResult.status === 'success'
					? simulatedTransaction.ethSimulateV1CallResult.logs.map((x, logIndex) => ({
						removed: false,
						blockHash: executionBlock.blockHash,
						address: x.address,
						logIndex: BigInt(currentLogIndex + logIndex),
						data: x.data,
						topics: x.topics,
						blockNumber: executionBlock.blockNumber,
						transactionIndex: BigInt(transactionIndex),
						transactionHash: simulatedTransaction.preSimulationTransaction.signedTransaction.hash
					}))
					: [],
				logsBloom: 0x0n, //TODO: what should this be?
				status: simulatedTransaction.ethSimulateV1CallResult.status
			}
		}
	}
	return await ethereumClientService.getTransactionReceipt(hash, requestAbortController)
}

export const getSimulatedBalance = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: ResolvedSimulationState, address: bigint, blockTag: EthereumBlockTag = 'latest'): Promise<bigint> => {
	if (simulationState.kind === 'passthrough' || await canQueryNodeDirectly(simulationState.value, blockTag)) return await ethereumClientService.getBalance(address, blockTag, requestAbortController)
	const currentState = simulationState.value
	const ethBalances = new Map<bigint, bigint>()
	if (currentState.success === false) throw new JsonRpcResponseError(currentState.jsonRpcError)
	for (const block of currentState.simulatedBlocks) {
		for (const [overrideAddress, override] of Object.entries(block.stateOverrides)) {
			if (override?.balance !== undefined) ethBalances.set(EthereumQuantity.parse(overrideAddress), override.balance)
		}
		for (const transaction of block.simulatedTransactions) {
			if (transaction.ethSimulateV1CallResult.status !== 'success') continue
			for (const b of transaction.tokenBalancesAfter) {
				if (b.balance === undefined || b.token !== ETHEREUM_LOGS_LOGGER_ADDRESS) continue
				ethBalances.set(b.owner, b.balance)
			}
		}
	}
	const balance = ethBalances.get(address)
	if (balance !== undefined) return balance
	return await ethereumClientService.getBalance(address, blockTag, requestAbortController)
}

export const getSimulatedCode = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: ResolvedSimulationState, address: bigint, blockTag: EthereumBlockTag = 'latest') => {
	if (simulationState.kind === 'passthrough' || await canQueryNodeDirectly(simulationState.value, blockTag)) {
		return {
			statusCode: 'success',
			getCodeReturn: await ethereumClientService.getCode(address, blockTag, requestAbortController)
		} as const
	}
	const input = stringToUint8Array(encodeFunctionCall(getCodeAbi, 'at', [addressString(address)]))

	const getCodeTransaction = {
		type: '1559',
		from: MOCK_ADDRESS,
		chainId: ethereumClientService.getChainId(),
		maxFeePerGas: 0n,
		maxPriorityFeePerGas: 0n,
		to: GET_CODE_CONTRACT,
		value: 0n,
		input,
		accessList: []
	} as const
	try {
		const result = await simulatedCall(ethereumClientService, undefined, simulationState, getCodeTransaction, blockTag)
		if ('error' in result) return { statusCode: 'failure' } as const
		const parsed = decodeFunctionOutput(getCodeAbi, 'at', result.result)
		return { statusCode: 'success', getCodeReturn: EthereumData.parse(parsed) } as const
	} catch(error: unknown) {
		if (error instanceof JsonRpcResponseError) return { statusCode: 'failure' } as const
		throw error
	}
}
// ported from: https://github.com/ethereum/go-ethereum/blob/509a64ffb9405942396276ae111d06f9bded9221/consensus/misc/eip1559/eip1559.go#L55
const getNextBaseFeePerGas = (parentGasUsed: bigint, parentGasLimit: bigint, parentBaseFeePerGas: bigint) => {
	const parentGasTarget = parentGasLimit / ETHEREUM_EIP1559_ELASTICITY_MULTIPLIER
	if (parentGasUsed === parentGasTarget) return parentBaseFeePerGas
	if (parentGasUsed > parentGasTarget) return parentBaseFeePerGas + max(1n, parentBaseFeePerGas * (parentGasUsed - parentGasTarget) / parentGasTarget / ETHEREUM_EIP1559_BASEFEECHANGEDENOMINATOR)
	return max(0n, parentBaseFeePerGas - parentBaseFeePerGas * (parentGasTarget - parentGasUsed) / parentGasTarget / ETHEREUM_EIP1559_BASEFEECHANGEDENOMINATOR)
}

const getSimulatedMockBlockFromPreparedContext = async (
	context: PreparedSimulationExecutionContext,
	blockIndex: number,
) => {
	const block = context.executionBlocks[blockIndex]
	if (block === undefined) return null
	const parentBlock = context.parentBlock
	return {
		author: parentBlock.miner,
		difficulty: parentBlock.difficulty,
		extraData: parentBlock.extraData,
		gasLimit: parentBlock.gasLimit,
		gasUsed: block.gasUsed,
		hash: block.blockHash,
		logsBloom: parentBlock.logsBloom, // TODO: this is wrong
		miner: parentBlock.miner,
		mixHash: parentBlock.mixHash, // TODO: this is wrong
		nonce: parentBlock.nonce,
		number: block.blockNumber,
		parentHash: block.parentHash,
		receiptsRoot: parentBlock.receiptsRoot, // TODO: this is wrong
		sha3Uncles: parentBlock.sha3Uncles, // TODO: this is wrong
		stateRoot: parentBlock.stateRoot, // TODO: this is wrong
		timestamp: block.blockTimestamp,
		size: parentBlock.size, // TODO: this is wrong
		totalDifficulty: block.totalDifficulty,
		uncles: [],
		baseFeePerGas: block.baseFeePerGas,
		transactionsRoot: parentBlock.transactionsRoot, // TODO: this is wrong
		transactions: block.inputBlock.transactions.map((transaction) => transaction.signedTransaction),
		withdrawals: [],
		withdrawalsRoot: 0n, // TODO: this is wrong
	} as const
}

const getSimulatedTransactionCountFromPreparedInputContext = async (
	ethereumClientService: EthereumClientService,
	requestAbortController: AbortController | undefined,
	context: PreparedSimulationExecutionContext | undefined,
	address: bigint,
	blockTag: EthereumBlockTag = 'latest',
) => {
	if (context === undefined) {
		return await ethereumClientService.getTransactionCount(address, blockTag, requestAbortController)
	}
	const baseBlockNumber = context.parentBlock.number
	if (canQueryNodeDirectlyFromInput(baseBlockNumber, context.executionBlocks.length, blockTag)) {
		return await ethereumClientService.getTransactionCount(address, blockTag, requestAbortController)
	}
	const resolvedBlockTag = resolveSimulationBlockTag(baseBlockNumber, context.executionBlocks.length, blockTag)
	const blockNumToUseForChain = typeof resolvedBlockTag === 'bigint' ? min(resolvedBlockTag, await ethereumClientService.getBlockNumber(requestAbortController)) : resolvedBlockTag
	let addedTransactions = 0n
	for (const block of getExecutionBlocksUpToTag(context, blockTag)) {
		for (const transaction of block.inputBlock.transactions) {
			if (transaction.signedTransaction.from === address) addedTransactions += 1n
		}
	}
	return (await ethereumClientService.getTransactionCount(address, blockNumToUseForChain, requestAbortController)) + addedTransactions
}

export const getSimulatedTransactionCountFromInput = async (
	ethereumClientService: EthereumClientService,
	requestAbortController: AbortController | undefined,
	simulationStateInput: ResolvedSimulationInput,
	address: bigint,
	blockTag: EthereumBlockTag = 'latest',
) => {
	const context = await createPreparedSimulationExecutionContext(ethereumClientService, requestAbortController, simulationStateInput)
	return await getSimulatedTransactionCountFromPreparedInputContext(ethereumClientService, requestAbortController, context, address, blockTag)
}

export const getSimulatedBlockNumberFromInput = async (
	ethereumClientService: EthereumClientService,
	requestAbortController: AbortController | undefined,
	simulationStateInput: ResolvedSimulationInput,
) => {
	const context = await createPreparedSimulationExecutionContext(ethereumClientService, requestAbortController, simulationStateInput)
	if (context === undefined) return await ethereumClientService.getBlockNumber(requestAbortController)
	return context.parentBlock.number + BigInt(context.executionBlocks.length)
}

export async function getSimulatedBlockFromInput(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationStateInput: ResolvedSimulationInput, blockTag?: EthereumBlockTag, fullObjects?: true): Promise<EthereumBlockHeader>
export async function getSimulatedBlockFromInput(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationStateInput: ResolvedSimulationInput, blockTag: EthereumBlockTag, fullObjects: boolean): Promise<EthereumBlockHeader | EthereumBlockHeaderWithTransactionHashes>
export async function getSimulatedBlockFromInput(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationStateInput: ResolvedSimulationInput, blockTag: EthereumBlockTag, fullObjects: false): Promise<EthereumBlockHeaderWithTransactionHashes>
export async function getSimulatedBlockFromInput(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationStateInput: ResolvedSimulationInput, blockTag: EthereumBlockTag = 'latest', fullObjects = true): Promise<EthereumBlockHeader | EthereumBlockHeaderWithTransactionHashes> {
	const context = await createPreparedSimulationExecutionContext(ethereumClientService, requestAbortController, simulationStateInput)
	if (context === undefined || canQueryNodeDirectlyFromInput(context.parentBlock.number, context.executionBlocks.length, blockTag)) {
		return await ethereumClientService.getBlock(requestAbortController, blockTag, fullObjects)
	}
	const blockIndex = getExecutionBlockIndexForTag(context.parentBlock.number, context.executionBlocks.length, blockTag)
	if (blockIndex === undefined) return null
	const block = await getSimulatedMockBlockFromPreparedContext(context, blockIndex)
	if (block === null) return null
	if (fullObjects) return block
	return { ...block, transactions: block.transactions.map((transaction) => transaction.hash) }
}

export const getSimulatedBlockByHashFromInput = async (
	ethereumClientService: EthereumClientService,
	requestAbortController: AbortController | undefined,
	simulationStateInput: ResolvedSimulationInput,
	blockHash: EthereumBytes32,
	fullObjects: boolean,
): Promise<EthereumBlockHeader | EthereumBlockHeaderWithTransactionHashes> => {
	const context = await createPreparedSimulationExecutionContext(ethereumClientService, requestAbortController, simulationStateInput)
	if (context === undefined) return await ethereumClientService.getBlockByHash(blockHash, requestAbortController, fullObjects)
	const blockIndex = context.executionBlocks.findIndex((block) => block.blockHash === blockHash)
	if (blockIndex < 0) return await ethereumClientService.getBlockByHash(blockHash, requestAbortController, fullObjects)
	const block = await getSimulatedMockBlockFromPreparedContext(context, blockIndex)
	if (block === null) return null
	if (fullObjects) return block
	return { ...block, transactions: block.transactions.map((transaction) => transaction.hash) }
}

export const getSimulatedTransactionByHashFromInput = async (
	ethereumClientService: EthereumClientService,
	requestAbortController: AbortController | undefined,
	simulationStateInput: ResolvedSimulationInput,
	hash: bigint,
): Promise<EthereumSignedTransactionWithBlockData | null> => {
		const context = await createPreparedSimulationExecutionContext(ethereumClientService, requestAbortController, simulationStateInput)
		if (context === undefined) return await ethereumClientService.getTransactionByHash(hash, requestAbortController)
		for (const executionBlock of context.executionBlocks) {
			for (const [transactionIndex, transaction] of executionBlock.inputBlock.transactions.entries()) {
				if (transaction.signedTransaction.hash !== hash) continue
				const v = getSignedTransactionV(transaction.signedTransaction)
				const gasPrice = 'gasPrice' in transaction.signedTransaction
					? transaction.signedTransaction.gasPrice
					: calculateRealizedEffectiveGasPrice(transaction.signedTransaction, executionBlock.baseFeePerGas || 0n)
				return {
				...transaction.signedTransaction,
				blockHash: executionBlock.blockHash,
				blockNumber: executionBlock.blockNumber,
				transactionIndex: BigInt(transactionIndex),
				data: transaction.signedTransaction.input,
				v,
				gasPrice,
			}
		}
	}
	return await ethereumClientService.getTransactionByHash(hash, requestAbortController)
}

const simulatedCallWithPreparedInputContext = async (
	ethereumClientService: EthereumClientService,
	requestAbortController: AbortController | undefined,
	context: PreparedSimulationExecutionContext | undefined,
	params: Pick<IUnsignedTransaction1559, 'to' | 'maxFeePerGas' | 'maxPriorityFeePerGas' | 'input' | 'value'> & Partial<Pick<IUnsignedTransaction1559, 'from' | 'gasLimit'>>,
	blockTag: EthereumBlockTag = 'latest',
) => {
	if (blockTag === 'finalized') {
		try {
			return { result: await ethereumClientService.call(params, 'finalized', requestAbortController) }
		} catch(error: unknown) {
			if (error instanceof JsonRpcResponseError) {
				const safeParsedData = EthereumData.safeParse(error.data)
				return { error: { code: error.code, message: error.message, data: safeParsedData.success ? dataStringWith0xStart(safeParsedData.value) : '0x' } }
			}
			throw error
		}
	}
	const from = params.from ?? DEFAULT_CALL_ADDRESS
	const transaction = {
		...params,
		type: '1559',
		from,
		nonce: await getSimulatedTransactionCountFromPreparedInputContext(ethereumClientService, requestAbortController, context, from, blockTag),
		chainId: ethereumClientService.getChainId(),
		...(params.gasLimit === undefined ? {} : { gasLimit: params.gasLimit }),
	} as const
	try {
		const callResult = await simulateBlockCallWithPreparedInputContext(ethereumClientService, requestAbortController, context, transaction)
		if (callResult === undefined) throw new Error('failed to get last call in eth simulate')
		if (callResult.status === 'failure') return { error: callResult.error }
		return { result: callResult.returnData }
	} catch(error: unknown) {
		if (error instanceof JsonRpcResponseError) {
			const safeParsedData = EthereumData.safeParse(error.data)
			return { error: { code: error.code, message: error.message, data: safeParsedData.success ? dataStringWith0xStart(safeParsedData.value) : '0x' } }
		}
		throw error
	}
}

export const simulatedCallFromInput = async (
	ethereumClientService: EthereumClientService,
	requestAbortController: AbortController | undefined,
	simulationStateInput: ResolvedSimulationInput,
	params: Pick<IUnsignedTransaction1559, 'to' | 'maxFeePerGas' | 'maxPriorityFeePerGas' | 'input' | 'value'> & Partial<Pick<IUnsignedTransaction1559, 'from' | 'gasLimit'>>,
	blockTag: EthereumBlockTag = 'latest',
) => {
	return await simulatedCallWithPreparedInputContext(
		ethereumClientService,
		requestAbortController,
		await createPreparedSimulationExecutionContext(ethereumClientService, requestAbortController, simulationStateInput),
		params,
		blockTag,
	)
}

export const getSimulatedCodeFromInput = async (
	ethereumClientService: EthereumClientService,
	requestAbortController: AbortController | undefined,
	simulationStateInput: ResolvedSimulationInput,
	address: bigint,
	blockTag: EthereumBlockTag = 'latest',
) => {
	const context = await createPreparedSimulationExecutionContext(ethereumClientService, requestAbortController, simulationStateInput)
	if (context === undefined || canQueryNodeDirectlyFromInput(context.parentBlock.number, context.executionBlocks.length, blockTag)) {
		return {
			statusCode: 'success',
			getCodeReturn: await ethereumClientService.getCode(address, blockTag, requestAbortController)
		} as const
	}
	const input = stringToUint8Array(encodeFunctionCall(getCodeAbi, 'at', [addressString(address)]))
	const getCodeTransaction = {
		type: '1559',
		from: MOCK_ADDRESS,
		chainId: ethereumClientService.getChainId(),
		maxFeePerGas: 0n,
		maxPriorityFeePerGas: 0n,
		to: GET_CODE_CONTRACT,
		value: 0n,
		input,
		accessList: []
	} as const
	try {
		const result = await simulatedCallWithPreparedInputContext(ethereumClientService, requestAbortController, context, getCodeTransaction, blockTag)
		if ('error' in result) return { statusCode: 'failure' } as const
		const parsed = decodeFunctionOutput(getCodeAbi, 'at', result.result)
		return { statusCode: 'success', getCodeReturn: EthereumData.parse(parsed) } as const
	} catch(error: unknown) {
		if (error instanceof JsonRpcResponseError) return { statusCode: 'failure' } as const
		throw error
	}
}

export const getSimulatedBalanceFromInput = async (
	ethereumClientService: EthereumClientService,
	requestAbortController: AbortController | undefined,
	simulationStateInput: ResolvedSimulationInput,
	address: bigint,
	blockTag: EthereumBlockTag = 'latest',
	baseBlockTag: EthereumBlockTag = 'latest',
): Promise<bigint> => {
	const context = await createPreparedSimulationExecutionContext(ethereumClientService, requestAbortController, simulationStateInput, baseBlockTag)
	if (context === undefined) {
		const directBlockTag = blockTag === 'latest' || blockTag === 'pending' ? baseBlockTag : blockTag
		return await ethereumClientService.getBalance(address, directBlockTag, requestAbortController)
	}
	if (canQueryNodeDirectlyFromInput(context.parentBlock.number, context.executionBlocks.length, blockTag)) {
		return await ethereumClientService.getBalance(address, blockTag, requestAbortController)
	}
	const executionBlocksToApply = getExecutionBlocksUpToTag(context, blockTag)
	if (executionBlocksToApply.length === 0) return await ethereumClientService.getBalance(address, blockTag, requestAbortController)
	const tokenBalances = await getSimulatedTokenBalances(
		ethereumClientService,
		requestAbortController,
		executionBlocksToApply.map((block) => block.inputBlock),
		[{ token: ETHEREUM_LOGS_LOGGER_ADDRESS, owner: address, type: 'ERC20' }],
	)
	const balance = last(tokenBalances)?.balance
	if (balance !== undefined) return balance
	return await ethereumClientService.getBalance(address, blockTag, requestAbortController)
}

export const simulateEstimateGasFromInput = async (
	ethereumClientService: EthereumClientService,
	requestAbortController: AbortController | undefined,
	simulationStateInput: ResolvedSimulationInput,
	data: PartialEthereumTransaction,
	blockDelta: number | undefined = undefined,
): Promise<{ error: ErrorWithCodeAndOptionalData } | { gas: bigint }> => {
	const context = await createPreparedSimulationExecutionContext(ethereumClientService, requestAbortController, simulationStateInput)
	const sendAddress = data.from !== undefined ? data.from : MOCK_ADDRESS
	const transactionCount = getSimulatedTransactionCountFromPreparedInputContext(ethereumClientService, requestAbortController, context, sendAddress)
	const latestSimulatedBlock = context === undefined ? undefined : await getSimulatedMockBlockFromPreparedContext(context, context.executionBlocks.length - 1)
	const fallbackBlock = latestSimulatedBlock ?? context?.parentBlock ?? await ethereumClientService.getBlock(requestAbortController)
	if (fallbackBlock === null) throw new Error('The latest block is null')
	const simulatedBlockIncrement = blockDelta === undefined ? context?.executionBlocks.length ?? 0 : blockDelta
	const maxGas = max(fallbackBlock.gasLimit * 1023n / 1024n - transactionQueueTotalGasLimitFromInput(context?.prepared.rpcBlocks[simulatedBlockIncrement]), 0n)
	const estimateGasTransaction = {
		type: '1559' as const,
		from: sendAddress,
		chainId: ethereumClientService.getChainId(),
		nonce: await transactionCount,
		maxFeePerGas: 0n,
		maxPriorityFeePerGas: 0n ,
		...(data.gas === undefined ? {} : { gasLimit: data.gas }),
		to: data.to === undefined ? null : data.to,
		value: data.value === undefined ? 0n : data.value,
		input: getInputFieldFromDataOrInput(data),
		accessList: []
	}
	try {
		const lastResult = await simulateBlockCallWithPreparedInputContext(ethereumClientService, requestAbortController, context, estimateGasTransaction, {}, true)
		if (lastResult === undefined) return { error: { code: ERROR_INTERCEPTOR_GAS_ESTIMATION_FAILED, message: 'ETH Simulate Failed to estimate gas', data: '0x' } }
		if (lastResult.status === 'failure') return { error: { ...lastResult.error, data: dataStringWith0xStart(lastResult.returnData) } }
		const gasSpent = lastResult.gasUsed * 125n * 64n / (100n * 63n)
		return { gas: gasSpent < maxGas ? gasSpent : maxGas }
	} catch (error: unknown) {
		if (error instanceof JsonRpcResponseError) {
			const safeParsedData = EthereumData.safeParse(error.data)
			return { error: { code: error.code, message: error.message, data: safeParsedData.success ? dataStringWith0xStart(safeParsedData.value) : '0x' } }
		}
		throw error
	}
}

async function getSimulatedMockBlock(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState, blockDelta: number) {
	// make a mock block based on the previous block
	const parentBlock = await ethereumClientService.getBlock(requestAbortController)
	if (parentBlock === null) throw new Error('The latest block is null')
	if (parentBlock.baseFeePerGas === undefined) throw new Error(CANNOT_SIMULATE_OFF_LEGACY_BLOCK)
	if (simulationState.success === false) throw new JsonRpcResponseError(simulationState.jsonRpcError)
	const simulatedBlock = simulationState.simulatedBlocks[blockDelta]
	const blockHeaderTemplate = getSimulatedBlockHeaderTemplate(simulationState, blockDelta)
	const parentHash = blockDelta === 0 ? blockHeaderTemplate?.parentHash ?? parentBlock.hash : getHashOfSimulatedBlock(simulationState, blockDelta - 1)
	return {
		author: blockHeaderTemplate?.miner ?? parentBlock.miner,
		difficulty: blockHeaderTemplate?.difficulty ?? parentBlock.difficulty,
		extraData: blockHeaderTemplate?.extraData ?? parentBlock.extraData,
		gasLimit: blockHeaderTemplate?.gasLimit ?? parentBlock.gasLimit,
		gasUsed: blockHeaderTemplate?.gasUsed ?? transactionQueueTotalGasUsed(simulatedBlock?.simulatedTransactions || []),
		hash: getHashOfSimulatedBlock(simulationState, blockDelta),
		logsBloom: blockHeaderTemplate?.logsBloom ?? parentBlock.logsBloom,
		miner: blockHeaderTemplate?.miner ?? parentBlock.miner,
		mixHash: blockHeaderTemplate?.mixHash ?? parentBlock.mixHash,
		nonce: blockHeaderTemplate?.nonce ?? parentBlock.nonce,
		number: getSimulationBlockNumber(simulationState, blockDelta),
		parentHash,
		receiptsRoot: blockHeaderTemplate?.receiptsRoot ?? parentBlock.receiptsRoot,
		sha3Uncles: blockHeaderTemplate?.sha3Uncles ?? parentBlock.sha3Uncles,
		stateRoot: blockHeaderTemplate?.stateRoot ?? parentBlock.stateRoot,
		timestamp: simulatedBlock?.blockTimestamp || bigintSecondsToDate((dateToBigintSeconds(simulationState.blockTimestamp) + getBlockTimeManipulationSeconds(DEFAULT_BLOCK_MANIPULATION.deltaToAdd, DEFAULT_BLOCK_MANIPULATION.deltaUnit))),
		size: blockHeaderTemplate?.size ?? parentBlock.size,
		totalDifficulty: blockHeaderTemplate?.totalDifficulty ?? ((parentBlock.totalDifficulty ?? 0n) + parentBlock.difficulty),
		uncles: blockHeaderTemplate?.uncles ?? [],
		baseFeePerGas: simulatedBlock?.blockBaseFeePerGas ?? getNextBaseFeePerGas(parentBlock.gasUsed, parentBlock.gasLimit, parentBlock.baseFeePerGas),
		transactionsRoot: blockHeaderTemplate?.transactionsRoot ?? parentBlock.transactionsRoot,
		transactions: simulatedBlock?.simulatedTransactions.map((simulatedTransaction) => simulatedTransaction.preSimulationTransaction.signedTransaction) || [],
		withdrawals: blockHeaderTemplate?.withdrawals ?? [],
		...(blockHeaderTemplate?.blobGasUsed !== undefined ? { blobGasUsed: blockHeaderTemplate.blobGasUsed } : {}),
		...(blockHeaderTemplate?.excessBlobGas !== undefined ? { excessBlobGas: blockHeaderTemplate.excessBlobGas } : {}),
		...(blockHeaderTemplate?.parentBeaconBlockRoot !== undefined ? { parentBeaconBlockRoot: blockHeaderTemplate.parentBeaconBlockRoot } : {}),
		...(blockHeaderTemplate?.withdrawalsRoot !== undefined ? { withdrawalsRoot: blockHeaderTemplate.withdrawalsRoot } : {}),
	} as const
}

export async function getSimulatedBlockByHash(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: ResolvedSimulationState, blockHash: EthereumBytes32, fullObjects: boolean): Promise<EthereumBlockHeader | EthereumBlockHeaderWithTransactionHashes> {
	if (simulationState.kind === 'simulated') {
		const currentState = simulationState.value
		if (currentState.success === false) throw new JsonRpcResponseError(currentState.jsonRpcError)
		const blockDelta = currentState.simulatedBlocks.findIndex((_block, index) => getHashOfSimulatedBlock(currentState, index) === blockHash)
		if (blockDelta < 0) return await ethereumClientService.getBlockByHash(blockHash, requestAbortController, fullObjects)
		const block = await getSimulatedMockBlock(ethereumClientService, requestAbortController, currentState, blockDelta)
		if (fullObjects) return block
		return { ...block, transactions: block.transactions.map((transaction) => transaction.hash) }
	}
	return await ethereumClientService.getBlockByHash(blockHash, requestAbortController, fullObjects)
}

export async function getSimulatedBlock(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: ResolvedSimulationState, blockTag?: EthereumBlockTag, fullObjects?: true): Promise<EthereumBlockHeader>
export async function getSimulatedBlock(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: ResolvedSimulationState, blockTag: EthereumBlockTag, fullObjects: boolean): Promise<EthereumBlockHeader | EthereumBlockHeaderWithTransactionHashes>
export async function getSimulatedBlock(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: ResolvedSimulationState, blockTag: EthereumBlockTag, fullObjects: false): Promise<EthereumBlockHeaderWithTransactionHashes>
export async function getSimulatedBlock(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: ResolvedSimulationState, blockTag: EthereumBlockTag = 'latest', fullObjects = true): Promise<EthereumBlockHeader | EthereumBlockHeaderWithTransactionHashes>  {
	if (simulationState.kind === 'passthrough' || blockTag === 'finalized' || await canQueryNodeDirectly(simulationState.value, blockTag)) {
		return await ethereumClientService.getBlock(requestAbortController, blockTag, fullObjects)
	}
	const currentState = simulationState.value
	if (currentState.success === false) throw new JsonRpcResponseError(currentState.jsonRpcError)
	const blockDelta = blockTag === 'latest' || blockTag === 'pending' ? currentState.simulatedBlocks.length - 1 : Math.max(Number(blockTag - currentState.blockNumber), 0) - 1
	if (blockDelta < 0) return await ethereumClientService.getBlock(requestAbortController, blockTag, fullObjects)
	const block = await getSimulatedMockBlock(ethereumClientService, requestAbortController, currentState, blockDelta)
	if (fullObjects) return block
	return { ...block, transactions: block.transactions.map((transaction) => transaction.hash) }
}

const getLogsOfPreparedSimulatedExecutionBlock = (executionBlock: PreparedSimulatedExecutionBlock, logFilter: EthGetLogsRequest): EthGetLogsResponse => {
	const events: EthGetLogsResponse = executionBlock.simulatedTransactions.reduce((acc, sim, transactionIndex) => {
		if (sim.ethSimulateV1CallResult.status === 'failure') return acc
		return [
			...acc,
			...sim.ethSimulateV1CallResult.logs.map((event, logIndex) => ({
				removed: false,
				logIndex: BigInt(acc.length + logIndex),
				transactionIndex: BigInt(transactionIndex),
				transactionHash: sim.preSimulationTransaction.signedTransaction.hash,
				blockHash: executionBlock.blockHash,
				blockNumber: executionBlock.blockNumber,
				address: event.address,
				data: event.data,
				topics: event.topics
			}))
		]
	}, [] as EthGetLogsResponse) || []

	const includeLogByTopic = (logsTopics: readonly bigint[], filtersTopics: readonly (bigint | readonly bigint[] | null)[] | undefined) => {
		if (filtersTopics === undefined || filtersTopics.length === 0) return true
		if (logsTopics.length < filtersTopics.length) return false
		for (const [index, filter] of filtersTopics.entries()) {
			if (filter === null) continue
			if (!Array.isArray(filter) && filter !== logsTopics[index]) return false
			if (Array.isArray(filter) && !filter.includes(logsTopics[index])) return false
		}
		return true
	}

	return events.filter((x) =>
		(logFilter.address === undefined
			|| x.address === logFilter.address
			|| (Array.isArray(logFilter.address) && logFilter.address.includes(x.address))
		)
		&& includeLogByTopic(x.topics, logFilter.topics)
	)
}

const resolveLogsBlockTag = (blockTag: EthereumBlockTag, latestBlockNumber: bigint) => {
	if (blockTag === 'latest' || blockTag === 'pending') return latestBlockNumber
	return blockTag
}

export const getSimulatedLogs = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: ResolvedExecutionSimulationState, logFilter: EthGetLogsRequest): Promise<EthGetLogsResponse> => {
	if (simulationState.kind === 'passthrough') return await ethereumClientService.getLogs(logFilter, requestAbortController)
	const currentState = simulationState.value
	if (currentState.success === false) throw new JsonRpcResponseError(currentState.jsonRpcError)
	const executionBlocks = await createPreparedSimulatedExecutionBlocks(ethereumClientService, requestAbortController, currentState)

	const toBlock = 'toBlock' in logFilter && logFilter.toBlock !== undefined ? logFilter.toBlock : 'latest'
	const fromBlock = 'fromBlock' in logFilter && logFilter.fromBlock !== undefined ? logFilter.fromBlock : 'latest'
	if (toBlock === 'pending' || fromBlock === 'pending') return await ethereumClientService.getLogs(logFilter, requestAbortController)
	if ((fromBlock === 'latest' && toBlock !== 'latest') || (fromBlock !== 'latest' && toBlock !== 'latest' && fromBlock > toBlock )) throw new Error(`From block '${ fromBlock }' is later than to block '${ toBlock }' `)

	if (toBlock === 'finalized' || fromBlock === 'finalized') return await ethereumClientService.getLogs(logFilter, requestAbortController)
	const simulatedHead = currentState.blockNumber + BigInt(executionBlocks.length)
	if ('blockHash' in logFilter) {
		const executionBlock = executionBlocks.find((block) => logFilter.blockHash === block.blockHash)
		if (executionBlock !== undefined) return getLogsOfPreparedSimulatedExecutionBlock(executionBlock, logFilter)
		return await ethereumClientService.getLogs(logFilter, requestAbortController)
	}
	const fromBlockNum = resolveLogsBlockTag(fromBlock, simulatedHead)
	const toBlockNum = resolveLogsBlockTag(toBlock, simulatedHead)
	if (typeof fromBlockNum !== 'bigint' || typeof toBlockNum !== 'bigint') return await ethereumClientService.getLogs(logFilter, requestAbortController)
	if (fromBlockNum > toBlockNum) return []
	const nodeLogs = fromBlockNum <= currentState.blockNumber
		? await ethereumClientService.getLogs({
			...logFilter,
			fromBlock: fromBlockNum,
			toBlock: min(currentState.blockNumber, toBlockNum),
		}, requestAbortController)
		: []
	const simulatedLogs = executionBlocks
		.filter((block) => block.blockNumber >= fromBlockNum && block.blockNumber <= toBlockNum)
		.flatMap((block) => getLogsOfPreparedSimulatedExecutionBlock(block, logFilter))
	if (nodeLogs.length > 0 || simulatedLogs.length > 0) return [...nodeLogs, ...simulatedLogs]
	if (toBlockNum > currentState.blockNumber) return []
	return await ethereumClientService.getLogs(logFilter, requestAbortController)
}
export const getSimulatedBlockNumber = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: ResolvedExecutionSimulationState) => {
	if (simulationState.kind === 'simulated') return await getSimulatedBlockNumberFromInput(ethereumClientService, requestAbortController, { kind: 'simulated', value: simulationState.value.simulationStateInput })
	return await ethereumClientService.getBlockNumber(requestAbortController)
}

function getSignedTransactionV(transaction: EthereumSendableSignedTransaction): bigint {
	if ('v' in transaction && transaction.v !== undefined) return transaction.v
	if (!('yParity' in transaction)) throw new Error('Signed transaction is missing both v and yParity.')
	if (transaction.type === 'legacy') return (transaction.yParity === 'even' ? 0n : 1n) + 35n + 2n * transaction.chainId
	return transaction.yParity === 'even' ? 0n : 1n
}

export const getSimulatedTransactionByHash = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: ResolvedSimulationState, hash: bigint): Promise<EthereumSignedTransactionWithBlockData | null> => {
	// try to see if the transaction is in our queue
	if (simulationState.kind === 'passthrough') return await ethereumClientService.getTransactionByHash(hash, requestAbortController)
	const currentState = simulationState.value
	if (currentState.success === false) throw new JsonRpcResponseError(currentState.jsonRpcError)
	for (const [blockDelta, block] of currentState.simulatedBlocks.entries()) {
		for (const [transactionIndex, simulatedTransaction] of block.simulatedTransactions.entries()) {
			if (hash === simulatedTransaction.preSimulationTransaction.signedTransaction.hash) {
				const v = getSignedTransactionV(simulatedTransaction.preSimulationTransaction.signedTransaction)
				const additionalParams = {
					blockHash: getHashOfSimulatedBlock(currentState, blockDelta),
					blockNumber: currentState.blockNumber + BigInt(blockDelta) + 1n,
					transactionIndex: BigInt(transactionIndex),
					data: simulatedTransaction.preSimulationTransaction.signedTransaction.input,
					v,
				}
				if ('gasPrice' in simulatedTransaction.preSimulationTransaction.signedTransaction) {
					return {
						...simulatedTransaction.preSimulationTransaction.signedTransaction,
						...additionalParams,
					}
				}
				return {
					...simulatedTransaction.preSimulationTransaction.signedTransaction,
					...additionalParams,
					gasPrice: simulatedTransaction.realizedGasPrice,
				}
			}
		}
	}

	// it was not in the queue, so we can just try to ask the chain for it
	return await ethereumClientService.getTransactionByHash(hash, requestAbortController)
}

export const simulatedCall = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: ResolvedSimulationState, params: Pick<IUnsignedTransaction1559, 'to' | 'maxFeePerGas' | 'maxPriorityFeePerGas' | 'input' | 'value'> & Partial<Pick<IUnsignedTransaction1559, 'from' | 'gasLimit'>>, blockTag: EthereumBlockTag = 'latest') => {
	if (blockTag === 'finalized') {
		try {
			return { result: await ethereumClientService.call(params, 'finalized', requestAbortController) }
		} catch(error: unknown) {
			if (error instanceof JsonRpcResponseError) {
				const safeParsedData = EthereumData.safeParse(error.data)
				return { error: { code: error.code, message: error.message, data: safeParsedData.success ? dataStringWith0xStart(safeParsedData.value) : '0x' } }
			}
			throw error
		}
	}
	const from = params.from ?? DEFAULT_CALL_ADDRESS
	const transaction = {
		...params,
		type: '1559',
		from,
		nonce: await getSimulatedTransactionCount(ethereumClientService, requestAbortController, simulationState, from, blockTag),
		chainId: ethereumClientService.getChainId(),
		...(params.gasLimit === undefined ? {} : { gasLimit: params.gasLimit }),
	} as const

	//todo, we can optimize this by leaving nonce out
	try {
		const callResult = await simulateBlockCallOnTopOfSimulationInput(ethereumClientService, requestAbortController, simulationState.kind === 'passthrough' ? undefined : simulationState.value.simulationStateInput, transaction)
		if (callResult === undefined) throw new Error('failed to get last call in eth simulate')
		if (callResult?.status === 'failure') return { error: callResult.error }
		return { result: callResult.returnData }
	} catch(error: unknown) {
		if (error instanceof JsonRpcResponseError) {
			const safeParsedData = EthereumData.safeParse(error.data)
			return { error: { code: error.code, message: error.message, data: safeParsedData.success ? dataStringWith0xStart(safeParsedData.value) : '0x' } }
		}
		throw error
	}
}

// prefer the node-provided simulated block hash when available, and fall back to a deterministic synthetic hash for grouped logical blocks
const getHashOfSimulatedBlock = (simulationState: SimulationState, blockDelta: number) => getSimulatedBlockHeaderTemplate(simulationState, blockDelta)?.hash ?? getHashOfSimulatedBlockFromInput(simulationState.simulationStateInput, blockDelta)

const getSimulatedBlockHeaderTemplate = (simulationState: SimulationState, blockDelta: number) => {
	if (simulationState.success === false) throw new JsonRpcResponseError(simulationState.jsonRpcError)
	return simulationState.simulatedBlocks[blockDelta]?.blockHeader
}

export const getMessageHashForPersonalSign = (params: PersonalSignParams) => hashMessage({ raw: stringToUint8Array(params.params[0]) })

export const simulatePersonalSign = async (params: SignMessageParams, signingAddress: EthereumAddress) => {
	const account = privateKeyToAccount(bytes32String(signingAddress === ADDRESS_FOR_PRIVATE_KEY_ONE ? MOCK_PUBLIC_PRIVATE_KEY : MOCK_SIMULATION_PRIVATE_KEY))
	switch (params.method) {
		case 'eth_signTypedData': throw new Error('No support for eth_signTypedData')
		case 'eth_signTypedData_v1':
		case 'eth_signTypedData_v2':
		case 'eth_signTypedData_v3':
		case 'eth_signTypedData_v4': {
			const messageHash = hashTypedData(params.params[1])
			const signature = await account.signTypedData(params.params[1])
			return { signature, messageHash }
		}
		case 'personal_sign': return {
			signature: await account.signMessage({ message: { raw: stringToUint8Array(params.params[0]) } }),
			messageHash: getMessageHashForPersonalSign(params)
		}
		default: assertNever(params)
	}
}

type BalanceQuery = {
	type: 'ERC20',
	token: bigint,
	owner: bigint,
} | {
	type: 'ERC1155',
	token: bigint,
	owner: bigint,
	tokenId: bigint,
}

const getSimulatedTokenBalances = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationStateInput: SimulationStateInputMinimalData, balanceQueries: BalanceQuery[]): Promise<TokenBalancesAfter> => {
	if (balanceQueries.length === 0) return []
	const deduplicatedBalanceQueries = deduplicateByFunction(balanceQueries, (query: BalanceQuery) => `${ query.type }-${ query.token }-${ query.owner }${ query.type === 'ERC1155' ? `${ query.tokenId }` : '' }`)
	const tokenAndEthBalancesInputData = stringToUint8Array(encodeFunctionCall(Multicall3ABI, 'aggregate3', [deduplicatedBalanceQueries.map((balanceQuery) => {
		if (balanceQuery.token === ETHEREUM_LOGS_LOGGER_ADDRESS && balanceQuery.type === 'ERC20') {
			return {
				target: addressString(MULTICALL3),
				allowFailure: true,
				callData: encodeFunctionCall(Multicall3ABI, 'getEthBalance', [addressString(balanceQuery.owner)])
			}
		}
		if (balanceQuery.type === 'ERC20') {
			return {
				target: addressString(balanceQuery.token),
				allowFailure: true,
				callData: encodeFunctionCall(Erc20ABI, 'balanceOf', [addressString(balanceQuery.owner)]),
			}
		}
		return {
			target: addressString(balanceQuery.token),
			allowFailure: true,
			callData: encodeFunctionCall(Erc1155ABI, 'balanceOf', [addressString(balanceQuery.owner), balanceQuery.tokenId]),
		}
	})]))
	const callTransaction = {
		type: '1559' as const,
		from: MOCK_ADDRESS,
		to: MULTICALL3,
		value: 0n,
		input: tokenAndEthBalancesInputData,
		maxFeePerGas: 0n,
		maxPriorityFeePerGas: 0n,
		nonce: 0n,
		chainId: ethereumClientService.getChainId(),
	} as const
	const aggregate3CallResult = await simulateBlockCallOnTopOfSimulationInput(ethereumClientService, requestAbortController, simulationStateInput, callTransaction)
	if (aggregate3CallResult === undefined || aggregate3CallResult.status === 'failure') throw Error('Failed aggregate3')
	const multicallReturnData = decodeFunctionOutput(Multicall3ABI, 'aggregate3', dataStringWith0xStart(aggregate3CallResult.returnData))
	if (multicallReturnData.length !== deduplicatedBalanceQueries.length) throw Error('Got wrong number of balances back')
	return multicallReturnData.map((singleCallResult, callIndex) => {
		const balanceQuery = deduplicatedBalanceQueries[callIndex]
		if (balanceQuery === undefined) throw new Error('aggregate3 failed to get eth balance')
		return {
			token: balanceQuery.token,
			tokenId: 'tokenId' in balanceQuery ? balanceQuery.tokenId : undefined,
			owner: balanceQuery.owner,
			balance: singleCallResult.success ? EthereumQuantity.parse(singleCallResult.returnData) : undefined
		}
	})
}

export const parseEventIfPossible = (abi: AbiLike, log: EthereumEvent) => {
	try {
		return decodeEventLoose(abi, { topics: log.topics.map((x) => bytes32String(x)), data: dataStringWith0xStart(log.data) })
	} catch (error) {
		return undefined
	}
}

export const parseTransactionInputIfPossible = (abi: AbiLike, data: EthereumData, value: EthereumQuantity) => {
	try {
		return decodeCallDataLoose(abi, dataStringWith0xStart(data), value)
	} catch (error) {
		return undefined
	}
}

const getAddressesInteractedWithErc20s = (events: readonly EthereumEvent[]): { token: bigint, owner: bigint, tokenId: undefined, type: 'ERC20' }[] => {
	const tokenOwners: { token: bigint, owner: bigint, tokenId: undefined, type: 'ERC20' }[] = []
	for (const log of events) {
		const parsed = parseEventIfPossible(Erc20ABI, log)
		if (parsed === undefined) continue
		const base = { token: log.address, tokenId: undefined, type: 'ERC20' as const }
		switch (parsed.name) {
			case 'Withdrawal':
			case 'Deposit': {
				const owner = parsed.args[0]
				tokenOwners.push({ ...base, owner: EthereumAddress.parse(owner) })
				break
			}
			case 'Approval':
			case 'Transfer': {
				const owner = parsed.args[0]
				const other = parsed.args[1]
				tokenOwners.push({ ...base, owner: EthereumAddress.parse(owner) })
				tokenOwners.push({ ...base, owner: EthereumAddress.parse(other) })
				break
			}
			default: throw new Error(`wrong name: ${ parsed.name }`)
		}
	}
	return tokenOwners
}

const getAddressesAndTokensIdsInteractedWithErc1155s = (events: readonly EthereumEvent[]): { token: bigint, owner: bigint, tokenId: bigint, type: 'ERC1155' }[] => {
	const tokenOwners: { token: bigint, owner: bigint, tokenId: bigint, type: 'ERC1155' }[] = []
	for (const log of events) {
		const parsed = parseEventIfPossible(Erc1155ABI, log)
		if (parsed === undefined) continue
		const base = { token: log.address, type: 'ERC1155' as const }
		switch (parsed.name) {
			case 'TransferSingle': {
				const parsedLog = handleERC1155TransferSingle(log)[0]
				if (parsedLog === undefined) break
				if (parsedLog.type !== 'ERC1155') continue
				tokenOwners.push({ ...base, owner: parsedLog.from, tokenId: parsedLog.tokenId })
				tokenOwners.push({ ...base, owner: parsedLog.to, tokenId: parsedLog.tokenId })
				break
			}
			case 'TransferBatch': {
				for (const parsedLog of handleERC1155TransferBatch(log)) {
					if (parsedLog.type !== 'ERC1155') continue
					tokenOwners.push({ ...base, owner: parsedLog.from, tokenId: parsedLog.tokenId })
					tokenOwners.push({ ...base, owner: parsedLog.to, tokenId: parsedLog.tokenId })
				}
				break
			}
			default: throw new Error(`wrong name: ${ parsed.name }`)
		}
	}
	return tokenOwners
}

type TokenBalancesBlocksAfter = {
	blocks: {
		transactions: { tokenBalancesAfter: TokenBalancesAfter }[]
	}[]
}

export const getTokenBalancesAfterForTransaction = async (
	ethereumClientService: EthereumClientService,
	requestAbortController: AbortController | undefined,
	simulationStateInput: SimulationStateInput,
	callResult: EthSimulateV1CallResult,
	sender: EthereumAddress,
): Promise<TokenBalancesAfter> => {
	const events = callResult.status === 'success' ? callResult.logs : []
	const erc20sAddresses = [
		{ token: ETHEREUM_LOGS_LOGGER_ADDRESS, owner: sender, tokenId: undefined, type: 'ERC20' as const }, // add original sender for eth always, as there's always gas payment
		...getAddressesInteractedWithErc20s(events)
	]
	const erc1155AddressIds = getAddressesAndTokensIdsInteractedWithErc1155s(events)
	return getSimulatedTokenBalances(ethereumClientService, requestAbortController, simulationStateInput, [...erc20sAddresses, ...erc1155AddressIds])
}

export const sliceSimulationStateInput = (simulationStateInput: SimulationStateInput, blockIndex: number, transactionIndex: number) => {
	const slicedBlock = simulationStateInput[blockIndex]
	if (slicedBlock === undefined) return simulationStateInput
	return [
		...simulationStateInput.slice(0, blockIndex),
		{
			...slicedBlock,
			transactions: slicedBlock.transactions.slice(0, transactionIndex)
		}
	]
}

export const sliceSimulationState = (simulationState: SimulationState, blockIndex: number, transactionIndex: number): SimulationState => {
	const slicedInputBlock = simulationState.simulationStateInput[blockIndex]
	if (slicedInputBlock === undefined) throw new Error('slicing overflow')
	if (simulationState.success === false) return modifyObject(simulationState, { simulationStateInput: sliceSimulationStateInput(simulationState.simulationStateInput, blockIndex, transactionIndex) })
	const slicedResultBlock = simulationState.simulatedBlocks[blockIndex]
	if (slicedResultBlock === undefined) throw new Error('slicing overflow')
	return modifyObject(simulationState, {
		success: true,
		simulationStateInput: sliceSimulationStateInput(simulationState.simulationStateInput, blockIndex, transactionIndex),
		simulatedBlocks: [
			...simulationState.simulatedBlocks.slice(0, blockIndex),
			{
				...slicedResultBlock,
				simulatedTransactions: slicedResultBlock.simulatedTransactions.slice(0, transactionIndex)
			}
		]
	})
}

export const getTokenBalancesAfter = async (
	ethereumClientService: EthereumClientService,
	requestAbortController: AbortController | undefined,
	ethSimulateV1Result: GroupedEthSimulateV1Result,
	simulationStateInput: SimulationStateInput,
): Promise<TokenBalancesBlocksAfter> => {
	const tokenBalancesAfterArray = await promiseAllMapAbortSafe(Array.from(simulationStateInput.entries()), async ([inputBlockIndex, inputBlock]) => {
		const groupedResultBlock = ethSimulateV1Result[inputBlockIndex]
		if (groupedResultBlock === undefined) throw new Error('singleResult block was undefined')
		return await promiseAllMapAbortSafe(Array.from(inputBlock.transactions.entries()), async ([inputTransactionIndex, inputTransaction]) => {
			const simulateResultTransaction = groupedResultBlock.calls[inputTransactionIndex]
			if (simulateResultTransaction === undefined) throw new Error('singleResult transaction was undefined')
			const sender = inputTransaction.signedTransaction.from
			const inputStateJustAfterTransaction = sliceSimulationStateInput(simulationStateInput, inputBlockIndex, inputTransactionIndex + 1)
			return getTokenBalancesAfterForTransaction(
				ethereumClientService,
				requestAbortController,
				inputStateJustAfterTransaction,
				simulateResultTransaction,
				sender,
			)
		})
	})

	return {
		blocks: tokenBalancesAfterArray.map((block) => ({
			transactions: block.map((tokenBalancesAfter) => ({ tokenBalancesAfter }))
		}))
	}
}

// takes the most recent block that the application is querying and does the calculation based on that
export const getSimulatedFeeHistory = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, request: FeeHistory): Promise<EthGetFeeHistoryResponse> => {
	//const numberOfBlocks = Number(request.params[0]) // number of blocks, not used atm as we just return one block
	const blockTag = request.params[1]
	const rewardPercentiles = request.params[2]
	const currentRealBlockNumber = await ethereumClientService.getBlockNumber(requestAbortController)
	const clampedBlockTag = typeof blockTag === 'bigint' && blockTag > currentRealBlockNumber ? currentRealBlockNumber : blockTag
	const newestBlock = await ethereumClientService.getBlock(requestAbortController, clampedBlockTag, true)
	if (newestBlock === null) throw new Error('The latest block is null')
	const newestBlockBaseFeePerGas = newestBlock.baseFeePerGas
	if (newestBlockBaseFeePerGas === undefined) throw new Error(`base fee per gas is missing for the block (it's too old)`)
	return {
		baseFeePerGas: [newestBlockBaseFeePerGas, getNextBaseFeePerGas(newestBlock.gasUsed, newestBlock.gasLimit, newestBlockBaseFeePerGas)],
		gasUsedRatio: [Number(newestBlock.gasUsed) / Number(newestBlock.gasLimit)],
		oldestBlock: newestBlock.number,
		...rewardPercentiles === undefined ? {} : {
			reward: [rewardPercentiles.map((percentile) => {
				// we are using transaction.gas as a weighting factor while this should be `gasUsed`. Getting `gasUsed` requires getting transaction receipts, which we don't want to be doing
				const getDataPoint = (tx: EthereumBlockHeaderTransaction) => {
					if ('maxPriorityFeePerGas' in tx && 'maxFeePerGas' in tx && 'gas' in tx) return { dataPoint: min(tx.maxPriorityFeePerGas, tx.maxFeePerGas - (newestBlockBaseFeePerGas ?? 0n)), weight: tx.gas }
					if ('gasPrice' in tx && 'gas' in tx) return { dataPoint: tx.gasPrice - (newestBlockBaseFeePerGas ?? 0n), weight: tx.gas }
					return { dataPoint: 0n, weight: 0n }
				}

				const effectivePriorityAndGasWeights = newestBlock.transactions.map((tx) => getDataPoint(tx))

				// we can have negative values here, as The Interceptor creates maxFeePerGas = 0 transactions that are intended to have zero base fee, which is not possible in reality
				const zeroOutNegativeValues = effectivePriorityAndGasWeights.map((point) => modifyObject(point, { dataPoint: max(0n, point.dataPoint) }))
				return calculateWeightedPercentile(zeroOutNegativeValues, BigInt(percentile))
			})]
		}
	}
}
