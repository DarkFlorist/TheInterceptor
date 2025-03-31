import { EthereumClientService } from './EthereumClientService.js'
import { EthereumUnsignedTransaction, EthereumSignedTransactionWithBlockData, EthereumBlockTag, EthereumAddress, EthereumBlockHeader, EthereumBlockHeaderWithTransactionHashes, EthereumData, EthereumQuantity, EthereumBytes32, EthereumSendableSignedTransaction } from '../../types/wire-types.js'
import { addressString, bigintToUint8Array, bytes32String, calculateWeightedPercentile, dataStringWith0xStart, max, min, stringToUint8Array } from '../../utils/bigint.js'
import { CANNOT_SIMULATE_OFF_LEGACY_BLOCK, ERROR_INTERCEPTOR_GAS_ESTIMATION_FAILED, ETHEREUM_LOGS_LOGGER_ADDRESS, ETHEREUM_EIP1559_BASEFEECHANGEDENOMINATOR, ETHEREUM_EIP1559_ELASTICITY_MULTIPLIER, MOCK_ADDRESS, MULTICALL3, Multicall3ABI, DEFAULT_CALL_ADDRESS, GAS_PER_BLOB, MAKE_YOU_RICH_TRANSACTION } from '../../utils/constants.js'
import { Interface, ethers, hashMessage, keccak256, } from 'ethers'
import { SimulatedTransaction, SimulationState, TokenBalancesAfter, EstimateGasError, PreSimulationTransaction, SimulationStateBlock, SimulationStateInput } from '../../types/visualizer-types.js'
import { EthereumUnsignedTransactionToUnsignedTransaction, IUnsignedTransaction1559, rlpEncode, serializeSignedTransactionToBytes } from '../../utils/ethereum.js'
import { EthGetLogsResponse, EthGetLogsRequest, EthTransactionReceiptResponse, PartialEthereumTransaction, EthGetFeeHistoryResponse, FeeHistory } from '../../types/JsonRpc-types.js'
import { handleERC1155TransferBatch, handleERC1155TransferSingle, handleERC20TransferLog } from '../logHandlers.js'
import { assertNever, modifyObject } from '../../utils/typescript.js'
import { SignMessageParams } from '../../types/jsonRpc-signing-types.js'
import { EthSimulateV1CallResult, EthSimulateV1Result, EthereumEvent, MutableStateOverrides, StateOverrides } from '../../types/ethSimulate-types.js'
import { getCodeByteCode } from '../../utils/ethereumByteCodes.js'
import { stripLeadingZeros } from '../../utils/typed-arrays.js'
import { GetSimulationStackReplyV1, GetSimulationStackReplyV2 } from '../../types/simulationStackTypes.js'
import { getMakeMeRich, getSettings } from '../../background/settings.js'
import { JsonRpcResponseError } from '../../utils/errors.js'

const MOCK_PUBLIC_PRIVATE_KEY = 0x1n // key used to sign mock transactions
const MOCK_SIMULATION_PRIVATE_KEY = 0x2n // key used to sign simulated transatons
const ADDRESS_FOR_PRIVATE_KEY_ONE = 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdfn
const GET_CODE_CONTRACT = 0x1ce438391307f908756fefe0fe220c0f0d51508an

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

export const copySimulationState = (simulationState: SimulationState): SimulationState => {
	return {
		rpcNetwork: simulationState.rpcNetwork,
		simulatedBlocks: [...simulationState.simulatedBlocks],
		blockNumber: simulationState.blockNumber,
		blockTimestamp: simulationState.blockTimestamp,
		simulationConductedTimestamp: simulationState.simulationConductedTimestamp,
		baseFeePerGas: simulationState.baseFeePerGas,
	}
}

const getETHBalanceChanges = (baseFeePerGas: bigint, transaction: SimulatedTransaction) => {
	if (transaction.ethSimulateV1CallResult.status === 'failure') return []
	const ethLogs = transaction.ethSimulateV1CallResult.logs.filter((log) => log.address === ETHEREUM_LOGS_LOGGER_ADDRESS)
	const ethBalanceAfter = transaction.tokenBalancesAfter.filter((x) => x.token === ETHEREUM_LOGS_LOGGER_ADDRESS)
	return ethBalanceAfter.map((balanceAfter) => {
		const balanceAfterBalance = baseFeePerGas * transaction.ethSimulateV1CallResult.gasUsed
		const gasFees = balanceAfter.owner === transaction.preSimulationTransaction.signedTransaction.from ? transaction.realizedGasPrice * transaction.ethSimulateV1CallResult.gasUsed : 0n
		return {
			address: balanceAfter.owner,
			before: ethLogs.reduce((total, event) => {
				const parsed = handleERC20TransferLog(event)[0]
				if (parsed === undefined || parsed.type !== 'ERC20') throw new Error('eth log was not erc20 transfer event')
				if (parsed.from === balanceAfter.owner && parsed.to !== balanceAfter.owner) return total + parsed.amount
				if (parsed.from !== balanceAfter.owner && parsed.to === balanceAfter.owner) return total - parsed.amount
				return total
			}, balanceAfterBalance ?? 0n) + gasFees,
			after: balanceAfterBalance ?? 0n,
		}
	})
}

const mergeSimulationOverrides = (stateOverridesArray: StateOverrides[]): StateOverrides => {
	let mergedStateOverrides: MutableStateOverrides = {}
	for (const stateOverrides of stateOverridesArray) {
		for (var key in stateOverrides){
			if (stateOverrides.hasOwnProperty(key)){
				mergedStateOverrides[key] = stateOverrides[key]
			}
		}
	}
	return mergedStateOverrides
}

