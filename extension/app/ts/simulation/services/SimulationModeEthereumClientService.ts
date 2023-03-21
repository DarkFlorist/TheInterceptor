import { EthereumClientService } from './EthereumClientService.js'
import { EthGetLogsResponse, EthereumUnsignedTransaction, EthereumSignedTransactionWithBlockData, EthereumBlockTag, EthGetLogsRequest, EthTransactionReceiptResponse, EstimateGasParamsVariables, EthSubscribeParams, JsonRpcMessage, JsonRpcNewHeadsNotification, PersonalSignParams, SignTypedDataParams, EthereumSignedTransaction, GetBlockReturn, EthereumData, EthereumQuantity } from '../../utils/wire-types.js'
import { bytes32String, max, min, stringToUint8Array } from '../../utils/bigint.js'
import { MOCK_ADDRESS } from '../../utils/constants.js'
import { ErrorWithData } from '../../utils/errors.js'
import { Future } from '../../utils/future.js'
import { ethers, keccak256 } from 'ethers'
import { SimulatedTransaction, SimulationState } from '../../utils/visualizer-types.js'
import { Website } from '../../utils/user-interface-types.js'
import { EthereumUnsignedTransactionToUnsignedTransaction, serializeSignedTransactionToBytes } from '../../utils/ethereum.js'

const MOCK_PRIVATE_KEY = 0x1n // key used to sign mock transactions
const GET_CODE_CONTRACT = 0x1ce438391307f908756fefe0fe220c0f0d51508an

type Subscription = {
	callback: (subscriptionId: string, reply: JsonRpcNewHeadsNotification) => void
	params: EthSubscribeParams,
	rpcSocket: WebSocket
}

export type EthereumUnsignedTransactionWithWebsite = EthereumUnsignedTransaction & { website: Website }

function convertSimulatedTransactionToEthereumUnsignedTransactionWithWebsite(tx: SimulatedTransaction) {
	return { ...tx.signedTransaction, website: tx.website }
}

export type ISimulationModeEthereumClientService = Pick<SimulationModeEthereumClientService, keyof SimulationModeEthereumClientService>
export class SimulationModeEthereumClientService {

	private ethereumClientService: EthereumClientService

	private prependTransactionsQueue: EthereumUnsignedTransactionWithWebsite[] = []

	private simulationState: SimulationState | undefined = undefined

	private webSocketConnectionString: string

	public constructor(ethereumClientService: EthereumClientService, webSocketConnectionString: string) {
		this.ethereumClientService = ethereumClientService
		this.webSocketConnectionString = webSocketConnectionString
	}

	public copy = () => {
		const newSimulation = new SimulationModeEthereumClientService(this.ethereumClientService, this.webSocketConnectionString)
		newSimulation.prependTransactionsQueue = [...this.prependTransactionsQueue]
		if (this.simulationState) {
			newSimulation.simulationState = {
				simulatedTransactions: [...this.simulationState.simulatedTransactions],
				blockNumber: this.simulationState?.blockNumber,
				blockTimestamp: this.simulationState?.blockTimestamp,
				chain: this.simulationState.chain,
				simulationConductedTimestamp: this.simulationState.simulationConductedTimestamp,
			}
		}
		newSimulation.prependTransactionsQueue = [...this.prependTransactionsQueue]
		return newSimulation
	}

	public getSimulationStack = () => {
		if (this.simulationState === undefined) return []
		return this.simulationState.simulatedTransactions.map((x) => ({
			...x.signedTransaction,
			...x.multicallResponse,
			realizedGasPrice: x.realizedGasPrice,
			gasLimit: x.signedTransaction.gas,
		}))
	}

	public transactionQueueTotalGasLimit = () => {
		if ( this.simulationState === undefined) return 0n
		return this.simulationState.simulatedTransactions.reduce((a, b) => a + b.signedTransaction.gas, 0n)
	}

