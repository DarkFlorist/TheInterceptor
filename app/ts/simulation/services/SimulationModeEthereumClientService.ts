import { EthereumClientService } from './EthereumClientService.js'
import { EthereumUnsignedTransaction, EthereumSignedTransactionWithBlockData, EthereumBlockTag, EthereumAddress, EthereumBlockHeader, EthereumBlockHeaderWithTransactionHashes, EthereumData, EthereumQuantity, EthereumBytes32, EthereumSendableSignedTransaction } from '../../types/wire-types.js'
import { addressString, bigintToUint8Array, bytes32String, calculateWeightedPercentile, dataStringWith0xStart, max, min, stringToUint8Array } from '../../utils/bigint.js'
import { CANNOT_SIMULATE_OFF_LEGACY_BLOCK, ERROR_INTERCEPTOR_GAS_ESTIMATION_FAILED, ETHEREUM_LOGS_LOGGER_ADDRESS, ETHEREUM_EIP1559_BASEFEECHANGEDENOMINATOR, ETHEREUM_EIP1559_ELASTICITY_MULTIPLIER, MOCK_ADDRESS, MULTICALL3, Multicall3ABI, DEFAULT_CALL_ADDRESS, GAS_PER_BLOB, MAKE_YOU_RICH_TRANSACTION } from '../../utils/constants.js'
import { Interface, ethers, hashMessage, keccak256, } from 'ethers'
import { SimulatedTransaction, SimulationState, TokenBalancesAfter, EstimateGasError, WebsiteCreatedEthereumUnsignedTransactionOrFailed, TransactionStack, PreSimulationTransaction } from '../../types/visualizer-types.js'
import { EthereumUnsignedTransactionToUnsignedTransaction, IUnsignedTransaction1559, rlpEncode, serializeSignedTransactionToBytes } from '../../utils/ethereum.js'
import { EthGetLogsResponse, EthGetLogsRequest, EthTransactionReceiptResponse, DappRequestTransaction, EthGetFeeHistoryResponse, FeeHistory } from '../../types/JsonRpc-types.js'
import { handleERC1155TransferBatch, handleERC1155TransferSingle, handleERC20TransferLog } from '../logHandlers.js'
import { assertNever, modifyObject } from '../../utils/typescript.js'
import { SignMessageParams } from '../../types/jsonRpc-signing-types.js'
import { EthSimulateV1CallResults, EthereumEvent, StateOverrides } from '../../types/ethSimulate-types.js'
import { getCodeByteCode } from '../../utils/ethereumByteCodes.js'
import { stripLeadingZeros } from '../../utils/typed-arrays.js'
import { GetSimulationStackOldReply, GetSimulationStackReply } from '../../types/simulationStackTypes.js'
import { getMakeMeRich, getSettings } from '../../background/settings.js'
import { JsonRpcResponseError } from '../../utils/errors.js'

const MOCK_PUBLIC_PRIVATE_KEY = 0x1n // key used to sign mock transactions
const MOCK_SIMULATION_PRIVATE_KEY = 0x2n // key used to sign simulated transatons
const ADDRESS_FOR_PRIVATE_KEY_ONE = 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdfn
const GET_CODE_CONTRACT = 0x1ce438391307f908756fefe0fe220c0f0d51508an

export const getWebsiteCreatedEthereumUnsignedTransactions = (simulatedTransactions: readonly SimulatedTransaction[]) => {
	return simulatedTransactions.map((simulatedTransaction) => ({
		transaction: simulatedTransaction.preSimulationTransaction.signedTransaction,
		website: simulatedTransaction.preSimulationTransaction.website,
		created: simulatedTransaction.preSimulationTransaction.created,
		originalRequestParameters: simulatedTransaction.preSimulationTransaction.originalRequestParameters,
		transactionIdentifier: simulatedTransaction.preSimulationTransaction.transactionIdentifier,
		success: true as const,
	}))
}

export const copySimulationState = (simulationState: SimulationState): SimulationState => {
	return {
		addressToMakeRich: simulationState.addressToMakeRich,
		simulatedTransactions: [...simulationState.simulatedTransactions],
		blockNumber: simulationState.blockNumber,
		blockTimestamp: simulationState.blockTimestamp,
		rpcNetwork: simulationState.rpcNetwork,
		simulationConductedTimestamp: simulationState.simulationConductedTimestamp,
		signedMessages: simulationState.signedMessages,
		baseFeePerGas: simulationState.baseFeePerGas,
	}
}

const getETHBalanceChanges = (baseFeePerGas: bigint, transaction: SimulatedTransaction) => {
	if (transaction.ethSimulateV1CallResult.status === 'failure') return []
	const ethLogs = transaction.ethSimulateV1CallResult.logs.filter((log) => log.address === ETHEREUM_LOGS_LOGGER_ADDRESS)
	const ethBalanceAfter = transaction.tokenBalancesAfter.filter((x) => x.token === ETHEREUM_LOGS_LOGGER_ADDRESS)
	return ethBalanceAfter.map((balanceAfter) => {
		const balanceAfterBalance = baseFeePerGas * transaction.ethSimulateV1CallResult.gasUsed
		const gasFees = balanceAfter.owner === transaction.preSimulationTransaction.signedTransaction.from ? transaction.realizedGasPrice * transaction.ethSimulateV1CallResult.gasUsed : 0n
		return {
			address: balanceAfter.owner,
			before: ethLogs.reduce((total, event) => {
				const parsed = handleERC20TransferLog(event)[0]
				if (parsed === undefined || parsed.type !== 'ERC20') throw new Error('eth log was not erc20 transfer event')
				if (parsed.from === balanceAfter.owner && parsed.to !== balanceAfter.owner) return total + parsed.amount
				if (parsed.from !== balanceAfter.owner && parsed.to === balanceAfter.owner) return total - parsed.amount
				return total
			}, balanceAfterBalance ?? 0n) + gasFees,
			after: balanceAfterBalance ?? 0n,
		}
	})
}

const getMakeMeRichStateOverride = (addressToMakeRich: bigint | undefined) => addressToMakeRich !== undefined ? { [addressString(addressToMakeRich)]: { balance: MAKE_YOU_RICH_TRANSACTION.transaction.value } } : {}

export const getSimulatedStack = (simulationState: SimulationState | undefined): GetSimulationStackReply => {
	if (simulationState === undefined) return { stateOverrides: {}, transactions: [] }
	return {
		stateOverrides: getMakeMeRichStateOverride(simulationState.addressToMakeRich),
		transactions: simulationState.simulatedTransactions.map((simulatedTransaction) => ({ ethBalanceChanges: getETHBalanceChanges(simulationState.baseFeePerGas, simulatedTransaction), simulatedTransaction }))
	}
}

