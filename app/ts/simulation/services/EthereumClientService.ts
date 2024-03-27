import { EthereumSignedTransactionWithBlockData, EthereumQuantity, EthereumBlockTag, EthereumData, EthereumBlockHeader, EthereumBlockHeaderWithTransactionHashes, EthereumBytes32, OptionalEthereumUnsignedTransaction } from '../../types/wire-types.js'
import { IUnsignedTransaction1559 } from '../../utils/ethereum.js'
import { TIME_BETWEEN_BLOCKS } from '../../utils/constants.js'
import { IEthereumJSONRpcRequestHandler } from './EthereumJSONRpcRequestHandler.js'
import { AbiCoder, Signature, ethers } from 'ethers'
import { addressString, bytes32String } from '../../utils/bigint.js'
import { BlockCalls, ethSimulateV1Result, StateOverrides } from '../../types/ethSimulate-types.js'
import { EthGetStorageAtResponse, EthTransactionReceiptResponse, EthGetLogsRequest, EthGetLogsResponse, DappRequestTransaction } from '../../types/JsonRpc-types.js'
import { MessageHashAndSignature, SignatureWithFakeSignerAddress, simulatePersonalSign } from './SimulationModeEthereumClientService.js'
import { getEcRecoverOverride } from '../../utils/ethereumByteCodes.js'
import * as funtypes from 'funtypes'

export type IEthereumClientService = Pick<EthereumClientService, keyof EthereumClientService>
export class EthereumClientService {
	private cachedBlock: EthereumBlockHeader | undefined = undefined
	private cacheRefreshTimer: NodeJS.Timer | undefined = undefined
	private retrievingBlock = false
	private newBlockAttemptCallback: (blockHeader: EthereumBlockHeader, ethereumClientService: EthereumClientService, isNewBlock: boolean) => Promise<void>
	private onErrorBlockCallback: (ethereumClientService: EthereumClientService) => Promise<void>
	private requestHandler

    constructor(requestHandler: IEthereumJSONRpcRequestHandler, newBlockAttemptCallback: (blockHeader: EthereumBlockHeader, ethereumClientService: EthereumClientService, isNewBlock: boolean) => Promise<void>, onErrorBlockCallback: (ethereumClientService: EthereumClientService) => Promise<void>) {
		this.requestHandler = requestHandler
		this.newBlockAttemptCallback = newBlockAttemptCallback
		this.onErrorBlockCallback = onErrorBlockCallback
    }

	public readonly getRpcEntry = () => this.requestHandler.getRpcEntry()
	
	public readonly getNewBlockAttemptCallback = () => this.newBlockAttemptCallback
	public readonly getOnErrorBlockCallback = () => this.onErrorBlockCallback

	public getCachedBlock = () => this.cachedBlock
	public cleanup = () => this.setBlockPolling(false)

	public readonly isBlockPolling = () => this.cacheRefreshTimer !== undefined