	public readonly estimateGas = async (data: EstimateGasParamsVariables) => {
		const sendAddress = data.from !== undefined ? data.from : MOCK_ADDRESS
		const transactionCount = this.getTransactionCount(sendAddress)
		const block = await this.ethereumClientService.getBlock()
		const maxGas = block.gasLimit * 1023n / 1024n - this.transactionQueueTotalGasLimit()
		const tmp = {
			type: '1559' as const,
			from: sendAddress,
			chainId: await this.getChainId(),
			nonce: await transactionCount,
			maxFeePerGas: data.gasPrice !== undefined ? data.gasPrice : 0n,
			maxPriorityFeePerGas: 2n,
			gas: data.gas === undefined ? maxGas : data.gas,
			to: data.to,
			value: data.value === undefined ? 0n : data.value,
			input: data.data === undefined ? new Uint8Array(0) : data.data,
			accessList: []
		}
		const multiCall = await this.multicall([tmp], block.number + 1n)
		const gasSpent = multiCall[multiCall.length - 1].gasSpent * 12n / 10n
		return gasSpent < maxGas ? gasSpent : maxGas
	}

	// calculates gas price for receipts
	public calculateGasPrice(transaction: EthereumUnsignedTransaction, gasUsed: bigint, gasLimit: bigint, baseFeePerGas: bigint) {
		if( 'gasPrice' in transaction) {
			return transaction.gasPrice
		}
		const baseFee = this.getBaseFeePerGasForNewBlock(gasUsed, gasLimit, baseFeePerGas)
		return min(baseFee + transaction.maxPriorityFeePerGas, transaction.maxFeePerGas)
	}

