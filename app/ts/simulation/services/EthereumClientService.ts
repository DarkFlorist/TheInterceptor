import { EthereumUnsignedTransaction, EthereumSignedTransactionWithBlockData, EthereumQuantity, EthereumBlockTag, EthereumData, EthereumBlockHeader, EthereumBlockHeaderWithTransactionHashes, EthereumAddress } from '../../types/wire-types.js'
import { IUnsignedTransaction1559 } from '../../utils/ethereum.js'
import { TIME_BETWEEN_BLOCKS, MOCK_ADDRESS, MULTICALL3, Multicall3ABI } from '../../utils/constants.js'
import { IEthereumJSONRpcRequestHandler } from './EthereumJSONRpcRequestHandler.js'
import { Interface, LogDescription, ethers } from 'ethers'
import { stringToUint8Array, addressString, bytes32String, dataStringWith0xStart } from '../../utils/bigint.js'
import { BlockCalls, ExecutionSpec383MultiCallResult, CallResultLog } from '../../types/multicall-types.js'
import { MulticallResponse, EthGetStorageAtResponse, EthTransactionReceiptResponse, EthGetLogsRequest, EthGetLogsResponse, DappRequestTransaction } from '../../types/JsonRpc-types.js'
import { assertNever } from '../../utils/typescript.js'
import { parseLogIfPossible } from './SimulationModeEthereumClientService.js'

export type IEthereumClientService = Pick<EthereumClientService, keyof EthereumClientService>
export class EthereumClientService {
	private cachedBlock: EthereumBlockHeader | undefined = undefined
	private cacheRefreshTimer: NodeJS.Timer | undefined = undefined
	private lastCacheAccess: number = 0
	private retrievingBlock: boolean = false
	private newBlockAttemptCallback: (blockHeader: EthereumBlockHeader, ethereumClientService: EthereumClientService, isNewBlock: boolean) => void
	private onErrorBlockCallback: (ethereumClientService: EthereumClientService) => void
	private requestHandler
	private cleanedUp = false

    constructor(requestHandler: IEthereumJSONRpcRequestHandler, newBlockAttemptCallback: (blockHeader: EthereumBlockHeader, ethereumClientService: EthereumClientService, isNewBlock: boolean) => void, onErrorBlockCallback: (ethereumClientService: EthereumClientService) => void) {
		this.requestHandler = requestHandler
		this.newBlockAttemptCallback = newBlockAttemptCallback
		this.onErrorBlockCallback = onErrorBlockCallback
    }

	public readonly getRpcNetwork = () => this.requestHandler.getRpcNetwork()
	
	public readonly getNewBlockAttemptCallback = () => this.newBlockAttemptCallback
	public readonly getOnErrorBlockCallback = () => this.onErrorBlockCallback

	public getLastKnownCachedBlockOrUndefined = () => this.cachedBlock

	public getCachedBlock() {
		if (this.cleanedUp === false) {
			this.setBlockPolling(true)
		}
		this.lastCacheAccess = Date.now()
		return this.cachedBlock
	}

	public cleanup = () => {
		this.cleanedUp = true
		this.setBlockPolling(false)
	}

	public readonly setBlockPolling = (enabled: boolean) => {
		if (enabled && this.cacheRefreshTimer === undefined) {
			const now = Date.now()

			// query block everytime clock hits time % 12 + 7
			this.updateCache()
			const timeToTarget = Math.floor(now / 1000 / TIME_BETWEEN_BLOCKS) * 1000 * TIME_BETWEEN_BLOCKS + 7 * 1000 - now
			this.cacheRefreshTimer = setTimeout( () => { // wait until the clock is just right ( % 12 + 7 ), an then start querying every TIME_BETWEEN_BLOCKS secs
				this.updateCache()
				this.cacheRefreshTimer = setInterval(this.updateCache, TIME_BETWEEN_BLOCKS * 1000)
				if (this.lastCacheAccess - Date.now() > 180000) {
					this.setBlockPolling(false)
				}
			}, timeToTarget > 0 ? timeToTarget : timeToTarget + TIME_BETWEEN_BLOCKS * 1000 )
			return
		}
		if (!enabled) {
			clearTimeout(this.cacheRefreshTimer)
			clearInterval(this.cacheRefreshTimer)
			this.cacheRefreshTimer = undefined
			this.cachedBlock = undefined
			return
		}
	}

