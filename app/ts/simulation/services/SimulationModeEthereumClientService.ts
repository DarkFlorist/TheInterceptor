import { EthereumClientService } from './EthereumClientService.js'
import { EthereumUnsignedTransaction, EthereumSignedTransactionWithBlockData, EthereumBlockTag, EthereumAddress, EthereumBlockHeader, EthereumBlockHeaderWithTransactionHashes, EthereumSignedTransaction, EthereumData, EthereumQuantity, EthereumBytes32 } from '../../types/wire-types.js'
import { addressString, bytes32String, calculateWeightedPercentile, dataStringWith0xStart, max, min, stringToUint8Array } from '../../utils/bigint.js'
import { CANNOT_SIMULATE_OFF_LEGACY_BLOCK, ERROR_INTERCEPTOR_GAS_ESTIMATION_FAILED, ETHEREUM_LOGS_LOGGER_ADDRESS, ETHEREUM_EIP1559_BASEFEECHANGEDENOMINATOR, ETHEREUM_EIP1559_ELASTICITY_MULTIPLIER, MOCK_ADDRESS, MULTICALL3, Multicall3ABI, DEFAULT_CALL_ADDRESS, GAS_PER_BLOB } from '../../utils/constants.js'
import { Interface, TypedDataEncoder, ethers, hashMessage, keccak256, } from 'ethers'
import { WebsiteCreatedEthereumUnsignedTransaction, SimulatedTransaction, SimulationState, TokenBalancesAfter, EstimateGasError, SignedMessageTransaction, WebsiteCreatedEthereumUnsignedTransactionOrFailed } from '../../types/visualizer-types.js'
import { EthereumUnsignedTransactionToUnsignedTransaction, IUnsignedTransaction1559, serializeSignedTransactionToBytes } from '../../utils/ethereum.js'
import { EthGetLogsResponse, EthGetLogsRequest, EthTransactionReceiptResponse, DappRequestTransaction, EthGetFeeHistoryResponse, FeeHistory } from '../../types/JsonRpc-types.js'
import { handleERC1155TransferBatch, handleERC1155TransferSingle } from '../logHandlers.js'
import { assertNever } from '../../utils/typescript.js'
import { SignMessageParams } from '../../types/jsonRpc-signing-types.js'
import { EthSimulateV1CallResults, EthereumEvent, StateOverrides } from '../../types/ethSimulate-types.js'
import { getCodeByteCode } from '../../utils/ethereumByteCodes.js'

const MOCK_PUBLIC_PRIVATE_KEY = 0x1n // key used to sign mock transactions
const MOCK_SIMULATION_PRIVATE_KEY = 0x2n // key used to sign simulated transatons
const ADDRESS_FOR_PRIVATE_KEY_ONE = 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdfn
const GET_CODE_CONTRACT = 0x1ce438391307f908756fefe0fe220c0f0d51508an

export const getWebsiteCreatedEthereumUnsignedTransactions = (simulatedTransactions: readonly SimulatedTransaction[]) => {
	return simulatedTransactions.map((simulatedTransaction) => ({
		transaction: simulatedTransaction.signedTransaction,
		website: simulatedTransaction.website,
		created: simulatedTransaction.created,
		originalRequestParameters: simulatedTransaction.originalRequestParameters,
		transactionIdentifier: simulatedTransaction.transactionIdentifier,
		success: true as const,
	}))
}

function convertSimulatedTransactionToWebsiteCreatedEthereumUnsignedTransaction(tx: SimulatedTransaction) {
	return {
		transaction: tx.signedTransaction,
		website: tx.website,
		created: tx.created,
		originalRequestParameters: tx.originalRequestParameters,
		transactionIdentifier: tx.transactionIdentifier,
		success: true as const,
	}
}

export const copySimulationState = (simulationState: SimulationState): SimulationState => {
	return {
		prependTransactionsQueue: [...simulationState.prependTransactionsQueue],
		simulatedTransactions: [...simulationState.simulatedTransactions],
		blockNumber: simulationState.blockNumber,
		blockTimestamp: simulationState.blockTimestamp,
		rpcNetwork: simulationState.rpcNetwork,
		simulationConductedTimestamp: simulationState.simulationConductedTimestamp,
		signedMessages: simulationState.signedMessages,
	}
}

const getNonPrependedSimulatedTransactionsFromState = (simulationState: SimulationState) => {
	return getNonPrependedSimulatedTransactions(simulationState.prependTransactionsQueue, simulationState.simulatedTransactions)
}

export const getNonPrependedSimulatedTransactions = (prependTransactionsQueue: readonly WebsiteCreatedEthereumUnsignedTransaction[], simulatedTransactions: readonly SimulatedTransaction[]) => {
	return simulatedTransactions.slice(prependTransactionsQueue.length, simulatedTransactions.length)
}

export const getSimulatedStack = (simulationState: SimulationState) => {
	return simulationState.simulatedTransactions.map((transaction) => ({
		...transaction.signedTransaction,
		...transaction.ethSimulateV1CallResult,
		realizedGasPrice: transaction.realizedGasPrice,
		gasLimit: transaction.signedTransaction.gas,
	}))
}

export const transactionQueueTotalGasLimit = (simulationState: SimulationState) => {
	return simulationState.simulatedTransactions.reduce((a, b) => a + b.signedTransaction.gas, 0n)
}

export const simulationGasLeft = (simulationState: SimulationState | undefined, blockHeader: EthereumBlockHeader) => {
	if (simulationState === undefined) return blockHeader.gasLimit * 1023n / 1024n
	return max(blockHeader.gasLimit * 1023n / 1024n - transactionQueueTotalGasLimit(simulationState), 0n)
}

export function getInputFieldFromDataOrInput(request: { input?: Uint8Array} | { data?: Uint8Array } | {}) {
	if ('data' in request && request.data !== undefined) return request.data
	if ('input' in request && request.input !== undefined) return request.input
	return new Uint8Array()
}

