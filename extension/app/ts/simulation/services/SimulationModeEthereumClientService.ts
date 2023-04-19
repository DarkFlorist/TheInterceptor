import { EthereumClientService } from './EthereumClientService.js'
import { EthGetLogsResponse, EthereumUnsignedTransaction, EthereumSignedTransactionWithBlockData, EthereumBlockTag, EthGetLogsRequest, EthTransactionReceiptResponse, EstimateGasParamsVariables, PersonalSignParams, SignTypedDataParams, EthereumSignedTransaction, GetBlockReturn, EthereumData, EthereumQuantity, MulticallResponseEventLogs, MulticallResponse, EthereumAddress } from '../../utils/wire-types.js'
import { addressString, bytes32String, bytesToUnsigned, dataStringWith0xStart, max, min, stringToUint8Array } from '../../utils/bigint.js'
import { MOCK_ADDRESS } from '../../utils/constants.js'
import { ethers, keccak256 } from 'ethers'
import { EthereumUnsignedTransactionWithWebsite, SimulatedTransaction, SimulationState, TokenBalancesAfter } from '../../utils/visualizer-types.js'
import { EthereumUnsignedTransactionToUnsignedTransaction, IUnsignedTransaction1559, serializeSignedTransactionToBytes } from '../../utils/ethereum.js'

const MOCK_PRIVATE_KEY = 0x1n // key used to sign mock transactions
const GET_CODE_CONTRACT = 0x1ce438391307f908756fefe0fe220c0f0d51508an

function convertSimulatedTransactionToEthereumUnsignedTransactionWithWebsite(tx: SimulatedTransaction) {
	return { transaction: tx.signedTransaction, website: tx.website }
}

export const copySimulationState = (simulationState: SimulationState): SimulationState => {
	return {
		prependTransactionsQueue: [...simulationState.prependTransactionsQueue],
		simulatedTransactions: [...simulationState.simulatedTransactions],
		blockNumber: simulationState.blockNumber,
		blockTimestamp: simulationState.blockTimestamp,
		chain: simulationState.chain,
		simulationConductedTimestamp: simulationState.simulationConductedTimestamp,
	}
}