export const getSimulatedStackV2 = (simulationState: SimulationState | undefined): GetSimulationStackReplyV2 => {
	if (simulationState === undefined) return { stateOverrides: {}, transactions: [] }
	return {
		stateOverrides: mergeSimulationOverrides(simulationState.simulatedBlocks.map((simulatedBlock) => simulatedBlock.stateOverrides)),
		transactions: simulationState.simulatedBlocks.flatMap((simulatedBlock) => simulatedBlock.simulatedTransactions).map((simulatedTransaction) => ({ ethBalanceChanges: getETHBalanceChanges(simulationState.baseFeePerGas, simulatedTransaction), simulatedTransaction }))
	}
}

export const getSimulatedStackOld = (simulationState: SimulationState | undefined, version: '1.0.0' | '1.0.1'): GetSimulationStackReplyV1 => {
	if (simulationState === undefined) return []
	const simulatedTransactions = simulationState.simulatedBlocks.flatMap((simulatedBlock) => simulatedBlock.simulatedTransactions).map((transaction) => {
		const ethLogs = transaction.ethSimulateV1CallResult.status === 'failure' ? [] : transaction.ethSimulateV1CallResult.logs.filter((log) => log.address === ETHEREUM_LOGS_LOGGER_ADDRESS)
		const ethBalanceAfter = transaction.tokenBalancesAfter.filter((x) => x.token === ETHEREUM_LOGS_LOGGER_ADDRESS)
		const maxPriorityFeePerGas = transaction.preSimulationTransaction.signedTransaction.type === '1559' ? transaction.preSimulationTransaction.signedTransaction.maxPriorityFeePerGas : 0n
		return {
			...transaction.preSimulationTransaction.signedTransaction,
			...transaction.ethSimulateV1CallResult,
			... ( transaction.ethSimulateV1CallResult.status === 'failure' ? {
				statusCode: transaction.ethSimulateV1CallResult.status,
				error: transaction.ethSimulateV1CallResult.error.message } : {
					statusCode: transaction.ethSimulateV1CallResult.status,
					events: transaction.ethSimulateV1CallResult.logs.map((x) => ({ loggersAddress: x.address, data: x.data, topics: x.topics }))
				}
			),
			returnValue: transaction.ethSimulateV1CallResult.returnData,
			maxPriorityFeePerGas,
			balanceChanges: ethBalanceAfter.map((balanceAfter) => {
				// in the version 1.0.0 , gas price was wrongly calculated with 'maxPriorityFeePerGas', this code keeps this for 1.0.0 but fixes it for other versions
				const balanceAfterBalance = version === '1.0.0' || balanceAfter.owner !== transaction.preSimulationTransaction.signedTransaction.from ? balanceAfter.balance : (balanceAfter.balance ?? 0n) - simulationState.baseFeePerGas * transaction.ethSimulateV1CallResult.gasUsed
				const gasFees = balanceAfter.owner === transaction.preSimulationTransaction.signedTransaction.from ? transaction.realizedGasPrice * transaction.ethSimulateV1CallResult.gasUsed : 0n
				return {
					address: balanceAfter.owner,
					before: ethLogs.reduce((total, event) => {
						const parsed = handleERC20TransferLog(event)[0]
						if (parsed === undefined || parsed.type !== 'ERC20') throw new Error('eth log was not erc20 transfer event')
						if (parsed.from === balanceAfter.owner && parsed.to !== balanceAfter.owner) return total + parsed.amount
						if (parsed.from !== balanceAfter.owner && parsed.to === balanceAfter.owner) return total - parsed.amount
						return total
					}, balanceAfterBalance ?? 0n) + gasFees,
					after: balanceAfterBalance ?? 0n,
				}
			}),
			realizedGasPrice: transaction.realizedGasPrice,
			gasLimit: transaction.preSimulationTransaction.signedTransaction.gas,
			gasSpent: transaction.ethSimulateV1CallResult.gasUsed,
		}
	})
	const guessWhatIsAddressToMakeRich = (simulationState: SimulationState) => {
		const firstBlockStateOverrides = simulationState.simulatedBlocks[0]?.stateOverrides
		if (firstBlockStateOverrides === undefined) return undefined
		const overrides = Object.entries(firstBlockStateOverrides)
		const override = overrides.find(([_address, override]) => override?.balance === MAKE_YOU_RICH_TRANSACTION.transaction.value)
		return override === undefined ? undefined : BigInt(override[0])
	}
	const addressToMakeRich = guessWhatIsAddressToMakeRich(simulationState)
	if (addressToMakeRich === undefined) return simulatedTransactions
	return [
		{
			from: 0x0n,
			chainId: simulationState.rpcNetwork.chainId,
			nonce: 0n,
			to: addressToMakeRich,
			...MAKE_YOU_RICH_TRANSACTION.transaction,
			statusCode: 'success' as const,
			gasSpent: MAKE_YOU_RICH_TRANSACTION.transaction.gas,
			realizedGasPrice: 0n,
			gasLimit: MAKE_YOU_RICH_TRANSACTION.transaction.gas,
			returnValue: new Uint8Array(),
			events: [],
			balanceChanges: [{ address: addressToMakeRich, before: 0n, after: MAKE_YOU_RICH_TRANSACTION.transaction.value }]
		}, ...simulatedTransactions
	]
}

