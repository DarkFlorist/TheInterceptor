import { EthereumClientService } from './EthereumClientService.js'
import { EthereumUnsignedTransaction, EthereumSignedTransactionWithBlockData, EthereumBlockTag, EthereumAddress, EthereumBlockHeader, EthereumBlockHeaderWithTransactionHashes, EthereumSignedTransaction, EthereumData, EthereumQuantity } from '../../utils/wire-types.js'
import { addressString, bytes32String, bytesToUnsigned, dataStringWith0xStart, max, min, stringToUint8Array } from '../../utils/bigint.js'
import { CANNOT_SIMULATE_OFF_LEGACY_BLOCK, ERROR_INTERCEPTOR_GAS_ESTIMATION_FAILED, MOCK_ADDRESS } from '../../utils/constants.js'
import { ethers, keccak256 } from 'ethers'
import { WebsiteCreatedEthereumUnsignedTransaction, SimulatedTransaction, SimulationState, TokenBalancesAfter, EstimateGasError } from '../../utils/visualizer-types.js'
import { EthereumUnsignedTransactionToUnsignedTransaction, IUnsignedTransaction1559, serializeSignedTransactionToBytes } from '../../utils/ethereum.js'
import { EthGetLogsResponse, EthGetLogsRequest, EthTransactionReceiptResponse, PersonalSignParams, SignTypedDataParams, MulticallResponseEventLogs, MulticallResponse, OldSignTypedDataParams, DappRequestTransaction } from '../../utils/JsonRpc-types.js'
import { handleERC1155TransferBatch, handleERC1155TransferSingle } from '../logHandlers.js'

const MOCK_PRIVATE_KEY = 0x1n // key used to sign mock transactions
const GET_CODE_CONTRACT = 0x1ce438391307f908756fefe0fe220c0f0d51508an

export const getWebsiteCreatedEthereumUnsignedTransactions = (simulatedTransactions: readonly SimulatedTransaction[]) => {
	return simulatedTransactions.map((simulatedTransaction) => ({
		transaction: simulatedTransaction.signedTransaction,
		website: simulatedTransaction.website,
		transactionCreated: simulatedTransaction.transactionCreated,
		originalTransactionRequestParameters: simulatedTransaction.originalTransactionRequestParameters,
		error: undefined,
	}))
}

function convertSimulatedTransactionToWebsiteCreatedEthereumUnsignedTransaction(tx: SimulatedTransaction) {
	return { transaction: tx.signedTransaction, website: tx.website, transactionCreated: tx.transactionCreated, originalTransactionRequestParameters: tx.originalTransactionRequestParameters, error: undefined, }
}