export const getSimulatedStackOld = (simulationState: SimulationState | undefined, version: '1.0.0' | '1.0.1'): GetSimulationStackOldReply => {
	if (simulationState === undefined) return []
	const simulatedTransactions = simulationState.simulatedTransactions.map((transaction) => {
		const ethLogs = transaction.ethSimulateV1CallResult.status === 'failure' ? [] : transaction.ethSimulateV1CallResult.logs.filter((log) => log.address === ETHEREUM_LOGS_LOGGER_ADDRESS)
		const ethBalanceAfter = transaction.tokenBalancesAfter.filter((x) => x.token === ETHEREUM_LOGS_LOGGER_ADDRESS)
		const maxPriorityFeePerGas = transaction.preSimulationTransaction.signedTransaction.type === '1559' ? transaction.preSimulationTransaction.signedTransaction.maxPriorityFeePerGas : 0n
		return {
			...transaction.preSimulationTransaction.signedTransaction,
			...transaction.ethSimulateV1CallResult,
			... ( transaction.ethSimulateV1CallResult.status === 'failure' ? {
				statusCode: transaction.ethSimulateV1CallResult.status,
				error: transaction.ethSimulateV1CallResult.error.message } : {
					statusCode: transaction.ethSimulateV1CallResult.status,
					events: transaction.ethSimulateV1CallResult.logs.map((x) => ({ loggersAddress: x.address, data: x.data, topics: x.topics }))
				}
			),
			returnValue: transaction.ethSimulateV1CallResult.returnData,
			maxPriorityFeePerGas,
			balanceChanges: ethBalanceAfter.map((balanceAfter) => {
				// in the version 1.0.0 , gas price was wrongly calculated with 'maxPriorityFeePerGas', this code keeps this for 1.0.0 but fixes it for other versions
				const balanceAfterBalance = version === '1.0.0' || balanceAfter.owner !== transaction.preSimulationTransaction.signedTransaction.from ? balanceAfter.balance : (balanceAfter.balance ?? 0n) - simulationState.baseFeePerGas * transaction.ethSimulateV1CallResult.gasUsed
				const gasFees = balanceAfter.owner === transaction.preSimulationTransaction.signedTransaction.from ? transaction.realizedGasPrice * transaction.ethSimulateV1CallResult.gasUsed : 0n
				return {
					address: balanceAfter.owner,
					before: ethLogs.reduce((total, event) => {
						const parsed = handleERC20TransferLog(event)[0]
						if (parsed === undefined || parsed.type !== 'ERC20') throw new Error('eth log was not erc20 transfer event')
						if (parsed.from === balanceAfter.owner && parsed.to !== balanceAfter.owner) return total + parsed.amount
						if (parsed.from !== balanceAfter.owner && parsed.to === balanceAfter.owner) return total - parsed.amount
						return total
					}, balanceAfterBalance ?? 0n) + gasFees,
					after: balanceAfterBalance ?? 0n,
				}
			}),
			realizedGasPrice: transaction.realizedGasPrice,
			gasLimit: transaction.preSimulationTransaction.signedTransaction.gas,
			gasSpent: transaction.ethSimulateV1CallResult.gasUsed,
		}
	})
	if (simulationState.addressToMakeRich === undefined) return simulatedTransactions
	return [
		{
			from: 0x0n,
			chainId: simulationState.rpcNetwork.chainId,
			nonce: 0n,
			to: simulationState.addressToMakeRich,
			...MAKE_YOU_RICH_TRANSACTION.transaction,
			statusCode: 'success' as const,
			gasSpent: MAKE_YOU_RICH_TRANSACTION.transaction.gas,
			realizedGasPrice: 0n,
			gasLimit: MAKE_YOU_RICH_TRANSACTION.transaction.gas,
			returnValue: new Uint8Array(),
			events: [],
			balanceChanges: [{ address: simulationState.addressToMakeRich, before: 0n, after: MAKE_YOU_RICH_TRANSACTION.transaction.value }]
		}, ...simulatedTransactions
	]
}

const transactionQueueTotalGasLimit = (simulationState: SimulationState) => {
	return simulationState.simulatedTransactions.reduce((a, b) => a + b.preSimulationTransaction.signedTransaction.gas, 0n)
}

export const simulationGasLeft = (simulationState: SimulationState | undefined, blockHeader: EthereumBlockHeader) => {
	if (blockHeader === null) throw new Error('The latest block is null')
	if (simulationState === undefined) return blockHeader.gasLimit * 1023n / 1024n
	return max(blockHeader.gasLimit * 1023n / 1024n - transactionQueueTotalGasLimit(simulationState), 0n)
}

export function getInputFieldFromDataOrInput(request: { input?: Uint8Array} | { data?: Uint8Array } | {}) {
	if ('data' in request && request.data !== undefined) return request.data
	if ('input' in request && request.input !== undefined) return request.input
	return new Uint8Array()
}

export const simulateEstimateGas = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState | undefined, data: DappRequestTransaction): Promise<EstimateGasError | { gas: bigint }> => {
	// commented out because of nethermind not estimating gas correctly https://github.com/NethermindEth/nethermind/issues/5946
	//if (simulationState === undefined) return { gas: await ethereumClientService.estimateGas(data) }
	const sendAddress = data.from !== undefined ? data.from : MOCK_ADDRESS
	const transactionCount = getSimulatedTransactionCount(ethereumClientService, requestAbortController, simulationState, sendAddress)
	const block = await ethereumClientService.getBlock(requestAbortController)
	if (block === null) throw new Error('The latest block is null')
	const maxGas = simulationGasLeft(simulationState, block)

	const getGasPriceFields = (data: DappRequestTransaction) => {
		if (data.gasPrice !== undefined) return { maxFeePerGas: data.gasPrice, maxPriorityFeePerGas: data.gasPrice }
		if (data.maxPriorityFeePerGas !== undefined && data.maxPriorityFeePerGas !== null && data.maxFeePerGas !== undefined && data.maxFeePerGas !== null) {
			return { maxFeePerGas: data.maxFeePerGas, maxPriorityFeePerGas: data.maxPriorityFeePerGas }
		}
		return { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }
	}

	const tmp = {
		type: '1559' as const,
		from: sendAddress,
		chainId: ethereumClientService.getChainId(),
		nonce: await transactionCount,
		...getGasPriceFields(data),
		gas: data.gas === undefined ? maxGas : data.gas,
		to: data.to === undefined ? null : data.to,
		value: data.value === undefined ? 0n : data.value,
		input: getInputFieldFromDataOrInput(data),
		accessList: []
	}
	try {
		const multiCall = (await simulatedMulticall(ethereumClientService, requestAbortController, simulationState, [tmp], block.number))[0]
		if (multiCall === undefined) return { error: { code: ERROR_INTERCEPTOR_GAS_ESTIMATION_FAILED, message: 'ETH Simulate Failed to estimate gas', data: '' } }
		const lastResult = multiCall.calls[multiCall.calls.length - 1]
		if (lastResult === undefined) return { error: { code: ERROR_INTERCEPTOR_GAS_ESTIMATION_FAILED, message: 'ETH Simulate Failed to estimate gas', data: '' } }
		if (lastResult.status === 'failure') return { error: { ...lastResult.error, data: dataStringWith0xStart(lastResult.returnData) } }
		const gasSpent = lastResult.gasUsed * 125n * 64n / (100n * 63n) // add 25% * 64 / 63 extra  to account for gas savings <https://eips.ethereum.org/EIPS/eip-3529>
		return { gas: gasSpent < maxGas ? gasSpent : maxGas }
	} catch (error: unknown) {
		if (error instanceof JsonRpcResponseError) {
			const safeParsedData = EthereumData.safeParse(error.data)
			return { error: { code: error.code, message: error.message, data: safeParsedData.success ? dataStringWith0xStart(safeParsedData.value) : '0x' } }
		}
		throw error
	}
}

// calculates gas price for receipts
export const calculateRealizedEffectiveGasPrice = (transaction: EthereumUnsignedTransaction, blocksBaseFeePerGas: bigint) => {
	if ('gasPrice' in transaction) return transaction.gasPrice
	return min(blocksBaseFeePerGas + transaction.maxPriorityFeePerGas, transaction.maxFeePerGas)
}

export const mockSignTransaction = (transaction: EthereumUnsignedTransaction) : EthereumSendableSignedTransaction => {
	const unsignedTransaction = EthereumUnsignedTransactionToUnsignedTransaction(transaction)
	if (unsignedTransaction.type === 'legacy') {
		const signatureParams = { r: 0n, s: 0n, v: 0n }
		const hash = EthereumQuantity.parse(keccak256(serializeSignedTransactionToBytes({ ...unsignedTransaction, ...signatureParams })))
		if (transaction.type !== 'legacy') throw new Error('types do not match')
		return { ...transaction, ...signatureParams, hash }
	}

	const signatureParams = { r: 0n, s: 0n, yParity: 'even' as const }
	const hash = EthereumQuantity.parse(keccak256(serializeSignedTransactionToBytes({ ...unsignedTransaction, ...signatureParams })))
	if (transaction.type === 'legacy') throw new Error('types do not match')
	return { ...transaction, ...signatureParams, hash }
}