const transactionQueueTotalGasLimit = (simulatedTransactions: readonly SimulatedTransaction[]) => {
	return simulatedTransactions.reduce((a, b) => a + b.preSimulationTransaction.signedTransaction.gas, 0n)
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
	const blockNumToUseForSim = blockTag === 'latest' || blockTag === 'pending' ? simulationState.blockNumber + BigInt(simulationState.simulatedBlocks.length) : blockTag
	const blockNumToUseForChain = blockTag === 'latest' || blockTag === 'pending' ? simulationState.blockNumber : min(blockTag, simulationState.blockNumber)
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

export const simulateEstimateGas = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState | undefined, data: PartialEthereumTransaction, blockDelta: number | undefined = undefined): Promise<EstimateGasError | { gas: bigint }> => {
	// commented out because of nethermind not estimating gas correctly https://github.com/NethermindEth/nethermind/issues/5946
	//if (simulationState === undefined) return { gas: await ethereumClientService.estimateGas(data) }
	const sendAddress = data.from !== undefined ? data.from : MOCK_ADDRESS
	const transactionCount = getSimulatedTransactionCount(ethereumClientService, requestAbortController, simulationState, sendAddress)
	const block = await getSimulatedBlock(ethereumClientService, requestAbortController, simulationState)
	if (block === null) throw new Error('The latest block is null')
	const simulatedBlockIncrement = blockDelta === undefined ? simulationState?.simulatedBlocks.length || 0 : blockDelta
	const maxGas = simulationGasLeft(simulationState?.simulatedBlocks[simulatedBlockIncrement] || undefined, block)

	const getGasPriceFields = (data: PartialEthereumTransaction) => {
		if (data.gasPrice !== undefined) return { maxFeePerGas: data.gasPrice, maxPriorityFeePerGas: data.gasPrice }
		if (data.maxPriorityFeePerGas !== undefined && data.maxPriorityFeePerGas !== null && data.maxFeePerGas !== undefined && data.maxFeePerGas !== null) {
			return { maxFeePerGas: data.maxFeePerGas, maxPriorityFeePerGas: data.maxPriorityFeePerGas }
		}
		return { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }
	}

	const tmp = {
		type: '1559' as const,
		from: sendAddress,
		chainId: ethereumClientService.getChainId(),
		nonce: await transactionCount,
		...getGasPriceFields(data),
		gas: data.gas === undefined ? maxGas : data.gas,
		to: data.to === undefined ? null : data.to,
		value: data.value === undefined ? 0n : data.value,
		input: getInputFieldFromDataOrInput(data),
		accessList: []
	}
	try {
		const simulatedTransactions = await simulateTransactionsOnTopOfSimulationState(ethereumClientService, requestAbortController, simulationState, [tmp])
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

	const signatureParams = { r: 0n, s: 0n, yParity: 'even' as const }
	const hash = EthereumQuantity.parse(keccak256(serializeSignedTransactionToBytes({ ...unsignedTransaction, ...signatureParams })))
	if (transaction.type === 'legacy') throw new Error('types do not match')
	return { ...transaction, ...signatureParams, hash }
}

export const getAddressToMakeRich = async () => await getMakeMeRich() ? (await getSettings()).activeSimulationAddress : undefined

export const createSimulationState = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationStateInput: SimulationStateInput): Promise<SimulationState> => {
	const parentBlock = await ethereumClientService.getBlock(requestAbortController)
	if (parentBlock === null) throw new Error('The latest block is null')
	if (simulationStateInput.blocks.length === 0 || (simulationStateInput.blocks[0]?.transactions.length === 0 && simulationStateInput.blocks[0]?.transactions.length === 0 && simulationStateInput.blocks.length === 1)) {
		// if there's no blocks, or there's an empty block (that can have state overrides), skip simulation and return empty results
		return {
			rpcNetwork: ethereumClientService.getRpcEntry(),
			simulatedBlocks: simulationStateInput.blocks.map(() => ({
				simulatedTransactions: [],
				signedMessages: [],
				stateOverrides: simulationStateInput.blocks[0]?.stateOverrides || {},
				timeIncreaseDelta: simulationStateInput.blocks[0]?.timeIncreaseDelta || 12n
			})),
			blockNumber: parentBlock.number,
			blockTimestamp: new Date(),
			simulationConductedTimestamp: new Date(),
			baseFeePerGas: 0n,
		}
	}
	const ethSimulateV1CallResult = await ethereumClientService.simulate(simulationStateInput, parentBlock.number, requestAbortController)
	if (ethSimulateV1CallResult === undefined) throw new Error('multicall length does not match in createSimulationState')
	if (ethSimulateV1CallResult.length !== simulationStateInput.blocks.length) throw Error('multicall length does not match in createSimulationState')
	const baseFeePerGas = ethSimulateV1CallResult[0]?.baseFeePerGas ?? 0n

	const tokenBalancesAfter = await getTokenBalancesAfter(
		ethereumClientService,
		requestAbortController,
		ethSimulateV1CallResult,
		simulationStateInput,
	)
	return {
		simulatedBlocks: ethSimulateV1CallResult.map((callResult, blockIndex) => ({
			simulatedTransactions: callResult.calls.map((singleResult, transactionIndex) => {
				const tokenBalancesAfterForIndex = tokenBalancesAfter.blocks[blockIndex]?.transactions[transactionIndex]?.tokenBalancesAfter
				const signedTx = simulationStateInput.blocks[blockIndex]?.transactions[transactionIndex]
				if (signedTx === undefined) throw Error('invalid transaction index')
				if (tokenBalancesAfterForIndex === undefined) throw Error('invalid tokenBalancesAfterForIndex index')
				return {
					type: 'transaction',
					ethSimulateV1CallResult: singleResult,
					realizedGasPrice: calculateRealizedEffectiveGasPrice(signedTx.signedTransaction, callResult.baseFeePerGas),
					preSimulationTransaction: signedTx,
					tokenBalancesAfter: tokenBalancesAfterForIndex,
				}
			}),
			signedMessages: simulationStateInput.blocks[blockIndex]?.signedMessages || [],
			stateOverrides: simulationStateInput.blocks[blockIndex]?.stateOverrides || {},
			timeIncreaseDelta: simulationStateInput.blocks[blockIndex]?.timeIncreaseDelta || 12n,
		})),
		blockNumber: parentBlock.number,
		blockTimestamp: parentBlock.timestamp,
		baseFeePerGas: baseFeePerGas,
		simulationConductedTimestamp: new Date(),
		rpcNetwork: ethereumClientService.getRpcEntry(),
	}
}

