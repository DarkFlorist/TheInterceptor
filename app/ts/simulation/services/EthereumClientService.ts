import { EthereumSignedTransactionWithBlockData, EthereumQuantity, EthereumBlockTag, EthereumData, EthereumBlockHeader, EthereumBlockHeaderWithTransactionHashes, EthereumBytes32 } from '../../types/wire-types.js'
import { IUnsignedTransaction1559 } from '../../utils/ethereum.js'
import { MAX_BLOCK_CACHE, TIME_BETWEEN_BLOCKS } from '../../utils/constants.js'
import { IEthereumJSONRpcRequestHandler } from './EthereumJSONRpcRequestHandler.js'
import { AbiCoder, Signature, ethers } from 'ethers'
import { addressString, bytes32String } from '../../utils/bigint.js'
import { BlockCalls, EthSimulateV1Result } from '../../types/ethSimulate-types.js'
import { EthGetStorageAtResponse, EthTransactionReceiptResponse, EthGetLogsRequest, EthGetLogsResponse, PartialEthereumTransaction } from '../../types/JsonRpc-types.js'
import { MessageHashAndSignature, simulatePersonalSign } from './SimulationModeEthereumClientService.js'
import { getEcRecoverOverride } from '../../utils/ethereumByteCodes.js'
import * as funtypes from 'funtypes'
import { RpcEntry } from '../../types/rpc.js'
import { SimulationStateInputMinimalData, SimulationStateInputMinimalDataBlock } from '../../types/visualizer-types.js'

export type IEthereumClientService = Pick<EthereumClientService, keyof EthereumClientService>
export class EthereumClientService {
	private cachedBlock: EthereumBlockHeader | undefined = undefined
	private cacheRefreshTimer: NodeJS.Timer | undefined = undefined
	private retrievingBlock = false
	private newBlockAttemptCallback: (blockHeader: EthereumBlockHeader, ethereumClientService: EthereumClientService, isNewBlock: boolean) => Promise<void>
	private onErrorBlockCallback: (ethereumClientService: EthereumClientService, error: unknown) => Promise<void>
	private requestHandler
	private rpcEntry

    constructor(requestHandler: IEthereumJSONRpcRequestHandler, newBlockAttemptCallback: (blockHeader: EthereumBlockHeader, ethereumClientService: EthereumClientService, isNewBlock: boolean) => Promise<void>, onErrorBlockCallback: (ethereumClientService: EthereumClientService, error: unknown) => Promise<void>, rpcEntry: RpcEntry) {
		this.requestHandler = requestHandler
		this.newBlockAttemptCallback = newBlockAttemptCallback
		this.onErrorBlockCallback = onErrorBlockCallback
		this.rpcEntry = rpcEntry

		if (this.rpcEntry.httpsRpc !== requestHandler.rpcUrl) throw new Error('The URL values for rpcEntry and requestHander must match')
    }

	public readonly getRpcEntry = () => this.rpcEntry

	public readonly getNewBlockAttemptCallback = () => this.newBlockAttemptCallback
	public readonly getOnErrorBlockCallback = () => this.onErrorBlockCallback