const getNonPrependedSimulatedTransactions = (simulationState: SimulationState) => {
	return simulationState.simulatedTransactions.slice(simulationState.prependTransactionsQueue.length, simulationState.simulatedTransactions.length)
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
//
export const simulateEstimateGas = async (ethereumClientService: EthereumClientService, simulationState: SimulationState, data: EstimateGasParamsVariables) => {
	const sendAddress = data.from !== undefined ? data.from : MOCK_ADDRESS
	const transactionCount = getSimulatedTransactionCount(ethereumClientService, simulationState, sendAddress)
	const block = await ethereumClientService.getBlock()
	const maxGas = max(block.gasLimit * 1023n / 1024n - transactionQueueTotalGasLimit(simulationState), 0n)
	const tmp = {
		type: '1559' as const,
		from: sendAddress,
		chainId: ethereumClientService.getChainId(),
		nonce: await transactionCount,
		maxFeePerGas: data.gasPrice !== undefined ? data.gasPrice : 0n,
		maxPriorityFeePerGas: 2n,
		gas: data.gas === undefined ? maxGas : data.gas,
		to: data.to === undefined ? null : data.to,
		value: data.value === undefined ? 0n : data.value,
		input: data.data === undefined ? new Uint8Array(0) : data.data,
		accessList: []
	}
	const multiCall = await simulatedMulticall(ethereumClientService, simulationState, [tmp], block.number + 1n)
	const gasSpent = multiCall[multiCall.length - 1].gasSpent * 12n / 10n
	return gasSpent < maxGas ? gasSpent : maxGas
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

export const appendTransaction = async (ethereumClientService: EthereumClientService, simulationState: SimulationState, transaction: EthereumUnsignedTransactionWithWebsite): Promise<SimulationState> => {
	const signed = await mockSignTransaction(transaction.transaction)
	const parentBlock = await ethereumClientService.getBlock()
	const signedTxs = simulationState.simulatedTransactions.map((x) => x.signedTransaction).concat([signed])
	const multicallResult = await ethereumClientService.multicall(signedTxs, parentBlock.number)
	const websites = simulationState.simulatedTransactions.map((x) => x.website).concat(transaction.website)
	if (multicallResult.length !== signedTxs.length || websites.length !== signedTxs.length) throw 'multicall length does not match in appendTransaction'

	const tokenBalancesAfter = await getTokenBalancesAfter(
		ethereumClientService,
		signedTxs,
		multicallResult,
		parentBlock.number
	)
	if (multicallResult.length !== tokenBalancesAfter.length) throw 'tokenBalancesAfter length does not match'

	return {
		prependTransactionsQueue: simulationState.prependTransactionsQueue,
		simulatedTransactions: multicallResult.map((singleResult, index) => ({
			multicallResponse: singleResult,
			signedTransaction: signedTxs[index],
			realizedGasPrice: calculateGasPrice(signedTxs[index], parentBlock.gasUsed, parentBlock.gasLimit, parentBlock.baseFeePerGas),
			website: websites[index],
			tokenBalancesAfter: tokenBalancesAfter[index],
		})),
		blockNumber: parentBlock.number,
		blockTimestamp: parentBlock.timestamp,
		chain: simulationState.chain,
		simulationConductedTimestamp: new Date(),
	}
}

export const setSimulationTransactions = async (ethereumClientService: EthereumClientService, simulationState: SimulationState, unsignedTxts: EthereumUnsignedTransactionWithWebsite[]): Promise<SimulationState>  => {
	if (unsignedTxts.length === 0 && simulationState.prependTransactionsQueue.length === 0) {
		const block = await ethereumClientService.getBlock()
		return {
			prependTransactionsQueue: simulationState.prependTransactionsQueue,
			simulatedTransactions: [],
			blockNumber: block.number,
			blockTimestamp: block.timestamp,
			chain: ethereumClientService.getChain(),
			simulationConductedTimestamp: new Date(),
		}
	}

	let signedTxs: EthereumSignedTransaction[] = []
	const newTransactionsToSimulate = simulationState.prependTransactionsQueue.concat(unsignedTxts)
	for (const transaction of newTransactionsToSimulate) {
		signedTxs.push(await mockSignTransaction(transaction.transaction))
	}
	const parentBlock = await ethereumClientService.getBlock()
	const multicallResult = await ethereumClientService.multicall(newTransactionsToSimulate.map((x) => x.transaction), parentBlock.number)
	if (multicallResult.length !== signedTxs.length) throw 'multicall length does not match in setSimulationTransactions'
	const chainId = ethereumClientService.getChain()

	const tokenBalancesAfter: TokenBalancesAfter[] = []
	for (let resultIndex = 0; resultIndex < multicallResult.length; resultIndex++) {
		const singleResult = multicallResult[resultIndex]
		const balances = await getSimulatedTokenBalances(
			ethereumClientService,
			signedTxs.slice(0, resultIndex + 1),
			getAddressesInteractedWithERC20s(singleResult.statusCode === 'success' ? singleResult.events : []),
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
			realizedGasPrice: calculateGasPrice(newTransactionsToSimulate[index].transaction, parentBlock.gasUsed, parentBlock.gasLimit, parentBlock.baseFeePerGas),
			website: newTransactionsToSimulate[index].website,
			tokenBalancesAfter: tokenBalancesAfter[index]
		})),
		blockNumber: parentBlock.number,
		blockTimestamp: parentBlock.timestamp,
		chain: chainId,
		simulationConductedTimestamp: new Date(),
	}
}

export const getTransactionQueue = (simulationState: SimulationState) => {
	return simulationState.simulatedTransactions.map((x) => x.signedTransaction)
}
export const getPrependTransactionsQueue = (simulationState: SimulationState) => simulationState.prependTransactionsQueue

export const setPrependTransactionsQueue = async (ethereumClientService: EthereumClientService, simulationState: SimulationState | undefined, prepend: readonly EthereumUnsignedTransactionWithWebsite[]): Promise<SimulationState>  => {
	if (prepend.length > 0 && simulationState !== undefined) {
		return await setSimulationTransactions(ethereumClientService, { ...simulationState, prependTransactionsQueue: prepend }, [])
	}
	const block = await ethereumClientService.getBlock()
	const newState = {
		prependTransactionsQueue: [],
		simulatedTransactions: [],
		blockNumber: block.number,
		blockTimestamp: block.timestamp,
		chain: ethereumClientService.getChain(),
		simulationConductedTimestamp: new Date(),
	}

	if (prepend.length > 0) {
		return await setSimulationTransactions(ethereumClientService, { ...newState, prependTransactionsQueue: prepend }, [])
	}
	return newState
}

export const removeTransaction = async (ethereumClientService: EthereumClientService, simulationState: SimulationState, transactionHash: bigint): Promise<SimulationState>  => {
	const filtered = getNonPrependedSimulatedTransactions(simulationState).filter( (transaction) => transaction.signedTransaction.hash !== transactionHash)
	return await setSimulationTransactions(ethereumClientService, simulationState, filtered.map((x) => convertSimulatedTransactionToEthereumUnsignedTransactionWithWebsite(x)))
}

