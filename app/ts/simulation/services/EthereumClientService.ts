import { EthereumSignedTransactionWithBlockData, EthereumQuantity, type EthereumBlockTag, EthereumData, EthereumBlockHeader, EthereumBlockHeaderWithTransactionHashes, type EthereumBytes32, type EthereumSendableSignedTransaction } from '../../types/wire-types.js'
import type { IUnsignedTransaction1559 } from '../../utils/ethereum.js'
import { MAX_BLOCK_CACHE, TIME_BETWEEN_BLOCKS } from '../../utils/constants.js'
import { keccak256 } from '../../utils/ethereumPrimitives.js'
import type { IEthereumJSONRpcRequestHandler } from './EthereumJSONRpcRequestHandler.js'
import { addressString, bigintSecondsToDate, bytes32String, dataString, dateToBigintSeconds, max } from '../../utils/bigint.js'
import { type BlockCalls, type BlockOverrides, EthSimulateV1Result, type EthSimulateV1Params, type StateOverrides } from '../../types/ethSimulate-types.js'
import { EthGetFeeHistoryResponse, EthGetStorageAtResponse, EthSyncingResponse, EthTransactionReceiptResponse, type FeeHistory, type EthGetLogsRequest, EthGetLogsResponse, type PartialEthereumTransaction } from '../../types/JsonRpc-types.js'
import { getBlockTimeManipulationSeconds, getSimulatedBlockBaseFeePerGas } from './simulationBlockParameters.js'
import { simulatePersonalSign } from './simulationPersonalSigning.js'
import { DEFAULT_BLOCK_MANIPULATION } from '../../config/defaults.js'
import { getEcRecoverOverride } from '../../utils/ethereumByteCodes.js'
import * as funtypes from 'funtypes'
import type { RpcEntry } from '../../types/rpc.js'
import { authorizesExecutedCall, type BlockTimeManipulation, type SimulatedExecutionInput, type SimulationStateInputMinimalData, type SimulationStateInputMinimalDataBlock } from '../../types/visualizer-types.js'
import type { MessageHashAndSignature } from '../../utils/eip712.js'
import { encodeAbiValues } from '../../utils/abiRuntime.js'
import { getCurrentTimestampString } from '../../utils/time.js'
import { projectEip7702AuthorizationForRpc } from '../../utils/eip7702Authorization.js'
import { mapBlocksWithEffectiveStateOverrides } from '../../utils/simulationStateOverrides.js'

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

export type RpcTransaction = SimulationStateInputMinimalDataBlock['transactions'][number]

// The call the node runs for a transaction: its executedTransaction when the simulation input was prepared with one, otherwise its signedTransaction. signedTransaction stays the call the transaction shows, which transaction lookups and receipts return.
export const getExecutedTransaction = (transaction: RpcTransaction) => transaction.executedTransaction ?? transaction.signedTransaction

// How a simulation input that reached the node breaks the executed-call invariant of prepareEthSimulateV1Input.
export type UnpreparedSimulationInputViolation = 'missing-executed-call' | 'unauthorized-executed-call'
const UNPREPARED_SIMULATION_INPUT_ERROR_NAME = 'UnpreparedSimulationInputError'

// A distinctly named error for an input whose preparation a caller skipped, so it reads apart from a node failure in logs and error reports. A plain Error with a name, not an InterceptorInternalError, so it is still reported as unexpected. The precondition is checked here at runtime rather than encoded in the parameter type, because SimulationStateInputMinimalData is also the stored simulation state's input and is built at many call sites, so a separate prepared type would have to wrap all of them.
export const createUnpreparedSimulationInputError = (violation: UnpreparedSimulationInputViolation, message: string) => Object.assign(new Error(message), { name: UNPREPARED_SIMULATION_INPUT_ERROR_NAME, violation })

export const isUnpreparedSimulationInputError = (error: unknown): error is Error & { readonly violation: UnpreparedSimulationInputViolation } => error instanceof Error
	&& error.name === UNPREPARED_SIMULATION_INPUT_ERROR_NAME
	&& 'violation' in error
	&& (error.violation === 'missing-executed-call' || error.violation === 'unauthorized-executed-call')

export const getTotalExecutedGasLimit = (transactions: readonly RpcTransaction[]) => transactions.reduce((totalGasLimit, transaction) => totalGasLimit + getExecutedTransaction(transaction).gas, 0n)

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
			authorizationList: transaction.authorizationList.map(projectEip7702AuthorizationForRpc),
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
	// Nodes reject an eth_simulateV1 block that is not strictly later than its parent, so a zero delay (a block split inserted by getCurrentSimulationInput, or a user's 0) still advances the simulated time by one second.
	if (blockTimeManipulation.type === 'AddToTimestamp') return bigintSecondsToDate(prevTime + max(1n, getBlockTimeManipulationSeconds(blockTimeManipulation.deltaToAdd, blockTimeManipulation.deltaUnit)))
	return bigintSecondsToDate(max(prevTime + 1n, blockTimeManipulation.timeToSet))
}