export const copySimulationState = (simulationState: SimulationState): SimulationState => {
	return {
		prependTransactionsQueue: [...simulationState.prependTransactionsQueue],
		simulatedTransactions: [...simulationState.simulatedTransactions],
		blockNumber: simulationState.blockNumber,
		blockTimestamp: simulationState.blockTimestamp,
		rpcNetwork: simulationState.rpcNetwork,
		simulationConductedTimestamp: simulationState.simulationConductedTimestamp,
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
		...transaction.multicallResponse,
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
	if ('data' in request && request.data !== undefined) {
		return request.data
	}
	if ('input' in request && request.input !== undefined) {
		return request.input
	}
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
	const lastResult = multiCall[multiCall.length - 1]
	if (lastResult.statusCode === 'failure') {
		return {
			error: {
				code: ERROR_INTERCEPTOR_GAS_ESTIMATION_FAILED,
				message: `execution reverted: failed to estimate gas.`,
				data: dataStringWith0xStart(lastResult.returnValue),
			},
			gas: maxGas,
		} as const 
	}
	const gasSpent = lastResult.gasSpent * 125n / 100n // add 25% extra to account for gas savings <https://eips.ethereum.org/EIPS/eip-3529>
	return { gas: gasSpent < maxGas ? gasSpent : maxGas }
}

// calculates gas price for receipts
export const calculateGasPrice = (transaction: EthereumUnsignedTransaction, gasUsed: bigint, gasLimit: bigint, baseFeePerGas: bigint) => {
	if ('gasPrice' in transaction) {
		return transaction.gasPrice
	}
	const baseFee = getBaseFeePerGasForNewBlock(gasUsed, gasLimit, baseFeePerGas)
	return min(baseFee + transaction.maxPriorityFeePerGas, transaction.maxFeePerGas)
}

export const mockSignTransaction = async (transaction: EthereumUnsignedTransaction) : Promise<EthereumSignedTransaction> => {
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

export const appendTransaction = async (ethereumClientService: EthereumClientService, simulationState: SimulationState | undefined, transaction: WebsiteCreatedEthereumUnsignedTransaction): Promise<SimulationState> => {
	const signed = await mockSignTransaction(transaction.transaction)
	const parentBlock = await ethereumClientService.getBlock()
	const parentBaseFeePerGas = parentBlock.baseFeePerGas
	if (parentBaseFeePerGas === undefined) throw new Error(CANNOT_SIMULATE_OFF_LEGACY_BLOCK)
	const signedTxs = simulationState === undefined ? [signed] : simulationState.simulatedTransactions.map((x) => x.signedTransaction).concat([signed])
	const multicallResult = await ethereumClientService.multicall(signedTxs, parentBlock.number)
	const transactionWebsiteData = { website: transaction.website, transactionCreated: transaction.transactionCreated }
	const websiteData = simulationState === undefined ? [transactionWebsiteData] : simulationState.simulatedTransactions.map((x) => ({ website: x.website, transactionCreated: x.transactionCreated })).concat(transactionWebsiteData)
	if (multicallResult.length !== signedTxs.length || websiteData.length !== signedTxs.length) throw 'multicall length does not match in appendTransaction'

	const tokenBalancesAfter = await getTokenBalancesAfter(
		ethereumClientService,
		signedTxs,
		multicallResult,
		parentBlock.number
	)
	if (multicallResult.length !== tokenBalancesAfter.length) throw 'tokenBalancesAfter length does not match'

	return {
		prependTransactionsQueue: simulationState === undefined ? [] : simulationState.prependTransactionsQueue,
		simulatedTransactions: multicallResult.map((singleResult, index) => ({
			multicallResponse: singleResult,
			signedTransaction: signedTxs[index],
			realizedGasPrice: calculateGasPrice(signedTxs[index], parentBlock.gasUsed, parentBlock.gasLimit, parentBaseFeePerGas),
			tokenBalancesAfter: tokenBalancesAfter[index],
			...websiteData[index],
			originalTransactionRequestParameters: transaction.originalTransactionRequestParameters,
		})),
		blockNumber: parentBlock.number,
		blockTimestamp: parentBlock.timestamp,
		rpcNetwork: ethereumClientService.getRpcNetwork(),
		simulationConductedTimestamp: new Date(),
	}
}

export const setSimulationTransactions = async (ethereumClientService: EthereumClientService, simulationState: SimulationState, unsignedTxts: WebsiteCreatedEthereumUnsignedTransaction[]): Promise<SimulationState>  => {
	if (unsignedTxts.length === 0 && simulationState.prependTransactionsQueue.length === 0) {
		const block = await ethereumClientService.getBlock()
		return {
			prependTransactionsQueue: simulationState.prependTransactionsQueue,
			simulatedTransactions: [],
			blockNumber: block.number,
			blockTimestamp: block.timestamp,
			rpcNetwork: ethereumClientService.getRpcNetwork(),
			simulationConductedTimestamp: new Date(),
		}
	}

	let signedTxs: EthereumSignedTransaction[] = []
	const newTransactionsToSimulate = simulationState.prependTransactionsQueue.concat(unsignedTxts)
	for (const transaction of newTransactionsToSimulate) {
		signedTxs.push(await mockSignTransaction(transaction.transaction))
	}
	const parentBlock = await ethereumClientService.getBlock()
	const parentBaseFeePerGas = parentBlock.baseFeePerGas
	if (parentBaseFeePerGas === undefined) throw new Error(CANNOT_SIMULATE_OFF_LEGACY_BLOCK)
	const multicallResult = await ethereumClientService.multicall(newTransactionsToSimulate.map((x) => x.transaction), parentBlock.number)
	if (multicallResult.length !== signedTxs.length) throw 'multicall length does not match in setSimulationTransactions'

	const tokenBalancesAfter: TokenBalancesAfter[] = []
	for (let resultIndex = 0; resultIndex < multicallResult.length; resultIndex++) {
		const singleResult = multicallResult[resultIndex]
		const balances = await getSimulatedTokenBalances(
			ethereumClientService,
			signedTxs.slice(0, resultIndex + 1),
			getAddressesInteractedWithErc20s(singleResult.statusCode === 'success' ? singleResult.events : []),
			parentBlock.number
		)
		tokenBalancesAfter.push(balances)
	}
	return {
		prependTransactionsQueue: simulationState.prependTransactionsQueue,
		simulatedTransactions: multicallResult.map((singleResult, index) => ({
			multicallResponse: singleResult,
			unsignedTransaction: newTransactionsToSimulate[index],
			signedTransaction: signedTxs[index],
			realizedGasPrice: calculateGasPrice(newTransactionsToSimulate[index].transaction, parentBlock.gasUsed, parentBlock.gasLimit, parentBaseFeePerGas),
			tokenBalancesAfter: tokenBalancesAfter[index],
			website: newTransactionsToSimulate[index].website,
			transactionCreated: newTransactionsToSimulate[index].transactionCreated,
			originalTransactionRequestParameters: newTransactionsToSimulate[index].originalTransactionRequestParameters,
		})),
		blockNumber: parentBlock.number,
		blockTimestamp: parentBlock.timestamp,
		rpcNetwork: ethereumClientService.getRpcNetwork(),
		simulationConductedTimestamp: new Date(),
	}
}

export const getTransactionQueue = (simulationState: SimulationState | undefined) => {
	if (simulationState === undefined) return []
	return simulationState.simulatedTransactions.map((x) => x.signedTransaction)
}
export const getPrependTransactionsQueue = (simulationState: SimulationState) => simulationState.prependTransactionsQueue

export const setPrependTransactionsQueue = async (ethereumClientService: EthereumClientService, simulationState: SimulationState | undefined, prepend: readonly WebsiteCreatedEthereumUnsignedTransaction[]): Promise<SimulationState>  => {
	if (prepend.length > 0 && simulationState !== undefined) {
		return await setSimulationTransactions(ethereumClientService, { ...simulationState, prependTransactionsQueue: prepend }, [])
	}
	const block = await ethereumClientService.getBlock()
	const newState = {
		prependTransactionsQueue: [],
		simulatedTransactions: [],
		blockNumber: block.number,
		blockTimestamp: block.timestamp,
		rpcNetwork: ethereumClientService.getRpcNetwork(),
		simulationConductedTimestamp: new Date(),
	}

	if (prepend.length > 0) {
		return await setSimulationTransactions(ethereumClientService, { ...newState, prependTransactionsQueue: prepend }, [])
	}
	return newState
}

export const removeTransaction = async (ethereumClientService: EthereumClientService, simulationState: SimulationState, transactionHash: bigint): Promise<SimulationState>  => {
	const filtered = getNonPrependedSimulatedTransactionsFromState(simulationState).filter( (transaction) => transaction.signedTransaction.hash !== transactionHash)
	return await setSimulationTransactions(ethereumClientService, simulationState, filtered.map((x) => convertSimulatedTransactionToWebsiteCreatedEthereumUnsignedTransaction(x)))
}

export const removeTransactionAndUpdateTransactionNonces = async (ethereumClientService: EthereumClientService, simulationState: SimulationState, transactionHash: bigint): Promise<SimulationState>  => {
	const transactionToBeRemoved = simulationState.simulatedTransactions.find((transaction) => transaction.signedTransaction.hash === transactionHash)
	if (transactionToBeRemoved == undefined) return simulationState

	let newTransactions: WebsiteCreatedEthereumUnsignedTransaction[] = []
	let transactionWasFound = false

	for (const transaction of getNonPrependedSimulatedTransactionsFromState(simulationState)) {
		if (transactionHash === transaction.signedTransaction.hash) {
			transactionWasFound = true
			continue
		}
		const shouldUpdateNonce = transactionWasFound && transaction.signedTransaction.from === transactionToBeRemoved.signedTransaction.from
		const newTransaction = { ...transaction.signedTransaction, ...(shouldUpdateNonce ? { nonce: transaction.signedTransaction.nonce - 1n } : {}) }
		newTransactions.push({
			transaction: newTransaction,
			website: transaction.website,
			transactionCreated: transaction.transactionCreated,
			originalTransactionRequestParameters: transaction.originalTransactionRequestParameters,
			error: undefined,
		})
	}
	return await setSimulationTransactions(ethereumClientService, simulationState, newTransactions)
}

export const getNonceFixedSimulatedTransactions = async(ethereumClientService: EthereumClientService, simulatedTransactions: readonly SimulatedTransaction[]) => {
	const isFixableNonceError = (transaction: SimulatedTransaction) => {
		return transaction.multicallResponse.statusCode === 'failure'
		&& transaction.multicallResponse.error === 'wrong transaction nonce'
		&& transaction.originalTransactionRequestParameters.method === 'eth_sendTransaction'
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
		knownPreviousNonce.set(fromString, nonceFixedTransactions[nonceFixedTransactions.length - 1].signedTransaction.nonce)
	}
	return nonceFixedTransactions
}

export const refreshSimulationState = async (ethereumClientService: EthereumClientService, simulationState: SimulationState): Promise<SimulationState>  => {
	if (ethereumClientService.getChainId() !== simulationState.rpcNetwork.chainId) return simulationState // don't refresh if we don't have the same chain to refresh from
	if (simulationState.blockNumber == await ethereumClientService.getBlockNumber()) {
		// if block number is the same, we don't need to compute anything as nothing has changed, but let's update timestamp to show the simulation was refreshed for this time
		return { ...simulationState, simulationConductedTimestamp: new Date() }
	}
	const nonPrepended = getNonPrependedSimulatedTransactionsFromState(simulationState)
	const nonceFixedTransactions = await getNonceFixedSimulatedTransactions(ethereumClientService, simulationState.simulatedTransactions)
	if (nonceFixedTransactions === 'NoNonceErrors') {
		return await setSimulationTransactions(ethereumClientService, simulationState, nonPrepended.map((x) => convertSimulatedTransactionToWebsiteCreatedEthereumUnsignedTransaction(x)))
	} else {
		const nonPrependedNonceFixedTransactions = getNonPrependedSimulatedTransactions(simulationState.prependTransactionsQueue, nonceFixedTransactions)
		return await setSimulationTransactions(ethereumClientService, simulationState, nonPrependedNonceFixedTransactions.map((x) => convertSimulatedTransactionToWebsiteCreatedEthereumUnsignedTransaction(x)))
	}
}

export const resetSimulationState = async (ethereumClientService: EthereumClientService, simulationState: SimulationState): Promise<SimulationState> => {
	return await setPrependTransactionsQueue(ethereumClientService, simulationState, simulationState.prependTransactionsQueue)
}

export const getStorageAt = async (ethereumClientService: EthereumClientService, contract: bigint, slot: bigint) => {
	//todo, requires plugin work...
	return await ethereumClientService.getStorageAt(contract, slot)
}

const canQueryNodeDirectly = async (ethereumClientService: EthereumClientService, simulationState: SimulationState, blockTag: EthereumBlockTag = 'latest') => {
	if (simulationState === undefined
		|| simulationState.simulatedTransactions.length == 0
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
		cumGas += simulatedTransaction.multicallResponse.gasSpent
		if(hash === simulatedTransaction.signedTransaction.hash) {
			const blockNum = await ethereumClientService.getBlockNumber()
			return {
				type: simulatedTransaction.signedTransaction.type,
				blockHash: getHashOfSimulatedBlock(),
				blockNumber: blockNum,
				transactionHash: simulatedTransaction.signedTransaction.hash,
				transactionIndex: BigInt(index),
				contractAddress: null, // this is not correct if we actually deploy contract, where to get right value?
				cumulativeGasUsed: cumGas,
				gasUsed: simulatedTransaction.multicallResponse.gasSpent,
				effectiveGasPrice: 0x2n,
				from: simulatedTransaction.signedTransaction.from,
				to: simulatedTransaction.signedTransaction.to,
				logs: simulatedTransaction.multicallResponse.statusCode === 'success'
					? simulatedTransaction.multicallResponse.events.map((x, logIndex) => ({
						removed: false,
						blockHash: getHashOfSimulatedBlock(),
						address: x.loggersAddress,
						logIndex: BigInt(currentLogIndex + logIndex),
						data: x.data,
						topics: x.topics,
						blockNumber: blockNum,
						transactionIndex: BigInt(index),
						transactionHash: simulatedTransaction.signedTransaction.hash
					}))
					: [],
				logsBloom: 0x0n, //TODO: what should this be?
				status: simulatedTransaction.multicallResponse.statusCode
			}
		}
		currentLogIndex += simulatedTransaction.multicallResponse.statusCode === 'success' ? simulatedTransaction.multicallResponse.events.length : 0
	}
	return await ethereumClientService.getTransactionReceipt(hash)
}

export const getSimulatedBalance = async (ethereumClientService: EthereumClientService, simulationState: SimulationState | undefined, address: bigint, blockTag: EthereumBlockTag = 'latest'): Promise<bigint> => {
	if (simulationState === undefined || await canQueryNodeDirectly(ethereumClientService, simulationState, blockTag)) return await ethereumClientService.getBalance(address, blockTag)
	const balances = new Map<bigint, bigint>()
	for (const transaction of simulationState.simulatedTransactions) {
		if (transaction.multicallResponse.statusCode !== 'success') continue

		for (const b of transaction.multicallResponse.balanceChanges) {
			balances.set(b.address, b.after)
		}
	}
	if (balances.has(address)) {
		return balances.get(address)!
	}
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
	const multiCall = await simulatedMulticall(ethereumClientService, simulationState, [getCodeTransaction], block.number + 1n)
	const lastResult = multiCall[multiCall.length - 1]
	if (lastResult.statusCode === 'failure') return { statusCode: 'failure' } as const
	const parsed = atInterface.decodeFunctionResult('at', lastResult.returnValue)
	return {
		statusCode: lastResult.statusCode,
		getCodeReturn: EthereumData.parse(parsed.toString())
	} as const
}

const getBaseFeePerGasForNewBlock = (parent_gas_used: bigint, parent_gas_limit: bigint, parent_base_fee_per_gas: bigint) => {
	// see https://eips.ethereum.org/EIPS/eip-1559
	const ELASTICITY_MULTIPLIER = 8n
	const BASE_FEE_MAX_CHANGE_DENOMINATOR = 8n
	const parent_gas_target = parent_gas_limit / ELASTICITY_MULTIPLIER

	if (parent_gas_used === parent_gas_target) {
		return parent_base_fee_per_gas
	}
	if (parent_gas_used > parent_gas_target) {
		const gas_used_delta = parent_gas_used - parent_gas_target
		const base_fee_per_gas_delta = max(parent_base_fee_per_gas * gas_used_delta / parent_gas_target / BASE_FEE_MAX_CHANGE_DENOMINATOR, 1n)
		return parent_base_fee_per_gas + base_fee_per_gas_delta
	}
	const gas_used_delta = parent_gas_target - parent_gas_used
	const base_fee_per_gas_delta = parent_base_fee_per_gas * gas_used_delta / parent_gas_target / BASE_FEE_MAX_CHANGE_DENOMINATOR
	return parent_base_fee_per_gas - base_fee_per_gas_delta
}

export async function getSimulatedBlock(ethereumClientService: EthereumClientService, simulationState: SimulationState | undefined, blockTag?: EthereumBlockTag, fullObjects?: true): Promise<EthereumBlockHeader>
export async function getSimulatedBlock(ethereumClientService: EthereumClientService, simulationState: SimulationState | undefined, blockTag: EthereumBlockTag, fullObjects: boolean): Promise<EthereumBlockHeader | EthereumBlockHeaderWithTransactionHashes>
export async function getSimulatedBlock(ethereumClientService: EthereumClientService, simulationState: SimulationState | undefined, blockTag: EthereumBlockTag, fullObjects: false): Promise<EthereumBlockHeaderWithTransactionHashes>
export async function getSimulatedBlock(ethereumClientService: EthereumClientService, simulationState: SimulationState | undefined, blockTag: EthereumBlockTag = 'latest', fullObjects: boolean = true): Promise<EthereumBlockHeader | EthereumBlockHeaderWithTransactionHashes>  {
	if (simulationState === undefined || await canQueryNodeDirectly(ethereumClientService, simulationState, blockTag)) {
		return await ethereumClientService.getBlock(blockTag, fullObjects)
	}

	// make a mock block based on the previous block
	const parentBlock = await ethereumClientService.getBlock()
	if (parentBlock.baseFeePerGas === undefined) throw new Error(CANNOT_SIMULATE_OFF_LEGACY_BLOCK)

	const block = {
		author: parentBlock.miner,
		difficulty: parentBlock.difficulty,
		extraData: parentBlock.extraData,
		gasLimit: parentBlock.gasLimit,
		gasUsed: transactionQueueTotalGasLimit(simulationState),
		hash: getHashOfSimulatedBlock(),
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
		baseFeePerGas: getBaseFeePerGasForNewBlock(parentBlock.gasUsed, parentBlock.gasLimit, parentBlock.baseFeePerGas),
		transactionsRoot: parentBlock.transactionsRoot, // TODO: this is wrong
		transactions: simulationState.simulatedTransactions.map((simulatedTransaction) => simulatedTransaction.signedTransaction),
		withdrawals: [], // TODO: this is wrong
		withdrawalsRoot: 0n, // TODO: this is wrong
	} as const

	if (fullObjects) return block
	return { ...block, transactions: block.transactions.map((transaction) => transaction.hash) }
}

const getLogsOfSimulatedBlock = (simulationState: SimulationState, logFilter: EthGetLogsRequest): EthGetLogsResponse => {
	const events: EthGetLogsResponse = simulationState?.simulatedTransactions.reduce((acc, sim, transactionIndex) => {
		if (!('events' in sim.multicallResponse)) return acc
		return [
			...acc,
			...sim.multicallResponse.events.map((event, logIndex) => ({
				removed: false,
				logIndex: BigInt(acc.length + logIndex),
				transactionIndex: BigInt(transactionIndex),
				transactionHash: sim.signedTransaction.hash,
				blockHash: getHashOfSimulatedBlock(),
				blockNumber: simulationState.blockNumber,
				address: event.loggersAddress,
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
	if ('blockHash' in logFilter && logFilter.blockHash === getHashOfSimulatedBlock()) return getLogsOfSimulatedBlock(simulationState, logFilter)
	const logs = await ethereumClientService.getLogs(logFilter)
	if (simulationState && (toBlock === 'latest' || toBlock >= simulationState.blockNumber)) {
		return [...logs, ...getLogsOfSimulatedBlock(simulationState, logFilter)]
	}
	return logs
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
				blockHash: getHashOfSimulatedBlock(),
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

export const simulatedCall = async (ethereumClientService: EthereumClientService, simulationState: SimulationState | undefined, params: Pick<IUnsignedTransaction1559, 'to' | 'from' | 'input' | 'value' | 'maxFeePerGas' | 'maxPriorityFeePerGas' | 'gasLimit'>, blockTag: EthereumBlockTag = 'latest') => {
	const currentBlock = await ethereumClientService.getBlockNumber()
	const blockNumToUse = blockTag === 'latest' || blockTag === 'pending' ? currentBlock : min(blockTag, currentBlock)
	const simulationStateToUse = blockNumToUse >= currentBlock ? simulationState : undefined

	const transaction = {
		...params,
		type: '1559',
		gas: params.gasLimit,
		nonce: await getSimulatedTransactionCount(ethereumClientService, simulationStateToUse, params.from, blockTag),
		chainId: ethereumClientService.getChainId(),
	} as const
	const multicallResult = await simulatedMulticall(ethereumClientService, simulationStateToUse, [transaction], blockNumToUse)
	const callResult = multicallResult[multicallResult.length - 1]
	if (callResult.statusCode === 'failure') {
		return {
			error: {
				code: -32015,
				message: 'VM execution error.',
				data: callResult.error,
			}
		}
	}
	return { result: callResult.returnValue }
}

export const simulatedMulticall = async (ethereumClientService: EthereumClientService, simulationState: SimulationState | undefined, transactions: EthereumUnsignedTransaction[], blockNumber: bigint) => {
	const mergedTxs: EthereumUnsignedTransaction[] = getTransactionQueue(simulationState)
	return await ethereumClientService.multicall(mergedTxs.concat(transactions), blockNumber)
}

export const getHashOfSimulatedBlock = () => {
	return 0x1n
}

export const simulatePersonalSign = async (params: PersonalSignParams | SignTypedDataParams | OldSignTypedDataParams) => {
	if (params.method === 'personal_sign') return await new ethers.Wallet(bytes32String(MOCK_PRIVATE_KEY)).signMessage(params.params[0])
	throw new Error(`Simulated signing not implemented for method ${ params.method }`)
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

const getSimulatedTokenBalances = async (ethereumClientService: EthereumClientService, transactionQueue: EthereumUnsignedTransaction[], balances: BalanceQuery[], blockNumber: bigint): Promise<TokenBalancesAfter> => {
	if (balances.length === 0) return []
	const erc20TokenInterface = new ethers.Interface(['function balanceOf(address account) view returns (uint256)'])
	const erc1155TokenInterface = new ethers.Interface(['function balanceOf(address _owner, uint256 _id) external view returns(uint256)'])
	const transactions = balances.map((balanceRequest, index) => {
		const base = {
			type: '1559' as const,
			from: MOCK_ADDRESS + BigInt(index) + 1n,
			to: balanceRequest.token,
			value: 0n,
			maxFeePerGas: 0n,
			maxPriorityFeePerGas: 0n,
			accessList: [],
			gas: 42000n,
			chainId: 0n,
			nonce: 0n,
		}
		if (balanceRequest.type === 'ERC20') {
			return {
				...base,
				input: stringToUint8Array(erc20TokenInterface.encodeFunctionData('balanceOf', [addressString(balanceRequest.owner)])),
			}
		}
		return {
			...base,
			input: stringToUint8Array(erc1155TokenInterface.encodeFunctionData('balanceOf', [addressString(balanceRequest.owner), balanceRequest.tokenId])),
		}
	})
	const transactionQueueSize = transactionQueue.length
	const response = await ethereumClientService.multicall(transactionQueue.concat(transactions), blockNumber)
	if (response.length !== transactions.length + transactionQueueSize) throw new Error('Multicall length mismatch')
	return balances.map((balance, index) => ({
		token: balance.token,
		tokenId: 'tokenId' in balance ? balance.tokenId : undefined,
		owner: balance.owner,
		balance: response[transactionQueueSize + index].statusCode === 'success' ? bytesToUnsigned(response[transactionQueueSize + index].returnValue) : undefined
	}))
}

export const parseLogIfPossible = (ethersInterface: ethers.Interface, log: { topics: string[], data: string }) => {
	try {
		return ethersInterface.parseLog(log)
	} catch (error) {
		return null
	}
}

const getAddressesInteractedWithErc20s = (events: MulticallResponseEventLogs): { token: bigint, owner: bigint, tokenId: undefined, type: 'ERC20' }[] => {
	const erc20ABI = [
		'event Transfer(address indexed from, address indexed to, uint256 value)',
		'event Approval(address indexed owner, address indexed spender, uint256 value)',
	]
	const erc20 = new ethers.Interface(erc20ABI)
	const tokenOwners: { token: bigint, owner: bigint, tokenId: undefined, type: 'ERC20' }[] = []
	for (const log of events) {
		const parsed = parseLogIfPossible(erc20, { topics: log.topics.map((x) => bytes32String(x)), data: dataStringWith0xStart(log.data) })
		if (parsed === null) continue
		const base = { token: log.loggersAddress, tokenId: undefined, type: 'ERC20' as const }
		switch (parsed.name) {
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

const getAddressesAndTokensIdsInteractedWithErc1155s = (events: MulticallResponseEventLogs): { token: bigint, owner: bigint, tokenId: bigint, type: 'ERC1155' }[] => {
	const erc1155ABI = [
		'event TransferSingle(address operator, address from, address to, uint256 id, uint256 value)',
		'event TransferBatch(address indexed _operator, address indexed _from, address indexed _to, uint256[] _ids, uint256[] _values)',
	]
	const erc20 = new ethers.Interface(erc1155ABI)
	const tokenOwners: { token: bigint, owner: bigint, tokenId: bigint, type: 'ERC1155' }[] = []
	for (const log of events) {
		const parsed = parseLogIfPossible(erc20, { topics: log.topics.map((x) => bytes32String(x)), data: dataStringWith0xStart(log.data) })
		if (parsed === null) continue
		const base = { token: log.loggersAddress, type: 'ERC1155' as const }
		switch (parsed.name) {
			case 'TransferSingle': {
				const parsedLog = handleERC1155TransferSingle(log)[0]
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

const getTokenBalancesAfter = async (
	ethereumClientService: EthereumClientService,
	signedTxs: EthereumSignedTransaction[] = [],
	multicallResult: MulticallResponse,
	blockNumber: bigint,
) => {
	const tokenBalancesAfter: TokenBalancesAfter[] = []
	for (let resultIndex = 0; resultIndex < multicallResult.length; resultIndex++) {
		const singleResult = multicallResult[resultIndex]
		const events = singleResult.statusCode === 'success' ? singleResult.events : []
		const erc20sAddresses: BalanceQuery[] = getAddressesInteractedWithErc20s(events)
		const erc1155AddressIds: BalanceQuery[] = getAddressesAndTokensIdsInteractedWithErc1155s(events)
		const balances = await getSimulatedTokenBalances(
			ethereumClientService,
			signedTxs.slice(0, resultIndex + 1),
			erc20sAddresses.concat(erc1155AddressIds),
			blockNumber
		)
		tokenBalancesAfter.push(balances)
	}
	return tokenBalancesAfter
}
