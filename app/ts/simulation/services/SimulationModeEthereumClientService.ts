import { EthereumClientService, getNextBlockTimeStampOverride } from './EthereumClientService.js'
import type { PreparedEthSimulateV1Input } from './EthereumClientService.js'
import { EthereumUnsignedTransaction, EthereumSignedTransactionWithBlockData, EthereumBlockTag, EthereumAddress, EthereumBlockHeader, EthereumBlockHeaderWithTransactionHashes, EthereumData, EthereumQuantity, EthereumBytes32, EthereumSendableSignedTransaction, EthereumBlockHeaderTransaction } from '../../types/wire-types.js'
import { addressString, bigintSecondsToDate, bigintToUint8Array, bytes32String, calculateWeightedPercentile, dataStringWith0xStart, dateToBigintSeconds, max, min, stringToUint8Array } from '../../utils/bigint.js'
import { CANNOT_SIMULATE_OFF_LEGACY_BLOCK, ERROR_INTERCEPTOR_GAS_ESTIMATION_FAILED, ETHEREUM_LOGS_LOGGER_ADDRESS, ETHEREUM_EIP1559_BASEFEECHANGEDENOMINATOR, ETHEREUM_EIP1559_ELASTICITY_MULTIPLIER, MOCK_ADDRESS, MULTICALL3, Multicall3ABI, DEFAULT_CALL_ADDRESS, GAS_PER_BLOB } from '../../utils/constants.js'
import { Interface, hashMessage, hashTypedData, keccak256, privateKeyToAccount, toUtf8Bytes } from '../../utils/viem.js'
import { SimulatedTransaction, SimulationState, TokenBalancesAfter, PreSimulationTransaction, SimulationStateBlock, SimulationStateInput, SimulationStateInputMinimalData, SimulationStateInputMinimalDataBlock, BlockTimeManipulationDeltaUnit } from '../../types/visualizer-types.js'
import { EthereumUnsignedTransactionToUnsignedTransaction, IUnsignedTransaction1559, rlpEncode, serializeSignedTransactionToBytes } from '../../utils/ethereum.js'
import { EthGetLogsResponse, EthGetLogsRequest, EthTransactionReceiptResponse, PartialEthereumTransaction, EthGetFeeHistoryResponse, FeeHistory } from '../../types/JsonRpc-types.js'
import { handleERC1155TransferBatch, handleERC1155TransferSingle } from '../logHandlers.js'
import { assertNever, modifyObject } from '../../utils/typescript.js'
import { PersonalSignParams, SignMessageParams } from '../../types/jsonRpc-signing-types.js'
import { EthSimulateV1CallResult, EthSimulateV1Result, EthereumEvent, StateOverrides } from '../../types/ethSimulate-types.js'
import { stripLeadingZeros } from '../../utils/typed-arrays.js'
import { getMakeCurrentAddressRich, getSettings } from '../../background/settings.js'
import { JsonRpcResponseError } from '../../utils/errors.js'
import { deduplicateByFunction, last } from '../../utils/array.js'
import { promiseAllMapAbortSafe } from '../../utils/requests.js'
import { ErrorWithCodeAndOptionalData } from '../../types/error.js'
import { getSimulationInputHash } from '../../utils/simulationFingerprint.js'

const MOCK_PUBLIC_PRIVATE_KEY = 0x1n // key used to sign mock transactions
const MOCK_SIMULATION_PRIVATE_KEY = 0x2n // key used to sign simulated transatons
const ADDRESS_FOR_PRIVATE_KEY_ONE = 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdfn
const GET_CODE_CONTRACT = 0x1ce438391307f908756fefe0fe220c0f0d51508an