export const getPreSimulated = (simulatedTransactions: readonly SimulatedTransaction[]) => simulatedTransactions.map((transaction) => transaction.preSimulationTransaction)

export const convertSimulationStateToSimulationInput = (simulationState: SimulationState | undefined) => {
	if (simulationState === undefined) return { blocks: [{ stateOverrides: {}, transactions: [], signedMessages: [], timeIncreaseDelta: 12n }] } as const
	return { blocks: simulationState.simulatedBlocks.map((block) => ({
		stateOverrides: block.stateOverrides,
		transactions: getPreSimulated(block.simulatedTransactions),
		signedMessages: block.signedMessages,
		timeIncreaseDelta: block.timeIncreaseDelta
	})) }
}

export const appendTransactionsToInput = (simulationStateInput: SimulationStateInput | undefined, transactions: PreSimulationTransaction[], blockDelta: number | undefined = undefined, stateOverrides: StateOverrides = {}): SimulationStateInput => {
	const nonUndefinedBlockDelta = simulationStateInput?.blocks.length || 0
	const mergeStateSets = (oldOverrides: StateOverrides, newOverrides: StateOverrides) => {
		const copy = { ...oldOverrides }
		Object.entries(newOverrides).forEach(([key, value]) => { copy[key] = value })
		return copy
	}
	const newTransactions = [...transactions]
	if (simulationStateInput === undefined) return { blocks: [{ stateOverrides, transactions: newTransactions, signedMessages: [], timeIncreaseDelta: 12n }] } as const
	if (simulationStateInput.blocks[nonUndefinedBlockDelta] !== undefined) {
		return { blocks: simulationStateInput.blocks.map((block, index) => ({
			stateOverrides: mergeStateSets(block.stateOverrides, stateOverrides),
			transactions: index === blockDelta ? [...block.transactions, ...newTransactions] : block.transactions,
			signedMessages: block.signedMessages,
			timeIncreaseDelta: block.timeIncreaseDelta,
		})) } as const
	}
	const oldBlocks = simulationStateInput.blocks.map((block) => ({
		stateOverrides: mergeStateSets(block.stateOverrides, stateOverrides),
		transactions: block.transactions,
		signedMessages: block.signedMessages,
		timeIncreaseDelta: block.timeIncreaseDelta
	}))
	return {
		blocks: [
			...oldBlocks,
			{ stateOverrides: {}, transactions: newTransactions, signedMessages: [], timeIncreaseDelta: 12n }
		]
	}
}

export const appendTransactionToInputAndSimulate = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState | undefined, transactions: PreSimulationTransaction[], blockDelta: number | undefined = undefined, stateOverrides: StateOverrides = {}): Promise<SimulationState> => {
	const oldSimulatedInput = convertSimulationStateToSimulationInput(simulationState)
	const simulationStateInput = appendTransactionsToInput(oldSimulatedInput, transactions, blockDelta, stateOverrides)
	return await createSimulationState(ethereumClientService, requestAbortController, simulationStateInput)
}

export const getNonceFixedSimulationStateInput = async(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState | undefined) => {
	const isFixableNonceError = (transaction: SimulatedTransaction) => {
		return transaction.ethSimulateV1CallResult.status === 'failure'
		&& transaction.ethSimulateV1CallResult.error.message === 'wrong transaction nonce' //TODO, change to error code
		&& transaction.preSimulationTransaction.originalRequestParameters.method === 'eth_sendTransaction'
	}
	const knownPreviousNonce = new Map<string, bigint>()
	const blocks = simulationState?.simulatedBlocks || []

	const areThereNonceIssues = () => {
		const nonceFixable = blocks.find((block) => block.simulatedTransactions.find((transaction) => isFixableNonceError(transaction)))
		return nonceFixable !== undefined
	}
	const oldInput = convertSimulationStateToSimulationInput(simulationState)
	if (!areThereNonceIssues()) return { nonceFixed: false, simulationStateInput: oldInput }
	let simulationInputBlocks = []
	for (const [blockIndex, block] of blocks.entries()) {
		const processedTransactions: PreSimulationTransaction[] = []
		for (const transaction of block.simulatedTransactions) {
			const preSimulationTransaction = transaction.preSimulationTransaction
			const fromString = addressString(preSimulationTransaction.signedTransaction.from)
			const fixTransaction = async (transaction: SimulatedTransaction) => {
				if (!isFixableNonceError(transaction)) return preSimulationTransaction
				const prevNonce = knownPreviousNonce.get(fromString)
				const newNonce = prevNonce === undefined ? await ethereumClientService.getTransactionCount(preSimulationTransaction.signedTransaction.from, 'latest', requestAbortController) : prevNonce + 1n
				return modifyObject(preSimulationTransaction, { signedTransaction: modifyObject(transaction.preSimulationTransaction.signedTransaction, { nonce: newNonce }) })
			}
			const fixedTransaction = await fixTransaction(transaction)
			processedTransactions.push(fixedTransaction)
			knownPreviousNonce.set(fromString, fixedTransaction.signedTransaction.nonce)
		}
		const oldBlock = oldInput.blocks[blockIndex]
		if (oldBlock === undefined) throw new Error('missing block when checking for nonces')
		simulationInputBlocks.push({ ...oldBlock, transactions: processedTransactions })
	}
	return { nonceFixed: true, simulationStateInput: { blocks: simulationInputBlocks } }
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
		|| (simulationState.simulatedBlocks.length === 0)
		|| (typeof blockTag === 'bigint' && blockTag <= simulationState.blockNumber + BigInt(simulationState.simulatedBlocks.length))
	){
		return true
	}
	return false
}