export const getAddressToMakeRich = async () => await getMakeMeRich() ? (await getSettings()).activeSimulationAddress : undefined

export const appendTransaction = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState | undefined, transaction: WebsiteCreatedEthereumUnsignedTransactionOrFailed, temporaryAccountOverrides: StateOverrides = {}): Promise<SimulationState> => {
	const getSignedTransactions = () => {
		if (!transaction.success) return simulationState === undefined ? [] : simulationState.simulatedTransactions.map((x) => x.preSimulationTransaction.signedTransaction)
		const signed = mockSignTransaction(transaction.transaction)
		return simulationState === undefined ? [signed] : simulationState.simulatedTransactions.map((x) => x.preSimulationTransaction.signedTransaction).concat([signed])
	}
	const getMakeMeRichAddress = async () => {
		if (simulationState === undefined) return undefined // we are not simulation, don't make anyone rich
		if (typeof browser === 'undefined') return simulationState.addressToMakeRich // if we are not running in browser (tests)
		return await getAddressToMakeRich()
	}

	const parentBlock = await ethereumClientService.getBlock(requestAbortController)
	if (parentBlock === null) throw new Error('The latest block is null')
	const parentBaseFeePerGas = parentBlock.baseFeePerGas
	if (parentBaseFeePerGas === undefined) throw new Error(CANNOT_SIMULATE_OFF_LEGACY_BLOCK)
	const signedMessages = getSignedMessagesWithFakeSigner(simulationState)
	const signedTxs = getSignedTransactions()
	const addressToMakeRich = await getMakeMeRichAddress()
	const extraAccountOverrides = { ...temporaryAccountOverrides, ...getMakeMeRichStateOverride(addressToMakeRich) }
	const ethSimulateV1CallResult = (await ethereumClientService.simulateTransactionsAndSignatures([signedTxs], signedMessages, parentBlock.number, requestAbortController, extraAccountOverrides))[0]
	if (ethSimulateV1CallResult === undefined) throw new Error('multicall length does not match in appendTransaction')
	const transactionWebsiteData = { website: transaction.website, created: transaction.created, originalRequestParameters: transaction.originalRequestParameters, transactionIdentifier: transaction.transactionIdentifier }
	const transactionData = simulationState === undefined ? [transactionWebsiteData] : simulationState.simulatedTransactions.map((x) => ({ website: x.preSimulationTransaction.website, created: x.preSimulationTransaction.created, originalRequestParameters: x.preSimulationTransaction.originalRequestParameters, transactionIdentifier: x.preSimulationTransaction.transactionIdentifier })).concat(transactionWebsiteData)
	if (ethSimulateV1CallResult.calls.length !== signedTxs.length) throw Error('multicall length does not match in appendTransaction')
	const tokenBalancesAfter = await getTokenBalancesAfter(
		ethereumClientService,
		requestAbortController,
		ethSimulateV1CallResult.calls,
		parentBlock.number,
		signedTxs,
		signedMessages,
		extraAccountOverrides,
	)
	if (ethSimulateV1CallResult.calls.length !== tokenBalancesAfter.length) throw Error('tokenBalancesAfter length does not match')

	return {
		addressToMakeRich,
		simulatedTransactions: ethSimulateV1CallResult.calls.map((singleResult, index) => {
			const signedTx = signedTxs[index]
			const tokenBalancesAfterForIndex = tokenBalancesAfter[index]
			const transactionDataForIndex = transactionData[index]
			if (signedTx === undefined || tokenBalancesAfterForIndex === undefined || transactionDataForIndex === undefined) throw Error('invalid transaction index')
			return {
				type: 'transaction',
				ethSimulateV1CallResult: singleResult,
				tokenBalancesAfter: tokenBalancesAfterForIndex,
				realizedGasPrice: calculateRealizedEffectiveGasPrice(signedTx, ethSimulateV1CallResult.baseFeePerGas),
				preSimulationTransaction: {
					signedTransaction: signedTx,
					...transactionDataForIndex,
				}
			}
		} ),
		blockNumber: parentBlock.number,
		blockTimestamp: parentBlock.timestamp,
		baseFeePerGas: ethSimulateV1CallResult.baseFeePerGas,
		rpcNetwork: ethereumClientService.getRpcEntry(),
		simulationConductedTimestamp: new Date(),
		signedMessages: simulationState === undefined ? [] : simulationState.signedMessages,
	}
}

export const setSimulationTransactionsAndSignedMessages = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, newestBlockNumber: bigint, transactionStack: TransactionStack, addressToMakeRich: bigint | undefined): Promise<SimulationState>  => {
	if (transactionStack.transactions.length === 0) {
		return {
			addressToMakeRich,
			simulatedTransactions: [],
			blockNumber: newestBlockNumber,
			blockTimestamp: new Date(),
			rpcNetwork: ethereumClientService.getRpcEntry(),
			simulationConductedTimestamp: new Date(),
			signedMessages: transactionStack.signedMessages,
			baseFeePerGas: 0n,
		}
	}
	const parentBlock = await ethereumClientService.getBlock(requestAbortController)
	if (parentBlock === null) throw new Error('The latest block is null')
	const parentBaseFeePerGas = parentBlock.baseFeePerGas
	if (parentBaseFeePerGas === undefined) throw new Error(CANNOT_SIMULATE_OFF_LEGACY_BLOCK)
	const makeMeRich = getMakeMeRichStateOverride(addressToMakeRich)
	const multicallResult = (await ethereumClientService.simulateTransactionsAndSignatures([transactionStack.transactions.map((x) => x.signedTransaction)], transactionStack.signedMessages, parentBlock.number, requestAbortController, makeMeRich))[0]
	if (multicallResult === undefined || multicallResult.calls.length !== transactionStack.transactions.length) throw new Error('Multicall length does not match in setSimulationTransactions')

	const tokenBalancesAfter: Promise<TokenBalancesAfter>[] = []
	for (let resultIndex = 0; resultIndex < multicallResult.calls.length; resultIndex++) {
		const singleResult = multicallResult.calls[resultIndex]
		if (singleResult === undefined) throw new Error('Multicall length does not match in setSimulationTransactions')
		const sender = transactionStack.transactions[resultIndex]?.signedTransaction.from
		if (sender === undefined) throw new Error('sender was undefined')
		tokenBalancesAfter.push(getSimulatedTokenBalances(
			ethereumClientService,
			requestAbortController,
			transactionStack.transactions.map((transaction) => transaction.signedTransaction).slice(0, resultIndex + 1),
			transactionStack.signedMessages,
			[
				{ token: ETHEREUM_LOGS_LOGGER_ADDRESS, owner: sender, tokenId: undefined, type: 'ERC20' as const }, // add original sender for eth always, as there's always gas payment
				...getAddressesInteractedWithErc20s(singleResult.status === 'success' ? singleResult.logs : [])
			],
			parentBlock.number,
			makeMeRich
		))
	}
	return {
		addressToMakeRich,
		simulatedTransactions: await Promise.all(multicallResult.calls.map(async(singleResult, index) => {
			const newTransaction = transactionStack.transactions[index]
			if (newTransaction === undefined) throw new Error('undefined transaction to simulate')
			const after = await tokenBalancesAfter[index]
			if (after === undefined) throw new Error('undefined transaction to simulate')
			return {
				preSimulationTransaction: {
					unsignedTransaction: newTransaction,
					signedTransaction: newTransaction.signedTransaction,
					website: newTransaction.website,
					created: newTransaction.created,
					originalRequestParameters: newTransaction.originalRequestParameters,
					transactionIdentifier: newTransaction.transactionIdentifier,
				},
				ethSimulateV1CallResult: singleResult,
				tokenBalancesAfter: after,
				realizedGasPrice: calculateRealizedEffectiveGasPrice(newTransaction.signedTransaction, multicallResult.baseFeePerGas)
			}
		})),
		blockNumber: parentBlock.number,
		blockTimestamp: parentBlock.timestamp,
		baseFeePerGas: multicallResult.baseFeePerGas,
		rpcNetwork: ethereumClientService.getRpcEntry(),
		simulationConductedTimestamp: new Date(),
		signedMessages: transactionStack.signedMessages,
	}
}