	public readonly setBlockPolling = (enabled: boolean) => {
		if (enabled && this.cacheRefreshTimer === undefined) {
			const now = Date.now()

			// query block everytime clock hits time % 12 + 7
			this.updateCache()
			const timeToTarget = Math.floor(now / 1000 / TIME_BETWEEN_BLOCKS) * 1000 * TIME_BETWEEN_BLOCKS + 7 * 1000 - now
			this.cacheRefreshTimer = setTimeout(() => { // wait until the clock is just right ( % 12 + 7 ), an then start querying every TIME_BETWEEN_BLOCKS secs
				this.updateCache()
				this.cacheRefreshTimer = setInterval(this.updateCache, TIME_BETWEEN_BLOCKS * 1000)
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
			const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_getBlockByNumber', params: ['latest', true] }, true, 6000)
			if (this.cacheRefreshTimer === undefined) return
			const newBlock = EthereumBlockHeader.parse(response)
			console.log(`Current block number: ${ newBlock.number } on ${ this.requestHandler.getRpcEntry().name }`)
			const gotNewBlock = this.cachedBlock?.number !== newBlock.number
			if (gotNewBlock) this.requestHandler.clearCache()
			this.newBlockAttemptCallback(newBlock, this, gotNewBlock)
			this.cachedBlock = newBlock
		} catch(error) {
			console.log(`Failed to get a block`)
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
	public async getBlock(blockTag: EthereumBlockTag = 'latest', fullObjects = true): Promise<EthereumBlockHeaderWithTransactionHashes | EthereumBlockHeader> {
		const cached = this.getCachedBlock()
		if (cached && (blockTag === 'latest' || blockTag === cached.number)) {
			if (fullObjects === false) return { ...cached, transactions: cached.transactions.map((transaction) => transaction.hash) }
			return cached
		}
		if (fullObjects === false) return EthereumBlockHeaderWithTransactionHashes.parse(await this.requestHandler.jsonRpcRequest({ method: 'eth_getBlockByNumber', params: [blockTag, false] }))
		return EthereumBlockHeader.parse(await this.requestHandler.jsonRpcRequest({ method: 'eth_getBlockByNumber', params: [blockTag, fullObjects] }))
	}

	public async getBlockByHash(blockHash: EthereumBytes32, fullObjects = true): Promise<EthereumBlockHeaderWithTransactionHashes | EthereumBlockHeader> {
		const cached = this.getCachedBlock()
		if (cached && (cached.hash === blockHash)) {
			if (fullObjects === false) {
				return { ...cached, transactions: cached.transactions.map((transaction) => transaction.hash) }
			}
			return cached
		}
		if (fullObjects === false) {
			return EthereumBlockHeaderWithTransactionHashes.parse(await this.requestHandler.jsonRpcRequest({ method: 'eth_getBlockByHash', params: [blockHash, false] }))
		}
		return EthereumBlockHeader.parse(await this.requestHandler.jsonRpcRequest({ method: 'eth_getBlockByHash', params: [blockHash, fullObjects] }))
	}

	public readonly getChainId = () => this.requestHandler.getRpcEntry().chainId

	public readonly getLogs = async (logFilter: EthGetLogsRequest) => {
		const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_getLogs', params: [logFilter] })
		return EthGetLogsResponse.parse(response)
	}

	public readonly getBlockNumber = async () => {
		const cached = this.getCachedBlock()
		if (cached) return cached.number
		const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_blockNumber' })
		return EthereumQuantity.parse(response)
	}

	public readonly getGasPrice = async() => {
		const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_gasPrice' })
		return EthereumQuantity.parse(response)
	}

	public readonly getTransactionByHash = async (hash: bigint) => {
		const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_getTransactionByHash', params: [hash] })
		if (response === null) return undefined
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

	public readonly ethSimulateV1 = async (blockStateCalls: readonly BlockCalls[], blockTag: EthereumBlockTag) => {
		const parentBlock = await this.getBlock()
		const call = {
			method: 'eth_simulateV1',
			params: [{
				blockStateCalls: blockStateCalls,
				traceTransfers: true,
				validation: false,
			},
			blockTag === parentBlock.number + 1n ? blockTag - 1n : blockTag
		] } as const
		const unvalidatedResult = await this.requestHandler.jsonRpcRequest(call)
		/*
		console.log('ethSimulateV1')
		console.log(call)
		console.log(unvalidatedResult)
		console.log(stringifyJSONWithBigInts(EthSimulateV1Params.serialize(call)))
		console.log(stringifyJSONWithBigInts(unvalidatedResult))
		console.log('end')
		*/
		return ethSimulateV1Result.parse(unvalidatedResult)
	}

	public readonly simulateTransactionsAndSignatures = async (transactions: readonly OptionalEthereumUnsignedTransaction[], signatures: readonly SignatureWithFakeSignerAddress[], blockNumber: bigint, extraAccountOverrides: StateOverrides = {}) => {
		const transactionsWithRemoveZeroPricedOnes = transactions.map((transaction) => {
			if (transaction.type !== '1559') return transaction
			const { maxFeePerGas, ...transactionWithoutMaxFee } = transaction
			return { ...transactionWithoutMaxFee, ...maxFeePerGas === 0n ? {} : { maxFeePerGas } }
		})
		const ecRecoverMovedToAddress = 0x123456n
		const ecRecoverAddress = 1n
		const parentBlock = await this.getBlock()
		const coder = AbiCoder.defaultAbiCoder()

		const encodePackedHash = (messageHashAndSignature: MessageHashAndSignature) => {
			const sig = Signature.from(messageHashAndSignature.signature)
			const packed = BigInt(ethers.keccak256(coder.encode(['bytes32', 'uint8', 'bytes32', 'bytes32'], [messageHashAndSignature.messageHash, sig.v, sig.r, sig.s])))
			return packed
		}
		
		// set mapping storage mapping() (instructed here: https://docs.soliditylang.org/en/latest/internals/layout_in_storage.html)
		const getMappingsMemorySlot = (hash: EthereumBytes32) => ethers.keccak256(coder.encode(['bytes32', 'uint256'], [bytes32String(hash), 0n]))
		const signatureStructs = await Promise.all(signatures.map(async (sign) => ({ key: getMappingsMemorySlot(encodePackedHash(await simulatePersonalSign(sign.originalRequestParameters, sign.fakeSignedFor))), value: sign.fakeSignedFor })))
		const stateSets = signatureStructs.reduce((acc, current) => {
			acc[current.key] = current.value
			return acc
		}, {} as { [key: string]: bigint } )

		const query = [{
			calls: transactionsWithRemoveZeroPricedOnes,
			blockOverride: {
				number: blockNumber + 1n,
				prevRandao: 0x1n,
				time: new Date(parentBlock.timestamp.getTime() + 12 * 1000),
				gasLimit: parentBlock.gasLimit,
				feeRecipient: parentBlock.miner,
				baseFee: parentBlock.baseFeePerGas === undefined ? 15000000n : parentBlock.baseFeePerGas
			},
			stateOverrides: {
				...signatures.length > 0 ? {
					[addressString(ecRecoverAddress)]: {
						movePrecompileToAddress: ecRecoverMovedToAddress,
						code: getEcRecoverOverride(),
						state: stateSets,
					}
				} : {},
				...extraAccountOverrides,
			}
		}]
		const ethSimulateResults = await this.ethSimulateV1(query, blockNumber)
		if (ethSimulateResults.length !== 1) throw new Error('Ran Eth Simulate for one block but did not get one block')
		const singleMulticalResult = ethSimulateResults[0]
		if (singleMulticalResult === undefined) throw new Error('Eth Simualte result was undefined')
		return singleMulticalResult
	}

	public readonly web3ClientVersion = async () => {
		const response = await this.requestHandler.jsonRpcRequest({ method: 'web3_clientVersion', params: [] } )
		return funtypes.String.parse(response)
	}
}