	public getCachedBlock = () => {
		if (this.cachedBlock === undefined || this.cachedBlock === null) return undefined
		// if the block is older than MAX_BLOCK_CACHE block intervals, invalidate cache
		if ((Date.now() - this.cachedBlock.timestamp.getTime() * 1000) > TIME_BETWEEN_BLOCKS * MAX_BLOCK_CACHE) return undefined
		return this.cachedBlock
	}
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
			const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_getBlockByNumber', params: ['latest', true] }, undefined, true, 6000)
			if (this.cacheRefreshTimer === undefined) return
			const newBlock = EthereumBlockHeader.parse(response)
			if (newBlock === null) return
			console.info(`Current block number: ${ newBlock.number } on ${ this.getRpcEntry().name }`)
			const gotNewBlock = this.cachedBlock?.number !== newBlock.number
			if (gotNewBlock) this.requestHandler.clearCache()
			this.newBlockAttemptCallback(newBlock, this, gotNewBlock)
			this.cachedBlock = newBlock
		} catch(error: unknown) {
			return this.onErrorBlockCallback(this, error)
		} finally {
			this.retrievingBlock = false
		}
	}

	public readonly estimateGas = async (data: PartialEthereumTransaction, requestAbortController: AbortController | undefined) => {
		const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_estimateGas', params: [data] }, requestAbortController )
		return EthereumQuantity.parse(response)
	}

	public readonly getStorageAt = async (contract: bigint, slot: bigint, blockTag: EthereumBlockTag, requestAbortController: AbortController | undefined) => {
		const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_getStorageAt', params: [contract, slot, blockTag] }, requestAbortController)
		return EthGetStorageAtResponse.parse(response)
	}

	public readonly getTransactionCount = async (address: bigint, blockTag: EthereumBlockTag, requestAbortController: AbortController | undefined) => {
		const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_getTransactionCount', params: [address, blockTag] }, requestAbortController)
		return EthereumQuantity.parse(response)
	}

	public readonly getTransactionReceipt = async (hash: bigint, requestAbortController: AbortController | undefined) => {
		const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_getTransactionReceipt', params: [hash] }, requestAbortController)
		return EthTransactionReceiptResponse.parse(response)
	}

	public readonly getBalance = async (address: bigint, blockTag: EthereumBlockTag, requestAbortController: AbortController | undefined) => {
		const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_getBalance', params: [address, blockTag] }, requestAbortController)
		return EthereumQuantity.parse(response)
	}

	public readonly getCode = async (address: bigint, blockTag: EthereumBlockTag, requestAbortController: AbortController | undefined) => {
		const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_getCode', params: [address, blockTag] }, requestAbortController)
		return EthereumData.parse(response)
	}

	public async getBlock(requestAbortController: AbortController | undefined, blockTag?: EthereumBlockTag, fullObjects?: true): Promise<EthereumBlockHeader>
	public async getBlock(requestAbortController: AbortController | undefined, blockTag: EthereumBlockTag, fullObjects: boolean): Promise<EthereumBlockHeaderWithTransactionHashes | EthereumBlockHeader>
	public async getBlock(requestAbortController: AbortController | undefined, blockTag: EthereumBlockTag, fullObjects: false): Promise<EthereumBlockHeaderWithTransactionHashes>
	public async getBlock(requestAbortController: AbortController | undefined, blockTag: EthereumBlockTag = 'latest', fullObjects = true): Promise<EthereumBlockHeaderWithTransactionHashes | EthereumBlockHeader> {
		const cached = this.getCachedBlock()
		if (cached && (blockTag === 'latest' || blockTag === cached.number)) {
			if (fullObjects === false) return { ...cached, transactions: cached.transactions.map((transaction) => transaction.hash) }
			return cached
		}
		if (fullObjects === false) return EthereumBlockHeaderWithTransactionHashes.parse(await this.requestHandler.jsonRpcRequest({ method: 'eth_getBlockByNumber', params: [blockTag, false] }))
		return EthereumBlockHeader.parse(await this.requestHandler.jsonRpcRequest({ method: 'eth_getBlockByNumber', params: [blockTag, fullObjects] }, requestAbortController))
	}

	public async getBlockByHash(blockHash: EthereumBytes32, requestAbortController: AbortController | undefined, fullObjects = true): Promise<EthereumBlockHeaderWithTransactionHashes | EthereumBlockHeader> {
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
		return EthereumBlockHeader.parse(await this.requestHandler.jsonRpcRequest({ method: 'eth_getBlockByHash', params: [blockHash, fullObjects] }, requestAbortController))
	}

	public readonly getChainId = () => this.getRpcEntry().chainId

	public readonly getLogs = async (logFilter: EthGetLogsRequest, requestAbortController: AbortController | undefined) => {
		const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_getLogs', params: [logFilter] }, requestAbortController)
		return EthGetLogsResponse.parse(response)
	}

	public readonly getBlockNumber = async (requestAbortController: AbortController | undefined) => {
		const cached = this.getCachedBlock()
		if (cached) return cached.number
		const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_blockNumber' }, requestAbortController)
		return EthereumQuantity.parse(response)
	}

	public readonly getGasPrice = async(requestAbortController: AbortController | undefined) => {
		const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_gasPrice' }, requestAbortController)
		return EthereumQuantity.parse(response)
	}

	public readonly getTransactionByHash = async (hash: bigint, requestAbortController: AbortController | undefined) => {
		const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_getTransactionByHash', params: [hash] }, requestAbortController)
		if (response === null) return null
		return EthereumSignedTransactionWithBlockData.parse(response)
	}

	public readonly call = async (transaction: Partial<Pick<IUnsignedTransaction1559, 'to' | 'from' | 'input' | 'value' | 'maxFeePerGas' | 'maxPriorityFeePerGas' | 'gasLimit'>>, blockTag: EthereumBlockTag, requestAbortController: AbortController | undefined) => {
		if (transaction.to === null) throw new Error('To cannot be null')
		const params = {
			to: transaction.to,
			from: transaction.from,
			data: transaction.input,
			value: transaction.value,
			...transaction.maxFeePerGas !== undefined && transaction.maxPriorityFeePerGas !== undefined ? { gasPrice: transaction.maxFeePerGas + transaction.maxPriorityFeePerGas } : {},
			gas: transaction.gasLimit
		}
		const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_call', params: [params, blockTag] }, requestAbortController)
		return response as string
	}

	public readonly ethSimulateV1 = async (blockStateCalls: readonly BlockCalls[], blockTag: EthereumBlockTag, requestAbortController: AbortController | undefined) => {
		const parentBlock = await this.getBlock(requestAbortController)
		if (parentBlock === null) throw new Error('The latest block is null')
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
		return EthSimulateV1Result.parse(unvalidatedResult)
	}

	public readonly simulate = async (simulationStateInput: SimulationStateInputMinimalData, blockNumber: bigint, requestAbortController: AbortController | undefined) => {
		const parentBlock = await this.getBlock(requestAbortController, blockNumber)
		if (parentBlock === null) throw new Error(`The block ${ blockNumber } is null`)

		const getBlockStateCall = async (block: SimulationStateInputMinimalDataBlock, blockdelta: number) => {
			const transactionsWithRemoveZeroPricedOnes = block.transactions.map((transaction) => {
				if (transaction.signedTransaction.type !== '1559') return transaction.signedTransaction
				const { maxFeePerGas, ...transactionWithoutMaxFee } = transaction.signedTransaction
				return { ...transactionWithoutMaxFee, ...maxFeePerGas === 0n ? {} : { maxFeePerGas } }
			})
			const ecRecoverMovedToAddress = 0x123456n
			const ecRecoverAddress = 1n

			const coder = AbiCoder.defaultAbiCoder()

			const encodePackedHash = (messageHashAndSignature: MessageHashAndSignature) => {
				const sig = Signature.from(messageHashAndSignature.signature)
				const packed = BigInt(ethers.keccak256(coder.encode(['bytes32', 'uint8', 'bytes32', 'bytes32'], [messageHashAndSignature.messageHash, sig.v, sig.r, sig.s])))
				return packed
			}

			// set mapping storage mapping() (instructed here: https://docs.soliditylang.org/en/latest/internals/layout_in_storage.html)
			const getMappingsMemorySlot = (hash: EthereumBytes32) => ethers.keccak256(coder.encode(['bytes32', 'uint256'], [bytes32String(hash), 0n]))
			const signatureStructs = await Promise.all(block.signedMessages.map(async (sign) => ({ key: getMappingsMemorySlot(encodePackedHash(simulatePersonalSign(sign.originalRequestParameters, sign.fakeSignedFor))), value: sign.fakeSignedFor })))
			const stateSets = signatureStructs.reduce((acc, current) => {
				acc[current.key] = current.value
				return acc
			}, {} as { [key: string]: bigint } )

			const calculateCumulativeIncrements = (arr: EthereumQuantity[]): EthereumQuantity[] => {
				return arr.reduce((result, current, index) => {
					result.push(current + (result[index - 1] || 0n))
					return result
				}, [] as EthereumQuantity[])
			}
			const cumulativeDeltas = calculateCumulativeIncrements(simulationStateInput.blocks.map((block) => block.timeIncreaseDelta))

			const getBlockOverrides = (index: number) => ({
				number: parentBlock.number + 1n + BigInt(index),
				prevRandao: 0x1n,
				time: new Date(parentBlock.timestamp.getTime() + Number(cumulativeDeltas[index]) * 1000),
				gasLimit: parentBlock.gasLimit,
				feeRecipient: parentBlock.miner,
				baseFeePerGas: parentBlock.baseFeePerGas === undefined ? 15000000n : parentBlock.baseFeePerGas
			})
			return {
				calls: transactionsWithRemoveZeroPricedOnes,
				blockOverrides: getBlockOverrides(blockdelta),
				stateOverrides: {
					...block.signedMessages.length > 0 ? {
						[addressString(ecRecoverAddress)]: {
							movePrecompileToAddress: ecRecoverMovedToAddress,
							code: getEcRecoverOverride(),
							state: stateSets,
						}
					} : {},
					...block.stateOverrides,
				}
			}
		}

		const blockStateCalls = await Promise.all(simulationStateInput.blocks.map(async (block, index) => await getBlockStateCall(block, index)))
		const ethSimulateResults = await this.ethSimulateV1(blockStateCalls, parentBlock.number, requestAbortController)
		if (ethSimulateResults.length !== blockStateCalls.length) throw new Error(`Ran Eth Simulate for ${ blockStateCalls.length } blocks but got ${ ethSimulateResults.length } blocks`)
		return ethSimulateResults
	}

	public readonly web3ClientVersion = async (requestAbortController: AbortController | undefined) => {
		const response = await this.requestHandler.jsonRpcRequest({ method: 'web3_clientVersion', params: [] }, requestAbortController)
		return funtypes.String.parse(response)
	}
}