const getTransactionQueue = (simulationState: SimulationState | undefined) => {
	if (simulationState === undefined) return []
	return simulationState.simulatedTransactions.map((x) => x.preSimulationTransaction.signedTransaction)
}

export const getNonceFixedSimulatedTransactions = async(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulatedTransactions: readonly SimulatedTransaction[]) => {
	const isFixableNonceError = (transaction: SimulatedTransaction) => {
		return transaction.ethSimulateV1CallResult.status === 'failure'
		&& transaction.ethSimulateV1CallResult.error.message === 'wrong transaction nonce' //TODO, change to error code
		&& transaction.preSimulationTransaction.originalRequestParameters.method === 'eth_sendTransaction'
	}
	if (simulatedTransactions.find((transaction) => isFixableNonceError(transaction)) === undefined) return 'NoNonceErrors' as const
	const nonceFixedTransactions: SimulatedTransaction[] = []
	const knownPreviousNonce = new Map<string, bigint>()
	for (const transaction of simulatedTransactions) {
		const preSimulationTransaction = transaction.preSimulationTransaction
		const fromString = addressString(preSimulationTransaction.signedTransaction.from)
		if (isFixableNonceError(transaction)) {
			const getNewNonce = async () => {
				const prevNonce = knownPreviousNonce.get(fromString)
				if (prevNonce === undefined) return await ethereumClientService.getTransactionCount(preSimulationTransaction.signedTransaction.from, 'latest', requestAbortController)
				return prevNonce + 1n
			}
			const presigned = modifyObject(preSimulationTransaction, { signedTransaction: modifyObject(transaction.preSimulationTransaction.signedTransaction, { nonce: await getNewNonce() }) })
			nonceFixedTransactions.push(modifyObject(transaction, { preSimulationTransaction: presigned }))
		} else {
			nonceFixedTransactions.push(transaction)
		}
		const lastTransaction = nonceFixedTransactions[nonceFixedTransactions.length - 1]
		if (lastTransaction === undefined) throw new Error('last transction did not exist')
		knownPreviousNonce.set(fromString, lastTransaction.preSimulationTransaction.signedTransaction.nonce)
	}
	return nonceFixedTransactions
}


export const getBaseFeeAdjustedTransactions = (parentBlock: EthereumBlockHeader, unsignedTxts: readonly PreSimulationTransaction[]): readonly PreSimulationTransaction[] => {
	if (parentBlock === null) return unsignedTxts
	const parentBaseFeePerGas = parentBlock.baseFeePerGas
	if (parentBaseFeePerGas === undefined) return unsignedTxts
	return unsignedTxts.map((transaction) => {
		if (transaction.originalRequestParameters.method !== 'eth_sendTransaction') return transaction
		if (transaction.signedTransaction.type !== '1559') return transaction
		return modifyObject(transaction, { signedTransaction: modifyObject(transaction.signedTransaction, { maxFeePerGas: parentBaseFeePerGas * 2n + transaction.signedTransaction.maxPriorityFeePerGas }) })
	})
}

export const fixNonceErrorsIfNeeded = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState): Promise<{ nonceFixed: true, transactions: readonly PreSimulationTransaction[] } | { nonceFixed: false }> => {
	const nonceFixedTransactions = await getNonceFixedSimulatedTransactions(ethereumClientService, requestAbortController, simulationState.simulatedTransactions)
	if (nonceFixedTransactions === 'NoNonceErrors') return { nonceFixed: false }
	return { nonceFixed: true, transactions: nonceFixedTransactions.map((x) => x.preSimulationTransaction) }
}

const canQueryNodeDirectly = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState, blockTag: EthereumBlockTag = 'latest') => {
	if (simulationState === undefined
		|| (simulationState.simulatedTransactions.length === 0 && simulationState.addressToMakeRich === undefined)
		|| (typeof blockTag === 'bigint' && blockTag <= await ethereumClientService.getBlockNumber(requestAbortController))
	){
		return true
	}
	return false
}

export const getSimulatedTransactionCount = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState | undefined, address: bigint, blockTag: EthereumBlockTag = 'latest') => {
	const currentBlock = await ethereumClientService.getBlockNumber(requestAbortController)
	const blockNumToUse = blockTag === 'latest' || blockTag === 'pending' ? currentBlock : min(blockTag, currentBlock)
	let addedTransactions = 0n
	if (simulationState !== undefined && (blockTag === 'latest' || blockTag === 'pending' || blockTag > currentBlock)) {
		// if we are on our simulated block, just count how many transactions we have sent in the simulation to increment transaction count
		for (const signed of simulationState.simulatedTransactions) {
			if (signed.preSimulationTransaction.signedTransaction.from === address) addedTransactions += 1n
		}
	}
	return (await ethereumClientService.getTransactionCount(address, blockNumToUse, requestAbortController)) + addedTransactions
}

export const getDeployedContractAddress = (from: EthereumAddress, nonce: EthereumQuantity): EthereumAddress => {
	return BigInt(`0x${ keccak256(rlpEncode([stripLeadingZeros(bigintToUint8Array(from, 20)), stripLeadingZeros(bigintToUint8Array(nonce, 32))])).slice(26) }`)
}

export const getSimulatedTransactionReceipt = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState | undefined, hash: bigint): Promise<EthTransactionReceiptResponse> => {
	let cumGas = 0n
	let currentLogIndex = 0
	if (simulationState === undefined) { return await ethereumClientService.getTransactionReceipt(hash, requestAbortController) }
	for (const [index, simulatedTransaction] of simulationState.simulatedTransactions.entries()) {
		cumGas += simulatedTransaction.ethSimulateV1CallResult.gasUsed
		if(hash === simulatedTransaction.preSimulationTransaction.signedTransaction.hash) {
			const blockNum = await ethereumClientService.getBlockNumber(requestAbortController)
			return {
				...simulatedTransaction.preSimulationTransaction.signedTransaction.type === '4844' ? {
					type: simulatedTransaction.preSimulationTransaction.signedTransaction.type,
					blobGasUsed: GAS_PER_BLOB * BigInt(simulatedTransaction.preSimulationTransaction.signedTransaction.blobVersionedHashes.length),
					blobGasPrice: simulatedTransaction.preSimulationTransaction.signedTransaction.maxFeePerBlobGas,
				} : {
					type: simulatedTransaction.preSimulationTransaction.signedTransaction.type,
				},
				blockHash: getHashOfSimulatedBlock(simulationState),
				blockNumber: blockNum,
				transactionHash: simulatedTransaction.preSimulationTransaction.signedTransaction.hash,
				transactionIndex: BigInt(index),
				contractAddress: simulatedTransaction.preSimulationTransaction.signedTransaction.to !== null ? null : getDeployedContractAddress(simulatedTransaction.preSimulationTransaction.signedTransaction.from, simulatedTransaction.preSimulationTransaction.signedTransaction.nonce),
				cumulativeGasUsed: cumGas,
				gasUsed: simulatedTransaction.ethSimulateV1CallResult.gasUsed,
				effectiveGasPrice: calculateRealizedEffectiveGasPrice(simulatedTransaction.preSimulationTransaction.signedTransaction, simulationState.baseFeePerGas),
				from: simulatedTransaction.preSimulationTransaction.signedTransaction.from,
				to: simulatedTransaction.preSimulationTransaction.signedTransaction.to,
				logs: simulatedTransaction.ethSimulateV1CallResult.status === 'success'
					? simulatedTransaction.ethSimulateV1CallResult.logs.map((x, logIndex) => ({
						removed: false,
						blockHash: getHashOfSimulatedBlock(simulationState),
						address: x.address,
						logIndex: BigInt(currentLogIndex + logIndex),
						data: x.data,
						topics: x.topics,
						blockNumber: blockNum,
						transactionIndex: BigInt(index),
						transactionHash: simulatedTransaction.preSimulationTransaction.signedTransaction.hash
					}))
					: [],
				logsBloom: 0x0n, //TODO: what should this be?
				status: simulatedTransaction.ethSimulateV1CallResult.status
			}
		}
		currentLogIndex += simulatedTransaction.ethSimulateV1CallResult.status === 'success' ? simulatedTransaction.ethSimulateV1CallResult.logs.length : 0
	}
	return await ethereumClientService.getTransactionReceipt(hash, requestAbortController)
}

