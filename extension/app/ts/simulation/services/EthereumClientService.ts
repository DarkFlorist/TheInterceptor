import { encodeMethod } from '@zoltu/ethereum-abi-encoder'
import { keccak256 } from '@zoltu/ethereum-crypto'
import { EthGetLogsResponse, MulticallRequestParameters, MulticallResponse, serializeUnsignedTransactionToJson, EthereumUnsignedTransaction, EthereumSignedTransactionWithBlockData, EthGetStorageAtResponse, serialize, EthGetStorageAtRequestParameters, EthereumAddress, EthereumQuantity, EthereumBlockTag, EthTransactionReceiptResponse, EthereumBytes32, EthereumData, EthGetLogsRequest, EthereumBlockHeader, EstimateGasParamsVariables, EthereumBlockHeaderWithTransactionHashes } from '../../utils/wire-types.js'
import { IUnsignedTransaction } from '../../utils/ethereum.js'

import { TIME_BETWEEN_BLOCKS, CHAINS, MOCK_ADDRESS } from '../../utils/constants.js'
import { CHAIN } from '../../utils/user-interface-types.js'
import { IEthereumJSONRpcRequestHandler } from './EthereumJSONRpcRequestHandler.js'

export type IEthereumClientService = Pick<EthereumClientService, keyof EthereumClientService>
export class EthereumClientService {
	private chain: CHAIN
	private cachedBlock: EthereumBlockHeader | undefined = undefined
	private cacheRefreshTimer: NodeJS.Timer | undefined = undefined
	private retrievingBlock: boolean = false
	private newBlockCallback: (blockNumber: bigint) => void
	private requestHandler

    constructor(requestHandler: IEthereumJSONRpcRequestHandler, chain: CHAIN, caching: boolean, newBlockCallback: (blockNumber: bigint) => void) {
		this.requestHandler = requestHandler
		this.chain = chain
		this.newBlockCallback = newBlockCallback
		this.setBlockPolling(caching)
    }

