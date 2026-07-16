import { EthereumSignedTransactionWithBlockData, EthereumQuantity, type EthereumBlockTag, EthereumData, EthereumBlockHeader, EthereumBlockHeaderWithTransactionHashes, type EthereumBytes32, type EthereumSendableSignedTransaction } from '../../types/wire-types.js'
import type { IUnsignedTransaction1559 } from '../../utils/ethereum.js'
import { MAX_BLOCK_CACHE, TIME_BETWEEN_BLOCKS } from '../../utils/constants.js'
import { keccak256 } from '../../utils/ethereumPrimitives.js'
import type { IEthereumJSONRpcRequestHandler } from './EthereumJSONRpcRequestHandler.js'
import { addressString, bigintSecondsToDate, bytes32String, dataString, dateToBigintSeconds, max } from '../../utils/bigint.js'
import { type BlockCalls, type BlockOverrides, EthSimulateV1Result, type EthSimulateV1Params } from '../../types/ethSimulate-types.js'
import { EthGetStorageAtResponse, EthTransactionReceiptResponse, type EthGetLogsRequest, EthGetLogsResponse, type PartialEthereumTransaction } from '../../types/JsonRpc-types.js'
import { DEFAULT_BLOCK_MANIPULATION, getBlockTimeManipulationSeconds, simulatePersonalSign } from './SimulationModeEthereumClientService.js'
import { getEcRecoverOverride } from '../../utils/ethereumByteCodes.js'
import * as funtypes from 'funtypes'
import type { RpcEntry } from '../../types/rpc.js'
import type { BlockTimeManipulation, SimulationStateInputMinimalData, SimulationStateInputMinimalDataBlock } from '../../types/visualizer-types.js'
import type { MessageHashAndSignature } from '../../utils/eip712.js'
import { encodeAbiValues } from '../../utils/abiRuntime.js'
import { getCurrentTimestampString } from '../../utils/time.js'

const parseSignatureHex = (signature: `0x${ string }`) => {
	const stripped = signature.slice(2)
	if (stripped.length !== 130) throw new Error('Unsupported signature length')
	const r: `0x${ string }` = `0x${ stripped.slice(0, 64) }`
	const s: `0x${ string }` = `0x${ stripped.slice(64, 128) }`
	const rawV = Number.parseInt(stripped.slice(128, 130), 16)
	return {
		r,
		s,
		v: BigInt(rawV >= 27 ? rawV : rawV + 27),
		yParity: rawV >= 27 ? rawV - 27 : rawV,
	}
}

const toEthSimulateCall = (transaction: EthereumSendableSignedTransaction) => {
	const commonFields = {
		type: transaction.type,
		from: transaction.from,
		nonce: transaction.nonce,
		gas: transaction.gas,
		to: transaction.to,
		value: transaction.value,
		input: transaction.input,
	}
	const signatureFields = {
		...('yParity' in transaction ? { yParity: transaction.yParity } : {}),
		...('v' in transaction ? { v: transaction.v } : {}),
		r: transaction.r,
		s: transaction.s,
	}
	switch (transaction.type) {
		case 'legacy': return {
			...commonFields,
			gasPrice: transaction.gasPrice,
			...transaction.chainId !== undefined ? { chainId: transaction.chainId } : {},
			...signatureFields,
		}
		case '2930': return {
			...commonFields,
			chainId: transaction.chainId,
			gasPrice: transaction.gasPrice,
			...transaction.accessList !== undefined ? { accessList: transaction.accessList } : {},
			...signatureFields,
		}
		case '1559': return {
			...commonFields,
			chainId: transaction.chainId,
			maxPriorityFeePerGas: transaction.maxPriorityFeePerGas,
			...transaction.maxFeePerGas === 0n ? {} : { maxFeePerGas: transaction.maxFeePerGas },
			...transaction.accessList !== undefined ? { accessList: transaction.accessList } : {},
			...signatureFields,
		}
		case '4844': return {
			...commonFields,
			chainId: transaction.chainId,
			maxPriorityFeePerGas: transaction.maxPriorityFeePerGas,
			maxFeePerGas: transaction.maxFeePerGas,
			...transaction.accessList !== undefined ? { accessList: transaction.accessList } : {},
			maxFeePerBlobGas: transaction.maxFeePerBlobGas,
			blobVersionedHashes: transaction.blobVersionedHashes,
			...signatureFields,
		}
		case '7702': return {
			...commonFields,
			chainId: transaction.chainId,
			maxPriorityFeePerGas: transaction.maxPriorityFeePerGas,
			maxFeePerGas: transaction.maxFeePerGas,
			...transaction.accessList !== undefined ? { accessList: transaction.accessList } : {},
			authorizationList: transaction.authorizationList,
			...signatureFields,
		}
		default: {
			const unsupportedTransaction: never = transaction
			throw new Error(`Unsupported transaction type for eth_simulateV1: ${ String(unsupportedTransaction) }`)
		}
	}
}