export const getSimulatedBalance = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState | undefined, address: bigint, blockTag: EthereumBlockTag = 'latest'): Promise<bigint> => {
	if (simulationState === undefined || await canQueryNodeDirectly(ethereumClientService, requestAbortController, simulationState, blockTag)) return await ethereumClientService.getBalance(address, blockTag, requestAbortController)
	const ethBalances = new Map<bigint, bigint>()
	if (simulationState.addressToMakeRich !== undefined) ethBalances.set(simulationState.addressToMakeRich, MAKE_YOU_RICH_TRANSACTION.transaction.value)
	for (const transaction of simulationState.simulatedTransactions) {
		if (transaction.ethSimulateV1CallResult.status !== 'success') continue
		for (const b of transaction.tokenBalancesAfter) { // todo, account for gasses!
			if (b.balance === undefined || b.token !== ETHEREUM_LOGS_LOGGER_ADDRESS) continue
			ethBalances.set(b.owner, b.balance)
		}
	}
	const balance = ethBalances.get(address)
	if (balance !== undefined) return balance
	return await ethereumClientService.getBalance(address, blockTag, requestAbortController)
}

export const getSimulatedCode = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState | undefined, address: bigint, blockTag: EthereumBlockTag = 'latest') => {
	if (simulationState === undefined || await canQueryNodeDirectly(ethereumClientService, requestAbortController, simulationState, blockTag)) {
		return {
			statusCode: 'success',
			getCodeReturn: await ethereumClientService.getCode(address, blockTag, requestAbortController)
		} as const
	}
	const block = await ethereumClientService.getBlock(requestAbortController)
	if (block === null) throw new Error('The latest block is null')

	const atInterface = new ethers.Interface(['function at(address) returns (bytes)'])
	const input = stringToUint8Array(atInterface.encodeFunctionData('at', [addressString(address)]))

	const getCodeTransaction = {
		type: '1559',
		from: MOCK_ADDRESS,
		chainId: ethereumClientService.getChainId(),
		nonce: await ethereumClientService.getTransactionCount(MOCK_ADDRESS, 'latest', requestAbortController),
		maxFeePerGas: 0n,
		maxPriorityFeePerGas: 0n,
		gas: block.gasLimit,
		to: GET_CODE_CONTRACT,
		value: 0n,
		input: input,
		accessList: []
	} as const
	const multiCall = await simulatedMulticall(ethereumClientService, requestAbortController, simulationState, [getCodeTransaction], block.number, { [addressString(GET_CODE_CONTRACT)]: { code: getCodeByteCode() } }, true)
	const lastBlock = multiCall[multiCall.length - 1]
	if (lastBlock === undefined) throw new Error('last block did not exist in multicall')
	const lastResult = lastBlock.calls[lastBlock.calls.length - 1]
	if (lastResult === undefined) throw new Error('last result did not exist in multicall')
	if (lastResult.status === 'failure') return { statusCode: 'failure' } as const
	const parsed = atInterface.decodeFunctionResult('at', lastResult.returnData)
	return {
		statusCode: lastResult.status,
		getCodeReturn: EthereumData.parse(parsed.toString())
	} as const
}

// ported from: https://github.com/ethereum/go-ethereum/blob/509a64ffb9405942396276ae111d06f9bded9221/consensus/misc/eip1559/eip1559.go#L55
const getNextBaseFeePerGas = (parentGasUsed: bigint, parentGasLimit: bigint, parentBaseFeePerGas: bigint) => {
	const parentGasTarget = parentGasLimit / ETHEREUM_EIP1559_ELASTICITY_MULTIPLIER
	if (parentGasUsed === parentGasTarget) return parentBaseFeePerGas
	if (parentGasUsed > parentGasTarget) return parentBaseFeePerGas + max(1n, parentBaseFeePerGas * (parentGasUsed - parentGasTarget) / parentGasTarget / ETHEREUM_EIP1559_BASEFEECHANGEDENOMINATOR)
	return max(0n, parentBaseFeePerGas - parentBaseFeePerGas * (parentGasTarget - parentGasUsed) / parentGasTarget / ETHEREUM_EIP1559_BASEFEECHANGEDENOMINATOR)
}

async function getSimulatedMockBlock(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState) {
	// make a mock block based on the previous block
	const parentBlock = await ethereumClientService.getBlock(requestAbortController)
	if (parentBlock === null) throw new Error('The latest block is null')
	if (parentBlock.baseFeePerGas === undefined) throw new Error(CANNOT_SIMULATE_OFF_LEGACY_BLOCK)
	return {
		author: parentBlock.miner,
		difficulty: parentBlock.difficulty,
		extraData: parentBlock.extraData,
		gasLimit: parentBlock.gasLimit,
		gasUsed: transactionQueueTotalGasLimit(simulationState),
		hash: getHashOfSimulatedBlock(simulationState),
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
		totalDifficulty: (parentBlock.totalDifficulty ?? 0n) + parentBlock.difficulty, // The difficulty increases about the same amount as previously
		uncles: [],
		baseFeePerGas: getNextBaseFeePerGas(parentBlock.gasUsed, parentBlock.gasLimit, parentBlock.baseFeePerGas),
		transactionsRoot: parentBlock.transactionsRoot, // TODO: this is wrong
		transactions: simulationState.simulatedTransactions.map((simulatedTransaction) => simulatedTransaction.preSimulationTransaction.signedTransaction),
		withdrawals: [],
		withdrawalsRoot: 0n, // TODO: this is wrong
	} as const
}

export async function getSimulatedBlockByHash(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState | undefined, blockHash: EthereumBytes32, fullObjects: boolean): Promise<EthereumBlockHeader | EthereumBlockHeaderWithTransactionHashes> {
	if (simulationState !== undefined && getHashOfSimulatedBlock(simulationState) === blockHash) {
		const block = await getSimulatedMockBlock(ethereumClientService, requestAbortController, simulationState)
		if (fullObjects) return block
		return { ...block, transactions: block.transactions.map((transaction) => transaction.hash) }
	}
	return await ethereumClientService.getBlockByHash(blockHash, requestAbortController, fullObjects)
}