export const getDeployedContractAddress = (from: EthereumAddress, nonce: EthereumQuantity): EthereumAddress => {
	return BigInt(`0x${ keccak256(rlpEncode([stripLeadingZeros(bigintToUint8Array(from, 20)), stripLeadingZeros(bigintToUint8Array(nonce, 32))])).slice(26) }`)
}

export const getSimulatedTransactionReceipt = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState | undefined, hash: bigint): Promise<EthTransactionReceiptResponse> => {
	let cumGas = 0n
	let currentLogIndex = 0
	if (simulationState === undefined) { return await ethereumClientService.getTransactionReceipt(hash, requestAbortController) }
	const blockNum = await ethereumClientService.getBlockNumber(requestAbortController)
	for (const [blockDelta, block] of simulationState.simulatedBlocks.entries()) {
		for (const [transactionIndex, simulatedTransaction] of block.simulatedTransactions.entries()) {
			cumGas += simulatedTransaction.ethSimulateV1CallResult.gasUsed
			if (hash === simulatedTransaction.preSimulationTransaction.signedTransaction.hash) {
				return {
					...simulatedTransaction.preSimulationTransaction.signedTransaction.type === '4844' ? {
						type: simulatedTransaction.preSimulationTransaction.signedTransaction.type,
						blobGasUsed: GAS_PER_BLOB * BigInt(simulatedTransaction.preSimulationTransaction.signedTransaction.blobVersionedHashes.length),
						blobGasPrice: simulatedTransaction.preSimulationTransaction.signedTransaction.maxFeePerBlobGas,
					} : {
						type: simulatedTransaction.preSimulationTransaction.signedTransaction.type,
					},
					blockHash: getHashOfSimulatedBlock(simulationState, blockDelta),
					blockNumber: blockNum + BigInt(blockDelta) + 1n,
					transactionHash: simulatedTransaction.preSimulationTransaction.signedTransaction.hash,
					transactionIndex: BigInt(transactionIndex),
					contractAddress: simulatedTransaction.preSimulationTransaction.signedTransaction.to !== null ? null : getDeployedContractAddress(simulatedTransaction.preSimulationTransaction.signedTransaction.from, simulatedTransaction.preSimulationTransaction.signedTransaction.nonce),
					cumulativeGasUsed: cumGas,
					gasUsed: simulatedTransaction.ethSimulateV1CallResult.gasUsed,
					effectiveGasPrice: calculateRealizedEffectiveGasPrice(simulatedTransaction.preSimulationTransaction.signedTransaction, simulationState.baseFeePerGas),
					from: simulatedTransaction.preSimulationTransaction.signedTransaction.from,
					to: simulatedTransaction.preSimulationTransaction.signedTransaction.to,
					logs: simulatedTransaction.ethSimulateV1CallResult.status === 'success'
						? simulatedTransaction.ethSimulateV1CallResult.logs.map((x, logIndex) => ({
							removed: false,
							blockHash: getHashOfSimulatedBlock(simulationState, blockDelta),
							address: x.address,
							logIndex: BigInt(currentLogIndex + logIndex),
							data: x.data,
							topics: x.topics,
							blockNumber: blockNum,
							transactionIndex: BigInt(transactionIndex),
							transactionHash: simulatedTransaction.preSimulationTransaction.signedTransaction.hash
						}))
						: [],
					logsBloom: 0x0n, //TODO: what should this be?
					status: simulatedTransaction.ethSimulateV1CallResult.status
				}
			}
			currentLogIndex += simulatedTransaction.ethSimulateV1CallResult.status === 'success' ? simulatedTransaction.ethSimulateV1CallResult.logs.length : 0
		}
	}
	return await ethereumClientService.getTransactionReceipt(hash, requestAbortController)
}