export const getNextBlockTimeStampOverride = (previousBlockTimeStamp: Date, blockTimeManipulation: BlockTimeManipulation) => {
	const prevTime = dateToBigintSeconds(previousBlockTimeStamp)
	if (blockTimeManipulation.type === 'AddToTimestamp') return bigintSecondsToDate(prevTime + getBlockTimeManipulationSeconds(blockTimeManipulation.deltaToAdd, blockTimeManipulation.deltaUnit))
	return bigintSecondsToDate(max(prevTime + 1n, blockTimeManipulation.timeToSet))
}

export type IEthereumClientService = Pick<EthereumClientService, keyof EthereumClientService>
export type PreparedEthSimulateV1InputBlock = {
	readonly inputBlock: SimulationStateInputMinimalDataBlock
	readonly rpcBlockCount: number
}
export type PreparedEthSimulateV1Input = {
	readonly request: EthSimulateV1Params
	readonly inputBlocks: readonly PreparedEthSimulateV1InputBlock[]
	readonly rpcBlocks: readonly SimulationStateInputMinimalDataBlock[]
	readonly blockOverrides: readonly BlockOverrides[]
}
export class EthereumClientService {
	private cachedBlock: EthereumBlockHeader | undefined = undefined
	private cacheRefreshTimer: ReturnType<typeof setTimeout> | undefined = undefined
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
		if ((Date.now() - this.cachedBlock.timestamp.getTime()) > TIME_BETWEEN_BLOCKS * MAX_BLOCK_CACHE * 1000) return undefined
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
			console.info(`${ getCurrentTimestampString() } Current block number: ${ newBlock.number } on ${ this.getRpcEntry().name }`)
			const gotNewBlock = this.cachedBlock?.number !== newBlock.number
			if (gotNewBlock) this.requestHandler.clearCache()
			this.cachedBlock = newBlock
			await this.newBlockAttemptCallback(newBlock, this, gotNewBlock)
		} catch(error: unknown) {
			return await this.onErrorBlockCallback(this, error)
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

	public readonly getDelegation = async (address: bigint, blockTag: EthereumBlockTag, requestAbortController: AbortController | undefined) => {
		const code = await this.getCode(address, blockTag, requestAbortController)
		if (code.length !== 23 || code[0] !== 0xef || code[1] !== 0x01 || code[2] !== 0x00) return undefined
		return BigInt(`0x${ dataString(code.slice(3)) }`)
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
			...(transaction.to !== undefined ? { to: transaction.to } : {}),
			...(transaction.from !== undefined ? { from: transaction.from } : {}),
			...(transaction.input !== undefined ? { data: transaction.input } : {}),
			...(transaction.value !== undefined ? { value: transaction.value } : {}),
			...transaction.maxFeePerGas !== undefined && transaction.maxPriorityFeePerGas !== undefined ? { gasPrice: transaction.maxFeePerGas + transaction.maxPriorityFeePerGas } : {},
			...(transaction.gasLimit !== undefined ? { gas: transaction.gasLimit } : {}),
		}
		const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_call', params: [params, blockTag] }, requestAbortController)
		return EthereumData.parse(response)
	}

	public readonly ethSimulateV1 = async (blockStateCalls: readonly BlockCalls[], blockTag: EthereumBlockTag, requestAbortController: AbortController | undefined) => {
		const parentBlock = await this.getBlock(requestAbortController)
		if (parentBlock === null) throw new Error('The latest block is null')
		const call: EthSimulateV1Params = {
			method: 'eth_simulateV1',
			params: [{
				blockStateCalls: blockStateCalls,
				traceTransfers: true,
				validation: false,
			},
			blockTag === parentBlock.number + 1n ? blockTag - 1n : blockTag
		] }
		return await this.ethSimulateV1Request(call, requestAbortController)
	}

	public readonly ethSimulateV1Request = async (request: EthSimulateV1Params, requestAbortController: AbortController | undefined) => {
		return EthSimulateV1Result.parse(await this.requestHandler.jsonRpcRequest(request, requestAbortController))
	}

	public readonly prepareEthSimulateV1Input = async (simulationStateInput: SimulationStateInputMinimalData, blockNumber: bigint, requestAbortController: AbortController | undefined): Promise<PreparedEthSimulateV1Input> => {
		const parentBlock = await this.getBlock(requestAbortController, blockNumber)
		if (parentBlock === null) throw new Error(`The block ${ blockNumber } is null`)

		const blockOverrides: BlockOverrides[] = []
		const baseFeePerGas = parentBlock.baseFeePerGas === undefined ? 15000000n : parentBlock.baseFeePerGas

		const gasLimitTransaction = (transaction: EthereumSendableSignedTransaction) => ({ ...transaction, gas: transaction.gas > parentBlock.gasLimit ? parentBlock.gasLimit : transaction.gas })

		const splitTransactionsByGasLimit = (currentTransactions: EthereumSendableSignedTransaction[], gasLimit: bigint): EthereumSendableSignedTransaction[][] => {
			const transactionChunks: EthereumSendableSignedTransaction[][] = []
			let currentChunk: EthereumSendableSignedTransaction[] = []
			let currentChunkGasSum = 0n
			for (const transaction of currentTransactions) {
				if (transaction.gas > gasLimit) throw new Error(`Transaction gas ${ transaction.gas.toString() } exceeds gas limit ${ gasLimit.toString() }`)
				if (currentChunkGasSum + transaction.gas <= gasLimit) {
					currentChunk.push(transaction)
					currentChunkGasSum = currentChunkGasSum + transaction.gas
				} else {
					transactionChunks.push(currentChunk)
					currentChunk = [ transaction ]
					currentChunkGasSum = transaction.gas
				}
			}
			if (currentChunk.length > 0) transactionChunks.push(currentChunk)
			return transactionChunks
		}

		// if transactions spend more gas in a block than the block allows, split them into multiple blocks. Also clamp a single transaction to take at most one block worth of gas
		const gasLimitedInput: SimulationStateInputMinimalData = simulationStateInput.map((block) => ({ ...block, transactions: block.transactions.map((transaction) => ({ signedTransaction: gasLimitTransaction(transaction.signedTransaction) })) }))
		const calculateTotalGasUsed = (currentTransactions: { gas: bigint }[]) => currentTransactions.reduce((totalGasUsed, transaction) => totalGasUsed + transaction.gas, 0n)
		const preparedBlocks: PreparedEthSimulateV1InputBlock[] = []
		const rpcBlocks: SimulationStateInputMinimalDataBlock[] = []
		for (const inputBlock of gasLimitedInput) {
			const signedTransactions = inputBlock.transactions.map((x) => x.signedTransaction)
			if (calculateTotalGasUsed(signedTransactions) > parentBlock.gasLimit) {
				const splitted = splitTransactionsByGasLimit(signedTransactions, parentBlock.gasLimit)
				for (const [index, newTransactions] of splitted.entries()) {
					const transactions = newTransactions.map((transaction) => ({ signedTransaction: transaction }))
					if (index === 0) {
						rpcBlocks.push({ ...inputBlock, transactions })
					} else {
						rpcBlocks.push({ transactions, stateOverrides: {}, signedMessages: [], blockTimeManipulation: DEFAULT_BLOCK_MANIPULATION, simulateWithZeroBaseFee: inputBlock.simulateWithZeroBaseFee })
					}
				}
				preparedBlocks.push({ inputBlock, rpcBlockCount: splitted.length })
			} else {
				rpcBlocks.push(inputBlock)
				preparedBlocks.push({ inputBlock, rpcBlockCount: 1 })
			}
		}

		let previousBlockOverride = { time: parentBlock.timestamp, feeRecipient: parentBlock.miner }
		for (const inputBlock of rpcBlocks) {
			const newBlockOverride = {
				...previousBlockOverride,
				baseFeePerGas: inputBlock.simulateWithZeroBaseFee ? 0n : baseFeePerGas,
				time: getNextBlockTimeStampOverride(previousBlockOverride.time, inputBlock.blockTimeManipulation)
			}
			blockOverrides.push(newBlockOverride)
			previousBlockOverride = newBlockOverride
		}

		const getBlockStateCall = async (block: SimulationStateInputMinimalDataBlock, blockOverrides: BlockOverrides) => {
			const rpcCalls = block.transactions.map((transaction) => toEthSimulateCall(transaction.signedTransaction))
			const ecRecoverMovedToAddress = 0x123456n
			const ecRecoverAddress = 1n

			const isHexSignature = (value: string): value is `0x${ string }` => value.startsWith('0x')
			const encodePackedHash = (messageHashAndSignature: MessageHashAndSignature) => {
				if (!isHexSignature(messageHashAndSignature.signature)) throw new Error('Signature must be hex encoded')
				const sig = parseSignatureHex(messageHashAndSignature.signature)
				const packed = BigInt(keccak256(encodeAbiValues(['bytes32', 'uint8', 'bytes32', 'bytes32'], [messageHashAndSignature.messageHash, sig.v ?? BigInt(sig.yParity), sig.r, sig.s])))
				return packed
			}

			// set mapping storage mapping() (instructed here: https://docs.soliditylang.org/en/latest/internals/layout_in_storage.html)
			const getMappingsMemorySlot = (hash: EthereumBytes32) => keccak256(encodeAbiValues(['bytes32', 'uint256'], [bytes32String(hash), 0n]))
			const signatureStructs = await Promise.all(block.signedMessages.map(async (sign) => {
				const messageHashAndSignature = await simulatePersonalSign(sign.originalRequestParameters, sign.fakeSignedFor)
				return { key: getMappingsMemorySlot(encodePackedHash(messageHashAndSignature)), value: sign.fakeSignedFor }
			}))
			const stateSets = signatureStructs.reduce((acc, current) => {
				acc[current.key] = current.value
				return acc
			}, {} as { [key: string]: bigint } )
			return {
				calls: rpcCalls,
				blockOverrides,
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

		const blockStateCalls = await Promise.all(rpcBlocks.map(async (block, index) => {
			const blockOverrideForBlock = blockOverrides[index]
			if (blockOverrideForBlock === undefined) throw new Error('Block Overridex index overflow')
			return await getBlockStateCall(block, blockOverrideForBlock)
		}))
		if (parentBlock === null) throw new Error('The latest block is null')
		return {
			inputBlocks: preparedBlocks,
			rpcBlocks,
			blockOverrides,
			request: {
				method: 'eth_simulateV1',
				params: [{
					blockStateCalls,
					traceTransfers: true,
					validation: false,
				}, blockNumber === parentBlock.number + 1n ? blockNumber - 1n : blockNumber] as const,
			},
		}
	}

	public readonly ethSimulateV1Input = async (simulationStateInput: SimulationStateInputMinimalData, blockNumber: bigint, requestAbortController: AbortController | undefined) => {
		return (await this.prepareEthSimulateV1Input(simulationStateInput, blockNumber, requestAbortController)).request
	}

	public readonly simulatePrepared = async (simulationStateInput: SimulationStateInputMinimalData, blockNumber: bigint, requestAbortController: AbortController | undefined) => {
		const prepared = await this.prepareEthSimulateV1Input(simulationStateInput, blockNumber, requestAbortController)
		return {
			prepared,
			result: EthSimulateV1Result.parse(await this.requestHandler.jsonRpcRequest(prepared.request)),
		}
	}

	public readonly simulate = async (simulationStateInput: SimulationStateInputMinimalData, blockNumber: bigint, requestAbortController: AbortController | undefined): Promise<EthSimulateV1Result> => {
		const input = await this.ethSimulateV1Input(simulationStateInput, blockNumber, requestAbortController)
		return EthSimulateV1Result.parse(await this.requestHandler.jsonRpcRequest(input))
	}

	public readonly web3ClientVersion = async (requestAbortController: AbortController | undefined) => {
		const response = await this.requestHandler.jsonRpcRequest({ method: 'web3_clientVersion', params: [] }, requestAbortController)
		return funtypes.String.parse(response)
	}
}