	private readonly updateCache = async () => {
		if (this.retrievingBlock) return
		try {
			this.retrievingBlock = true
			const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_getBlockByNumber', params: ['latest', true] })
			if (this.cacheRefreshTimer === undefined) return
			const newBlock = EthereumBlockHeader.parse(response)
			console.log(`Current block number: ${ newBlock.number }`)
			this.newBlockAttemptCallback(newBlock, this, this.cachedBlock?.number != newBlock.number)
			this.cachedBlock = newBlock
		} catch(error) {
			console.warn(error)
			return this.onErrorBlockCallback(this)
		} finally {
			this.retrievingBlock = false
		}
	}

	public readonly estimateGas = async (data: DappRequestTransaction) => {
		const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_estimateGas', params: [data] } )
		return EthereumQuantity.parse(response)
	}

	public readonly getStorageAt = async (contract: bigint, slot: bigint, blockTag: EthereumBlockTag = 'latest') => {
		const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_getStorageAt', params: [contract, slot, blockTag] })
		return EthGetStorageAtResponse.parse(response)
	}

	public readonly getTransactionCount = async (address: bigint, blockTag: EthereumBlockTag = 'latest') => {
		const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_getTransactionCount', params: [address, blockTag] })
		return EthereumQuantity.parse(response)
	}

	public readonly getTransactionReceipt = async (hash: bigint) => {
		const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_getTransactionReceipt', params: [hash] })
		return EthTransactionReceiptResponse.parse(response)
	}

	public readonly getBalance = async (address: bigint, blockTag: EthereumBlockTag = 'latest') => {
		const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_getBalance', params: [address, blockTag] })
		return EthereumQuantity.parse(response)
	}

	public readonly getCode = async (address: bigint, blockTag: EthereumBlockTag = 'latest') => {
		const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_getCode', params: [address, blockTag] })
		return EthereumData.parse(response)
	}

	public async getBlock(blockTag?: EthereumBlockTag, fullObjects?: true): Promise<EthereumBlockHeader>
	public async getBlock(blockTag: EthereumBlockTag, fullObjects: boolean): Promise<EthereumBlockHeaderWithTransactionHashes | EthereumBlockHeader>
	public async getBlock(blockTag: EthereumBlockTag, fullObjects: false): Promise<EthereumBlockHeaderWithTransactionHashes>
	public async getBlock(blockTag: EthereumBlockTag = 'latest', fullObjects: boolean = true): Promise<EthereumBlockHeaderWithTransactionHashes | EthereumBlockHeader> {
		const cached = this.getCachedBlock()
		if (cached && (blockTag === 'latest' || blockTag === cached.number)) {
			if (fullObjects === false) {
				return { ...cached, transactions: cached.transactions.map((transaction) => transaction.hash) }
			}
			return cached
		}
		if (fullObjects === false) {
			return EthereumBlockHeaderWithTransactionHashes.parse(await this.requestHandler.jsonRpcRequest({ method: 'eth_getBlockByNumber', params: [blockTag, false] }))
		}
		return EthereumBlockHeader.parse(await this.requestHandler.jsonRpcRequest({ method: 'eth_getBlockByNumber', params: [blockTag, fullObjects] }))
	}

	public readonly getChainId = () => this.requestHandler.getRpcNetwork().chainId

	public readonly getLogs = async (logFilter: EthGetLogsRequest) => {
		const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_getLogs', params: [logFilter] })
		return EthGetLogsResponse.parse(response)
	}

	public readonly getBlockNumber = async () => {
		const cached = this.getCachedBlock()
		if (cached) {
			return cached.number
		}
		const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_blockNumber' })
		return EthereumQuantity.parse(response)
	}

	public readonly getGasPrice = async() => {
		const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_gasPrice' })
		return EthereumQuantity.parse(response)
	}

	public readonly getTransactionByHash = async (hash: bigint) => {
		const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_getTransactionByHash', params: [hash] })
		if( response === null) return undefined
		return EthereumSignedTransactionWithBlockData.parse(response)
	}

	public readonly call = async (transaction: Partial<Pick<IUnsignedTransaction1559, 'to' | 'from' | 'input' | 'value' | 'maxFeePerGas' | 'maxPriorityFeePerGas' | 'gasLimit'>>, blockTag: EthereumBlockTag = 'latest') => {
		if (transaction.to === null) throw new Error('To cannot be null')
		const params = {
			to: transaction.to,
			from: transaction.from,
			data: transaction.input,
			value: transaction.value,
			...transaction.maxFeePerGas !== undefined && transaction.maxPriorityFeePerGas !== undefined ? { gasPrice: transaction.maxFeePerGas + transaction.maxPriorityFeePerGas } : {},
			gas: transaction.gasLimit
		}
		const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_call', params: [params, blockTag] })
		return response as string
	}