export async function getSimulatedBlock(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState | undefined, blockTag?: EthereumBlockTag, fullObjects?: true): Promise<EthereumBlockHeader>
export async function getSimulatedBlock(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState | undefined, blockTag: EthereumBlockTag, fullObjects: boolean): Promise<EthereumBlockHeader | EthereumBlockHeaderWithTransactionHashes>
export async function getSimulatedBlock(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState | undefined, blockTag: EthereumBlockTag, fullObjects: false): Promise<EthereumBlockHeaderWithTransactionHashes>
export async function getSimulatedBlock(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState | undefined, blockTag: EthereumBlockTag = 'latest', fullObjects = true): Promise<EthereumBlockHeader | EthereumBlockHeaderWithTransactionHashes>  {
	if (simulationState === undefined || await canQueryNodeDirectly(ethereumClientService, requestAbortController, simulationState, blockTag)) {
		return await ethereumClientService.getBlock(requestAbortController, blockTag, fullObjects)
	}
	const block = await getSimulatedMockBlock(ethereumClientService, requestAbortController, simulationState)
	if (fullObjects) return block
	return { ...block, transactions: block.transactions.map((transaction) => transaction.hash) }
}

const getLogsOfSimulatedBlock = (simulationState: SimulationState, logFilter: EthGetLogsRequest): EthGetLogsResponse => {
	const events: EthGetLogsResponse = simulationState?.simulatedTransactions.reduce((acc, sim, transactionIndex) => {
		if (sim.ethSimulateV1CallResult.status === 'failure') return acc
		return [
			...acc,
			...sim.ethSimulateV1CallResult.logs.map((event, logIndex) => ({
				removed: false,
				logIndex: BigInt(acc.length + logIndex),
				transactionIndex: BigInt(transactionIndex),
				transactionHash: sim.preSimulationTransaction.signedTransaction.hash,
				blockHash: getHashOfSimulatedBlock(simulationState),
				blockNumber: simulationState.blockNumber,
				address: event.address,
				data: event.data,
				topics: event.topics
			}))
		]
	}, [] as EthGetLogsResponse) || []

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

	return events.filter((x) =>
		(logFilter.address === undefined
			|| x.address === logFilter.address
			|| (Array.isArray(logFilter.address) && logFilter.address.includes(x.address))
		)
		&& includeLogByTopic(x.topics, logFilter.topics)
	)
}

export const getSimulatedLogs = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState | undefined, logFilter: EthGetLogsRequest): Promise<EthGetLogsResponse> => {
	if (simulationState === undefined) return await ethereumClientService.getLogs(logFilter, requestAbortController)
	const toBlock = 'toBlock' in logFilter && logFilter.toBlock !== undefined ? logFilter.toBlock : 'latest'
	const fromBlock = 'fromBlock' in logFilter && logFilter.fromBlock !== undefined ? logFilter.fromBlock : 'latest'
	if (toBlock === 'pending' || fromBlock === 'pending') return await ethereumClientService.getLogs(logFilter, requestAbortController)
	if ((fromBlock === 'latest' && toBlock !== 'latest') || (fromBlock !== 'latest' && toBlock !== 'latest' && fromBlock > toBlock )) throw new Error(`From block '${ fromBlock }' is later than to block '${ toBlock }' `)
	if ('blockHash' in logFilter && logFilter.blockHash === getHashOfSimulatedBlock(simulationState)) return getLogsOfSimulatedBlock(simulationState, logFilter)
	if (simulationState && (toBlock === 'latest' || toBlock >= simulationState.blockNumber)) {
		const logParamsToNode = fromBlock !== 'latest' && fromBlock >= simulationState.blockNumber ? { ...logFilter, fromBlock: simulationState.blockNumber - 1n, toBlock: simulationState.blockNumber - 1n } : { ...logFilter, toBlock: simulationState.blockNumber - 1n }
		return [...await ethereumClientService.getLogs(logParamsToNode, requestAbortController), ...getLogsOfSimulatedBlock(simulationState, logFilter)]
	}
	return await ethereumClientService.getLogs(logFilter, requestAbortController)
}

export const getSimulatedBlockNumber = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState | undefined) => {
	if (simulationState !== undefined) return (await ethereumClientService.getBlockNumber(requestAbortController)) + 1n
	return await ethereumClientService.getBlockNumber(requestAbortController)
}

export const getSimulatedTransactionByHash = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState | undefined, hash: bigint): Promise<EthereumSignedTransactionWithBlockData | null> => {
	// try to see if the transaction is in our queue
	if (simulationState === undefined) return await ethereumClientService.getTransactionByHash(hash, requestAbortController)
	for (const [index, simulatedTransaction] of simulationState.simulatedTransactions.entries()) {
		if (hash === simulatedTransaction.preSimulationTransaction.signedTransaction.hash) {
			const v = 'v' in simulatedTransaction.preSimulationTransaction.signedTransaction ? simulatedTransaction.preSimulationTransaction.signedTransaction.v : (simulatedTransaction.preSimulationTransaction.signedTransaction.yParity === 'even' ? 0n : 1n)
			const additionalParams = {
				blockHash: getHashOfSimulatedBlock(simulationState),
				blockNumber: await ethereumClientService.getBlockNumber(requestAbortController),
				transactionIndex: BigInt(index),
				data: simulatedTransaction.preSimulationTransaction.signedTransaction.input,
				v : v,
			}
			if ('gasPrice' in simulatedTransaction.preSimulationTransaction.signedTransaction) {
				return {
					...simulatedTransaction.preSimulationTransaction.signedTransaction,
					...additionalParams,
				}
			}
			return {
				...simulatedTransaction.preSimulationTransaction.signedTransaction,
				...additionalParams,
				gasPrice: simulatedTransaction.realizedGasPrice,
			}
		}
	}

	// it was not in the queue, so we can just try to ask the chain for it
	return await ethereumClientService.getTransactionByHash(hash, requestAbortController)
}

export const simulatedCall = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState | undefined, params: Pick<IUnsignedTransaction1559, 'to' | 'maxFeePerGas' | 'maxPriorityFeePerGas' | 'input' | 'value'> & Partial<Pick<IUnsignedTransaction1559, 'from' | 'gasLimit'>>, blockTag: EthereumBlockTag = 'latest') => {
	const currentBlock = await ethereumClientService.getBlock(requestAbortController)
	if (currentBlock === null) throw new Error('cannot perform call on top of missing block')
	const blockNumToUse = blockTag === 'latest' || blockTag === 'pending' ? currentBlock.number : min(blockTag, currentBlock.number)
	const simulationStateToUse = blockNumToUse >= currentBlock.number ? simulationState : undefined
	const from = params.from ?? DEFAULT_CALL_ADDRESS
	const transaction = {
		...params,
		type: '1559',
		gas: params.gasLimit,
		from,
		nonce: await getSimulatedTransactionCount(ethereumClientService, requestAbortController, simulationStateToUse, from, blockTag),
		chainId: ethereumClientService.getChainId(),
	} as const

	//todo, we can optimize this by leaving nonce out
	try {
		const multicallResult = await simulatedMulticall(ethereumClientService, requestAbortController, simulationStateToUse, [{ ...transaction, gas: params.gasLimit === undefined ? currentBlock.gasLimit : params.gasLimit }], blockNumToUse, {}, true)
		const lastBlockResult = multicallResult[multicallResult.length - 1]
		if (lastBlockResult === undefined) throw new Error('failed to get last block in eth simulate')
		const callResult = lastBlockResult.calls[lastBlockResult.calls.length - 1]
		if (callResult === undefined) throw new Error('failed to get last call in eth simulate')
		if (callResult?.status === 'failure') return { error: callResult.error }
		return { result: callResult.returnData }
	} catch(error: unknown) {
		if (error instanceof JsonRpcResponseError) {
			const safeParsedData = EthereumData.safeParse(error.data)
			return { error: { code: error.code, message: error.message, data: safeParsedData.success ? dataStringWith0xStart(safeParsedData.value) : '0x' } }
		}
		throw error
	}
}