export const getSimulatedBalance = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState | undefined, address: bigint, blockTag: EthereumBlockTag = 'latest'): Promise<bigint> => {
	if (simulationState === undefined || await canQueryNodeDirectly(simulationState, blockTag)) return await ethereumClientService.getBalance(address, blockTag, requestAbortController)
	const ethBalances = new Map<bigint, bigint>()
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

	const atInterface = new ethers.Interface(['function at(address) returns (bytes)'])
	const input = stringToUint8Array(atInterface.encodeFunctionData('at', [addressString(address)]))

	const getCodeTransaction = {
		type: '1559',
		from: MOCK_ADDRESS,
		chainId: ethereumClientService.getChainId(),
		nonce: await ethereumClientService.getTransactionCount(MOCK_ADDRESS, 'latest', requestAbortController),
		maxFeePerGas: 0n,
		maxPriorityFeePerGas: 0n,
		gas: block.gasLimit,
		to: GET_CODE_CONTRACT,
		value: 0n,
		input: input,
		accessList: []
	} as const

	const simulatedTransactions = await simulateTransactionsOnTopOfSimulationState(ethereumClientService, requestAbortController, simulationState, [getCodeTransaction], { [addressString(GET_CODE_CONTRACT)]: { code: getCodeByteCode() } })
	const lastResult = simulatedTransactions.at(-1)
	if (lastResult === undefined) throw new Error('last result did not exist in multicall')
	if (lastResult.status === 'failure') return { statusCode: 'failure' } as const
	const parsed = atInterface.decodeFunctionResult('at', lastResult.returnData)
	return {
		statusCode: lastResult.status,
		getCodeReturn: EthereumData.parse(parsed.toString())
	} as const
}
// ported from: https://github.com/ethereum/go-ethereum/blob/509a64ffb9405942396276ae111d06f9bded9221/consensus/misc/eip1559/eip1559.go#L55
const getNextBaseFeePerGas = (parentGasUsed: bigint, parentGasLimit: bigint, parentBaseFeePerGas: bigint) => {
	const parentGasTarget = parentGasLimit / ETHEREUM_EIP1559_ELASTICITY_MULTIPLIER
	if (parentGasUsed === parentGasTarget) return parentBaseFeePerGas
	if (parentGasUsed > parentGasTarget) return parentBaseFeePerGas + max(1n, parentBaseFeePerGas * (parentGasUsed - parentGasTarget) / parentGasTarget / ETHEREUM_EIP1559_BASEFEECHANGEDENOMINATOR)
	return max(0n, parentBaseFeePerGas - parentBaseFeePerGas * (parentGasTarget - parentGasUsed) / parentGasTarget / ETHEREUM_EIP1559_BASEFEECHANGEDENOMINATOR)
}

async function getSimulatedMockBlock(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState, blockDelta: number) {
	// make a mock block based on the previous block
	const parentBlock = await ethereumClientService.getBlock(requestAbortController)
	if (parentBlock === null) throw new Error('The latest block is null')
	if (parentBlock.baseFeePerGas === undefined) throw new Error(CANNOT_SIMULATE_OFF_LEGACY_BLOCK)
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
		timestamp: new Date((simulationState.blockTimestamp.getUTCSeconds() + Number(simulationState.simulatedBlocks.filter((_, index) => index <= blockDelta).map((x) => x.timeIncreaseDelta).reduce((a, b) => a + b, 0n))) * 1000), // estimate that the next block is after 12 secs
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
	const blockDelta = blockTag === 'latest' || blockTag === 'pending' ? simulationState.simulatedBlocks.length - 1 : Math.max(Number(blockTag - simulationState.blockNumber), 0) - 1
	if (blockDelta < 0) return await ethereumClientService.getBlock(requestAbortController, blockTag, fullObjects)
	const block = await getSimulatedMockBlock(ethereumClientService, requestAbortController, simulationState, blockDelta)
	if (fullObjects) return block
	return { ...block, transactions: block.transactions.map((transaction) => transaction.hash) }
}