	public readonly multicall = async (transactions: readonly EthereumUnsignedTransaction[], blockNumber: bigint) => {
		const httpsRpc = this.requestHandler.getRpcNetwork().httpsRpc
		if (httpsRpc === 'https://rpc.dark.florist/winedancemuffinborrow' || httpsRpc === 'https://rpc.dark.florist/birdchalkrenewtip') {
			//TODO: Remove this when we get rid of our old multicall
			return this.executionSpec383MultiCallOnlyTransactions(transactions, blockNumber)
		}

		const blockAuthor: bigint = MOCK_ADDRESS
		const unvalidatedResult = await this.requestHandler.jsonRpcRequest({ method: 'eth_multicall', params: [blockNumber, blockAuthor, transactions] })
		return MulticallResponse.parse(unvalidatedResult)
	}

	public readonly executionSpec383MultiCall = async (blockStateCalls: readonly BlockCalls[], blockTag: EthereumBlockTag) => {
		const parentBlock = await this.getBlock()
		const call = {
			method: 'eth_multicallV1',
			params: [{
				blockStateCalls: blockStateCalls,
				traceTransfers: true,
				validation: false,
			},
			blockTag === parentBlock.number + 1n ? blockTag - 1n : blockTag
		] } as const
		const unvalidatedResult = await this.requestHandler.jsonRpcRequest(call)
		return ExecutionSpec383MultiCallResult.parse(unvalidatedResult)
	}

	public readonly getEthBalancesOfAccounts = async (blockNumber: bigint, accounts: readonly EthereumAddress[]) => {
		if (accounts.length === 0) return []
		const IMulticall3 = new Interface(Multicall3ABI)
		const ethBalanceQueryInput = stringToUint8Array(IMulticall3.encodeFunctionData('aggregate3', [accounts.map((account) => ({
			target: addressString(MULTICALL3),
			allowFailure: false,
			callData: IMulticall3.encodeFunctionData('getEthBalance', [addressString(account)])
		}))]))
		const callTransaction: EthereumUnsignedTransaction = {
			type: '1559' as const,
			from: MOCK_ADDRESS,
			to: MULTICALL3,
			value: 0n,
			input: ethBalanceQueryInput,
			maxFeePerGas: 0n,
			maxPriorityFeePerGas: 0n,
			gas: 15_000_000n,
			nonce: 0n,
			chainId: this.getChainId(),
		} as const
		const parentBlock = await this.getBlock()
		const multicallResults = await this.executionSpec383MultiCall([{
			calls: [callTransaction],
			blockOverride: {
				number: blockNumber + 1n,
				prevRandao: 0x1n,
				time: new Date(parentBlock.timestamp.getTime() + 12 * 1000),
				gasLimit: parentBlock.gasLimit,
				feeRecipient: parentBlock.miner,
				baseFee: parentBlock.baseFeePerGas === undefined ? 15000000n : parentBlock.baseFeePerGas
			},
		}], blockNumber)
		if (multicallResults.length !== 1) throw new Error('multicall returned too many or too few blocks')
		const callResults = multicallResults[0]
		if (callResults.calls.length !== 1) throw new Error('invalid multicall results length')
		const aggregate3CallResult = callResults.calls[0]
		if (aggregate3CallResult.status === 'failure' || aggregate3CallResult.status === 'invalid') throw Error('Failed aggregate3')
		const multicallReturnData: { success: boolean, returnData: string }[] = IMulticall3.decodeFunctionResult('aggregate3', dataStringWith0xStart(aggregate3CallResult.return))[0]
		
		if (multicallReturnData.length !== accounts.length) throw Error('Got wrong number of balances back')
		return multicallReturnData.map((singleCallResult, callIndex) => {
			if (singleCallResult.success === false) throw new Error('aggregate3 failed to get eth balance')
			return { address: accounts[callIndex], balance: EthereumQuantity.parse(singleCallResult.returnData) }
		})
	}