export const DEFAULT_BLOCK_MANIPULATION = { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' } as const

type GroupedEthSimulateV1BlockResult = {
	inputBlock: SimulationStateInputMinimalDataBlock
	baseFeePerGas: bigint
	timestamp: bigint
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
	simulationStateInput: SimulationStateInput
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

type SuccessfulSimulationState = Extract<SimulationState, { success: true }>
export type ExecutionSimulatedTransaction = Omit<SimulatedTransaction, 'tokenBalancesAfter'>
type ExecutionSimulationStateBlock = Omit<SimulationStateBlock, 'simulatedTransactions'> & {
	simulatedTransactions: readonly ExecutionSimulatedTransaction[]
}
type SuccessfulExecutionSimulationState = Omit<SuccessfulSimulationState, 'simulatedBlocks'> & {
	simulatedBlocks: readonly ExecutionSimulationStateBlock[]
}
export type ExecutionSimulationState = Extract<SimulationState, { success: false }> | SuccessfulExecutionSimulationState

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

const transactionQueueTotalGasLimitFromInput = (block: SimulationStateInputMinimalDataBlock | undefined) => {
	if (block === undefined) return 0n
	return block.transactions.reduce((totalGasUsed, transaction) => totalGasUsed + transaction.signedTransaction.gas, 0n)
}

const isEmptySimulationInput = (simulationStateInput: SimulationStateInput | SimulationStateInputMinimalData) => (
	simulationStateInput.length === 0
	|| (simulationStateInput.length === 1 && simulationStateInput[0]?.transactions.length === 0 && simulationStateInput[0]?.signedMessages.length === 0)
)

const getHashOfSimulatedBlockFromInput = (simulationStateInput: SimulationStateInput, blockDelta: number) => {
	return BigInt(keccak256(toUtf8Bytes(`${ getSimulationInputHash(simulationStateInput) }:${ blockDelta }`)))
}

const createPreparedSimulationExecutionContext = async (
	ethereumClientService: EthereumClientService,
	requestAbortController: AbortController | undefined,
	simulationStateInput: SimulationStateInput | undefined,
	baseBlockTag: EthereumBlockTag = 'latest',
): Promise<PreparedSimulationExecutionContext | undefined> => {
	if (simulationStateInput === undefined) return undefined
	if (isEmptySimulationInput(simulationStateInput)) return undefined
	const parentBlock = await ethereumClientService.getBlock(requestAbortController, baseBlockTag)
	if (parentBlock === null) throw new Error('The latest block is null')
	const prepared = await ethereumClientService.prepareEthSimulateV1Input(simulationStateInput, parentBlock.number, requestAbortController)
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
		const blockHash = getHashOfSimulatedBlockFromInput(simulationStateInput, blockIndex)
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
		simulationStateInput,
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

export const getSimulatedTransactionCount = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState | undefined, address: bigint, blockTag: EthereumBlockTag = 'latest') => {
	if (blockTag === 'finalized' || simulationState === undefined) return await ethereumClientService.getTransactionCount(address, blockTag, requestAbortController)
	if (simulationState.success === false) throw new JsonRpcResponseError(simulationState.jsonRpcError)
	const blockNumToUseForSim = blockTag === 'latest' || blockTag === 'pending' ? simulationState.blockNumber + BigInt(simulationState.simulatedBlocks.length) : blockTag
	const blockNumToUseForChain = blockTag === 'latest' || blockTag === 'pending' ? blockTag : min(blockTag, await ethereumClientService.getBlockNumber(requestAbortController))
	let addedTransactions = 0n
	if (simulationState !== undefined && (blockTag === 'latest' || blockTag === 'pending' || blockTag > simulationState.blockNumber)) {
		// if we are on our simulated block, just count how many transactions we have sent in the simulation to increment transaction count
		let index = 0
		for (const block of simulationState.simulatedBlocks) {
			const currBlockNum = simulationState.blockNumber + BigInt(index) + 1n
			if (blockNumToUseForSim > currBlockNum) break
			for (const signed of block.simulatedTransactions) {
				if (signed.preSimulationTransaction.signedTransaction.from === address) addedTransactions += 1n
			}
			index++
		}
	}
	return (await ethereumClientService.getTransactionCount(address, blockNumToUseForChain, requestAbortController)) + addedTransactions
}

export const simulateEstimateGas = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState | undefined, data: PartialEthereumTransaction, blockDelta: number | undefined = undefined): Promise<{ error: ErrorWithCodeAndOptionalData } | { gas: bigint }> => {
	if (simulationState === undefined) return { gas: await ethereumClientService.estimateGas(data, requestAbortController) }
	if (simulationState.success === false) throw new JsonRpcResponseError(simulationState.jsonRpcError)
	const sendAddress = data.from !== undefined ? data.from : MOCK_ADDRESS
	const transactionCount = getSimulatedTransactionCount(ethereumClientService, requestAbortController, simulationState, sendAddress)
	const block = await getSimulatedBlock(ethereumClientService, requestAbortController, simulationState)
	if (block === null) throw new Error('The latest block is null')
	const simulatedBlockIncrement = blockDelta === undefined ? simulationState.simulatedBlocks.length || 0 : blockDelta
	const maxGas = simulationGasLeft(simulationState.simulatedBlocks[simulatedBlockIncrement] || undefined, block)

	const estimateGasTransaction = {
		type: '1559' as const,
		from: sendAddress,
		chainId: ethereumClientService.getChainId(),
		nonce: await transactionCount,
		// Ideally, we would estimate using the correct base fee and priority fee values.
		// However, doing so would require the account to hold enough ETH to cover the gas cost of an entire block, which is not a reasonable expectation.
		maxFeePerGas: 0n,
		maxPriorityFeePerGas: 0n ,
		gas: data.gas === undefined ? maxGas : data.gas,
		to: data.to === undefined ? null : data.to,
		value: data.value === undefined ? 0n : data.value,
		input: getInputFieldFromDataOrInput(data),
		accessList: []
	}
	try {
		const simulatedTransactions = await simulateTransactionsOnTopOfSimulationInput(ethereumClientService, requestAbortController, simulationState.simulationStateInput, [estimateGasTransaction], {}, true)
		const lastResult = simulatedTransactions[simulatedTransactions.length - 1]
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
		return {
			inputBlock: preparedInputBlock.inputBlock,
			baseFeePerGas: firstResultBlock.baseFeePerGas,
			timestamp: firstResultBlock.timestamp,
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
	const context = await createPreparedSimulationExecutionContext(ethereumClientService, requestAbortController, simulationState.simulationStateInput, simulationState.blockNumber)
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

export const appendTransactionsToInput = (simulationStateInput: SimulationStateInput | undefined, transactions: PreSimulationTransaction[], blockDelta: number | undefined = undefined, stateOverrides: StateOverrides = {}, simulateWithZeroBaseFee = false): SimulationStateInput => {
	const nonUndefinedBlockDelta = simulationStateInput?.length || 0
	const mergeStateSets = (oldOverrides: StateOverrides, newOverrides: StateOverrides) => {
		const copy = { ...oldOverrides }
		Object.entries(newOverrides).forEach(([key, value]) => { copy[key] = value })
		return copy
	}
	const newTransactions = [...transactions]
	if (simulationStateInput === undefined) return [{ stateOverrides, transactions: newTransactions, signedMessages: [], blockTimeManipulation: DEFAULT_BLOCK_MANIPULATION, simulateWithZeroBaseFee: false }]
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

export const appendTransactionToInputAndSimulate = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, oldSimulatedInput: SimulationStateInput | undefined, transactions: PreSimulationTransaction[], blockDelta: number | undefined = undefined, stateOverrides: StateOverrides = {}): Promise<SimulationState> => {
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
	let simulationInputBlocks = []
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

export const getBaseFeeAdjustedTransactions = (parentBlock: EthereumBlockHeader, preSimulationTransactions: readonly PreSimulationTransaction[]): readonly PreSimulationTransaction[] => {
	if (parentBlock === null) return preSimulationTransactions
	const parentBaseFeePerGas = parentBlock.baseFeePerGas
	if (parentBaseFeePerGas === undefined) return preSimulationTransactions
	return preSimulationTransactions.map((transaction) => {
		if (transaction.originalRequestParameters.method !== 'eth_sendTransaction') return transaction
		if (transaction.signedTransaction.type !== '1559') return transaction
		return modifyObject(transaction, { signedTransaction: modifyObject(transaction.signedTransaction, { maxFeePerGas: parentBaseFeePerGas * 2n + transaction.signedTransaction.maxPriorityFeePerGas }) })
	})
}

const canQueryNodeDirectly = async (simulationState: SimulationState, blockTag: EthereumBlockTag = 'latest') => {
	if (simulationState === undefined
		|| blockTag === 'finalized'
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

export const getSimulatedTransactionReceipt = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: ExecutionSimulationState | undefined, hash: bigint): Promise<EthTransactionReceiptResponse> => {
	if (simulationState === undefined) { return await ethereumClientService.getTransactionReceipt(hash, requestAbortController) }
	if (simulationState.success === false) throw new JsonRpcResponseError(simulationState.jsonRpcError)
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

	const executionBlocks = await createPreparedSimulatedExecutionBlocks(ethereumClientService, requestAbortController, simulationState)
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

export const getSimulatedBalance = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState | undefined, address: bigint, blockTag: EthereumBlockTag = 'latest'): Promise<bigint> => {
	if (simulationState === undefined || await canQueryNodeDirectly(simulationState, blockTag)) return await ethereumClientService.getBalance(address, blockTag, requestAbortController)
	const ethBalances = new Map<bigint, bigint>()
	if (simulationState.success === false) throw new JsonRpcResponseError(simulationState.jsonRpcError)
	for (const block of simulationState.simulatedBlocks) {
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

export const getSimulatedCode = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState | undefined, address: bigint, blockTag: EthereumBlockTag = 'latest') => {
	if (simulationState === undefined || await canQueryNodeDirectly(simulationState, blockTag)) {
		return {
			statusCode: 'success',
			getCodeReturn: await ethereumClientService.getCode(address, blockTag, requestAbortController)
		} as const
	}
	const block = await ethereumClientService.getBlock(requestAbortController)
	if (block === null) throw new Error('The latest block is null')

	const atInterface = new Interface(['function at(address) returns (bytes)'])
	const input = stringToUint8Array(atInterface.encodeFunctionData('at', [addressString(address)]))

	const getCodeTransaction = {
		type: '1559',
		from: MOCK_ADDRESS,
		chainId: ethereumClientService.getChainId(),
		maxFeePerGas: 0n,
		maxPriorityFeePerGas: 0n,
		gas: block.gasLimit,
		to: GET_CODE_CONTRACT,
		value: 0n,
		input,
		accessList: []
	} as const
	try {
		const result = await simulatedCall(ethereumClientService, undefined, simulationState, getCodeTransaction, blockTag)
		if ('error' in result) return { statusCode: 'failure' } as const
		const parsed = atInterface.decodeFunctionResult('at', result.result)
		return { statusCode: 'success', getCodeReturn: EthereumData.parse(parsed.toString()) } as const
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
	simulationStateInput: SimulationStateInput | undefined,
	address: bigint,
	blockTag: EthereumBlockTag = 'latest',
) => {
	const context = await createPreparedSimulationExecutionContext(ethereumClientService, requestAbortController, simulationStateInput)
	return await getSimulatedTransactionCountFromPreparedInputContext(ethereumClientService, requestAbortController, context, address, blockTag)
}

export const getSimulatedBlockNumberFromInput = async (
	ethereumClientService: EthereumClientService,
	requestAbortController: AbortController | undefined,
	simulationStateInput: SimulationStateInput | undefined,
) => {
	if (simulationStateInput === undefined) return await ethereumClientService.getBlockNumber(requestAbortController)
	const context = await createPreparedSimulationExecutionContext(ethereumClientService, requestAbortController, simulationStateInput)
	if (context === undefined) return await ethereumClientService.getBlockNumber(requestAbortController)
	return context.parentBlock.number + BigInt(context.executionBlocks.length)
}

export async function getSimulatedBlockFromInput(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationStateInput: SimulationStateInput | undefined, blockTag?: EthereumBlockTag, fullObjects?: true): Promise<EthereumBlockHeader>
export async function getSimulatedBlockFromInput(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationStateInput: SimulationStateInput | undefined, blockTag: EthereumBlockTag, fullObjects: boolean): Promise<EthereumBlockHeader | EthereumBlockHeaderWithTransactionHashes>
export async function getSimulatedBlockFromInput(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationStateInput: SimulationStateInput | undefined, blockTag: EthereumBlockTag, fullObjects: false): Promise<EthereumBlockHeaderWithTransactionHashes>
export async function getSimulatedBlockFromInput(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationStateInput: SimulationStateInput | undefined, blockTag: EthereumBlockTag = 'latest', fullObjects = true): Promise<EthereumBlockHeader | EthereumBlockHeaderWithTransactionHashes> {
	if (simulationStateInput === undefined) return await ethereumClientService.getBlock(requestAbortController, blockTag, fullObjects)
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
	simulationStateInput: SimulationStateInput | undefined,
	blockHash: EthereumBytes32,
	fullObjects: boolean,
): Promise<EthereumBlockHeader | EthereumBlockHeaderWithTransactionHashes> => {
	if (simulationStateInput === undefined) return await ethereumClientService.getBlockByHash(blockHash, requestAbortController, fullObjects)
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
	simulationStateInput: SimulationStateInput | undefined,
	hash: bigint,
): Promise<EthereumSignedTransactionWithBlockData | null> => {
	if (simulationStateInput === undefined) return await ethereumClientService.getTransactionByHash(hash, requestAbortController)
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
			return { result: EthereumData.parse(ethereumClientService.call(params, 'finalized', requestAbortController)) }
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
		gas: params.gasLimit,
		from,
		nonce: await getSimulatedTransactionCountFromPreparedInputContext(ethereumClientService, requestAbortController, context, from, blockTag),
		chainId: ethereumClientService.getChainId(),
	} as const
	try {
		const currentBlock = context?.parentBlock ?? await ethereumClientService.getBlock(requestAbortController)
		if (currentBlock === null) throw new Error('cannot perform call on top of missing block')
		const simulatedTransactions = await simulateTransactionsOnTopOfSimulationInput(ethereumClientService, requestAbortController, context?.simulationStateInput, [{ ...transaction, gas: params.gasLimit === undefined ? currentBlock.gasLimit : params.gasLimit }])
		const callResult = simulatedTransactions[simulatedTransactions.length - 1]
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
	simulationStateInput: SimulationStateInput | undefined,
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
	simulationStateInput: SimulationStateInput | undefined,
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
	const atInterface = new Interface(['function at(address) returns (bytes)'])
	const input = stringToUint8Array(atInterface.encodeFunctionData('at', [addressString(address)]))
	const getCodeTransaction = {
		type: '1559',
		from: MOCK_ADDRESS,
		chainId: ethereumClientService.getChainId(),
		maxFeePerGas: 0n,
		maxPriorityFeePerGas: 0n,
		gas: context.parentBlock.gasLimit,
		to: GET_CODE_CONTRACT,
		value: 0n,
		input,
		accessList: []
	} as const
	try {
		const result = await simulatedCallWithPreparedInputContext(ethereumClientService, requestAbortController, context, getCodeTransaction, blockTag)
		if ('error' in result) return { statusCode: 'failure' } as const
		const parsed = atInterface.decodeFunctionResult('at', result.result)
		return { statusCode: 'success', getCodeReturn: EthereumData.parse(parsed.toString()) } as const
	} catch(error: unknown) {
		if (error instanceof JsonRpcResponseError) return { statusCode: 'failure' } as const
		throw error
	}
}

export const getSimulatedBalanceFromInput = async (
	ethereumClientService: EthereumClientService,
	requestAbortController: AbortController | undefined,
	simulationStateInput: SimulationStateInput | undefined,
	address: bigint,
	blockTag: EthereumBlockTag = 'latest',
): Promise<bigint> => {
	if (simulationStateInput === undefined) return await ethereumClientService.getBalance(address, blockTag, requestAbortController)
	const context = await createPreparedSimulationExecutionContext(ethereumClientService, requestAbortController, simulationStateInput)
	if (context === undefined || canQueryNodeDirectlyFromInput(context.parentBlock.number, context.executionBlocks.length, blockTag)) {
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
	simulationStateInput: SimulationStateInput | undefined,
	data: PartialEthereumTransaction,
	blockDelta: number | undefined = undefined,
): Promise<{ error: ErrorWithCodeAndOptionalData } | { gas: bigint }> => {
	if (simulationStateInput === undefined) return { gas: await ethereumClientService.estimateGas(data, requestAbortController) }
	const context = await createPreparedSimulationExecutionContext(ethereumClientService, requestAbortController, simulationStateInput)
	if (context === undefined) return { gas: await ethereumClientService.estimateGas(data, requestAbortController) }
	const sendAddress = data.from !== undefined ? data.from : MOCK_ADDRESS
	const transactionCount = getSimulatedTransactionCountFromPreparedInputContext(ethereumClientService, requestAbortController, context, sendAddress)
	const latestSimulatedBlock = await getSimulatedMockBlockFromPreparedContext(context, context.executionBlocks.length - 1)
	const fallbackBlock = latestSimulatedBlock ?? context.parentBlock
	const simulatedBlockIncrement = blockDelta === undefined ? context.executionBlocks.length : blockDelta
	const maxGas = max(fallbackBlock.gasLimit * 1023n / 1024n - transactionQueueTotalGasLimitFromInput(context.prepared.rpcBlocks[simulatedBlockIncrement]), 0n)
	const estimateGasTransaction = {
		type: '1559' as const,
		from: sendAddress,
		chainId: ethereumClientService.getChainId(),
		nonce: await transactionCount,
		maxFeePerGas: 0n,
		maxPriorityFeePerGas: 0n ,
		gas: data.gas === undefined ? maxGas : data.gas,
		to: data.to === undefined ? null : data.to,
		value: data.value === undefined ? 0n : data.value,
		input: getInputFieldFromDataOrInput(data),
		accessList: []
	}
	try {
		const simulatedTransactions = await simulateTransactionsOnTopOfSimulationInput(ethereumClientService, requestAbortController, simulationStateInput, [estimateGasTransaction], {}, true)
		const lastResult = simulatedTransactions[simulatedTransactions.length - 1]
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
	return {
		author: parentBlock.miner,
		difficulty: parentBlock.difficulty,
		extraData: parentBlock.extraData,
		gasLimit: parentBlock.gasLimit,
		gasUsed: transactionQueueTotalGasLimit(simulationState.simulatedBlocks[blockDelta]?.simulatedTransactions || []),
		hash: getHashOfSimulatedBlock(simulationState, blockDelta),
		logsBloom: parentBlock.logsBloom, // TODO: this is wrong
		miner: parentBlock.miner,
		mixHash: parentBlock.mixHash, // TODO: this is wrong
		nonce: parentBlock.nonce,
		number: simulationState.blockNumber + BigInt(blockDelta) + 1n,
		parentHash: parentBlock.hash,
		receiptsRoot: parentBlock.receiptsRoot, // TODO: this is wrong
		sha3Uncles: parentBlock.sha3Uncles, // TODO: this is wrong
		stateRoot: parentBlock.stateRoot, // TODO: this is wrong
		timestamp: simulationState.simulatedBlocks[blockDelta]?.blockTimestamp || bigintSecondsToDate((dateToBigintSeconds(simulationState.blockTimestamp) + getBlockTimeManipulationSeconds(DEFAULT_BLOCK_MANIPULATION.deltaToAdd, DEFAULT_BLOCK_MANIPULATION.deltaUnit))),
		size: parentBlock.size, // TODO: this is wrong
		totalDifficulty: (parentBlock.totalDifficulty ?? 0n) + parentBlock.difficulty, // The difficulty increases about the same amount as previously
		uncles: [],
		baseFeePerGas: getNextBaseFeePerGas(parentBlock.gasUsed, parentBlock.gasLimit, parentBlock.baseFeePerGas),
		transactionsRoot: parentBlock.transactionsRoot, // TODO: this is wrong
		transactions: simulationState.simulatedBlocks[blockDelta]?.simulatedTransactions.map((simulatedTransaction) => simulatedTransaction.preSimulationTransaction.signedTransaction) || [],
		withdrawals: [],
		withdrawalsRoot: 0n, // TODO: this is wrong
	} as const
}

export async function getSimulatedBlockByHash(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState | undefined, blockHash: EthereumBytes32, fullObjects: boolean): Promise<EthereumBlockHeader | EthereumBlockHeaderWithTransactionHashes> {
	if (simulationState !== undefined) {
		if (simulationState.success === false) throw new JsonRpcResponseError(simulationState.jsonRpcError)
		const blockDelta = simulationState.simulatedBlocks.findIndex((_block, index) => getHashOfSimulatedBlock(simulationState, index) === blockHash)
		if (blockDelta < 0) return await ethereumClientService.getBlockByHash(blockHash, requestAbortController, fullObjects)
		const block = await getSimulatedMockBlock(ethereumClientService, requestAbortController, simulationState, blockDelta)
		if (fullObjects) return block
		return { ...block, transactions: block.transactions.map((transaction) => transaction.hash) }
	}
	return await ethereumClientService.getBlockByHash(blockHash, requestAbortController, fullObjects)
}

export async function getSimulatedBlock(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState | undefined, blockTag?: EthereumBlockTag, fullObjects?: true): Promise<EthereumBlockHeader>
export async function getSimulatedBlock(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState | undefined, blockTag: EthereumBlockTag, fullObjects: boolean): Promise<EthereumBlockHeader | EthereumBlockHeaderWithTransactionHashes>
export async function getSimulatedBlock(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState | undefined, blockTag: EthereumBlockTag, fullObjects: false): Promise<EthereumBlockHeaderWithTransactionHashes>
export async function getSimulatedBlock(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState | undefined, blockTag: EthereumBlockTag = 'latest', fullObjects = true): Promise<EthereumBlockHeader | EthereumBlockHeaderWithTransactionHashes>  {
	if (simulationState === undefined || blockTag === 'finalized' || await canQueryNodeDirectly(simulationState, blockTag)) {
		return await ethereumClientService.getBlock(requestAbortController, blockTag, fullObjects)
	}
	if (simulationState.success === false) throw new JsonRpcResponseError(simulationState.jsonRpcError)
	const blockDelta = blockTag === 'latest' || blockTag === 'pending' ? simulationState.simulatedBlocks.length - 1 : Math.max(Number(blockTag - simulationState.blockNumber), 0) - 1
	if (blockDelta < 0) return await ethereumClientService.getBlock(requestAbortController, blockTag, fullObjects)
	const block = await getSimulatedMockBlock(ethereumClientService, requestAbortController, simulationState, blockDelta)
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

export const getSimulatedLogs = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: ExecutionSimulationState | undefined, logFilter: EthGetLogsRequest): Promise<EthGetLogsResponse> => {
	if (simulationState === undefined) return await ethereumClientService.getLogs(logFilter, requestAbortController)
	if (simulationState.success === false) throw new JsonRpcResponseError(simulationState.jsonRpcError)
	const executionBlocks = await createPreparedSimulatedExecutionBlocks(ethereumClientService, requestAbortController, simulationState)

	const toBlock = 'toBlock' in logFilter && logFilter.toBlock !== undefined ? logFilter.toBlock : 'latest'
	const fromBlock = 'fromBlock' in logFilter && logFilter.fromBlock !== undefined ? logFilter.fromBlock : 'latest'
	if (toBlock === 'pending' || fromBlock === 'pending') return await ethereumClientService.getLogs(logFilter, requestAbortController)
	if ((fromBlock === 'latest' && toBlock !== 'latest') || (fromBlock !== 'latest' && toBlock !== 'latest' && fromBlock > toBlock )) throw new Error(`From block '${ fromBlock }' is later than to block '${ toBlock }' `)

	if (toBlock === 'finalized' || fromBlock === 'finalized') return await ethereumClientService.getLogs(logFilter, requestAbortController)
	const simulatedHead = simulationState.blockNumber + BigInt(executionBlocks.length)
	if ('blockHash' in logFilter) {
		const executionBlock = executionBlocks.find((block) => logFilter.blockHash === block.blockHash)
		if (executionBlock !== undefined) return getLogsOfPreparedSimulatedExecutionBlock(executionBlock, logFilter)
		return await ethereumClientService.getLogs(logFilter, requestAbortController)
	}
	const fromBlockNum = resolveLogsBlockTag(fromBlock, simulatedHead)
	const toBlockNum = resolveLogsBlockTag(toBlock, simulatedHead)
	if (typeof fromBlockNum !== 'bigint' || typeof toBlockNum !== 'bigint') return await ethereumClientService.getLogs(logFilter, requestAbortController)
	if (fromBlockNum > toBlockNum) return []
	const nodeLogs = fromBlockNum <= simulationState.blockNumber
		? await ethereumClientService.getLogs({
			...logFilter,
			fromBlock: fromBlockNum,
			toBlock: min(simulationState.blockNumber, toBlockNum),
		}, requestAbortController)
		: []
	const simulatedLogs = executionBlocks
		.filter((block) => block.blockNumber >= fromBlockNum && block.blockNumber <= toBlockNum)
		.flatMap((block) => getLogsOfPreparedSimulatedExecutionBlock(block, logFilter))
	if (nodeLogs.length > 0 || simulatedLogs.length > 0) return [...nodeLogs, ...simulatedLogs]
	if (toBlockNum > simulationState.blockNumber) return []
	return await ethereumClientService.getLogs(logFilter, requestAbortController)
}
export const getSimulatedBlockNumber = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: ExecutionSimulationState | undefined) => {
	if (simulationState !== undefined) return await getSimulatedBlockNumberFromInput(ethereumClientService, requestAbortController, simulationState.simulationStateInput)
	return await ethereumClientService.getBlockNumber(requestAbortController)
}

function getSignedTransactionV(transaction: EthereumSendableSignedTransaction): bigint {
	if ('v' in transaction && transaction.v !== undefined) return transaction.v
	if (!('yParity' in transaction)) throw new Error('Signed transaction is missing both v and yParity.')
	if (transaction.type === 'legacy') return (transaction.yParity === 'even' ? 0n : 1n) + 35n + 2n * transaction.chainId
	return transaction.yParity === 'even' ? 0n : 1n
}

export const getSimulatedTransactionByHash = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState | undefined, hash: bigint): Promise<EthereumSignedTransactionWithBlockData | null> => {
	// try to see if the transaction is in our queue
	if (simulationState === undefined) return await ethereumClientService.getTransactionByHash(hash, requestAbortController)
	if (simulationState.success === false) throw new JsonRpcResponseError(simulationState.jsonRpcError)
	for (const [blockDelta, block] of simulationState.simulatedBlocks.entries()) {
		for (const [transactionIndex, simulatedTransaction] of block.simulatedTransactions.entries()) {
			if (hash === simulatedTransaction.preSimulationTransaction.signedTransaction.hash) {
				const v = getSignedTransactionV(simulatedTransaction.preSimulationTransaction.signedTransaction)
				const additionalParams = {
					blockHash: getHashOfSimulatedBlock(simulationState, blockDelta),
					blockNumber: simulationState.blockNumber + BigInt(blockDelta) + 1n,
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

export const simulatedCall = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState | undefined, params: Pick<IUnsignedTransaction1559, 'to' | 'maxFeePerGas' | 'maxPriorityFeePerGas' | 'input' | 'value'> & Partial<Pick<IUnsignedTransaction1559, 'from' | 'gasLimit'>>, blockTag: EthereumBlockTag = 'latest') => {
	if (blockTag === 'finalized') {
		try {
			return { result: EthereumData.parse(ethereumClientService.call(params, 'finalized', requestAbortController)) }
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
		gas: params.gasLimit,
		from,
		nonce: await getSimulatedTransactionCount(ethereumClientService, requestAbortController, simulationState, from, blockTag),
		chainId: ethereumClientService.getChainId(),
	} as const

	//todo, we can optimize this by leaving nonce out
	try {
		const currentBlock = await ethereumClientService.getBlock(requestAbortController)
		if (currentBlock === null) throw new Error('cannot perform call on top of missing block')
		const simulatedTransactions = await simulateTransactionsOnTopOfSimulationInput(ethereumClientService, requestAbortController, simulationState?.simulationStateInput, [{ ...transaction, gas: params.gasLimit === undefined ? currentBlock.gasLimit : params.gasLimit }])
		const callResult = simulatedTransactions[simulatedTransactions.length - 1]
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

const simulateTransactionsOnTopOfSimulationInput = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationStateInput: SimulationStateInputMinimalData | undefined, transactions: EthereumUnsignedTransaction[], extraOverrides: StateOverrides = {}, simulateWithZeroBaseFee: boolean = false) => {
	if (transactions.length === 0) return []
	const signedTransactions = transactions.map((transaction) => mockSignTransaction(transaction))
	const newTransactions = {
		transactions: [...signedTransactions.map((signedTransaction) => ({ signedTransaction: signedTransaction }) )],
		stateOverrides: extraOverrides,
		signedMessages: [],
		blockTimeManipulation: DEFAULT_BLOCK_MANIPULATION,
		simulateWithZeroBaseFee,
	}
	const simulationStateInputWithNewTransactions = simulationStateInput !== undefined ? [...simulationStateInput, newTransactions] : [newTransactions]
	const { prepared, result: ethSimulateV1CallResult } = await ethereumClientService.simulatePrepared(simulationStateInputWithNewTransactions, await ethereumClientService.getBlockNumber(requestAbortController), requestAbortController)
	return last(groupEthSimulateV1ResultByInputBlocks(prepared, ethSimulateV1CallResult))?.calls || []
}

// use time as block hash as that makes it so that updated simulations with different states are different, but requires no additional calculation
const getHashOfSimulatedBlock = (simulationState: SimulationState, blockDelta: number) => getHashOfSimulatedBlockFromInput(simulationState.simulationStateInput, blockDelta)

export const getMessageHashForPersonalSign = (params: PersonalSignParams) => hashMessage({ raw: stringToUint8Array(params.params[0]) })

export const simulatePersonalSign = async (params: SignMessageParams, signingAddress: EthereumAddress) => {
	const account = privateKeyToAccount(bytes32String(signingAddress === ADDRESS_FOR_PRIVATE_KEY_ONE ? MOCK_PUBLIC_PRIVATE_KEY : MOCK_SIMULATION_PRIVATE_KEY) as `0x${ string }`)
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
	const IMulticall3 = new Interface(Multicall3ABI)
	const erc20TokenInterface = new Interface(['function balanceOf(address account) view returns (uint256)'])
	const erc1155TokenInterface = new Interface(['function balanceOf(address _owner, uint256 _id) external view returns(uint256)'])
	const tokenAndEthBalancesInputData = stringToUint8Array(IMulticall3.encodeFunctionData('aggregate3', [deduplicatedBalanceQueries.map((balanceQuery) => {
		if (balanceQuery.token === ETHEREUM_LOGS_LOGGER_ADDRESS && balanceQuery.type === 'ERC20') {
			return {
				target: addressString(MULTICALL3),
				allowFailure: true,
				callData: IMulticall3.encodeFunctionData('getEthBalance', [addressString(balanceQuery.owner)])
			}
		}
		if (balanceQuery.type === 'ERC20') {
			return {
				target: addressString(balanceQuery.token),
				allowFailure: true,
				callData: stringToUint8Array(erc20TokenInterface.encodeFunctionData('balanceOf', [addressString(balanceQuery.owner)])),
			}
		}
		return {
			target: addressString(balanceQuery.token),
			allowFailure: true,
			callData: stringToUint8Array(erc1155TokenInterface.encodeFunctionData('balanceOf', [addressString(balanceQuery.owner), EthereumQuantity.serialize(balanceQuery.tokenId)])),
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
		gas: (await ethereumClientService.getBlock(requestAbortController))?.gasLimit || 15_000_000n,
		nonce: 0n,
		chainId: ethereumClientService.getChainId(),
		r: 0n,
		s: 0n,
		v: 0n,
		hash: 0n,
	} as const
	const simulatedTransactions = await simulateTransactionsOnTopOfSimulationInput(ethereumClientService, requestAbortController, simulationStateInput, [callTransaction])
	const aggregate3CallResult = simulatedTransactions[simulatedTransactions.length - 1]
	if (aggregate3CallResult === undefined || aggregate3CallResult.status === 'failure') throw Error('Failed aggregate3')
	const multicallReturnData: { success: boolean, returnData: string }[] = IMulticall3.decodeFunctionResult('aggregate3', dataStringWith0xStart(aggregate3CallResult.returnData))[0]
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

export const parseEventIfPossible = (ethersInterface: Interface, log: EthereumEvent) => {
	try {
		return ethersInterface.parseLog({ topics: log.topics.map((x) => bytes32String(x)), data: dataStringWith0xStart(log.data) })
	} catch (error) {
		return null
	}
}

export const parseTransactionInputIfPossible = (ethersInterface: Interface, data: EthereumData, value: EthereumQuantity) => {
	try {
		return ethersInterface.parseTransaction({ data: dataStringWith0xStart(data), value })
	} catch (error) {
		return null
	}
}

const getAddressesInteractedWithErc20s = (events: readonly EthereumEvent[]): { token: bigint, owner: bigint, tokenId: undefined, type: 'ERC20' }[] => {
	const erc20ABI = [
		'event Withdrawal(address indexed src, uint wad)', // weth withdraw function
		'event Deposit(address indexed dst, uint wad)', // weth deposit function
		'event Transfer(address indexed from, address indexed to, uint256 value)',
		'event Approval(address indexed owner, address indexed spender, uint256 value)',
	]
	const erc20 = new Interface(erc20ABI)
	const tokenOwners: { token: bigint, owner: bigint, tokenId: undefined, type: 'ERC20' }[] = []
	for (const log of events) {
		const parsed = parseEventIfPossible(erc20, log)
		if (parsed === null) continue
		const base = { token: log.address, tokenId: undefined, type: 'ERC20' as const }
		switch (parsed.name) {
			case 'Withdrawal':
			case 'Deposit': {
				tokenOwners.push({ ...base, owner: EthereumAddress.parse(parsed.args[0]) })
				break
			}
			case 'Approval':
			case 'Transfer': {
				tokenOwners.push({ ...base, owner: EthereumAddress.parse(parsed.args[0]) })
				tokenOwners.push({ ...base, owner: EthereumAddress.parse(parsed.args[1]) })
				break
			}
			default: throw new Error(`wrong name: ${ parsed.name }`)
		}
	}
	return tokenOwners
}

const getAddressesAndTokensIdsInteractedWithErc1155s = (events: readonly EthereumEvent[]): { token: bigint, owner: bigint, tokenId: bigint, type: 'ERC1155' }[] => {
	const erc1155ABI = [
		'event TransferSingle(address operator, address from, address to, uint256 id, uint256 value)',
		'event TransferBatch(address indexed _operator, address indexed _from, address indexed _to, uint256[] _ids, uint256[] _values)',
	]
	const erc20 = new Interface(erc1155ABI)
	const tokenOwners: { token: bigint, owner: bigint, tokenId: bigint, type: 'ERC1155' }[] = []
	for (const log of events) {
		const parsed = parseEventIfPossible(erc20, log)
		if (parsed === null) continue
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
