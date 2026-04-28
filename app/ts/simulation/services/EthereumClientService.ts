import { EthereumSignedTransactionWithBlockData, EthereumQuantity, EthereumBlockTag, EthereumData, EthereumBlockHeader, EthereumBlockHeaderWithTransactionHashes, EthereumBytes32, EthereumSendableSignedTransaction } from '../../types/wire-types.js'
import { IUnsignedTransaction1559 } from '../../utils/ethereum.js'
import { MAX_BLOCK_CACHE, TIME_BETWEEN_BLOCKS } from '../../utils/constants.js'
import { IEthereumJSONRpcRequestHandler } from './EthereumJSONRpcRequestHandler.js'
import { AbiCoder, Signature, ethers } from 'ethers'
import { addressString, bigintSecondsToDate, bytes32String, dateToBigintSeconds, max } from '../../utils/bigint.js'
import { BlockCalls, BlockOverrides, EthSimulateV1Result, EthSimulateV1Params } from '../../types/ethSimulate-types.js'
import { EthGetStorageAtResponse, EthTransactionReceiptResponse, EthGetLogsRequest, EthGetLogsResponse, PartialEthereumTransaction } from '../../types/JsonRpc-types.js'
import { DEFAULT_BLOCK_MANIPULATION, getBlockTimeManipulationSeconds, simulatePersonalSign } from './SimulationModeEthereumClientService.js'
import { getEcRecoverOverride } from '../../utils/ethereumByteCodes.js'
import * as funtypes from 'funtypes'
import { RpcEntry } from '../../types/rpc.js'
import { BlockTimeManipulation, SimulationStateInputMinimalData, SimulationStateInputMinimalDataBlock } from '../../types/visualizer-types.js'
import { MessageHashAndSignature } from '../../utils/eip712.js'
import { getCurrentTimestampString } from '../../components/ui-utils.js'

export const getNextBlockTimeStampOverride = (previousBlockTimeStamp: Date, blockTimeManipulation: BlockTimeManipulation) => {
	const prevTime = dateToBigintSeconds(previousBlockTimeStamp)
	if (blockTimeManipulation.type === 'AddToTimestamp') return bigintSecondsToDate(prevTime + getBlockTimeManipulationSeconds(blockTimeManipulation.deltaToAdd, blockTimeManipulation.deltaUnit))
	return bigintSecondsToDate(max(prevTime + 1n, blockTimeManipulation.timeToSet))
}