export const removeTransactionAndUpdateTransactionNonces = async (ethereumClientService: EthereumClientService, simulationState: SimulationState, transactionHash: bigint): Promise<SimulationState>  => {
	const transactionToBeRemoved = simulationState.simulatedTransactions.find( (transaction) => transaction.signedTransaction.hash === transactionHash)
	if (transactionToBeRemoved == undefined) return simulationState

	let newTransactions: EthereumUnsignedTransactionWithWebsite[] = []
	let transactionWasFound = false

	for (const transaction of getNonPrependedSimulatedTransactions(simulationState)) {
		if (transactionHash === transaction.signedTransaction.hash) {
			transactionWasFound = true
			continue
		}
		const shouldUpdateNonce = transactionWasFound && transaction.signedTransaction.from === transactionToBeRemoved.signedTransaction.from
		const newTransaction = { ...transaction.signedTransaction, ...(shouldUpdateNonce ? { nonce: transaction.signedTransaction.nonce - 1n } : {}) }
		newTransactions.push({ transaction: newTransaction, website: transaction.website })
	}
	return await setSimulationTransactions(ethereumClientService, simulationState, newTransactions)
}

export const refreshSimulationState = async (ethereumClientService: EthereumClientService, simulationState: SimulationState): Promise<SimulationState>  => {
	if (ethereumClientService.getChain() !== simulationState.chain) return simulationState // don't refresh if we don't have the same chain to refresh from
	if (simulationState.blockNumber == await ethereumClientService.getBlockNumber()) {
		// if block number is the same, we don't need to compute anything as nothing has changed, but let's update timestamp to show the simulation was refreshed for this time
		return { ...simulationState, simulationConductedTimestamp: new Date() }
	}
	return await setSimulationTransactions(ethereumClientService, simulationState,  getNonPrependedSimulatedTransactions(simulationState).map((x) => convertSimulatedTransactionToEthereumUnsignedTransactionWithWebsite(x)))
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
	let addedTransactions = 0n
	if (simulationState !== undefined && (blockTag === 'latest' || blockTag === 'pending' || blockTag === await ethereumClientService.getBlockNumber())) {
		// if we are on our simulated block, just count how many transactions we have sent in the simulation to increment transaction count
		if (simulationState === undefined) return await ethereumClientService.getTransactionCount(address, blockTag)
		for (const signed of simulationState.simulatedTransactions) {
			if (signed.signedTransaction.from === address) addedTransactions += 1n
		}
	}
	return (await ethereumClientService.getTransactionCount(address, blockTag)) + addedTransactions
}

export const getSimulatedTransactionReceipt = async (ethereumClientService: EthereumClientService, simulationState: SimulationState, hash: bigint): Promise<EthTransactionReceiptResponse> => {
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
				logs: simulatedTransaction.multicallResponse.statusCode === 'success' ? simulatedTransaction.multicallResponse.events.map((x, logIndex) => ({
					removed: false,
					blockHash: getHashOfSimulatedBlock(),
					address: x.loggersAddress,
					logIndex: BigInt(currentLogIndex + logIndex),
					data: x.data,
					topics: x.topics,
					blockNumber: blockNum,
					transactionIndex: BigInt(index),
					transactionHash: simulatedTransaction.signedTransaction.hash
				})) : [],
				logsBloom: 0x0n, //TODO: what should this be?
				status: simulatedTransaction.multicallResponse.statusCode
			}
		}
		currentLogIndex += simulatedTransaction.multicallResponse.statusCode === 'success' ? simulatedTransaction.multicallResponse.events.length : 0
	}
	return await ethereumClientService.getTransactionReceipt(hash)
}