	public cleanup = () => {
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
			}, timeToTarget > 0 ? timeToTarget : timeToTarget + TIME_BETWEEN_BLOCKS * 1000 )
			return
		}
		if (!enabled) {
			clearInterval(this.cacheRefreshTimer)
			this.cacheRefreshTimer = undefined
			this.cachedBlock = undefined
			return
		}
	}
	public readonly isBlockPolling = () => this.cacheRefreshTimer !== undefined

	private readonly updateCache = async () => {
		if (this.retrievingBlock) return
		try {
			this.retrievingBlock = true
			const response = await this.requestHandler.jsonRpcRequest('eth_getBlockByNumber', ['latest', true])
			if (this.cacheRefreshTimer === undefined) return
			const newBlock = EthereumBlockHeader.parse(response)
			console.log(`Current block number: ${ newBlock.number }`)
			if (this.cachedBlock?.number != newBlock.number) {
				this.cachedBlock = newBlock
				this.newBlockCallback(newBlock.number)
			}
		} catch(e) {
			throw e
		} finally {
			this.retrievingBlock = false
		}
	}

	public readonly estimateGas = async (data: EstimateGasParamsVariables) => {
		const response = await this.requestHandler.jsonRpcRequest('eth_estimateGas', [serialize(EstimateGasParamsVariables, data) ] )
		return EthereumQuantity.parse(response)
	}

	public readonly getStorageAt = async (contract: bigint, slot: bigint) => {
		const response = await this.requestHandler.jsonRpcRequest('eth_getStorageAt', serialize(EthGetStorageAtRequestParameters, [contract, slot] as const))
		return EthGetStorageAtResponse.parse(response)
	}

	public readonly getTransactionCount = async (address: bigint, blockTag: EthereumBlockTag = 'latest') => {
		const response = await this.requestHandler.jsonRpcRequest('eth_getTransactionCount', [serialize(EthereumAddress, address), serialize(EthereumBlockTag, blockTag)])
		return EthereumQuantity.parse(response)
	}

	public readonly getTransactionReceipt = async (hash: bigint) => {
		const response = await this.requestHandler.jsonRpcRequest('eth_getTransactionReceipt', [serialize(EthereumBytes32, hash)])
		return EthTransactionReceiptResponse.parse(response)
	}

	public readonly getBalance = async (address: bigint, blockTag: EthereumBlockTag = 'latest') => {
		const response = await this.requestHandler.jsonRpcRequest('eth_getBalance', [serialize(EthereumAddress, address), serialize(EthereumBlockTag, blockTag)])
		return EthereumQuantity.parse(response)
	}

	public readonly getCode = async (address: bigint, blockTag: EthereumBlockTag = 'latest') => {
		const response = await this.requestHandler.jsonRpcRequest('eth_getCode', [serialize(EthereumAddress, address), serialize(EthereumBlockTag, blockTag)])
		return EthereumData.parse(response)
	}

	public readonly getBlock = async (blockTag: EthereumBlockTag = 'latest', fullObjects: boolean = true) => {
		if (this.cachedBlock && fullObjects) {
			// todo, add here conversion from fullObjects to non fullObjects if non fullObjects block is asked
			return this.cachedBlock
		}
		const response = await this.requestHandler.jsonRpcRequest('eth_getBlockByNumber', [serialize(EthereumBlockTag, blockTag), fullObjects])
		if ( fullObjects === false ) {
			return EthereumBlockHeaderWithTransactionHashes.parse(response)
		}
		return EthereumBlockHeader.parse(response)
	}

	public readonly getChainId = async () => {
		return CHAINS[this.chain].chainId
	}

	public readonly getChain = async () => {
		return this.chain
	}

	public readonly sendEncodedTransaction = async (transaction: Uint8Array) => {
		const response = await this.requestHandler.jsonRpcRequest('eth_sendRawTransaction', [serialize(EthereumData, transaction)])
		return EthereumBytes32.parse(response)
	}

	public readonly getLogs = async (logFilter: EthGetLogsRequest) => {
		const response = await this.requestHandler.jsonRpcRequest('eth_getLogs', [serialize(EthGetLogsRequest, logFilter)])
		return EthGetLogsResponse.parse(response)
	}

	public readonly getBlockNumber = async () => {
		if (this.cachedBlock) {
			return this.cachedBlock.number
		}
		const response = await this.requestHandler.jsonRpcRequest('eth_blockNumber', [])
		return EthereumQuantity.parse(response)
	}

	public readonly getGasPrice = async() => {
		const response = await this.requestHandler.jsonRpcRequest('eth_gasPrice', [])
		return EthereumQuantity.parse(response)
	}

	public readonly getTokenBalance = async (token: bigint, owner: bigint) => {
		const balanceOfCallData = await encodeMethod(keccak256.hash, 'balanceOf(address)', [owner])
		const callTransaction = {
			type: '1559' as const,
			from: MOCK_ADDRESS,
			to: token,
			value: 0n,
			input: balanceOfCallData,
			maxFeePerGas: 0n,
			maxPriorityFeePerGas: 0n,
			accessList: [],
			// nethermind will treat this the same as missing/null
			gasLimit: 15_000_000n,
			// nethermind will overwrite this, so safe to put whatever here
			chainId: 0n,
			// nethermind null coalesces to 0 internally for calls, so this will give us the same behavior as missing
			nonce: 0n,
		}
		const response = await this.call(callTransaction)
		return EthereumQuantity.parse(response)
	}

	public readonly getTokenDecimals = async (token: bigint) => {
		const balanceOfCallData = await encodeMethod(keccak256.hash, 'decimals()', [])
		const callTransaction = {
			type: '1559' as const,
			from: MOCK_ADDRESS,
			to: token,
			value: 0n,
			input: balanceOfCallData,
			maxFeePerGas: 0n,
			maxPriorityFeePerGas: 0n,
			accessList: [],
			// nethermind will treat this the same as missing/null
			gasLimit: 15_000_000n,
			// nethermind will overwrite this, so safe to put whatever here
			chainId: 0n,
			// nethermind null coalesces to 0 internally for calls, so this will give us the same behavior as missing
			nonce: 0n,
		}
		const response = await this.call(callTransaction)
		return EthereumQuantity.parse(response)
	}

	public readonly getTransactionByHash = async (hash: bigint) => {
		const response = (await this.requestHandler.jsonRpcRequest('eth_getTransactionByHash', [serialize(EthereumBytes32, hash)])) as string
		if( response === null) return undefined
		return EthereumSignedTransactionWithBlockData.parse(response)
	}

	public readonly call = async (transaction: IUnsignedTransaction, blockTag: EthereumBlockTag = 'latest') => {
		const serializedTransaction = serializeUnsignedTransactionToJson(transaction)
		const serializedBlockTag = serialize(EthereumBlockTag, blockTag)
		const response = await this.requestHandler.jsonRpcRequest('eth_call', [serializedTransaction, serializedBlockTag])
		return response as string
	}

	public readonly multicall = async (transactions: readonly EthereumUnsignedTransaction[], blockNumber: bigint) => {
		// typecast here for basically the same reason as above, MOCK_ADDRESS is too narrow which causes the `serialize` first parameter to not infer correctly
		const blockAuthor: bigint = MOCK_ADDRESS
		const params = serialize(MulticallRequestParameters, [blockNumber, blockAuthor, transactions] as const)
		const unvalidatedResult = await this.requestHandler.jsonRpcRequest('eth_multicall', params) as any[]
		return MulticallResponse.parse(unvalidatedResult)
	}
}