	public readonly getBalanceChanges = async (blockNumber: bigint, events: readonly (readonly CallResultLog[])[], senders: readonly EthereumAddress[]) => {
		const parseEthLogs = (logs: readonly CallResultLog[]) => {
			return logs.filter((log) => log.address == 0n).map((log) => parseLogIfPossible(erc20, { topics: log.topics.map((x) => bytes32String(x)), data: dataStringWith0xStart(log.data) })).filter((x): x is LogDescription => x !== null)
		}
		const erc20ABI = ['event Transfer(address indexed from, address indexed to, uint256 value)']
		const erc20 = new ethers.Interface(erc20ABI)
		const flattenedLogs = events.flat()
		const parsedEthLogs = parseEthLogs(flattenedLogs)
		const extractEthSender = (log: LogDescription) => EthereumAddress.parse(log.args[0])
		const extractEthReceiver = (log: LogDescription) => EthereumAddress.parse(log.args[1])
		const addressesWithEthTransfers = new Set<bigint>(parsedEthLogs.map(extractEthSender).concat(parsedEthLogs.map(extractEthReceiver).concat(senders)))
		const initialBalances = await this.getEthBalancesOfAccounts(blockNumber, Array.from(addressesWithEthTransfers))
		const currentBalance = new Map<string, bigint>(initialBalances.map((balance) => [addressString(balance.address), balance.balance]))
		
		const balanceChanges = []
		for (const [index, logs] of events.entries()) {
			const senderBalance = currentBalance.get(addressString(senders[index]))
			if (senderBalance === undefined) throw new Error('sender ETH balance is missing')
			const changesForCall = [{
				address: senders[index],
				before: senderBalance,
				after: senderBalance,
			}]
			const parsedLogsForCall = parseEthLogs(logs)
			for (const parsed of parsedLogsForCall) {
				if (parsed === null) continue
				if (parsed.name !== 'Transfer') throw new Error(`wrong name: ${ parsed.name }`)
				const from = extractEthSender(parsed)
				const to = extractEthReceiver(parsed)
				const amount = parsed.args[2]
				const previousFromBalance = currentBalance.get(addressString(from))
				const previousToBalance = currentBalance.get(addressString(to))
				if (previousFromBalance === undefined || previousToBalance === undefined) throw new Error('Did not find previous ETH balance')
				currentBalance.set(addressString(from), previousFromBalance - amount)
				currentBalance.set(addressString(to), previousToBalance + amount)
				changesForCall.push({ address: from, before: previousFromBalance, after: previousFromBalance - amount })
				changesForCall.push({ address: to, before: previousToBalance, after: previousToBalance + amount })
			}
			balanceChanges.push(changesForCall)
		}
		return balanceChanges
	}

	// intended drop in replacement of the old multicall
	public readonly executionSpec383MultiCallOnlyTransactions = async (transactions: readonly EthereumUnsignedTransaction[], blockNumber: bigint): Promise<MulticallResponse> => {
		const parentBlock = await this.getBlock()
		const multicallResults = await this.executionSpec383MultiCall([{
			calls: transactions,
			blockOverride: {
				number: blockNumber + 1n,
				prevRandao: 0x1n,
				time: new Date(parentBlock.timestamp.getTime() + 12 * 1000),
				gasLimit: parentBlock.gasLimit,
				feeRecipient: parentBlock.miner,
				baseFee: parentBlock.baseFeePerGas === undefined ? 15000000n : parentBlock.baseFeePerGas
			},
		}], blockNumber)
		if (multicallResults.length !== 1) throw new Error('Multicalled for one block but did not get one block')
		const calls = multicallResults[0].calls
		const allLogs = calls.map((singleResult) => singleResult.status !== 'success' || singleResult.logs === undefined ? [] : singleResult.logs)
		const balanceChanges = await this.getBalanceChanges(blockNumber, allLogs, transactions.map((tx) => tx.from))
		const endResult = calls.map((singleResult, callIndex) => {
			switch (singleResult.status) {
				case 'success': return {
					statusCode: 'success' as const,
					gasSpent: singleResult.gasUsed,
					returnValue: singleResult.return,
					events: (singleResult.logs === undefined ? [] : singleResult.logs).map((log) => ({
						loggersAddress: log.address,
						data: 'data' in log && log.data !== undefined ? log.data : new Uint8Array(),
						topics: 'topics' in log && log.topics !== undefined ? log.topics : [],
					})).filter((x) => x.loggersAddress !== 0x0n), //TODO, keep eth logs
					balanceChanges: balanceChanges[callIndex],
				}
				case 'failure': return {
					statusCode: 'failure' as const,
					gasSpent: singleResult.gasUsed,
					error: singleResult.error.message,
					returnValue: singleResult.return,
				}
				case 'invalid': throw new Error(`Invalid multicall: ${ singleResult.error }`)
				default: assertNever(singleResult)
			}
		})
		return endResult
	}
}