	public static mockSignTransaction = async (transaction: EthereumUnsignedTransaction) : Promise<EthereumSignedTransaction> => {
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

	public appendTransaction = async (transaction: EthereumUnsignedTransactionWithWebsite) => {
		const signed = await SimulationModeEthereumClientService.mockSignTransaction(transaction)
		const parentBlock = await this.ethereumClientService.getBlock()
		if ( this.simulationState === undefined ) {
			const multicallResult = await this.multicall([transaction], parentBlock.number)
			if (multicallResult.length != 1) throw 'multicall length does not match'
			this.simulationState = {
				simulatedTransactions: [{
					multicallResponse: multicallResult[0],
					signedTransaction: signed,
					realizedGasPrice: this.calculateGasPrice(transaction, parentBlock.gasUsed, parentBlock.gasLimit, parentBlock.baseFeePerGas),
					website: transaction.website,
				}],
				blockNumber: parentBlock.number,
				blockTimestamp: parentBlock.timestamp,
				chain: await this.ethereumClientService.getChain(),
				simulationConductedTimestamp: new Date(),
			}
			return { signed: signed, simulationState: this.simulationState }
		}

		const signedTxs = this.simulationState.simulatedTransactions.map((x) => x.signedTransaction ).concat([signed])
		const multicallResult = await this.multicall([transaction], parentBlock.number)
		const websites = this.simulationState.simulatedTransactions.map((x) => x.website ).concat(transaction.website)
		if (multicallResult.length !== signedTxs.length || websites.length !== signedTxs.length) throw 'multicall length does not match'

		this.simulationState = {
			simulatedTransactions: multicallResult.map( (singleResult, index) => ({
				multicallResponse: singleResult,
				signedTransaction: signedTxs[index],
				realizedGasPrice: this.calculateGasPrice(signedTxs[index], parentBlock.gasUsed, parentBlock.gasLimit, parentBlock.baseFeePerGas),
				website: websites[index],
			})),
			blockNumber: parentBlock.number,
			blockTimestamp: parentBlock.timestamp,
			chain: await this.ethereumClientService.getChain(),
			simulationConductedTimestamp: new Date(),
		}

		return { signed: signed, simulationState: this.simulationState }
	}

	public setTransactions = async (unsignedTxts: EthereumUnsignedTransactionWithWebsite[]) => {
		if (unsignedTxts.length === 0) {
			const block = await this.ethereumClientService.getBlock()
			this.simulationState = {
				simulatedTransactions: [],
				blockNumber: block.number,
				blockTimestamp: block.timestamp,
				chain: await this.ethereumClientService.getChain(),
				simulationConductedTimestamp: new Date(),
			}
		}

		let signedTxs: EthereumSignedTransaction[] = []
		for (const transaction of unsignedTxts) {
			signedTxs.push(await SimulationModeEthereumClientService.mockSignTransaction(transaction))
		}
		const parentBlock = await this.ethereumClientService.getBlock()
		const multicallResult = await this.ethereumClientService.multicall(unsignedTxts, parentBlock.number)
		if (multicallResult.length !== signedTxs.length) throw 'multicall length does not match'

		this.simulationState = {
			simulatedTransactions: multicallResult.map( (singleResult, index) => ({
				multicallResponse: singleResult,
				unsignedTransaction: unsignedTxts[index],
				signedTransaction: signedTxs[index],
				realizedGasPrice: this.calculateGasPrice(unsignedTxts[index], parentBlock.gasUsed, parentBlock.gasLimit, parentBlock.baseFeePerGas),
				website: unsignedTxts[index].website,
			})),
			blockNumber: parentBlock.number,
			blockTimestamp: parentBlock.timestamp,
			chain: await this.ethereumClientService.getChain(),
			simulationConductedTimestamp: new Date(),
		}
		return this.simulationState
	}

	public getTransactionQueue = () => {
		if ( this.simulationState === undefined ) return []
		return this.simulationState.simulatedTransactions.map((x) => x.signedTransaction)
	}
	public getPrependTransactionsQueue = () => this.prependTransactionsQueue

	public setPrependTransactionsQueue = async (prepend: EthereumUnsignedTransactionWithWebsite[]) => {
		this.prependTransactionsQueue = prepend
		if (prepend.length > 0) {
			return await this.setTransactions(prepend)
		}
		const block = await this.ethereumClientService.getBlock()
		this.simulationState = {
			simulatedTransactions: [],
			blockNumber: block.number,
			blockTimestamp: block.timestamp,
			chain: await this.ethereumClientService.getChain(),
			simulationConductedTimestamp: new Date(),
		}
		return this.simulationState
	}

	public removeTransaction = async (transactionHash: bigint) => {
		if ( this.simulationState === undefined) return this.simulationState
		const filtered = this.simulationState.simulatedTransactions.filter( (transaction) => transaction.signedTransaction.hash !== transactionHash)
		return await this.setTransactions(filtered.map((x) => convertSimulatedTransactionToEthereumUnsignedTransactionWithWebsite(x)))
	}

	public removeTransactionAndUpdateTransactionNonces = async (transactionHash: bigint) => {
		if ( this.simulationState === undefined ) return this.simulationState
		const transactionToBeRemoved = this.simulationState.simulatedTransactions.find( (transaction) => transaction.signedTransaction.hash === transactionHash)
		if ( transactionToBeRemoved == undefined ) return this.simulationState

		let newTransactions: EthereumUnsignedTransactionWithWebsite[] = []
		let transactionWasFound = false

		for (const transaction of this.simulationState.simulatedTransactions) {
			if ( transactionHash === transaction.signedTransaction.hash ) {
				transactionWasFound = true
				continue
			}
			const shouldUpdateNonce = transactionWasFound && transaction.signedTransaction.from === transactionToBeRemoved.signedTransaction.from
			const newTransaction = { ...transaction.signedTransaction, ...(shouldUpdateNonce ? { nonce: transaction.signedTransaction.nonce - 1n } : {}) }
			newTransactions.push({ ...newTransaction, website: transaction.website })
		}
		return await this.setTransactions(newTransactions)
	}

	public refreshSimulation = async () => {
		if ( this.simulationState === undefined ) return await this.resetSimulation()
		if ( this.simulationState.blockNumber == await this.ethereumClientService.getBlockNumber() ) {
			// if block number is the same, we don't need to compute anything as nothing has changed, but let's update timestamp to show the simulation was refreshed for this time
			return { ...this.simulationState, simulationConductedTimestamp: new Date() }
		}
		return await this.setTransactions(this.simulationState.simulatedTransactions.map((x) => convertSimulatedTransactionToEthereumUnsignedTransactionWithWebsite(x)))
	}

	public resetSimulation = async () => {
		return await this.setPrependTransactionsQueue(this.prependTransactionsQueue)
	}

	public readonly getStorageAt = async (contract: bigint, slot: bigint) => {
		//todo, requires plugin work...
		return await this.ethereumClientService.getStorageAt(contract, slot)
	}

	canQueryNodeDirectly = async (blockTag: EthereumBlockTag = 'latest') => {
		if ( this.simulationState === undefined
			|| this.simulationState.simulatedTransactions.length == 0 ||
			(typeof blockTag === 'bigint' && blockTag <= await this.ethereumClientService.getBlockNumber())
		){
			return true
		}
		return false
	}

	public readonly getTransactionCount = async (address: bigint, blockTag: EthereumBlockTag = 'latest') => {
		let addedTransactions = 0n
		if (blockTag === 'latest' || blockTag === 'pending' || blockTag === await this.getBlockNumber()) {
			// if we are on our simulated block, just count how many transactions we have sent in the simulation to increment transaction count
			if ( this.simulationState === undefined ) return await this.ethereumClientService.getTransactionCount(address, blockTag)
			for (const signed of this.simulationState.simulatedTransactions) {
				if (signed.signedTransaction.from === address) addedTransactions += 1n
			}
		}
		return (await this.ethereumClientService.getTransactionCount(address, blockTag)) + addedTransactions
	}

	public readonly getTransactionReceipt = async (hash: bigint): Promise<EthTransactionReceiptResponse> => {
		let cumGas = 0n
		let currentLogIndex = 0
		if (this.simulationState === undefined ) { return await this.ethereumClientService.getTransactionReceipt(hash)}

		for (const [index, simulatedTransaction] of this.simulationState.simulatedTransactions.entries()) {
			cumGas += simulatedTransaction.multicallResponse.gasSpent
			if(hash === simulatedTransaction.signedTransaction.hash) {
				const blockNum = await this.getBlockNumber()
				return {
					type: simulatedTransaction.signedTransaction.type,
					blockHash: this.getHashOfSimulatedBlock(),
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
						blockHash: this.getHashOfSimulatedBlock(),
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
		return await this.ethereumClientService.getTransactionReceipt(hash)
	}

	public readonly getBalance = async (address: bigint, blockTag: EthereumBlockTag = 'latest'): Promise<bigint> => {
		if (await this.canQueryNodeDirectly(blockTag) || this.simulationState === undefined) return await this.ethereumClientService.getBalance(address, blockTag)
		const balances = new Map<bigint, bigint>()
		for (const transaction of this.simulationState.simulatedTransactions) {
			if (transaction.multicallResponse.statusCode !== 'success') continue

			for (const b of transaction.multicallResponse.balanceChanges) {
				balances.set(b.address, b.after)
			}
		}
		if (balances.has(address)) {
			return balances.get(address)!
		}
		return await this.ethereumClientService.getBalance(address, blockTag)
	}

	public readonly getCode = async (address: bigint, blockTag: EthereumBlockTag = 'latest') => {
		if (await this.canQueryNodeDirectly(blockTag)) return await this.ethereumClientService.getCode(address, blockTag)
		const blockNum = await this.ethereumClientService.getBlockNumber()

		const atInterface = new ethers.Interface(['function at(address) returns (uint256)'])
		const input = stringToUint8Array(atInterface.encodeFunctionData('at', [address]))

		const getCodeTransaction = {
			type: '1559' as const,
			from: MOCK_ADDRESS,
			chainId: await this.getChainId(),
			nonce: await this.getTransactionCount(MOCK_ADDRESS),
			maxFeePerGas: 0n,
			maxPriorityFeePerGas: 0n,
			gas: await this.estimateGas( {
				from: MOCK_ADDRESS,
				to: GET_CODE_CONTRACT,
				data: input,
				value: 0n,
				gasPrice: 0n,
			}),
			to: GET_CODE_CONTRACT,
			value: 0n,
			input: input,
			accessList: []
		}
		const multiCall = await this.multicall([getCodeTransaction], blockNum + 1n)
		return multiCall[multiCall.length-1].returnValue
	}

	private readonly getBaseFeePerGasForNewBlock = (parent_gas_used: bigint, parent_gas_limit: bigint, parent_base_fee_per_gas: bigint) => {
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

	public readonly getBlock = async (blockTag: EthereumBlockTag = 'latest', fullObjects: boolean = true): Promise<GetBlockReturn> => {
		if (this.simulationState == undefined || await this.canQueryNodeDirectly(blockTag)) return await this.ethereumClientService.getBlock(blockTag, fullObjects)

		// make a mock block based on the previous block
		const parentBlock = await this.ethereumClientService.getBlock('latest', true)
		const block = {
			author: parentBlock.miner,
			difficulty: parentBlock.difficulty,
			extraData: parentBlock.extraData,
			gasLimit: parentBlock.gasLimit,
			gasUsed: this.transactionQueueTotalGasLimit(),
			hash: this.getHashOfSimulatedBlock(),
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
			baseFeePerGas: this.getBaseFeePerGasForNewBlock(parentBlock.gasUsed, parentBlock.gasLimit, parentBlock.baseFeePerGas),
			transactionsRoot: parentBlock.transactionsRoot // TODO: this is wrong
		}

		if (fullObjects) {
			return {
				...block,
				transactions: this.simulationState.simulatedTransactions.map( (simulatedTransaction) => {
					return simulatedTransaction.signedTransaction
				})
			}
		}

		return {
			...block,
			transactions: this.simulationState.simulatedTransactions.map( (simulatedTransaction) => simulatedTransaction.signedTransaction.hash)
		}
	}

	public readonly getChainId = async () => {
		return await this.ethereumClientService.getChainId()
	}

	private getSimulatedLogs = async (logFilter: EthGetLogsRequest): Promise<EthGetLogsResponse> => {
		let events: unknown[] = []
		if (this.simulationState !== undefined) {
			const blockNum = await this.getBlockNumber()
			for (const [index, sim] of this.simulationState.simulatedTransactions.entries()) {
				if (!('events' in sim.multicallResponse)) continue

				for (const event of sim.multicallResponse.events) {
					events.push({
						logIndex: BigInt(events.length),
						transactionIndex: BigInt(index),
						transactionHash: sim.signedTransaction.hash,
						blockHash: this.getHashOfSimulatedBlock(),
						blockNumber: blockNum,
						address: event.loggersAddress,
						data: event.data,
						topics: event.topics
					})
				}
			}
		}
		//TODO: handle other filter options
		return EthGetLogsResponse.parse(events).filter((x) => logFilter.address === undefined || x.address === logFilter.address)
	}

	public readonly getLogs = async (logFilter: EthGetLogsRequest): Promise<EthGetLogsResponse> => {
		if ('blockHash' in logFilter) {
			if (logFilter.blockHash === this.getHashOfSimulatedBlock()) {
				return (await this.getSimulatedLogs(logFilter))
			}
		}
		if('fromBlock' in logFilter) {
			const logs = await this.ethereumClientService.getLogs(logFilter)
			if(logFilter.toBlock === 'latest' || logFilter.toBlock === await this.getBlockNumber() ) {
				return [...logs, ...await this.getSimulatedLogs(logFilter)]
			}
			return logs
		}
		return await this.ethereumClientService.getLogs(logFilter)
	}

	public readonly getBlockNumber = async () => {
		if (this.simulationState === undefined) return (await this.ethereumClientService.getBlockNumber()) + 1n
		return await this.ethereumClientService.getBlockNumber()
	}

	public readonly getTransactionByHash = async (hash: bigint): Promise<EthereumSignedTransactionWithBlockData|undefined> => {
		// try to see if the transaction is in our queue
		if ( this.simulationState === undefined ) return await this.ethereumClientService.getTransactionByHash(hash)
		for (const [index, simulatedTransaction] of this.simulationState.simulatedTransactions.entries()) {
			if (hash === simulatedTransaction.signedTransaction.hash) {
				const v = 'v' in simulatedTransaction.signedTransaction ? simulatedTransaction.signedTransaction.v : (simulatedTransaction.signedTransaction.yParity === 'even' ? 0n : 1n)
				const additionalParams = {
					blockHash: this.getHashOfSimulatedBlock(),
					blockNumber: await this.getBlockNumber(),
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
		return await this.ethereumClientService.getTransactionByHash(hash)
	}

	public readonly call = async (transaction: EthereumUnsignedTransaction, blockTag: EthereumBlockTag = 'latest') => {
		const multicallResult = blockTag === 'latest' || blockTag === 'pending' ?
			await this.multicall([transaction], await this.ethereumClientService.getBlockNumber() + 1n)
			: await this.multicall([transaction], blockTag)
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

	public readonly multicall = async (transactions: readonly EthereumUnsignedTransaction[], blockNumber: bigint) => {
		const mergedTxs: EthereumUnsignedTransaction[] = this.getTransactionQueue()
		return await this.ethereumClientService.multicall(mergedTxs.concat(transactions), blockNumber)
	}

	public readonly getHashOfSimulatedBlock = () => {
		return 0x1n
	}

	public readonly personalSign = async (params: PersonalSignParams | SignTypedDataParams) => {
		if (params.method === 'personal_sign') {
			return await new ethers.Wallet(bytes32String(MOCK_PRIVATE_KEY)).signMessage(params.params[0])
		}
		return 'NOT IMPLEMENTED'
	}

	private subscriptions = new Map<string, Subscription>()
	private subscriptionSocket = new Map<WebSocket, string>()

	public readonly remoteSubscription = (subscriptionId: string) => {
		if(this.subscriptions.has(subscriptionId)) {
			this.subscriptions.get(subscriptionId)?.rpcSocket.close()
			this.subscriptions.delete(subscriptionId)
			return true
		}
		return false
	}

	public readonly createSubscription = async (params: EthSubscribeParams, callback: (subscriptionId: string, reply: JsonRpcNewHeadsNotification) => void) => {
		switch(params.params[0]) {
			case 'newHeads': {
				const rpcSocket = new WebSocket(this.webSocketConnectionString)
				const subscriptionId = new Future<string>()

				rpcSocket.addEventListener('open', _event => {
					const request = { jsonrpc: '2.0', id: 0, method: 'eth_subscribe', params: ['newHeads'] }
					rpcSocket.send(JSON.stringify(request))
				})

				rpcSocket.addEventListener('close', event => {
					if (event.code === 1000) return
					if (this.subscriptionSocket.has(rpcSocket)) {
						this.subscriptions.delete(this.subscriptionSocket.get(rpcSocket)!)
						this.subscriptionSocket.delete(rpcSocket)
					}
					throw new Error(`Websocket disconnected with code ${event.code} and reason: ${event.reason}`)
				})

				rpcSocket.addEventListener('message', event => {
					const subResponse = JsonRpcMessage.parse(JSON.parse(event.data))
					if ('error' in subResponse) {
						throw new ErrorWithData(`Websocket error`, subResponse.error)
					}
					if ('id' in subResponse && 'result' in subResponse) {
						if (typeof subResponse.result !== 'string') throw new ErrorWithData(`Expected rpc payload to be a string but it was a ${typeof event.data}`, event.data)
						return subscriptionId.resolve(subResponse.result)
					}
					try {
						if (typeof event.data !== 'string') throw new ErrorWithData(`Expected rpc payload to be a string but it was a ${typeof event.data}`, event.data)
						const jsonRpcNotification = JsonRpcNewHeadsNotification.parse(JSON.parse(event.data))
						if (jsonRpcNotification['method'] === 'eth_subscription') {
							return callback(jsonRpcNotification.params.subscription, jsonRpcNotification)
						} else {
							throw('not eth_subscription')
						}
					} catch (error: unknown) {
						console.error(error)
					}
				})

				rpcSocket.addEventListener('error', event => {
					throw new ErrorWithData(`Websocket error`, event)
				})

				const subId = await subscriptionId

				this.subscriptions.set(subId, {
					callback: callback,
					params: params,
					rpcSocket: rpcSocket
				})
				this.subscriptionSocket.set(rpcSocket, subId)

				return subId
			}
			case 'logs': throw `Dapp requested for 'logs' subscription but it's not implemented`
			case 'newPendingTransactions': throw `Dapp requested for 'newPendingTransactions' subscription but it's not implemented`
			case 'syncing': throw `Dapp requested for 'syncing' subscription but it's not implemented`
		}
	}
}
