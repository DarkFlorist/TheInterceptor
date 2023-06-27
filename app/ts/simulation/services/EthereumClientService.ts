import { MulticallResponse, EthereumUnsignedTransaction, EthereumSignedTransactionWithBlockData, EthGetStorageAtResponse, EthereumQuantity, EthereumBlockTag, EthTransactionReceiptResponse, EthereumData, EthereumBlockHeader, EthereumBlockHeaderWithTransactionHashes, EthGetLogsRequest, EthGetLogsResponse, DappRequestTransaction } from '../../utils/wire-types.js'
import { IUnsignedTransaction1559 } from '../../utils/ethereum.js'
import { TIME_BETWEEN_BLOCKS, MOCK_ADDRESS } from '../../utils/constants.js'
import { IEthereumJSONRpcRequestHandler } from './EthereumJSONRpcRequestHandler.js'
import { ethers } from 'ethers'
import { stringToUint8Array } from '../../utils/bigint.js'

export type IEthereumClientService = Pick<EthereumClientService, keyof EthereumClientService>
export class EthereumClientService {
	private cachedBlock: EthereumBlockHeader | undefined = undefined
	private cacheRefreshTimer: NodeJS.Timer | undefined = undefined
	private lastCacheAccess: number = 0
	private retrievingBlock: boolean = false
	private newBlockCallback: (blockNumber: bigint, ethereumClientService: EthereumClientService) => void
	private onErrorBlockCallback: (ethereumClientService: EthereumClientService, error: Error) => void
	private requestHandler
	private cleanedUp = false

    constructor(requestHandler: IEthereumJSONRpcRequestHandler, newBlockCallback: (blockNumber: bigint, ethereumClientService: EthereumClientService) => void, onErrorBlockCallback: (ethereumClientService: EthereumClientService, error: Error) => void) {
		this.requestHandler = requestHandler
		this.newBlockCallback = newBlockCallback
		this.onErrorBlockCallback = onErrorBlockCallback
    }

	public readonly getSelectedNetwork = () => this.requestHandler.getSelectedNetwork()

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
			if (this.cachedBlock?.number != newBlock.number) {
				this.cachedBlock = newBlock
				this.newBlockCallback(newBlock.number, this)
			}
		} catch(error) {
			if (error instanceof Error) {
				return this.onErrorBlockCallback(this, error)
			}
			throw error
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

	public readonly getChainId = () => this.requestHandler.getSelectedNetwork().chainId

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

	public readonly getTokenDecimals = async (token: bigint) => {
		const tokenInterface = new ethers.Interface([
			'function decimals() view returns (uint8)',
		])
		const balanceOfCallData = stringToUint8Array(tokenInterface.encodeFunctionData('decimals'))
		const callTransaction = {
			type: '1559',
			from: MOCK_ADDRESS,
			to: token,
			value: 0n,
			input: balanceOfCallData,
			maxFeePerGas: 0n,
			maxPriorityFeePerGas: 0n,
			gasLimit: 15_000_000n,
		}
		const response = await this.call(callTransaction)
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
		const blockAuthor: bigint = MOCK_ADDRESS
		const unvalidatedResult = await this.requestHandler.jsonRpcRequest({ method: 'eth_multicall', params: [blockNumber, blockAuthor, transactions] })
		return MulticallResponse.parse(unvalidatedResult)
	}
}