const getLogsOfSimulatedBlock = (simulationState: SimulationState, blockDelta: number, logFilter: EthGetLogsRequest): EthGetLogsResponse => {
	const block = simulationState?.simulatedBlocks[blockDelta]
	if (block === undefined) return []
	const events: EthGetLogsResponse = block.simulatedTransactions.reduce((acc, sim, transactionIndex) => {
		if (sim.ethSimulateV1CallResult.status === 'failure') return acc
		return [
			...acc,
			...sim.ethSimulateV1CallResult.logs.map((event, logIndex) => ({
				removed: false,
				logIndex: BigInt(acc.length + logIndex),
				transactionIndex: BigInt(transactionIndex),
				transactionHash: sim.preSimulationTransaction.signedTransaction.hash,
				blockHash: getHashOfSimulatedBlock(simulationState, blockDelta),
				blockNumber: simulationState.blockNumber + BigInt(blockDelta) + 1n,
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

export const getSimulatedLogs = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState | undefined, logFilter: EthGetLogsRequest): Promise<EthGetLogsResponse> => {
	if (simulationState === undefined) return await ethereumClientService.getLogs(logFilter, requestAbortController)
	const toBlock = 'toBlock' in logFilter && logFilter.toBlock !== undefined ? logFilter.toBlock : 'latest'
	const fromBlock = 'fromBlock' in logFilter && logFilter.fromBlock !== undefined ? logFilter.fromBlock : 'latest'
	if (toBlock === 'pending' || fromBlock === 'pending') return await ethereumClientService.getLogs(logFilter, requestAbortController)
	if ((fromBlock === 'latest' && toBlock !== 'latest') || (fromBlock !== 'latest' && toBlock !== 'latest' && fromBlock > toBlock )) throw new Error(`From block '${ fromBlock }' is later than to block '${ toBlock }' `)

	if (toBlock === 'finalized' || fromBlock === 'finalized') return await ethereumClientService.getLogs(logFilter, requestAbortController)
	if ('blockHash' in logFilter) {
		const blockDelta = simulationState.simulatedBlocks.findIndex((_block, index) => logFilter.blockHash === getHashOfSimulatedBlock(simulationState, index))
		if (blockDelta > 0) return getLogsOfSimulatedBlock(simulationState, blockDelta, logFilter)
	}
	if (simulationState && (toBlock === 'latest' || toBlock > simulationState.blockNumber)) {
		const logParamsToNode = fromBlock !== 'latest' && fromBlock >= simulationState.blockNumber ? { ...logFilter, fromBlock: simulationState.blockNumber - BigInt(simulationState.simulatedBlocks.length), toBlock: simulationState.blockNumber - BigInt(simulationState.simulatedBlocks.length) } : { ...logFilter, toBlock: simulationState.blockNumber - BigInt(simulationState.simulatedBlocks.length) }

		const fromBlockNum = fromBlock === 'latest' ? simulationState.blockNumber + BigInt(simulationState.simulatedBlocks.length) : fromBlock
		const toBlockNum = toBlock === 'latest' ? simulationState.blockNumber + BigInt(simulationState.simulatedBlocks.length) : toBlock
		const blockDeltas = simulationState.simulatedBlocks.map((_block, blockDelta) => {
			const thisBlockNum = simulationState.blockNumber + BigInt(blockDelta) + 1n
			if (thisBlockNum >= fromBlockNum && thisBlockNum <= toBlockNum) return blockDelta
			return undefined
		}).filter((blockDelta): blockDelta is number => blockDelta !== undefined)
		return [...await ethereumClientService.getLogs(logParamsToNode, requestAbortController), ...blockDeltas.flatMap((blockDelta) => getLogsOfSimulatedBlock(simulationState, blockDelta, logFilter))]
	}
	return await ethereumClientService.getLogs(logFilter, requestAbortController)
}
export const getSimulatedBlockNumber = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState | undefined) => {
	if (simulationState !== undefined) return (await ethereumClientService.getBlockNumber(requestAbortController)) + 1n
	return await ethereumClientService.getBlockNumber(requestAbortController)
}

export const getSimulatedTransactionByHash = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState | undefined, hash: bigint): Promise<EthereumSignedTransactionWithBlockData | null> => {
	// try to see if the transaction is in our queue
	if (simulationState === undefined) return await ethereumClientService.getTransactionByHash(hash, requestAbortController)
	for (const [blockDelta, block] of simulationState.simulatedBlocks.entries()) {
		for (const [transactionIndex, simulatedTransaction] of block.simulatedTransactions.entries()) {
			if (hash === simulatedTransaction.preSimulationTransaction.signedTransaction.hash) {
				const v = 'v' in simulatedTransaction.preSimulationTransaction.signedTransaction ? simulatedTransaction.preSimulationTransaction.signedTransaction.v : (simulatedTransaction.preSimulationTransaction.signedTransaction.yParity === 'even' ? 0n : 1n)
				const additionalParams = {
					blockHash: getHashOfSimulatedBlock(simulationState, blockDelta),
					blockNumber: simulationState.blockNumber + BigInt(blockDelta) + 1n,
					transactionIndex: BigInt(transactionIndex),
					data: simulatedTransaction.preSimulationTransaction.signedTransaction.input,
					v : v,
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
		const simulatedTransactions = await simulateTransactionsOnTopOfSimulationState(ethereumClientService, requestAbortController, simulationState, [{ ...transaction, gas: params.gasLimit === undefined ? currentBlock.gasLimit : params.gasLimit }])
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

const simulateTransactionsOnTopOfSimulationInput = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationStateInput: SimulationStateInput, transactions: EthereumUnsignedTransaction[], extraOverrides: StateOverrides = {}) => {
	if (transactions.length === 0) return []
	const signedTransactions = transactions.map((transaction) => mockSignTransaction(transaction))
	const simulationStateInputWithNewTransactions = { blocks: [...simulationStateInput.blocks, {
		transactions: [...signedTransactions.map((signedTransaction) => ({ signedTransaction: signedTransaction }) )],
		stateOverrides: extraOverrides,
		signedMessages: [],
		timeIncreaseDelta: 1n, //TODO, change to 0 when geth supports same timestamp simulaions
	}] }
	const ethSimulateV1CallResult = await ethereumClientService.simulate(simulationStateInputWithNewTransactions, await ethereumClientService.getBlockNumber(requestAbortController), requestAbortController)
	return ethSimulateV1CallResult.at(-1)?.calls || []
}

const simulateTransactionsOnTopOfSimulationState = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState | undefined, transactions: EthereumUnsignedTransaction[], extraOverrides: StateOverrides = {}) => {
	const simulationInput = convertSimulationStateToSimulationInput(simulationState)
	return simulateTransactionsOnTopOfSimulationInput(ethereumClientService, requestAbortController, simulationInput, transactions, extraOverrides)
}
// use time as block hash as that makes it so that updated simulations with different states are different, but requires no additional calculation
const getHashOfSimulatedBlock = (simulationState: SimulationState, blockDelta: number) => BigInt(simulationState.simulationConductedTimestamp.getTime() * 100000 + blockDelta)

export type SignatureWithFakeSignerAddress = { originalRequestParameters: SignMessageParams, fakeSignedFor: EthereumAddress }
export type MessageHashAndSignature = { signature: string, messageHash: string }

export const isValidMessage = (params: SignMessageParams, signingAddress: EthereumAddress) => {
	try {
		simulatePersonalSign(params, signingAddress)
		return true
	} catch(e) {
		console.error(e)
		return false
	}
}

export const simulatePersonalSign = (params: SignMessageParams, signingAddress: EthereumAddress) => {
	const wallet = new ethers.Wallet(bytes32String(signingAddress === ADDRESS_FOR_PRIVATE_KEY_ONE ? MOCK_PUBLIC_PRIVATE_KEY : MOCK_SIMULATION_PRIVATE_KEY))
	switch (params.method) {
		case 'eth_signTypedData': throw new Error('No support for eth_signTypedData')
		case 'eth_signTypedData_v1':
		case 'eth_signTypedData_v2':
		case 'eth_signTypedData_v3':
		case 'eth_signTypedData_v4': {
			const typesWithoutDomain = Object.assign({}, params.params[1].types)
			delete typesWithoutDomain.EIP712Domain
			const castedTypesWithoutDomain = typesWithoutDomain as { [x: string]: { name: string, type: string }[] }
			const messageHash = ethers.TypedDataEncoder.hash(params.params[1].domain, castedTypesWithoutDomain, params.params[1].message)
			const signature = wallet.signMessageSync(messageHash)
			return { signature, messageHash }
		}
		case 'personal_sign': return {
			signature: wallet.signMessageSync(stringToUint8Array(params.params[0])),
			messageHash: hashMessage(params.params[0])
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

const getSimulatedTokenBalances = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationStateInput: SimulationStateInput, balanceQueries: BalanceQuery[]): Promise<TokenBalancesAfter> => {
	if (balanceQueries.length === 0) return []
	function removeDuplicates(queries: BalanceQuery[]): BalanceQuery[] {
		const unique: Map<string, BalanceQuery> = new Map()
		for (const query of queries) {
			const key = `${ query.type }-${ query.token }-${ query.owner }${ query.type === 'ERC1155' ? `${ query.tokenId }` : ''}`
			if (unique.has(key)) continue
			unique.set(key, query)
		}
		return Array.from(unique.values())
	}
	const deduplicatedBalanceQueries = removeDuplicates(balanceQueries)
	const IMulticall3 = new Interface(Multicall3ABI)
	const erc20TokenInterface = new ethers.Interface(['function balanceOf(address account) view returns (uint256)'])
	const erc1155TokenInterface = new ethers.Interface(['function balanceOf(address _owner, uint256 _id) external view returns(uint256)'])
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

export const parseEventIfPossible = (ethersInterface: ethers.Interface, log: EthereumEvent) => {
	try {
		return ethersInterface.parseLog({ topics: log.topics.map((x) => bytes32String(x)), data: dataStringWith0xStart(log.data) })
	} catch (error) {
		return null
	}
}

export const parseTransactionInputIfPossible = (ethersInterface: ethers.Interface, data: EthereumData, value: EthereumQuantity) => {
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
	const erc20 = new ethers.Interface(erc20ABI)
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
	const erc20 = new ethers.Interface(erc1155ABI)
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
					if (parsedLog.type !== "ERC1155") continue
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
	const slicedBlock = simulationStateInput.blocks[blockIndex]
	if (slicedBlock === undefined) return simulationStateInput
	return {
		blocks: [
			...simulationStateInput.blocks.slice(0, blockIndex),
			{
				...slicedBlock,
				transactions: slicedBlock.transactions.slice(0, transactionIndex)
			}
		]
	}
}

export const sliceSimulationState = (simulationState: SimulationState, blockIndex: number, transactionIndex: number) => {
	const slicedBlock = simulationState.simulatedBlocks[blockIndex]
	if (slicedBlock === undefined) return simulationState
	return {
		...simulationState,
		simulatedBlocks: [
			...simulationState.simulatedBlocks.slice(0, blockIndex),
			{
				...slicedBlock,
				transactions: slicedBlock.simulatedTransactions.slice(0, transactionIndex)
			}
		]
	}
}

export const getTokenBalancesAfter = async (
	ethereumClientService: EthereumClientService,
	requestAbortController: AbortController | undefined,
	ethSimulateV1Result: EthSimulateV1Result,
	simulationStateInput: SimulationStateInput,
): Promise<TokenBalancesBlocksAfter> => {
	const tokenBalancesAfterArray = await Promise.all(Array.from(simulationStateInput.blocks.entries()).map(([inputBlockIndex, inputBlock]) => {
		const simulateResultBlock = ethSimulateV1Result[inputBlockIndex]
		if (simulateResultBlock === undefined) throw new Error('singleResult block was undefined')
		return Promise.all(Array.from(inputBlock.transactions.entries()).map(([inputTransactionIndex, inputTransaction]) => {
			const simulateResultTransaction = simulateResultBlock.calls[inputTransactionIndex]
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
		}))
	}))

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
				const effectivePriorityAndGasWeights = newestBlock.transactions.map((tx) => tx.type === '1559' || tx.type === '4844' ?
					{ dataPoint: min(tx.maxPriorityFeePerGas, tx.maxFeePerGas - (newestBlockBaseFeePerGas ?? 0n)), weight: tx.gas }
					: { dataPoint: tx.gasPrice - (newestBlockBaseFeePerGas ?? 0n), weight: tx.gas })

				// we can have negative values here, as The Interceptor creates maxFeePerGas = 0 transactions that are intended to have zero base fee, which is not possible in reality
				const zeroOutNegativeValues = effectivePriorityAndGasWeights.map((point) => modifyObject(point, { dataPoint: max(0n, point.dataPoint) }))
				return calculateWeightedPercentile(zeroOutNegativeValues, BigInt(percentile))
			})]
		}
	}
}