export const getSimulatedBalance = async (ethereumClientService: EthereumClientService, simulationState: SimulationState, address: bigint, blockTag: EthereumBlockTag = 'latest'): Promise<bigint> => {
	if (await canQueryNodeDirectly(ethereumClientService, simulationState, blockTag) || simulationState === undefined) return await ethereumClientService.getBalance(address, blockTag)
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

export const getSimulatedCode = async (ethereumClientService: EthereumClientService, simulationState: SimulationState, address: bigint, blockTag: EthereumBlockTag = 'latest') => {
	if (await canQueryNodeDirectly(ethereumClientService, simulationState, blockTag)) {
		return {
			statusCode: 'success' as const,
			getCodeReturn: await ethereumClientService.getCode(address, blockTag)
		}
	}
	const blockNum = await ethereumClientService.getBlockNumber()

	const atInterface = new ethers.Interface(['function at(address) returns (uint256)'])
	const input = stringToUint8Array(atInterface.encodeFunctionData('at', [addressString(address)]))

	const getCodeTransaction = {
		type: '1559' as const,
		from: MOCK_ADDRESS,
		chainId: ethereumClientService.getChainId(),
		nonce: await ethereumClientService.getTransactionCount(MOCK_ADDRESS),
		maxFeePerGas: 0n,
		maxPriorityFeePerGas: 0n,
		gas: 94104n,
		to: GET_CODE_CONTRACT,
		value: 0n,
		input: input,
		accessList: []
	} as const
	const multiCall = await simulatedMulticall(ethereumClientService, simulationState, [getCodeTransaction], blockNum + 1n)
	return {
		statusCode: multiCall[multiCall.length - 1].statusCode,
		getCodeReturn: multiCall[multiCall.length - 1].returnValue
	}
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

export const getSimulatedBlock = async (ethereumClientService: EthereumClientService, simulationState: SimulationState, blockTag: EthereumBlockTag = 'latest', fullObjects: boolean = true): Promise<GetBlockReturn> => {
	if (simulationState == undefined || await canQueryNodeDirectly(ethereumClientService, simulationState, blockTag)) return await ethereumClientService.getBlock(blockTag, fullObjects)

	// make a mock block based on the previous block
	const parentBlock = await ethereumClientService.getBlock('latest', true)
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
		transactionsRoot: parentBlock.transactionsRoot // TODO: this is wrong
	} as const

	if (fullObjects) {
		return {
			...block,
			transactions: simulationState.simulatedTransactions.map( (simulatedTransaction) => {
				return simulatedTransaction.signedTransaction
			})
		}
	}

	return {
		...block,
		transactions: simulationState.simulatedTransactions.map( (simulatedTransaction) => simulatedTransaction.signedTransaction.hash)
	}
}

const getLogsOfSimulatedBlock = (simulationState: SimulationState, logFilter: EthGetLogsRequest): EthGetLogsResponse => {
	let events: unknown[] = []
	if (simulationState !== undefined) {
		for (const [index, sim] of simulationState.simulatedTransactions.entries()) {
			if (!('events' in sim.multicallResponse)) continue
			for (const event of sim.multicallResponse.events) {
				events.push({
					logIndex: BigInt(events.length),
					transactionIndex: BigInt(index),
					transactionHash: sim.signedTransaction.hash,
					blockHash: getHashOfSimulatedBlock(),
					blockNumber: simulationState.blockNumber,
					address: event.loggersAddress,
					data: event.data,
					topics: event.topics
				})
			}
		}
	}

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

	return EthGetLogsResponse.parse(events).filter((x) =>
		(logFilter.address === undefined
			|| x.address === logFilter.address
			|| (Array.isArray(logFilter.address) && logFilter.address.includes(x.address))
		)
		&& includeLogByTopic(x.topics, logFilter.topics)
	)
}

export const getSimulatedLogs = async (ethereumClientService: EthereumClientService, simulationState: SimulationState, logFilter: EthGetLogsRequest): Promise<EthGetLogsResponse> => {
	if ('blockHash' in logFilter) {
		if (logFilter.blockHash === getHashOfSimulatedBlock()) {
			return getLogsOfSimulatedBlock(simulationState, logFilter)
		}
	}
	if('fromBlock' in logFilter) {
		const logs = await ethereumClientService.getLogs(logFilter)
		if (simulationState && (logFilter.toBlock === 'latest' || logFilter.toBlock >= simulationState.blockNumber)) {
			return [...logs, ...getLogsOfSimulatedBlock(simulationState, logFilter)]
		} else {
			return logs
		}
	}
	return await ethereumClientService.getLogs(logFilter)
}

export const getSimulatedBlockNumber = async (ethereumClientService: EthereumClientService, simulationState: SimulationState, ) => {
	if (simulationState === undefined) return (await ethereumClientService.getBlockNumber()) + 1n
	return await ethereumClientService.getBlockNumber()
}

export const getSimulatedTransactionByHash = async (ethereumClientService: EthereumClientService, simulationState: SimulationState, hash: bigint): Promise<EthereumSignedTransactionWithBlockData|undefined> => {
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

export const getTokenDecimals = async (ethereumClientService: EthereumClientService, token: bigint) => {
	const tokenInterface = new ethers.Interface(['function decimals() view returns (uint8)'])
	const balanceOfCallData = stringToUint8Array(tokenInterface.encodeFunctionData('decimals'))
	const callParams = {
		from: MOCK_ADDRESS,
		to: token,
		input: balanceOfCallData,
	} as const
	const response = await ethereumClientService.call(callParams)
	return EthereumQuantity.parse(response)
}

export const simulatedCall = async (ethereumClientService: EthereumClientService, simulationState: SimulationState, params: Pick<IUnsignedTransaction1559, 'to' | 'from' | 'input' | 'value' | 'maxFeePerGas' | 'maxPriorityFeePerGas' | 'gasLimit'>, blockTag: EthereumBlockTag = 'latest') => {
	const transaction = {
		...params,
		type: '1559' as const,
		gas: params.gasLimit,
		nonce: 0n,
		chainId: ethereumClientService.getChainId()
	} as const

	const multicallResult = blockTag === 'latest' || blockTag === 'pending' ?
		await simulatedMulticall(ethereumClientService, simulationState, [transaction], await ethereumClientService.getBlockNumber() + 1n)
		: await simulatedMulticall(ethereumClientService, simulationState, [transaction], blockTag)
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
	return { result: EthereumData.serialize(callResult.returnValue) }
}

export const simulatedMulticall = async (ethereumClientService: EthereumClientService, simulationState: SimulationState, transactions: EthereumUnsignedTransaction[], blockNumber: bigint) => {
	const mergedTxs: EthereumUnsignedTransaction[] = getTransactionQueue(simulationState)
	return await ethereumClientService.multicall(mergedTxs.concat(transactions), blockNumber)
}

export const getHashOfSimulatedBlock = () => {
	return 0x1n
}

export const simulatePersonalSign = async (params: PersonalSignParams | SignTypedDataParams) => {
	if (params.method === 'personal_sign') {
		return await new ethers.Wallet(bytes32String(MOCK_PRIVATE_KEY)).signMessage(params.params[0])
	}
	return 'NOT IMPLEMENTED'
}

const getSimulatedTokenBalances = async (ethereumClientService: EthereumClientService, transactionQueue: EthereumUnsignedTransaction[], balances: { token: bigint, owner: bigint }[], blockNumber: bigint): Promise<TokenBalancesAfter> => {
	if (balances.length === 0) return []
	const tokenInterface = new ethers.Interface(['function balanceOf(address account) view returns (uint256)'])
	const transactions = balances.map((balanceRequest, index) => {
		const balanceOfCallData = stringToUint8Array(tokenInterface.encodeFunctionData('balanceOf', [addressString(balanceRequest.owner)]))
		return {
			type: '1559' as const,
			from: MOCK_ADDRESS + BigInt(index) + 1n,
			to: balanceRequest.token,
			value: 0n,
			input: balanceOfCallData,
			maxFeePerGas: 0n,
			maxPriorityFeePerGas: 0n,
			accessList: [],
			gas: 42000n,
			chainId: 0n,
			nonce: 0n,
		}
	})
	const transactionQueueSize = transactionQueue.length
	const response = await ethereumClientService.multicall(transactionQueue.concat(transactions), blockNumber)
	if (response.length !== transactions.length + transactionQueueSize) throw new Error('Multicall length mismatch')
	return balances.map((balance, index) => ({
		token: balance.token,
		owner: balance.owner,
		balance: response[transactionQueueSize + index].statusCode === 'success' ? bytesToUnsigned(response[transactionQueueSize + index].returnValue) : undefined
	}))
}

const getAddressesInteractedWithERC20s = (events: MulticallResponseEventLogs): { token: bigint, owner: bigint }[] => {
	const erc20ABI = [
		'event Transfer(address indexed from, address indexed to, uint256 value)',
		'event Approval(address indexed owner, address indexed spender, uint256 value)',
	]
	const erc20 = new ethers.Interface(erc20ABI)
	const tokenOwners: { token: bigint, owner: bigint }[] = []
	for (const log of events) {
		const parsed = erc20.parseLog({ topics: log.topics.map((x) => bytes32String(x)), data: dataStringWith0xStart(log.data) })
		if (parsed === null) continue
		switch (parsed.name) {
			case 'Approval':
			case 'Transfer': {
				tokenOwners.push({ token: log.loggersAddress, owner: EthereumAddress.parse(parsed.args[0]) })
				tokenOwners.push({ token: log.loggersAddress, owner: EthereumAddress.parse(parsed.args[1]) })
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
		const balances = await getSimulatedTokenBalances(
			ethereumClientService,
			signedTxs.slice(0, resultIndex + 1),
			getAddressesInteractedWithERC20s(singleResult.statusCode === 'success' ? singleResult.events : []),
			blockNumber
		)
		tokenBalancesAfter.push(balances)
	}
	return tokenBalancesAfter
}