// The delegate an EIP-7702 delegation designator (0xef0100 followed by the delegate's address) points to, or undefined for any other code.
export const getDelegateFromCode = (code: Uint8Array) => {
	if (code.length !== 23 || code[0] !== 0xef || code[1] !== 0x01 || code[2] !== 0x00) return undefined
	return BigInt(`0x${ dataString(code.slice(3)) }`)
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
			// Cached responses are only valid for the block they were read in, and no new blocks are observed while polling sleeps, so they are dropped together with that block.
			this.cachedBlock = undefined
			this.requestHandler.clearCache()
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
		return getDelegateFromCode(await this.getCode(address, blockTag, requestAbortController))
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

	public readonly getMaxPriorityFeePerGas = async(requestAbortController: AbortController | undefined) => {
		const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_maxPriorityFeePerGas' }, requestAbortController)
		return EthereumQuantity.parse(response)
	}

	// Bypass the response cache: it is only cleared when the latest block changes, and a stalled or syncing node's status can change while its latest block does not.
	public readonly getSyncingStatus = async(requestAbortController: AbortController | undefined) => {
		const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_syncing' }, requestAbortController, true)
		return EthSyncingResponse.parse(response)
	}

	public readonly getTransactionByHash = async (hash: bigint, requestAbortController: AbortController | undefined) => {
		const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_getTransactionByHash', params: [hash] }, requestAbortController)
		if (response === null) return null
		return EthereumSignedTransactionWithBlockData.parse(response)
	}

	public readonly call = async (transaction: Partial<Pick<IUnsignedTransaction1559, 'to' | 'from' | 'input' | 'value' | 'maxFeePerGas' | 'maxPriorityFeePerGas' | 'gasLimit' | 'accessList'>>, blockTag: EthereumBlockTag, requestAbortController: AbortController | undefined) => {
		const params = {
			...(transaction.to !== undefined ? { to: transaction.to } : {}),
			...(transaction.from !== undefined ? { from: transaction.from } : {}),
			...(transaction.input !== undefined ? { data: transaction.input } : {}),
			...(transaction.value !== undefined ? { value: transaction.value } : {}),
			...(transaction.maxFeePerGas !== undefined ? { maxFeePerGas: transaction.maxFeePerGas } : {}),
			...(transaction.maxPriorityFeePerGas !== undefined ? { maxPriorityFeePerGas: transaction.maxPriorityFeePerGas } : {}),
			...(transaction.gasLimit !== undefined ? { gas: transaction.gasLimit } : {}),
			...(transaction.accessList !== undefined ? { accessList: transaction.accessList } : {}),
		}
		const response = await this.requestHandler.jsonRpcRequest({ method: 'eth_call', params: [params, blockTag] }, requestAbortController)
		return EthereumData.parse(response)
	}

	public readonly getFeeHistory = async (request: FeeHistory, requestAbortController: AbortController | undefined) => {
		return EthGetFeeHistoryResponse.parse(await this.requestHandler.jsonRpcRequest(request, requestAbortController))
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

	public readonly prepareEthSimulateV1Input = async (executionInput: SimulatedExecutionInput, blockNumber: bigint, requestAbortController: AbortController | undefined): Promise<PreparedEthSimulateV1Input> => {
		const simulationStateInput = executionInput.value
		// This service applies caller-supplied initial account state; mode and preference selection happen upstream.
		const simulationOverrides = executionInput.simulationOverrides
		// Every simulation input reaches the node through here, so this enforces, in both directions, that a transaction runs a call other than its signedTransaction exactly when its simulation options authorize one (authorizesExecutedCall). A transaction whose options ask for an executed call but whose input was not prepared with one would otherwise run as the call it shows. Both throws are internal invariant failures (a caller skipped preparing its input), not user-facing errors, so they stay reported as unexpected errors. Their messages stay protocol-agnostic so this RPC layer names no Safe or background helper.
		if (simulationStateInput.some((block) => block.transactions.some((transaction) => authorizesExecutedCall(transaction.simulationOptions) && transaction.executedTransaction === undefined))) throw createUnpreparedSimulationInputError('missing-executed-call', 'A transaction whose simulation options require a prepared executed call reached the node without one.')
		if (simulationStateInput.some((block) => block.transactions.some((transaction) => transaction.executedTransaction !== undefined && !authorizesExecutedCall(transaction.simulationOptions)))) throw createUnpreparedSimulationInputError('unauthorized-executed-call', 'A transaction reached the node with an executed call other than its signed transaction, which its simulation options do not authorize.')
		const parentBlock = await this.getBlock(requestAbortController, blockNumber)
		if (parentBlock === null) throw new Error(`The block ${ blockNumber } is null`)

		const blockOverrides: BlockOverrides[] = []
		const baseFeePerGas = getSimulatedBlockBaseFeePerGas(parentBlock)

		const clampGasToBlock = (transaction: EthereumSendableSignedTransaction) => ({ ...transaction, gas: transaction.gas > parentBlock.gasLimit ? parentBlock.gasLimit : transaction.gas })
		const gasLimitTransaction = (transaction: RpcTransaction): RpcTransaction => ({
			signedTransaction: clampGasToBlock(transaction.signedTransaction),
			...(transaction.executedTransaction === undefined ? {} : { executedTransaction: clampGasToBlock(transaction.executedTransaction) }),
			// simulationOptions stays with executedTransaction: the rpcBlocks are simulation input blocks too and must satisfy the invariant checked above.
			...(transaction.simulationOptions === undefined ? {} : { simulationOptions: transaction.simulationOptions }),
		})

		const splitTransactionsByGasLimit = (currentTransactions: readonly RpcTransaction[], gasLimit: bigint): RpcTransaction[][] => {
			const transactionChunks: RpcTransaction[][] = []
			let currentChunk: RpcTransaction[] = []
			let currentChunkGasSum = 0n
			for (const transaction of currentTransactions) {
				const { gas } = getExecutedTransaction(transaction)
				if (gas > gasLimit) throw new Error(`Transaction gas ${ gas.toString() } exceeds gas limit ${ gasLimit.toString() }`)
				if (currentChunkGasSum + gas <= gasLimit) {
					currentChunk.push(transaction)
					currentChunkGasSum = currentChunkGasSum + gas
				} else {
					transactionChunks.push(currentChunk)
					currentChunk = [ transaction ]
					currentChunkGasSum = gas
				}
			}
			if (currentChunk.length > 0) transactionChunks.push(currentChunk)
			return transactionChunks
		}

		// Initial account state reaches the node only through the first block, so an input without blocks sends it in one call-less block instead of dropping it.
		const blocksToSend: SimulationStateInputMinimalData = simulationStateInput.length === 0 && Object.keys(simulationOverrides).length > 0
			? [{ transactions: [], stateOverrides: {}, signedMessages: [], blockTimeManipulation: DEFAULT_BLOCK_MANIPULATION, simulateWithZeroBaseFee: false }]
			: simulationStateInput
		// if transactions spend more gas in a block than the block allows, split them into multiple blocks. Also clamp a single transaction to take at most one block worth of gas
		const gasLimitedInput: SimulationStateInputMinimalData = blocksToSend.map((block) => ({ ...block, transactions: block.transactions.map(gasLimitTransaction) }))
		const preparedBlocks: PreparedEthSimulateV1InputBlock[] = []
		const rpcBlocks: SimulationStateInputMinimalDataBlock[] = []
		for (const inputBlock of gasLimitedInput) {
			if (getTotalExecutedGasLimit(inputBlock.transactions) > parentBlock.gasLimit) {
				const splitted = splitTransactionsByGasLimit(inputBlock.transactions, parentBlock.gasLimit)
				for (const [index, transactions] of splitted.entries()) {
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

		const getBlockStateCall = async (block: SimulationStateInputMinimalDataBlock, blockOverrides: BlockOverrides, effectiveStateOverrides: StateOverrides) => {
			const rpcCalls = block.transactions.map((transaction) => toEthSimulateCall(getExecutedTransaction(transaction)))
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
					...effectiveStateOverrides,
				}
			}
		}

		const blockStateCalls = await Promise.all(mapBlocksWithEffectiveStateOverrides(rpcBlocks, simulationOverrides, (block) => block.stateOverrides, async (block, effectiveStateOverrides, index) => {
			const blockOverrideForBlock = blockOverrides[index]
			if (blockOverrideForBlock === undefined) throw new Error('Block Overridex index overflow')
			return await getBlockStateCall(block, blockOverrideForBlock, effectiveStateOverrides)
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

	public readonly ethSimulateV1Input = async (simulationInput: SimulatedExecutionInput, blockNumber: bigint, requestAbortController: AbortController | undefined) => {
		return (await this.prepareEthSimulateV1Input(simulationInput, blockNumber, requestAbortController)).request
	}

	public readonly simulatePrepared = async (simulationInput: SimulatedExecutionInput, blockNumber: bigint, requestAbortController: AbortController | undefined) => {
		const prepared = await this.prepareEthSimulateV1Input(simulationInput, blockNumber, requestAbortController)
		return {
			prepared,
			result: EthSimulateV1Result.parse(await this.requestHandler.jsonRpcRequest(prepared.request)),
		}
	}

	public readonly simulate = async (simulationInput: SimulatedExecutionInput, blockNumber: bigint, requestAbortController: AbortController | undefined): Promise<EthSimulateV1Result> => {
		const input = await this.ethSimulateV1Input(simulationInput, blockNumber, requestAbortController)
		return EthSimulateV1Result.parse(await this.requestHandler.jsonRpcRequest(input))
	}

	public readonly web3ClientVersion = async (requestAbortController: AbortController | undefined) => {
		const response = await this.requestHandler.jsonRpcRequest({ method: 'web3_clientVersion', params: [] }, requestAbortController)
		return funtypes.String.parse(response)
	}
}