export const simulateEstimateGas = async (ethereumClientService: EthereumClientService, simulationState: SimulationState | undefined, data: DappRequestTransaction): Promise<EstimateGasError | { gas: bigint }> => {
	// commented out because of nethermind not estimating gas correctly https://github.com/NethermindEth/nethermind/issues/5946
	//if (simulationState === undefined) return { gas: await ethereumClientService.estimateGas(data) }
	const sendAddress = data.from !== undefined ? data.from : MOCK_ADDRESS
	const transactionCount = getSimulatedTransactionCount(ethereumClientService, simulationState, sendAddress)
	const block = await ethereumClientService.getBlock()
	const maxGas = simulationGasLeft(simulationState, block)

	const getGasPriceFields = (data: DappRequestTransaction) => {
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
	const multiCall = await simulatedMulticall(ethereumClientService, simulationState, [tmp], block.number + 1n)
	const lastResult = multiCall.calls[multiCall.calls.length - 1]
	if (lastResult === undefined) {
		return {
			error: {
				code: ERROR_INTERCEPTOR_GAS_ESTIMATION_FAILED,
				message: `ETH Simulate Failed to estimate gas`,
				data: '',
			},
		} as const 
	}
	if (lastResult.status === 'failure') {
		console.log(lastResult)
		return {
			error: {
				code: ERROR_INTERCEPTOR_GAS_ESTIMATION_FAILED,
				message: `Failed to estimate gas: "${ lastResult.error.message }"`,
				data: dataStringWith0xStart(lastResult.returnData),
			},
		} as const 
	}
	const gasSpent = lastResult.gasUsed * 125n * 64n / (100n * 63n) // add 25% * 64 / 63 extra  to account for gas savings <https://eips.ethereum.org/EIPS/eip-3529>
	return { gas: gasSpent < maxGas ? gasSpent : maxGas }
}

// calculates gas price for receipts
export const calculateGasPrice = (transaction: EthereumUnsignedTransaction, gasUsed: bigint, gasLimit: bigint, baseFeePerGas: bigint) => {
	if ('gasPrice' in transaction) return transaction.gasPrice
	const baseFee = getNextBaseFee(gasUsed, gasLimit, baseFeePerGas)
	return min(baseFee + transaction.maxPriorityFeePerGas, transaction.maxFeePerGas)
}

export const mockSignTransaction = (transaction: EthereumUnsignedTransaction) : EthereumSignedTransaction => {
	const unsignedTransaction = EthereumUnsignedTransactionToUnsignedTransaction(transaction)
	if (unsignedTransaction.type === 'legacy') {
		const signatureParams = { r: 0n, s: 0n, v: 0n }
		const hash = EthereumQuantity.parse(keccak256(serializeSignedTransactionToBytes({ ...unsignedTransaction, ...signatureParams })))
		if (transaction.type !== 'legacy') throw new Error('types do not match')
		return { ...transaction, ...signatureParams, hash }
	} else {
		const signatureParams = { r: 0n, s: 0n, yParity: 'even' as const }
		const hash = EthereumQuantity.parse(keccak256(serializeSignedTransactionToBytes({ ...unsignedTransaction, ...signatureParams })))
		if (transaction.type === 'legacy') throw new Error('types do not match')
		return { ...transaction, ...signatureParams, hash }
	}
}

export const appendTransaction = async (ethereumClientService: EthereumClientService, simulationState: SimulationState | undefined, transaction: WebsiteCreatedEthereumUnsignedTransactionOrFailed): Promise<SimulationState> => {
	const getSignedTransactions = () => {
		if (!transaction.success) return simulationState === undefined ? [] : simulationState.simulatedTransactions.map((x) => x.signedTransaction)
		const signed = mockSignTransaction(transaction.transaction)
		return simulationState === undefined ? [signed] : simulationState.simulatedTransactions.map((x) => x.signedTransaction).concat([signed])
	}
	
	const parentBlock = await ethereumClientService.getBlock()
	const parentBaseFeePerGas = parentBlock.baseFeePerGas
	if (parentBaseFeePerGas === undefined) throw new Error(CANNOT_SIMULATE_OFF_LEGACY_BLOCK)
	const signedMessages = getSignedMessagesWithFakeSigner(simulationState)
	const signedTxs = getSignedTransactions()
	const ethSimulateV1CallResult = await ethereumClientService.simulateTransactionsAndSignatures(signedTxs, signedMessages, parentBlock.number)
	const transactionWebsiteData = { website: transaction.website, created: transaction.created, originalRequestParameters: transaction.originalRequestParameters, transactionIdentifier: transaction.transactionIdentifier }
	const transactionData = simulationState === undefined ? [transactionWebsiteData] : simulationState.simulatedTransactions.map((x) => ({ website: x.website, created: x.created, originalRequestParameters: x.originalRequestParameters, transactionIdentifier: x.transactionIdentifier })).concat(transactionWebsiteData)
	if (ethSimulateV1CallResult.calls.length !== signedTxs.length) throw 'multicall length does not match in appendTransaction'

	const tokenBalancesAfter = await getTokenBalancesAfter(
		ethereumClientService,
		signedTxs,
		signedMessages,
		ethSimulateV1CallResult.calls,
		parentBlock.number
	)
	if (ethSimulateV1CallResult.calls.length !== tokenBalancesAfter.length) throw 'tokenBalancesAfter length does not match'

	return {
		prependTransactionsQueue: simulationState === undefined ? [] : simulationState.prependTransactionsQueue,
		simulatedTransactions: ethSimulateV1CallResult.calls.map((singleResult, index) => {
			const signedTx = signedTxs[index]
			const tokenBalancesAfterForIndex = tokenBalancesAfter[index]
			const transactionDataForIndex = transactionData[index]
			if (signedTx === undefined || tokenBalancesAfterForIndex === undefined || transactionDataForIndex === undefined) throw 'invalid transaction index'
			return {
				type: 'transaction',
				ethSimulateV1CallResult: singleResult,
				signedTransaction: signedTx,
				realizedGasPrice: calculateGasPrice(signedTx, parentBlock.gasUsed, parentBlock.gasLimit, parentBaseFeePerGas),
				tokenBalancesAfter: tokenBalancesAfterForIndex,
				...transactionDataForIndex,
			}
		} ),
		blockNumber: parentBlock.number,
		blockTimestamp: parentBlock.timestamp,
		rpcNetwork: ethereumClientService.getRpcEntry(),
		simulationConductedTimestamp: new Date(),
		signedMessages: simulationState === undefined ? [] : simulationState.signedMessages,
	}
}

export const setSimulationTransactionsAndSignedMessages = async (ethereumClientService: EthereumClientService, simulationState: SimulationState, unsignedTxts: readonly WebsiteCreatedEthereumUnsignedTransaction[], signedMessages: readonly SignedMessageTransaction[]): Promise<SimulationState>  => {
	const parentBlock = await ethereumClientService.getBlock()
	if (unsignedTxts.length === 0 && simulationState.prependTransactionsQueue.length === 0 && unsignedTxts.length === 0 && signedMessages.length === 0) {
		return {
			prependTransactionsQueue: simulationState.prependTransactionsQueue,
			simulatedTransactions: [],
			blockNumber: parentBlock.number,
			blockTimestamp: parentBlock.timestamp,
			rpcNetwork: ethereumClientService.getRpcEntry(),
			simulationConductedTimestamp: new Date(),
			signedMessages: [],
		}
	}

	const newTransactionsToSimulate = simulationState.prependTransactionsQueue.concat(unsignedTxts)
	const signedTxs = newTransactionsToSimulate.map((tx) => mockSignTransaction(tx.transaction))
	const parentBaseFeePerGas = parentBlock.baseFeePerGas
	if (parentBaseFeePerGas === undefined) throw new Error(CANNOT_SIMULATE_OFF_LEGACY_BLOCK)
	const multicallResult = await ethereumClientService.simulateTransactionsAndSignatures(newTransactionsToSimulate.map((x) => x.transaction), signedMessages, parentBlock.number)
	if (multicallResult.calls.length !== signedTxs.length) throw new Error('Multicall length does not match in setSimulationTransactions')

	const tokenBalancesAfter: Promise<TokenBalancesAfter>[] = []
	for (let resultIndex = 0; resultIndex < multicallResult.calls.length; resultIndex++) {
		const singleResult = multicallResult.calls[resultIndex]
		if (singleResult === undefined) throw new Error('Multicall length does not match in setSimulationTransactions')
		tokenBalancesAfter.push(getSimulatedTokenBalances(
			ethereumClientService,
			signedTxs.slice(0, resultIndex + 1),
			signedMessages,
			getAddressesInteractedWithErc20s(singleResult.status === 'success' ? singleResult.logs : []),
			parentBlock.number
		))
	}
	return {
		prependTransactionsQueue: simulationState.prependTransactionsQueue,
		simulatedTransactions: await Promise.all(multicallResult.calls.map(async(singleResult, index) => {
			const newTransaction = newTransactionsToSimulate[index]
			if (newTransaction === undefined) throw new Error('undefined transaction to simulate')
			const after = await tokenBalancesAfter[index]
			if (after === undefined) throw new Error('undefined transaction to simulate')
			const signed = signedTxs[index]
			if (signed === undefined) throw new Error('signed transaction was undefined')
			return {
				ethSimulateV1CallResult: singleResult,
				unsignedTransaction: newTransaction,
				signedTransaction: signed,
				realizedGasPrice: calculateGasPrice(newTransaction.transaction, parentBlock.gasUsed, parentBlock.gasLimit, parentBaseFeePerGas),
				tokenBalancesAfter: after,
				website: newTransaction.website,
				created: newTransaction.created,
				originalRequestParameters: newTransaction.originalRequestParameters,
				transactionIdentifier: newTransaction.transactionIdentifier,
			}
		})),
		blockNumber: parentBlock.number,
		blockTimestamp: parentBlock.timestamp,
		rpcNetwork: ethereumClientService.getRpcEntry(),
		simulationConductedTimestamp: new Date(),
		signedMessages,
	}
}

export const getTransactionQueue = (simulationState: SimulationState | undefined) => {
	if (simulationState === undefined) return []
	return simulationState.simulatedTransactions.map((x) => x.signedTransaction)
}
export const getPrependTransactionsQueue = (simulationState: SimulationState) => simulationState.prependTransactionsQueue

export const setPrependTransactionsQueue = async (ethereumClientService: EthereumClientService, prepend: readonly WebsiteCreatedEthereumUnsignedTransaction[]): Promise<SimulationState>  => {
	const block = await ethereumClientService.getBlock()
	const newState = {
		prependTransactionsQueue: prepend,
		simulatedTransactions: [],
		blockNumber: block.number,
		blockTimestamp: block.timestamp,
		rpcNetwork: ethereumClientService.getRpcEntry(),
		simulationConductedTimestamp: new Date(),
		signedMessages: [],
	}
	return await setSimulationTransactionsAndSignedMessages(ethereumClientService, newState, [], [])
}

export const removeTransactionOrSignedMessage = async (ethereumClientService: EthereumClientService, simulationState: SimulationState, transactionHash: bigint): Promise<SimulationState>  => {
	const filtered = getNonPrependedSimulatedTransactionsFromState(simulationState).filter((transaction) => transaction.signedTransaction.hash !== transactionHash)
	return await setSimulationTransactionsAndSignedMessages(ethereumClientService, simulationState, filtered.map((x) => convertSimulatedTransactionToWebsiteCreatedEthereumUnsignedTransaction(x)), simulationState.signedMessages)
}

export const removeSignedMessageFromSimulation = async (ethereumClientService: EthereumClientService, simulationState: SimulationState, messageIdentifier: EthereumQuantity): Promise<SimulationState>  => {
	const numberOfMessages = simulationState.signedMessages.length
	const newSignedMessages = simulationState.signedMessages.filter((message) => message.messageIdentifier !== messageIdentifier)
	if (numberOfMessages === newSignedMessages.length) return simulationState
	const nonPrepended = getNonPrependedSimulatedTransactionsFromState(simulationState).map((x) => convertSimulatedTransactionToWebsiteCreatedEthereumUnsignedTransaction(x))
	return await setSimulationTransactionsAndSignedMessages(ethereumClientService, simulationState, nonPrepended, newSignedMessages)
}

export const removeTransactionAndUpdateTransactionNonces = async (ethereumClientService: EthereumClientService, simulationState: SimulationState, transactionIdentifier: bigint): Promise<SimulationState>  => {
	const transactionToBeRemoved = simulationState.simulatedTransactions.find((transaction) => transaction.transactionIdentifier === transactionIdentifier)
	if (transactionToBeRemoved === undefined) return simulationState

	let newTransactions: WebsiteCreatedEthereumUnsignedTransaction[] = []
	let transactionWasFound = false

	for (const transaction of getNonPrependedSimulatedTransactionsFromState(simulationState)) {
		if (transactionIdentifier === transaction.transactionIdentifier) {
			transactionWasFound = true
			continue
		}
		const shouldUpdateNonce = transactionWasFound && transaction.signedTransaction.from === transactionToBeRemoved.signedTransaction.from
		const newTransaction = { ...transaction.signedTransaction, ...(shouldUpdateNonce ? { nonce: transaction.signedTransaction.nonce - 1n } : {}) }
		newTransactions.push({
			transaction: newTransaction,
			website: transaction.website,
			created: transaction.created,
			originalRequestParameters: transaction.originalRequestParameters,
			success: true as const,
			transactionIdentifier: transaction.transactionIdentifier,
		})
	}
	return await setSimulationTransactionsAndSignedMessages(ethereumClientService, simulationState, newTransactions, simulationState.signedMessages)
}

export const getNonceFixedSimulatedTransactions = async(ethereumClientService: EthereumClientService, simulatedTransactions: readonly SimulatedTransaction[]) => {
	const isFixableNonceError = (transaction: SimulatedTransaction) => {
		return transaction.ethSimulateV1CallResult.status === 'failure'
		&& transaction.ethSimulateV1CallResult.error.message === 'wrong transaction nonce' //TODO, change to error code
		&& transaction.originalRequestParameters.method === 'eth_sendTransaction'
	}
	if (simulatedTransactions.find((transaction) => isFixableNonceError(transaction)) === undefined) return 'NoNonceErrors' as const
	const nonceFixedTransactions: SimulatedTransaction[] = []
	const knownPreviousNonce = new Map<string, bigint>()
	for (const transaction of simulatedTransactions) {
		const signedTransaction = transaction.signedTransaction
		const fromString = addressString(signedTransaction.from)
		if (isFixableNonceError(transaction)) {
			const previousNonce = knownPreviousNonce.get(fromString)
			if (previousNonce !== undefined) {
				nonceFixedTransactions.push({ ...transaction, signedTransaction: { ...signedTransaction, nonce: previousNonce + 1n } })
			} else {
				nonceFixedTransactions.push({ ...transaction, signedTransaction: { ...signedTransaction, nonce: await ethereumClientService.getTransactionCount(signedTransaction.from) } })
			}
		} else {
			nonceFixedTransactions.push(transaction)
		}
		const lastTransaction = nonceFixedTransactions[nonceFixedTransactions.length - 1]
		if (lastTransaction === undefined) throw new Error('last transction did not exist')
		knownPreviousNonce.set(fromString, lastTransaction.signedTransaction.nonce)
	}
	return nonceFixedTransactions
}

const getBaseFeeAdjustedTransactions = (parentBlock: EthereumBlockHeader, unsignedTxts: readonly WebsiteCreatedEthereumUnsignedTransaction[]): readonly WebsiteCreatedEthereumUnsignedTransaction[] => {
	const parentBaseFeePerGas = parentBlock.baseFeePerGas
	if (parentBaseFeePerGas === undefined) return unsignedTxts
	return unsignedTxts.map((transaction) => {
		if (transaction.originalRequestParameters.method !== 'eth_sendTransaction') return transaction
		if (transaction.transaction.type !== '1559') return transaction
		return {
			...transaction,
			transaction: {
				...transaction.transaction,
				maxFeePerGas: parentBaseFeePerGas * 2n
			}
		}
	})
}

export const refreshSimulationState = async (ethereumClientService: EthereumClientService, simulationState: SimulationState): Promise<SimulationState>  => {
	if (ethereumClientService.getChainId() !== simulationState.rpcNetwork.chainId) return simulationState // don't refresh if we don't have the same chain to refresh from
	if (simulationState.blockNumber === await ethereumClientService.getBlockNumber()) {
		// if block number is the same, we don't need to compute anything as nothing has changed, but let's update timestamp to show the simulation was refreshed for this time
		return { ...simulationState, simulationConductedTimestamp: new Date() }
	}
	const parentBlockPromise = ethereumClientService.getBlock()
	const getNonceFixedTransactions = async () => {
		const nonPrepended = getNonPrependedSimulatedTransactionsFromState(simulationState)
		const nonceFixedTransactions = await getNonceFixedSimulatedTransactions(ethereumClientService, simulationState.simulatedTransactions)
		if (nonceFixedTransactions === 'NoNonceErrors') return nonPrepended
		const nonPrependedNonceFixedTransactions = getNonPrependedSimulatedTransactions(simulationState.prependTransactionsQueue, nonceFixedTransactions)
		return nonPrependedNonceFixedTransactions
	}
	const transactions = (await getNonceFixedTransactions()).map((x) => convertSimulatedTransactionToWebsiteCreatedEthereumUnsignedTransaction(x))
	const baseFeeAdjustedTransactions = getBaseFeeAdjustedTransactions(await parentBlockPromise, transactions)
	return await setSimulationTransactionsAndSignedMessages(ethereumClientService, simulationState, baseFeeAdjustedTransactions, simulationState.signedMessages)	
}

export const resetSimulationState = async (ethereumClientService: EthereumClientService, simulationState: SimulationState): Promise<SimulationState> => {
	return await setPrependTransactionsQueue(ethereumClientService, simulationState.prependTransactionsQueue)
}

export const getStorageAt = async (ethereumClientService: EthereumClientService, contract: bigint, slot: bigint) => {
	//todo, requires plugin work...
	return await ethereumClientService.getStorageAt(contract, slot)
}

const canQueryNodeDirectly = async (ethereumClientService: EthereumClientService, simulationState: SimulationState, blockTag: EthereumBlockTag = 'latest') => {
	if (simulationState === undefined
		|| simulationState.simulatedTransactions.length === 0
		|| (typeof blockTag === 'bigint' && blockTag <= await ethereumClientService.getBlockNumber())
	){
		return true
	}
	return false
}

export const getSimulatedTransactionCount = async (ethereumClientService: EthereumClientService, simulationState: SimulationState | undefined, address: bigint, blockTag: EthereumBlockTag = 'latest') => {
	const currentBlock = await ethereumClientService.getBlockNumber()
	const blockNumToUse = blockTag === 'latest' || blockTag === 'pending' ? currentBlock : min(blockTag, currentBlock)
	let addedTransactions = 0n
	if (simulationState !== undefined && (blockTag === 'latest' || blockTag === 'pending' || blockTag > currentBlock)) {
		// if we are on our simulated block, just count how many transactions we have sent in the simulation to increment transaction count
		for (const signed of simulationState.simulatedTransactions) {
			if (signed.signedTransaction.from === address) addedTransactions += 1n
		}
	}
	return (await ethereumClientService.getTransactionCount(address, blockNumToUse)) + addedTransactions
}

export const getSimulatedTransactionReceipt = async (ethereumClientService: EthereumClientService, simulationState: SimulationState | undefined, hash: bigint): Promise<EthTransactionReceiptResponse> => {
	let cumGas = 0n
	let currentLogIndex = 0
	if (simulationState === undefined) { return await ethereumClientService.getTransactionReceipt(hash) }
	for (const [index, simulatedTransaction] of simulationState.simulatedTransactions.entries()) {
		cumGas += simulatedTransaction.ethSimulateV1CallResult.gasUsed
		if(hash === simulatedTransaction.signedTransaction.hash) {
			const blockNum = await ethereumClientService.getBlockNumber()
			return {
				...simulatedTransaction.signedTransaction.type === '4844' ? {
					type: simulatedTransaction.signedTransaction.type,
					blobGasUsed: GAS_PER_BLOB * BigInt(simulatedTransaction.signedTransaction.blobVersionedHashes.length),
					blobGasPrice: simulatedTransaction.signedTransaction.maxFeePerBlobGas,
				} : {
					type: simulatedTransaction.signedTransaction.type,
				},
				blockHash: getHashOfSimulatedBlock(simulationState),
				blockNumber: blockNum,
				transactionHash: simulatedTransaction.signedTransaction.hash,
				transactionIndex: BigInt(index),
				contractAddress: null, // this is not correct if we actually deploy contract, where to get right value?
				cumulativeGasUsed: cumGas,
				gasUsed: simulatedTransaction.ethSimulateV1CallResult.gasUsed,
				effectiveGasPrice: 0x2n,
				from: simulatedTransaction.signedTransaction.from,
				to: simulatedTransaction.signedTransaction.to,
				logs: simulatedTransaction.ethSimulateV1CallResult.status === 'success'
					? simulatedTransaction.ethSimulateV1CallResult.logs.map((x, logIndex) => ({
						removed: false,
						blockHash: getHashOfSimulatedBlock(simulationState),
						address: x.address,
						logIndex: BigInt(currentLogIndex + logIndex),
						data: x.data,
						topics: x.topics,
						blockNumber: blockNum,
						transactionIndex: BigInt(index),
						transactionHash: simulatedTransaction.signedTransaction.hash
					}))
					: [],
				logsBloom: 0x0n, //TODO: what should this be?
				status: simulatedTransaction.ethSimulateV1CallResult.status
			}
		}
		currentLogIndex += simulatedTransaction.ethSimulateV1CallResult.status === 'success' ? simulatedTransaction.ethSimulateV1CallResult.logs.length : 0
	}
	return await ethereumClientService.getTransactionReceipt(hash)
}

export const getSimulatedBalance = async (ethereumClientService: EthereumClientService, simulationState: SimulationState | undefined, address: bigint, blockTag: EthereumBlockTag = 'latest'): Promise<bigint> => {
	if (simulationState === undefined || await canQueryNodeDirectly(ethereumClientService, simulationState, blockTag)) return await ethereumClientService.getBalance(address, blockTag)
	const ethBalances = new Map<bigint, bigint>()
	for (const transaction of simulationState.simulatedTransactions) {
		if (transaction.ethSimulateV1CallResult.status !== 'success') continue
		for (const b of transaction.tokenBalancesAfter) { // todo, account for gasses!
			if (b.balance === undefined || b.token !== ETHEREUM_LOGS_LOGGER_ADDRESS) continue
			ethBalances.set(b.owner, b.balance)
		}
	}
	const balance = ethBalances.get(address)
	if (balance !== undefined) return balance
	return await ethereumClientService.getBalance(address, blockTag)
}

export const getSimulatedCode = async (ethereumClientService: EthereumClientService, simulationState: SimulationState | undefined, address: bigint, blockTag: EthereumBlockTag = 'latest') => {
	if (simulationState === undefined || await canQueryNodeDirectly(ethereumClientService, simulationState, blockTag)) {
		return {
			statusCode: 'success',
			getCodeReturn: await ethereumClientService.getCode(address, blockTag)
		} as const
	}
	const block = await ethereumClientService.getBlock()

	const atInterface = new ethers.Interface(['function at(address) returns (bytes)'])
	const input = stringToUint8Array(atInterface.encodeFunctionData('at', [addressString(address)]))

	const getCodeTransaction = {
		type: '1559',
		from: MOCK_ADDRESS,
		chainId: ethereumClientService.getChainId(),
		nonce: await ethereumClientService.getTransactionCount(MOCK_ADDRESS),
		maxFeePerGas: 0n,
		maxPriorityFeePerGas: 0n,
		gas: simulationGasLeft(simulationState, block),
		to: GET_CODE_CONTRACT,
		value: 0n,
		input: input,
		accessList: []
	} as const
	const multiCall = await simulatedMulticall(ethereumClientService, simulationState, [getCodeTransaction], block.number + 1n, { [addressString(GET_CODE_CONTRACT)]: { code: getCodeByteCode() } })
	const lastResult = multiCall.calls[multiCall.calls.length - 1]
	if (lastResult === undefined) throw new Error('last result did not exist in multicall')
	if (lastResult.status === 'failure') return { statusCode: 'failure' } as const
	const parsed = atInterface.decodeFunctionResult('at', lastResult.returnData)
	return {
		statusCode: lastResult.status,
		getCodeReturn: EthereumData.parse(parsed.toString())
	} as const
}

// ported from: https://github.com/ethereum/go-ethereum/blob/509a64ffb9405942396276ae111d06f9bded9221/consensus/misc/eip1559/eip1559.go#L55
const getNextBaseFee = (parentGasUsed: bigint, parentGasLimit: bigint, parentBaseFeePerGas: bigint) => {
	const parentGasTarget = parentGasLimit / ETHEREUM_EIP1559_ELASTICITY_MULTIPLIER
	if (parentGasUsed === parentGasTarget) return parentBaseFeePerGas
	if (parentGasUsed > parentGasTarget) return parentBaseFeePerGas + max(1n, parentBaseFeePerGas * (parentGasUsed - parentGasTarget) / parentGasTarget / ETHEREUM_EIP1559_BASEFEECHANGEDENOMINATOR)
	return max(0n, parentBaseFeePerGas - parentBaseFeePerGas * (parentGasTarget - parentGasUsed) / parentGasTarget / ETHEREUM_EIP1559_BASEFEECHANGEDENOMINATOR)
}

async function getSimulatedMockBlock(ethereumClientService: EthereumClientService, simulationState: SimulationState) {
	// make a mock block based on the previous block
	const parentBlock = await ethereumClientService.getBlock()
	if (parentBlock.baseFeePerGas === undefined) throw new Error(CANNOT_SIMULATE_OFF_LEGACY_BLOCK)
	return {
		author: parentBlock.miner,
		difficulty: parentBlock.difficulty,
		extraData: parentBlock.extraData,
		gasLimit: parentBlock.gasLimit,
		gasUsed: transactionQueueTotalGasLimit(simulationState),
		hash: getHashOfSimulatedBlock(simulationState),
		logsBloom: parentBlock.logsBloom, // TODO: this is wrong
		miner: parentBlock.miner,
		mixHash: parentBlock.mixHash, // TODO: this is wrong
		nonce: parentBlock.nonce,
		number: parentBlock.number + 1n,
		parentHash: parentBlock.hash,
		receiptsRoot: parentBlock.receiptsRoot, // TODO: this is wrong
		sha3Uncles: parentBlock.sha3Uncles, // TODO: this is wrong
		stateRoot: parentBlock.stateRoot, // TODO: this is wrong
		timestamp: new Date(parentBlock.timestamp.getTime() + 12 * 1000), // estimate that the next block is after 12 secs
		size: parentBlock.size, // TODO: this is wrong
		totalDifficulty: parentBlock.totalDifficulty + parentBlock.difficulty, // The difficulty increases about the same amount as previously
		uncles: [],
		baseFeePerGas: getNextBaseFee(parentBlock.gasUsed, parentBlock.gasLimit, parentBlock.baseFeePerGas),
		transactionsRoot: parentBlock.transactionsRoot, // TODO: this is wrong
		transactions: simulationState.simulatedTransactions.map((simulatedTransaction) => simulatedTransaction.signedTransaction),
		withdrawals: [], // TODO: this is wrong
		withdrawalsRoot: 0n, // TODO: this is wrong
	} as const
}

export async function getSimulatedBlockByHash(ethereumClientService: EthereumClientService, simulationState: SimulationState | undefined, blockHash: EthereumBytes32, fullObjects: boolean): Promise<EthereumBlockHeader | EthereumBlockHeaderWithTransactionHashes> {
	if (simulationState !== undefined && getHashOfSimulatedBlock(simulationState) === blockHash) {
		const block = await getSimulatedMockBlock(ethereumClientService, simulationState)
		if (fullObjects) return block
		return { ...block, transactions: block.transactions.map((transaction) => transaction.hash) }
	}
	return await ethereumClientService.getBlockByHash(blockHash, fullObjects)
}

export async function getSimulatedBlock(ethereumClientService: EthereumClientService, simulationState: SimulationState | undefined, blockTag?: EthereumBlockTag, fullObjects?: true): Promise<EthereumBlockHeader>
export async function getSimulatedBlock(ethereumClientService: EthereumClientService, simulationState: SimulationState | undefined, blockTag: EthereumBlockTag, fullObjects: boolean): Promise<EthereumBlockHeader | EthereumBlockHeaderWithTransactionHashes>
export async function getSimulatedBlock(ethereumClientService: EthereumClientService, simulationState: SimulationState | undefined, blockTag: EthereumBlockTag, fullObjects: false): Promise<EthereumBlockHeaderWithTransactionHashes>
export async function getSimulatedBlock(ethereumClientService: EthereumClientService, simulationState: SimulationState | undefined, blockTag: EthereumBlockTag = 'latest', fullObjects: boolean = true): Promise<EthereumBlockHeader | EthereumBlockHeaderWithTransactionHashes>  {
	if (simulationState === undefined || await canQueryNodeDirectly(ethereumClientService, simulationState, blockTag)) {
		return await ethereumClientService.getBlock(blockTag, fullObjects)
	}
	const block = await getSimulatedMockBlock(ethereumClientService, simulationState)
	if (fullObjects) return block
	return { ...block, transactions: block.transactions.map((transaction) => transaction.hash) }
}

const getLogsOfSimulatedBlock = (simulationState: SimulationState, logFilter: EthGetLogsRequest): EthGetLogsResponse => {
	const events: EthGetLogsResponse = simulationState?.simulatedTransactions.reduce((acc, sim, transactionIndex) => {
		if (sim.ethSimulateV1CallResult.status === 'failure') return acc
		return [
			...acc,
			...sim.ethSimulateV1CallResult.logs.map((event, logIndex) => ({
				removed: false,
				logIndex: BigInt(acc.length + logIndex),
				transactionIndex: BigInt(transactionIndex),
				transactionHash: sim.signedTransaction.hash,
				blockHash: getHashOfSimulatedBlock(simulationState),
				blockNumber: simulationState.blockNumber,
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

export const getSimulatedLogs = async (ethereumClientService: EthereumClientService, simulationState: SimulationState | undefined, logFilter: EthGetLogsRequest): Promise<EthGetLogsResponse> => {
	if (simulationState === undefined) return await ethereumClientService.getLogs(logFilter)
	const toBlock = 'toBlock' in logFilter && logFilter.toBlock !== undefined ? logFilter.toBlock : 'latest'
	const fromBlock = 'fromBlock' in logFilter && logFilter.fromBlock !== undefined ? logFilter.fromBlock : 'latest'
	if (toBlock === 'pending' || fromBlock === 'pending') return await ethereumClientService.getLogs(logFilter)
	if ((fromBlock === 'latest' && toBlock !== 'latest') || (fromBlock !== 'latest' && toBlock !== 'latest' && fromBlock > toBlock )) throw new Error(`From block '${ fromBlock }' is later than to block '${ toBlock }' `)
	if ('blockHash' in logFilter && logFilter.blockHash === getHashOfSimulatedBlock(simulationState)) return getLogsOfSimulatedBlock(simulationState, logFilter)
	if (simulationState && (toBlock === 'latest' || toBlock >= simulationState.blockNumber)) {
		const logParamsToNode = fromBlock !== 'latest' && fromBlock >= simulationState.blockNumber ? { ...logFilter, fromBlock: simulationState.blockNumber - 1n, toBlock: simulationState.blockNumber - 1n } : { ...logFilter, toBlock: simulationState.blockNumber - 1n }
		return [...await ethereumClientService.getLogs(logParamsToNode), ...getLogsOfSimulatedBlock(simulationState, logFilter)]
	}
	return await ethereumClientService.getLogs(logFilter)
}

export const getSimulatedBlockNumber = async (ethereumClientService: EthereumClientService, simulationState: SimulationState | undefined) => {
	if (simulationState !== undefined) return (await ethereumClientService.getBlockNumber()) + 1n
	return await ethereumClientService.getBlockNumber()
}

export const getSimulatedTransactionByHash = async (ethereumClientService: EthereumClientService, simulationState: SimulationState | undefined, hash: bigint): Promise<EthereumSignedTransactionWithBlockData|undefined> => {
	// try to see if the transaction is in our queue
	if (simulationState === undefined) return await ethereumClientService.getTransactionByHash(hash)
	for (const [index, simulatedTransaction] of simulationState.simulatedTransactions.entries()) {
		if (hash === simulatedTransaction.signedTransaction.hash) {
			const v = 'v' in simulatedTransaction.signedTransaction ? simulatedTransaction.signedTransaction.v : (simulatedTransaction.signedTransaction.yParity === 'even' ? 0n : 1n)
			const additionalParams = {
				blockHash: getHashOfSimulatedBlock(simulationState),
				blockNumber: await ethereumClientService.getBlockNumber(),
				transactionIndex: BigInt(index),
				data: simulatedTransaction.signedTransaction.input,
				v : v,
			}
			if ('gasPrice' in simulatedTransaction.signedTransaction) {
				return {
					...simulatedTransaction.signedTransaction,
					...additionalParams,
				}
			}
			return {
				...simulatedTransaction.signedTransaction,
				...additionalParams,
				gasPrice: simulatedTransaction.realizedGasPrice,
			}
		}
	}

	// it was not in the queue, so we can just try to ask the chain for it
	return await ethereumClientService.getTransactionByHash(hash)
}

export const simulatedCall = async (ethereumClientService: EthereumClientService, simulationState: SimulationState | undefined, params: Pick<IUnsignedTransaction1559, 'to' | 'maxFeePerGas' | 'maxPriorityFeePerGas' | 'input' | 'value'> & Partial<Pick<IUnsignedTransaction1559, 'from' | 'gasLimit'>>, blockTag: EthereumBlockTag = 'latest') => {
	const currentBlock = await ethereumClientService.getBlockNumber()
	const blockNumToUse = blockTag === 'latest' || blockTag === 'pending' ? currentBlock : min(blockTag, currentBlock)
	const simulationStateToUse = blockNumToUse >= currentBlock ? simulationState : undefined
	const from = params.from ?? DEFAULT_CALL_ADDRESS
	const transaction = {
		...params,
		type: '1559',
		gas: params.gasLimit,
		from,
		nonce: await getSimulatedTransactionCount(ethereumClientService, simulationStateToUse, from, blockTag),
		chainId: ethereumClientService.getChainId(),
	} as const

	//todo, we can optimize this by leaving nonce out
	const multicallResult = await simulatedMulticall(ethereumClientService, simulationStateToUse, [{ ...transaction, gas: params.gasLimit === undefined ? simulationGasLeft(simulationState, await ethereumClientService.getBlock()) : params.gasLimit }], blockNumToUse)
	const callResult = multicallResult.calls[multicallResult.calls.length - 1]
	if (callResult === undefined) throw new Error('failed to eth simulate')
	if (callResult?.status === 'failure') return { error: callResult.error }
	return { result: callResult.returnData }
}

const getSignedMessagesWithFakeSigner = (simulationState: SimulationState | undefined) => {
	return simulationState === undefined ? [] : simulationState.signedMessages.map((x) => ({ fakeSignedFor: x.fakeSignedFor, originalRequestParameters: x.originalRequestParameters }))
}

export const simulatedMulticall = async (ethereumClientService: EthereumClientService, simulationState: SimulationState | undefined, transactions: EthereumUnsignedTransaction[], blockNumber: bigint, extraAccountOverrides: StateOverrides = {}) => {
	const mergedTxs: EthereumUnsignedTransaction[] = getTransactionQueue(simulationState)
	return await ethereumClientService.simulateTransactionsAndSignatures(mergedTxs.concat(transactions), getSignedMessagesWithFakeSigner(simulationState), blockNumber, extraAccountOverrides)
}

// use time as block hash as that makes it so that updated simulations with different states are different, but requires no additional calculation
export const getHashOfSimulatedBlock = (simulationState: SimulationState) => BigInt(simulationState.simulationConductedTimestamp.getTime())

export type SignatureWithFakeSignerAddress = { originalRequestParameters: SignMessageParams, fakeSignedFor: EthereumAddress }
export type MessageHashAndSignature = { signature: string, messageHash: string }

export const simulatePersonalSign = async (params: SignMessageParams, signingAddress: EthereumAddress) => {
	const wallet = new ethers.Wallet(bytes32String(signingAddress === ADDRESS_FOR_PRIVATE_KEY_ONE ? MOCK_PUBLIC_PRIVATE_KEY : MOCK_SIMULATION_PRIVATE_KEY))
	const signMessage = async () => {
		switch (params.method) {
			case 'eth_signTypedData': throw new Error('no support for eth_signTypedData')
			case 'eth_signTypedData_v1':
			case 'eth_signTypedData_v2':
			case 'eth_signTypedData_v3':
			case 'eth_signTypedData_v4': {
				const typesWithoutDomain = Object.assign({}, params.params[1].types)
				delete typesWithoutDomain['EIP712Domain']
				const castedTypesWithoutDomain = typesWithoutDomain as { [x: string]: { name: string, type: string }[] }
				return {
					signature: await wallet.signTypedData(params.params[1].domain, castedTypesWithoutDomain, params.params[1].message),
					messageHash: TypedDataEncoder.hash(params.params[1].domain, castedTypesWithoutDomain, params.params[1].message)
				}
			}
			case 'personal_sign': return {
				signature: await wallet.signMessage(stringToUint8Array(params.params[0])),
				messageHash: hashMessage(params.params[0])
			}
			default: assertNever(params)
		}
	}
	return await signMessage()
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

const getSimulatedTokenBalances = async (ethereumClientService: EthereumClientService, transactionQueue: EthereumUnsignedTransaction[], signedMessages: readonly SignatureWithFakeSignerAddress[], balanceQueries: BalanceQuery[], blockNumber: bigint): Promise<TokenBalancesAfter> => {
	if (balanceQueries.length === 0) return []
	const IMulticall3 = new Interface(Multicall3ABI)
	const erc20TokenInterface = new ethers.Interface(['function balanceOf(address account) view returns (uint256)'])
	const erc1155TokenInterface = new ethers.Interface(['function balanceOf(address _owner, uint256 _id) external view returns(uint256)'])
	const tokenAndEthBalancesInputData = stringToUint8Array(IMulticall3.encodeFunctionData('aggregate3', [balanceQueries.map((balanceQuery) => {
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
			input: stringToUint8Array(erc1155TokenInterface.encodeFunctionData('balanceOf', [addressString(balanceQuery.owner), balanceQuery.tokenId])),
		}
	})]))
	const callTransaction: EthereumUnsignedTransaction = {
		type: '1559' as const,
		from: MOCK_ADDRESS,
		to: MULTICALL3,
		value: 0n,
		input: tokenAndEthBalancesInputData,
		maxFeePerGas: 0n,
		maxPriorityFeePerGas: 0n,
		gas: 15_000_000n,
		nonce: 0n,
		chainId: ethereumClientService.getChainId(),
	} as const
	const multicallResults = await ethereumClientService.simulateTransactionsAndSignatures(transactionQueue.concat(callTransaction), signedMessages, blockNumber)
	const aggregate3CallResult = multicallResults.calls[multicallResults.calls.length - 1]
	if (aggregate3CallResult === undefined || aggregate3CallResult.status === 'failure') throw Error('Failed aggregate3')
	const multicallReturnData: { success: boolean, returnData: string }[] = IMulticall3.decodeFunctionResult('aggregate3', dataStringWith0xStart(aggregate3CallResult.returnData))[0]
	
	if (multicallReturnData.length !== balanceQueries.length) throw Error('Got wrong number of balances back')
	return multicallReturnData.map((singleCallResult, callIndex) => {
		const balanceQuery = balanceQueries[callIndex]
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
				handleERC1155TransferBatch(log).forEach((parsedLog) => {
					if (parsedLog.type !== 'ERC1155') return
					tokenOwners.push({ ...base, owner: parsedLog.from, tokenId: parsedLog.tokenId })
					tokenOwners.push({ ...base, owner: parsedLog.to, tokenId: parsedLog.tokenId })
				})
				break
			}
			default: throw new Error(`wrong name: ${ parsed.name }`)
		}
	}
	return tokenOwners
}

export const getTokenBalancesAfter = async (
	ethereumClientService: EthereumClientService,
	signedTxs: EthereumSignedTransaction[] = [],
	signedMessages: readonly SignatureWithFakeSignerAddress[] = [],
	ethSimulateV1CallResults: EthSimulateV1CallResults,
	blockNumber: bigint,
) => {
	const tokenBalancesAfter: Promise<TokenBalancesAfter>[] = []
	for (let resultIndex = 0; resultIndex < ethSimulateV1CallResults.length; resultIndex++) {
		const singleResult = ethSimulateV1CallResults[resultIndex]
		if (singleResult === undefined) throw new Error('singleResult was undefined')
		const events = singleResult.status === 'success' ? singleResult.logs : []
		const erc20sAddresses = getAddressesInteractedWithErc20s(events)
		const erc1155AddressIds = getAddressesAndTokensIdsInteractedWithErc1155s(events)
		const balancesPromises = getSimulatedTokenBalances(ethereumClientService, signedTxs.slice(0, resultIndex + 1), signedMessages, [...erc20sAddresses, ...erc1155AddressIds], blockNumber)
		tokenBalancesAfter.push(balancesPromises)
	}
	return await Promise.all(tokenBalancesAfter)
}

export const appendSignedMessage = async (ethereumClientService: EthereumClientService, simulationState: SimulationState | undefined, signedMessage: SignedMessageTransaction): Promise<SimulationState> => {
	if (simulationState === undefined) {
		const block = await ethereumClientService.getBlock()
		return {
			prependTransactionsQueue: [],
			simulatedTransactions: [],
			blockNumber: block.number,
			blockTimestamp: block.timestamp,
			rpcNetwork: ethereumClientService.getRpcEntry(),
			simulationConductedTimestamp: new Date(),
			signedMessages: [signedMessage],
		}
	}
	return { ...simulationState, signedMessages: simulationState.signedMessages.concat(signedMessage) }
}

// takes the most recent block that the application is querying and does the calculation based on that
export const getSimulatedFeeHistory = async (ethereumClientService: EthereumClientService, request: FeeHistory): Promise<EthGetFeeHistoryResponse> => {
	//const numberOfBlocks = Number(request.params[0]) // number of blocks, not used atm as we just return one block
	const blockTag = request.params[1]
	const rewardPercentiles = request.params[2]
	const currentRealBlockNumber = (await ethereumClientService.getBlock()).number
	const clampedBlockTag = typeof blockTag === 'bigint' && blockTag > currentRealBlockNumber ? currentRealBlockNumber : blockTag
	const newestBlock = await ethereumClientService.getBlock(clampedBlockTag, true)
	const newestBlockBaseFeePerGas = newestBlock.baseFeePerGas
	if (newestBlockBaseFeePerGas === undefined) throw new Error(`base fee per gas is missing for the block (it's too old)`)
	return {
		baseFeePerGas: [newestBlockBaseFeePerGas, getNextBaseFee(newestBlock.gasUsed, newestBlock.gasLimit, newestBlockBaseFeePerGas)],
		gasUsedRatio: [Number(newestBlock.gasUsed) / Number(newestBlock.gasLimit)],
		oldestBlock: newestBlock.number,
		...rewardPercentiles === undefined ? {} : {
			reward: [rewardPercentiles.map((percentile) => {
				// we are using transaction.gas as a weighting factor while this should be `gasUsed`. Getting `gasUsed` requires getting transaction receipts, which we don't want to be doing
				const effectivePriorityAndGasWeights = newestBlock.transactions.map((tx) => tx.type === '1559' || tx.type === '4844' ?
					{ dataPoint: min(tx.maxPriorityFeePerGas, tx.maxFeePerGas - (newestBlockBaseFeePerGas ?? 0n)), weight: tx.gas }
					: { dataPoint: tx.gasPrice - (newestBlockBaseFeePerGas ?? 0n), weight: tx.gas })

				// we can have negative values here, as The Interceptor creates maxFeePerGas = 0 transactions that are intended to have zero base fee, which is not possible in reality
				const zeroOutNegativeValues = effectivePriorityAndGasWeights.map((point) => ({ ...point, dataPoint: max(0n, point.dataPoint) }))
				return calculateWeightedPercentile(zeroOutNegativeValues, BigInt(percentile))
			})]
		}
	}
}