export interface EthereumClientService {
	getRpcEntry(): RpcEntry
	getNewBlockAttemptCallback(): (blockHeader: EthereumBlockHeader, ethereumClientService: EthereumClientService, isNewBlock: boolean) => Promise<void>
	getOnErrorBlockCallback(): (ethereumClientService: EthereumClientService, error: unknown) => Promise<void>
	getCachedBlock(): EthereumBlockHeader | undefined
	cleanup(): void
	isBlockPolling(): boolean
	setBlockPolling(enabled: boolean): void
	estimateGas(data: PartialEthereumTransaction, requestAbortController: AbortController | undefined): Promise<bigint>
	getStorageAt(contract: bigint, slot: bigint, blockTag: EthereumBlockTag, requestAbortController: AbortController | undefined): Promise<ReturnType<typeof EthGetStorageAtResponse.parse>>
	getTransactionCount(address: bigint, blockTag: EthereumBlockTag, requestAbortController: AbortController | undefined): Promise<bigint>
	getTransactionReceipt(hash: bigint, requestAbortController: AbortController | undefined): Promise<ReturnType<typeof EthTransactionReceiptResponse.parse>>
	getBalance(address: bigint, blockTag: EthereumBlockTag, requestAbortController: AbortController | undefined): Promise<bigint>
	getCode(address: bigint, blockTag: EthereumBlockTag, requestAbortController: AbortController | undefined): Promise<Uint8Array>
	getBlock(requestAbortController: AbortController | undefined, blockTag?: EthereumBlockTag, fullObjects?: true): Promise<EthereumBlockHeader>
	getBlock(requestAbortController: AbortController | undefined, blockTag: EthereumBlockTag, fullObjects: boolean): Promise<EthereumBlockHeaderWithTransactionHashes | EthereumBlockHeader>
	getBlock(requestAbortController: AbortController | undefined, blockTag: EthereumBlockTag, fullObjects: false): Promise<EthereumBlockHeaderWithTransactionHashes>
	getBlockByHash(blockHash: EthereumBytes32, requestAbortController: AbortController | undefined, fullObjects?: boolean): Promise<EthereumBlockHeaderWithTransactionHashes | EthereumBlockHeader>
	getChainId(): bigint
	getLogs(logFilter: EthGetLogsRequest, requestAbortController: AbortController | undefined): Promise<ReturnType<typeof EthGetLogsResponse.parse>>
	getBlockNumber(requestAbortController: AbortController | undefined): Promise<bigint>
	getGasPrice(requestAbortController: AbortController | undefined): Promise<bigint>
	getTransactionByHash(hash: bigint, requestAbortController: AbortController | undefined): Promise<ReturnType<typeof EthereumSignedTransactionWithBlockData.parse> | null>
	call(transaction: Partial<Pick<IUnsignedTransaction1559, 'to' | 'from' | 'input' | 'value' | 'maxFeePerGas' | 'maxPriorityFeePerGas' | 'gasLimit'>>, blockTag: EthereumBlockTag, requestAbortController: AbortController | undefined): Promise<string>
	ethSimulateV1(blockStateCalls: readonly BlockCalls[], blockTag: EthereumBlockTag, requestAbortController: AbortController | undefined): Promise<ReturnType<typeof EthSimulateV1Result.parse>>
	prepareEthSimulateV1Input(simulationStateInput: SimulationStateInputMinimalData, blockNumber: bigint, requestAbortController: AbortController | undefined): Promise<PreparedEthSimulateV1Input>
	ethSimulateV1Input(simulationStateInput: SimulationStateInputMinimalData, blockNumber: bigint, requestAbortController: AbortController | undefined): Promise<EthSimulateV1Params>
	simulatePrepared(simulationStateInput: SimulationStateInputMinimalData, blockNumber: bigint, requestAbortController: AbortController | undefined): Promise<{ prepared: PreparedEthSimulateV1Input, result: ReturnType<typeof EthSimulateV1Result.parse> }>
	simulate(simulationStateInput: SimulationStateInputMinimalData, blockNumber: bigint, requestAbortController: AbortController | undefined): Promise<ReturnType<typeof EthSimulateV1Result.parse>>
	web3ClientVersion(requestAbortController: AbortController | undefined): Promise<string>
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

export function EthereumClientService(
	requestHandler: IEthereumJSONRpcRequestHandler,
	newBlockAttemptCallback: (blockHeader: EthereumBlockHeader, ethereumClientService: EthereumClientService, isNewBlock: boolean) => Promise<void>,
	onErrorBlockCallback: (ethereumClientService: EthereumClientService, error: unknown) => Promise<void>,
	rpcEntry: RpcEntry,
): EthereumClientService {
	let cachedBlock: EthereumBlockHeader | undefined = undefined
	let cacheRefreshTimer: NodeJS.Timeout | undefined = undefined
	let retrievingBlock = false

	if (rpcEntry.httpsRpc !== requestHandler.rpcUrl) throw new Error('The URL values for rpcEntry and requestHander must match')

	const getRpcEntry = () => rpcEntry
	const getNewBlockAttemptCallback = () => newBlockAttemptCallback
	const getOnErrorBlockCallback = () => onErrorBlockCallback

	const getCachedBlock = () => {
		const currentCachedBlock = cachedBlock
		if (currentCachedBlock === undefined || currentCachedBlock === null) return undefined
		if ((Date.now() - currentCachedBlock.timestamp.getTime() * 1000) > TIME_BETWEEN_BLOCKS * MAX_BLOCK_CACHE) return undefined
		return currentCachedBlock
	}

	const isBlockPolling = () => cacheRefreshTimer !== undefined

	const updateCache = async () => {
		if (retrievingBlock) return
		try {
			retrievingBlock = true
			const response = await requestHandler.jsonRpcRequest({ method: 'eth_getBlockByNumber', params: ['latest', true] }, undefined, true, 6000)
			if (cacheRefreshTimer === undefined) return
			const newBlock = EthereumBlockHeader.parse(response)
			if (newBlock === null) return
			console.info(`${ getCurrentTimestampString() } Current block number: ${ newBlock.number } on ${ getRpcEntry().name }`)
			const gotNewBlock = cachedBlock?.number !== newBlock.number
			if (gotNewBlock) requestHandler.clearCache()
			cachedBlock = newBlock
			await newBlockAttemptCallback(newBlock, service, gotNewBlock)
		} catch(error: unknown) {
			return await onErrorBlockCallback(service, error)
		} finally {
			retrievingBlock = false
		}
	}

	const setBlockPolling = (enabled: boolean) => {
		if (enabled && cacheRefreshTimer === undefined) {
			const now = Date.now()
			updateCache()
			const timeToTarget = Math.floor(now / 1000 / TIME_BETWEEN_BLOCKS) * 1000 * TIME_BETWEEN_BLOCKS + 7 * 1000 - now
			cacheRefreshTimer = setTimeout(() => {
				updateCache()
				cacheRefreshTimer = setInterval(updateCache, TIME_BETWEEN_BLOCKS * 1000)
			}, timeToTarget > 0 ? timeToTarget : timeToTarget + TIME_BETWEEN_BLOCKS * 1000)
			return
		}
		if (!enabled) {
			clearTimeout(cacheRefreshTimer)
			clearInterval(cacheRefreshTimer)
			cacheRefreshTimer = undefined
			cachedBlock = undefined
		}
	}

	const cleanup = () => {
		setBlockPolling(false)
	}

	const estimateGas = async (data: PartialEthereumTransaction, requestAbortController: AbortController | undefined) => {
		const response = await requestHandler.jsonRpcRequest({ method: 'eth_estimateGas', params: [data] }, requestAbortController)
		return EthereumQuantity.parse(response)
	}

	const getStorageAt = async (contract: bigint, slot: bigint, blockTag: EthereumBlockTag, requestAbortController: AbortController | undefined) => {
		const response = await requestHandler.jsonRpcRequest({ method: 'eth_getStorageAt', params: [contract, slot, blockTag] }, requestAbortController)
		return EthGetStorageAtResponse.parse(response)
	}

	const getTransactionCount = async (address: bigint, blockTag: EthereumBlockTag, requestAbortController: AbortController | undefined) => {
		const response = await requestHandler.jsonRpcRequest({ method: 'eth_getTransactionCount', params: [address, blockTag] }, requestAbortController)
		return EthereumQuantity.parse(response)
	}

	const getTransactionReceipt = async (hash: bigint, requestAbortController: AbortController | undefined) => {
		const response = await requestHandler.jsonRpcRequest({ method: 'eth_getTransactionReceipt', params: [hash] }, requestAbortController)
		return EthTransactionReceiptResponse.parse(response)
	}

	const getBalance = async (address: bigint, blockTag: EthereumBlockTag, requestAbortController: AbortController | undefined) => {
		const response = await requestHandler.jsonRpcRequest({ method: 'eth_getBalance', params: [address, blockTag] }, requestAbortController)
		return EthereumQuantity.parse(response)
	}

	const getCode = async (address: bigint, blockTag: EthereumBlockTag, requestAbortController: AbortController | undefined) => {
		const response = await requestHandler.jsonRpcRequest({ method: 'eth_getCode', params: [address, blockTag] }, requestAbortController)
		return EthereumData.parse(response)
	}

	async function getBlock(requestAbortController: AbortController | undefined, blockTag?: EthereumBlockTag, fullObjects?: true): Promise<EthereumBlockHeader>
	async function getBlock(requestAbortController: AbortController | undefined, blockTag: EthereumBlockTag, fullObjects: boolean): Promise<EthereumBlockHeaderWithTransactionHashes | EthereumBlockHeader>
	async function getBlock(requestAbortController: AbortController | undefined, blockTag: EthereumBlockTag, fullObjects: false): Promise<EthereumBlockHeaderWithTransactionHashes>
	async function getBlock(requestAbortController: AbortController | undefined, blockTag: EthereumBlockTag = 'latest', fullObjects = true): Promise<EthereumBlockHeaderWithTransactionHashes | EthereumBlockHeader> {
		const cached = getCachedBlock()
		if (cached && (blockTag === 'latest' || blockTag === cached.number)) {
			if (fullObjects === false) return { ...cached, transactions: cached.transactions.map((transaction) => transaction.hash) }
			return cached
		}
		if (fullObjects === false) return EthereumBlockHeaderWithTransactionHashes.parse(await requestHandler.jsonRpcRequest({ method: 'eth_getBlockByNumber', params: [blockTag, false] }))
		return EthereumBlockHeader.parse(await requestHandler.jsonRpcRequest({ method: 'eth_getBlockByNumber', params: [blockTag, fullObjects] }, requestAbortController))
	}

	const getBlockByHash = async (blockHash: EthereumBytes32, requestAbortController: AbortController | undefined, fullObjects = true): Promise<EthereumBlockHeaderWithTransactionHashes | EthereumBlockHeader> => {
		const cached = getCachedBlock()
		if (cached && cached.hash === blockHash) {
			if (fullObjects === false) return { ...cached, transactions: cached.transactions.map((transaction) => transaction.hash) }
			return cached
		}
		if (fullObjects === false) return EthereumBlockHeaderWithTransactionHashes.parse(await requestHandler.jsonRpcRequest({ method: 'eth_getBlockByHash', params: [blockHash, false] }))
		return EthereumBlockHeader.parse(await requestHandler.jsonRpcRequest({ method: 'eth_getBlockByHash', params: [blockHash, fullObjects] }, requestAbortController))
	}

	const getChainId = () => getRpcEntry().chainId

	const getLogs = async (logFilter: EthGetLogsRequest, requestAbortController: AbortController | undefined) => {
		const response = await requestHandler.jsonRpcRequest({ method: 'eth_getLogs', params: [logFilter] }, requestAbortController)
		return EthGetLogsResponse.parse(response)
	}

	const getBlockNumber = async (requestAbortController: AbortController | undefined) => {
		const cached = getCachedBlock()
		if (cached) return cached.number
		const response = await requestHandler.jsonRpcRequest({ method: 'eth_blockNumber' }, requestAbortController)
		return EthereumQuantity.parse(response)
	}

	const getGasPrice = async (requestAbortController: AbortController | undefined) => {
		const response = await requestHandler.jsonRpcRequest({ method: 'eth_gasPrice' }, requestAbortController)
		return EthereumQuantity.parse(response)
	}

	const getTransactionByHash = async (hash: bigint, requestAbortController: AbortController | undefined) => {
		const response = await requestHandler.jsonRpcRequest({ method: 'eth_getTransactionByHash', params: [hash] }, requestAbortController)
		if (response === null) return null
		return EthereumSignedTransactionWithBlockData.parse(response)
	}

	const call = async (
		transaction: Partial<Pick<IUnsignedTransaction1559, 'to' | 'from' | 'input' | 'value' | 'maxFeePerGas' | 'maxPriorityFeePerGas' | 'gasLimit'>>,
		blockTag: EthereumBlockTag,
		requestAbortController: AbortController | undefined,
	) => {
		if (transaction.to === null) throw new Error('To cannot be null')
		const params = {
			...(transaction.to !== undefined ? { to: transaction.to } : {}),
			...(transaction.from !== undefined ? { from: transaction.from } : {}),
			...(transaction.input !== undefined ? { data: transaction.input } : {}),
			...(transaction.value !== undefined ? { value: transaction.value } : {}),
			...transaction.maxFeePerGas !== undefined && transaction.maxPriorityFeePerGas !== undefined ? { gasPrice: transaction.maxFeePerGas + transaction.maxPriorityFeePerGas } : {},
			...(transaction.gasLimit !== undefined ? { gas: transaction.gasLimit } : {}),
		}
		const response = await requestHandler.jsonRpcRequest({ method: 'eth_call', params: [params, blockTag] }, requestAbortController)
		if (typeof response !== 'string') throw new Error('eth_call returned a non-string result')
		return response
	}

	const ethSimulateV1 = async (blockStateCalls: readonly BlockCalls[], blockTag: EthereumBlockTag, requestAbortController: AbortController | undefined) => {
		const parentBlock = await getBlock(requestAbortController)
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
		return EthSimulateV1Result.parse(await requestHandler.jsonRpcRequest(call))
	}

	const prepareEthSimulateV1Input = async (
		simulationStateInput: SimulationStateInputMinimalData,
		blockNumber: bigint,
		requestAbortController: AbortController | undefined,
	): Promise<PreparedEthSimulateV1Input> => {
		const parentBlock = await getBlock(requestAbortController, blockNumber)
		if (parentBlock === null) throw new Error(`The block ${ blockNumber } is null`)

		const blockOverrides: BlockOverrides[] = []
		const baseFeePerGas = parentBlock.baseFeePerGas === undefined ? 15000000n : parentBlock.baseFeePerGas

		const gasLimitTransaction = (transaction: EthereumSendableSignedTransaction) => ({ ...transaction, gas: transaction.gas > parentBlock.gasLimit ? parentBlock.gasLimit : transaction.gas })

		const splitTransactionsByGasLimit = (currentTransactions: EthereumSendableSignedTransaction[], gasLimit: bigint): EthereumSendableSignedTransaction[][] => {
			const transactionChunks: EthereumSendableSignedTransaction[][] = []
			let currentChunk: EthereumSendableSignedTransaction[] = []
			let currentChunkGasSum: bigint = 0n
			for (const transaction of currentTransactions) {
				if (transaction.gas > gasLimit) throw new Error(`Transaction gas ${ transaction.gas.toString() } exceeds gas limit ${ gasLimit.toString() }`)
				if (currentChunkGasSum + transaction.gas <= gasLimit) {
					currentChunk.push(transaction)
					currentChunkGasSum += transaction.gas
				} else {
					transactionChunks.push(currentChunk)
					currentChunk = [transaction]
					currentChunkGasSum = transaction.gas
				}
			}
			if (currentChunk.length > 0) transactionChunks.push(currentChunk)
			return transactionChunks
		}

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

		const getBlockStateCall = async (block: SimulationStateInputMinimalDataBlock, currentBlockOverrides: BlockOverrides) => {
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
				return BigInt(ethers.keccak256(coder.encode(['bytes32', 'uint8', 'bytes32', 'bytes32'], [messageHashAndSignature.messageHash, sig.v, sig.r, sig.s])))
			}

			const getMappingsMemorySlot = (hash: EthereumBytes32) => ethers.keccak256(coder.encode(['bytes32', 'uint256'], [bytes32String(hash), 0n]))
			const signatureStructs = await Promise.all(block.signedMessages.map(async (sign) => ({ key: getMappingsMemorySlot(encodePackedHash(simulatePersonalSign(sign.originalRequestParameters, sign.fakeSignedFor))), value: sign.fakeSignedFor })))
			const stateSets: { [key: string]: bigint } = {}
			for (const current of signatureStructs) {
				stateSets[current.key] = current.value
			}
			return {
				calls: transactionsWithRemoveZeroPricedOnes,
				blockOverrides: currentBlockOverrides,
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

	const ethSimulateV1Input = async (simulationStateInput: SimulationStateInputMinimalData, blockNumber: bigint, requestAbortController: AbortController | undefined) => {
		return (await prepareEthSimulateV1Input(simulationStateInput, blockNumber, requestAbortController)).request
	}

	const simulatePrepared = async (simulationStateInput: SimulationStateInputMinimalData, blockNumber: bigint, requestAbortController: AbortController | undefined) => {
		const prepared = await prepareEthSimulateV1Input(simulationStateInput, blockNumber, requestAbortController)
		return {
			prepared,
			result: EthSimulateV1Result.parse(await requestHandler.jsonRpcRequest(prepared.request)),
		}
	}

	const simulate = async (simulationStateInput: SimulationStateInputMinimalData, blockNumber: bigint, requestAbortController: AbortController | undefined) => {
		const input = await ethSimulateV1Input(simulationStateInput, blockNumber, requestAbortController)
		return EthSimulateV1Result.parse(await requestHandler.jsonRpcRequest(input))
	}

	const web3ClientVersion = async (requestAbortController: AbortController | undefined) => {
		const response = await requestHandler.jsonRpcRequest({ method: 'web3_clientVersion', params: [] }, requestAbortController)
		return funtypes.String.parse(response)
	}

	const service: EthereumClientService = {
		getRpcEntry,
		getNewBlockAttemptCallback,
		getOnErrorBlockCallback,
		getCachedBlock,
		cleanup,
		isBlockPolling,
		setBlockPolling,
		estimateGas,
		getStorageAt,
		getTransactionCount,
		getTransactionReceipt,
		getBalance,
		getCode,
		getBlock,
		getBlockByHash,
		getChainId,
		getLogs,
		getBlockNumber,
		getGasPrice,
		getTransactionByHash,
		call,
		ethSimulateV1,
		prepareEthSimulateV1Input,
		ethSimulateV1Input,
		simulatePrepared,
		simulate,
		web3ClientVersion,
	}

	return service
}