const getSignedMessagesWithFakeSigner = (simulationState: SimulationState | undefined) => {
	return simulationState === undefined ? [] : simulationState.signedMessages.map((x) => ({ fakeSignedFor: x.fakeSignedFor, originalRequestParameters: x.originalRequestParameters }))
}

const simulatedMulticall = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState | undefined, transactions: EthereumUnsignedTransaction[], blockNumber: bigint, extraAccountOverrides: StateOverrides = {}, simulateOnBlockAboveExistingSimulationStack = false) => {
	const mergedTxs: EthereumUnsignedTransaction[] = getTransactionQueue(simulationState)
	const makeMeRich = getMakeMeRichStateOverride(simulationState?.addressToMakeRich)
	const transactionsInBlocks = simulateOnBlockAboveExistingSimulationStack ? [mergedTxs, transactions] : [mergedTxs.concat(transactions)]
	return await ethereumClientService.simulateTransactionsAndSignatures(transactionsInBlocks, getSignedMessagesWithFakeSigner(simulationState), blockNumber, requestAbortController, { ...extraAccountOverrides, ...makeMeRich })
}

// use time as block hash as that makes it so that updated simulations with different states are different, but requires no additional calculation
const getHashOfSimulatedBlock = (simulationState: SimulationState) => BigInt(simulationState.simulationConductedTimestamp.getTime())

export type SignatureWithFakeSignerAddress = { originalRequestParameters: SignMessageParams, fakeSignedFor: EthereumAddress }
export type MessageHashAndSignature = { signature: string, messageHash: string }

export const isValidMessage = (params: SignMessageParams, signingAddress: EthereumAddress) => {
	try {
		simulatePersonalSign(params, signingAddress)
		return true
	} catch(e) {
		console.error(e)
		return false
	}
}

export const simulatePersonalSign = (params: SignMessageParams, signingAddress: EthereumAddress) => {
	const wallet = new ethers.Wallet(bytes32String(signingAddress === ADDRESS_FOR_PRIVATE_KEY_ONE ? MOCK_PUBLIC_PRIVATE_KEY : MOCK_SIMULATION_PRIVATE_KEY))
	switch (params.method) {
		case 'eth_signTypedData': throw new Error('No support for eth_signTypedData')
		case 'eth_signTypedData_v1':
		case 'eth_signTypedData_v2':
		case 'eth_signTypedData_v3':
		case 'eth_signTypedData_v4': {
			const typesWithoutDomain = Object.assign({}, params.params[1].types)
			delete typesWithoutDomain.EIP712Domain
			const castedTypesWithoutDomain = typesWithoutDomain as { [x: string]: { name: string, type: string }[] }
			const messageHash = ethers.TypedDataEncoder.hash(params.params[1].domain, castedTypesWithoutDomain, params.params[1].message)
			const signature = wallet.signMessageSync(messageHash)
			return { signature, messageHash }
		}
		case 'personal_sign': return {
			signature: wallet.signMessageSync(stringToUint8Array(params.params[0])),
			messageHash: hashMessage(params.params[0])
		}
		default: assertNever(params)
	}
}

type BalanceQuery = {
	type: 'ERC20',
	token: bigint,
	owner: bigint,
} | {
	type: 'ERC1155',
	token: bigint,
	owner: bigint,
	tokenId: bigint,
}

const getSimulatedTokenBalances = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, transactionQueue: EthereumUnsignedTransaction[], signedMessages: readonly SignatureWithFakeSignerAddress[], balanceQueries: BalanceQuery[], blockNumber: bigint, extraAccountOverrides: StateOverrides): Promise<TokenBalancesAfter> => {
	if (balanceQueries.length === 0) return []
	function removeDuplicates(queries: BalanceQuery[]): BalanceQuery[] {
		const unique: Map<string, BalanceQuery> = new Map()
		for (const query of queries) {
			const key = `${ query.type }-${ query.token }-${ query.owner }${ query.type === 'ERC1155' ? `${ query.tokenId }` : ''}`
			if (unique.has(key)) continue
			unique.set(key, query)
		}
		return Array.from(unique.values())
	}
	const deduplicatedBalanceQueries = removeDuplicates(balanceQueries)
	const IMulticall3 = new Interface(Multicall3ABI)
	const erc20TokenInterface = new ethers.Interface(['function balanceOf(address account) view returns (uint256)'])
	const erc1155TokenInterface = new ethers.Interface(['function balanceOf(address _owner, uint256 _id) external view returns(uint256)'])
	const tokenAndEthBalancesInputData = stringToUint8Array(IMulticall3.encodeFunctionData('aggregate3', [deduplicatedBalanceQueries.map((balanceQuery) => {
		if (balanceQuery.token === ETHEREUM_LOGS_LOGGER_ADDRESS && balanceQuery.type === 'ERC20') {
			return {
				target: addressString(MULTICALL3),
				allowFailure: true,
				callData: IMulticall3.encodeFunctionData('getEthBalance', [addressString(balanceQuery.owner)])
			}
		}
		if (balanceQuery.type === 'ERC20') {
			return {
				target: addressString(balanceQuery.token),
				allowFailure: true,
				callData: stringToUint8Array(erc20TokenInterface.encodeFunctionData('balanceOf', [addressString(balanceQuery.owner)])),
			}
		}
		return {
			target: addressString(balanceQuery.token),
			allowFailure: true,
			callData: stringToUint8Array(erc1155TokenInterface.encodeFunctionData('balanceOf', [addressString(balanceQuery.owner), EthereumQuantity.serialize(balanceQuery.tokenId)])),
		}
	})]))
	const callTransaction: EthereumUnsignedTransaction = {
		type: '1559' as const,
		from: MOCK_ADDRESS,
		to: MULTICALL3,
		value: 0n,
		input: tokenAndEthBalancesInputData,
		maxFeePerGas: 0n,
		maxPriorityFeePerGas: 0n,
		gas: (await ethereumClientService.getBlock(requestAbortController))?.gasLimit || 15_000_000n,
		nonce: 0n,
		chainId: ethereumClientService.getChainId(),
	} as const
	const multicallResults = await ethereumClientService.simulateTransactionsAndSignatures([transactionQueue, [callTransaction]], signedMessages, blockNumber, requestAbortController, extraAccountOverrides)
	const lastBlockResults = multicallResults[multicallResults.length - 1]
	if (lastBlockResults === undefined) throw Error('Failed to get last block in eth simulate in aggregate3')
	const aggregate3CallResult = lastBlockResults.calls[lastBlockResults.calls.length - 1]
	if (aggregate3CallResult === undefined || aggregate3CallResult.status === 'failure') throw Error('Failed aggregate3')
	const multicallReturnData: { success: boolean, returnData: string }[] = IMulticall3.decodeFunctionResult('aggregate3', dataStringWith0xStart(aggregate3CallResult.returnData))[0]
	if (multicallReturnData.length !== deduplicatedBalanceQueries.length) throw Error('Got wrong number of balances back')
	return multicallReturnData.map((singleCallResult, callIndex) => {
		const balanceQuery = deduplicatedBalanceQueries[callIndex]
		if (balanceQuery === undefined) throw new Error('aggregate3 failed to get eth balance')
		return {
			token: balanceQuery.token,
			tokenId: 'tokenId' in balanceQuery ? balanceQuery.tokenId : undefined,
			owner: balanceQuery.owner,
			balance: singleCallResult.success ? EthereumQuantity.parse(singleCallResult.returnData) : undefined
		}
	})
}

export const parseEventIfPossible = (ethersInterface: ethers.Interface, log: EthereumEvent) => {
	try {
		return ethersInterface.parseLog({ topics: log.topics.map((x) => bytes32String(x)), data: dataStringWith0xStart(log.data) })
	} catch (error) {
		return null
	}
}

export const parseTransactionInputIfPossible = (ethersInterface: ethers.Interface, data: EthereumData, value: EthereumQuantity) => {
	try {
		return ethersInterface.parseTransaction({ data: dataStringWith0xStart(data), value })
	} catch (error) {
		return null
	}
}

const getAddressesInteractedWithErc20s = (events: readonly EthereumEvent[]): { token: bigint, owner: bigint, tokenId: undefined, type: 'ERC20' }[] => {
	const erc20ABI = [
		'event Withdrawal(address indexed src, uint wad)', // weth withdraw function
		'event Deposit(address indexed dst, uint wad)', // weth deposit function
		'event Transfer(address indexed from, address indexed to, uint256 value)',
		'event Approval(address indexed owner, address indexed spender, uint256 value)',
	]
	const erc20 = new ethers.Interface(erc20ABI)
	const tokenOwners: { token: bigint, owner: bigint, tokenId: undefined, type: 'ERC20' }[] = []
	for (const log of events) {
		const parsed = parseEventIfPossible(erc20, log)
		if (parsed === null) continue
		const base = { token: log.address, tokenId: undefined, type: 'ERC20' as const }
		switch (parsed.name) {
			case 'Withdrawal':
			case 'Deposit': {
				tokenOwners.push({ ...base, owner: EthereumAddress.parse(parsed.args[0]) })
				break
			}
			case 'Approval':
			case 'Transfer': {
				tokenOwners.push({ ...base, owner: EthereumAddress.parse(parsed.args[0]) })
				tokenOwners.push({ ...base, owner: EthereumAddress.parse(parsed.args[1]) })
				break
			}
			default: throw new Error(`wrong name: ${ parsed.name }`)
		}
	}
	return tokenOwners
}

const getAddressesAndTokensIdsInteractedWithErc1155s = (events: readonly EthereumEvent[]): { token: bigint, owner: bigint, tokenId: bigint, type: 'ERC1155' }[] => {
	const erc1155ABI = [
		'event TransferSingle(address operator, address from, address to, uint256 id, uint256 value)',
		'event TransferBatch(address indexed _operator, address indexed _from, address indexed _to, uint256[] _ids, uint256[] _values)',
	]
	const erc20 = new ethers.Interface(erc1155ABI)
	const tokenOwners: { token: bigint, owner: bigint, tokenId: bigint, type: 'ERC1155' }[] = []
	for (const log of events) {
		const parsed = parseEventIfPossible(erc20, log)
		if (parsed === null) continue
		const base = { token: log.address, type: 'ERC1155' as const }
		switch (parsed.name) {
			case 'TransferSingle': {
				const parsedLog = handleERC1155TransferSingle(log)[0]
				if (parsedLog === undefined) break
				if (parsedLog.type !== 'ERC1155') continue
				tokenOwners.push({ ...base, owner: parsedLog.from, tokenId: parsedLog.tokenId })
				tokenOwners.push({ ...base, owner: parsedLog.to, tokenId: parsedLog.tokenId })
				break
			}
			case 'TransferBatch': {
				for (const parsedLog of handleERC1155TransferBatch(log)) {
					if (parsedLog.type !== "ERC1155") continue
					tokenOwners.push({ ...base, owner: parsedLog.from, tokenId: parsedLog.tokenId })
					tokenOwners.push({ ...base, owner: parsedLog.to, tokenId: parsedLog.tokenId })
				}
				break
			}
			default: throw new Error(`wrong name: ${ parsed.name }`)
		}
	}
	return tokenOwners
}

export const getTokenBalancesAfter = async (
	ethereumClientService: EthereumClientService,
	requestAbortController: AbortController | undefined,
	ethSimulateV1CallResults: EthSimulateV1CallResults,
	blockNumber: bigint,
	signedTxs: EthereumSendableSignedTransaction[] = [],
	signedMessages: readonly SignatureWithFakeSignerAddress[] = [],
	extraAccountOverrides: StateOverrides = {},
) => {
	const tokenBalancesAfter: Promise<TokenBalancesAfter>[] = []
	for (let resultIndex = 0; resultIndex < ethSimulateV1CallResults.length; resultIndex++) {
		const singleResult = ethSimulateV1CallResults[resultIndex]
		if (singleResult === undefined) throw new Error('singleResult was undefined')
		const events = singleResult.status === 'success' ? singleResult.logs : []
		const sender = signedTxs[resultIndex]?.from
		if (sender === undefined) throw new Error('sender was undefined')
		const erc20sAddresses = [
			{ token: ETHEREUM_LOGS_LOGGER_ADDRESS, owner: sender, tokenId: undefined, type: 'ERC20' as const }, // add original sender for eth always, as there's always gas payment
			...getAddressesInteractedWithErc20s(events)
		]
		const erc1155AddressIds = getAddressesAndTokensIdsInteractedWithErc1155s(events)
		const balancesPromises = getSimulatedTokenBalances(ethereumClientService, requestAbortController, signedTxs.slice(0, resultIndex + 1), signedMessages, [...erc20sAddresses, ...erc1155AddressIds], blockNumber, extraAccountOverrides)
		tokenBalancesAfter.push(balancesPromises)
	}
	return await Promise.all(tokenBalancesAfter)
}

// takes the most recent block that the application is querying and does the calculation based on that
export const getSimulatedFeeHistory = async (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, request: FeeHistory): Promise<EthGetFeeHistoryResponse> => {
	//const numberOfBlocks = Number(request.params[0]) // number of blocks, not used atm as we just return one block
	const blockTag = request.params[1]
	const rewardPercentiles = request.params[2]
	const currentRealBlockNumber = await ethereumClientService.getBlockNumber(requestAbortController)
	const clampedBlockTag = typeof blockTag === 'bigint' && blockTag > currentRealBlockNumber ? currentRealBlockNumber : blockTag
	const newestBlock = await ethereumClientService.getBlock(requestAbortController, clampedBlockTag, true)
	if (newestBlock === null) throw new Error('The latest block is null')
	const newestBlockBaseFeePerGas = newestBlock.baseFeePerGas
	if (newestBlockBaseFeePerGas === undefined) throw new Error(`base fee per gas is missing for the block (it's too old)`)
	return {
		baseFeePerGas: [newestBlockBaseFeePerGas, getNextBaseFeePerGas(newestBlock.gasUsed, newestBlock.gasLimit, newestBlockBaseFeePerGas)],
		gasUsedRatio: [Number(newestBlock.gasUsed) / Number(newestBlock.gasLimit)],
		oldestBlock: newestBlock.number,
		...rewardPercentiles === undefined ? {} : {
			reward: [rewardPercentiles.map((percentile) => {
				// we are using transaction.gas as a weighting factor while this should be `gasUsed`. Getting `gasUsed` requires getting transaction receipts, which we don't want to be doing
				const effectivePriorityAndGasWeights = newestBlock.transactions.map((tx) => tx.type === '1559' || tx.type === '4844' ?
					{ dataPoint: min(tx.maxPriorityFeePerGas, tx.maxFeePerGas - (newestBlockBaseFeePerGas ?? 0n)), weight: tx.gas }
					: { dataPoint: tx.gasPrice - (newestBlockBaseFeePerGas ?? 0n), weight: tx.gas })

				// we can have negative values here, as The Interceptor creates maxFeePerGas = 0 transactions that are intended to have zero base fee, which is not possible in reality
				const zeroOutNegativeValues = effectivePriorityAndGasWeights.map((point) => modifyObject(point, { dataPoint: max(0n, point.dataPoint) }))
				return calculateWeightedPercentile(zeroOutNegativeValues, BigInt(percentile))
			})]
		}
	}
}
