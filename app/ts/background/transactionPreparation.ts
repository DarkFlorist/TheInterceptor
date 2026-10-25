import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { getInputFieldFromDataOrInput, getSimulatedBalance, getSimulatedErc20Balance, getSimulatedTransactionCount, simulateEstimateGas, simulateEstimateGasAppendedToSimulation } from '../simulation/services/SimulationModeEthereumClientService.js'
import type { SendRawTransactionParams, SendTransactionParams } from '../types/JsonRpc-types.js'
import { PASSTHROUGH_STATE, type ResolvedSimulationState, type WebsiteCreatedEthereumTransaction, type WebsiteCreatedEthereumTransactionOrFailed } from '../types/visualizer-types.js'
import type { EthereumQuantity } from '../types/wire-types.js'
import type { Website } from '../types/websiteAccessTypes.js'
import { CANNOT_SIMULATE_OFF_LEGACY_BLOCK } from '../utils/constants.js'
import { createEip1559Or7702Transaction } from '../utils/eip7702Authorization.js'
import { JsonRpcResponseError, isNewBlockAbort, reportLocalRecovery } from '../utils/errors.js'
import { resolveInsufficientBalanceMessage } from '../utils/insufficientBalance.js'
import { silenceChromeUnCaughtPromise } from '../utils/requests.js'
import { parseSendRawTransaction } from '../utils/sendRawTransactionParsing.js'
import { getDesiredMaxFeePerGasForBaseFee, getTransactionFeesForBaseFee, hasExplicitMaxFeePerGas } from '../utils/transactionFees.js'
import { identifyAddress } from './metadataUtils.js'
import { captureSimulationSnapshot, getUpdatedSimulationState } from './simulationUpdating.js'

// Prepares the transactions that confirmations simulate and add to the simulation stack: their nonce, fees and gas limit. Both the confirmation window and wallet_sendCalls batches use it.

const resolveInsufficientBalanceMessageForTransaction = async (
	ethereumClientService: EthereumClientService,
	requestAbortController: AbortController | undefined,
	simulationState: Awaited<ReturnType<typeof getUpdatedSimulationState>>,
	transaction: {
		from: bigint
		to: bigint | null
		value: bigint
		input: Uint8Array
	},
	nativeBalancePromise: Promise<bigint>,
) => {
	try {
		const nativeBalance = await nativeBalancePromise
		return await resolveInsufficientBalanceMessage(
			transaction,
			{ balance: nativeBalance, symbol: ethereumClientService.getRpcEntry().currencyTicker, decimals: 18n },
			async (token, owner) => {
				const tokenEntry = await identifyAddress(ethereumClientService, requestAbortController, token)
				if (tokenEntry.type !== 'ERC20') return undefined
				const tokenBalance = await getSimulatedErc20Balance(ethereumClientService, requestAbortController, simulationState, token, owner)
				if (tokenBalance === undefined) return undefined
				return { token, balance: tokenBalance, symbol: tokenEntry.symbol, decimals: tokenEntry.decimals }
			},
		)
	} catch(error: unknown) {
		if (isNewBlockAbort(error)) throw error
		await reportLocalRecovery(error, {
			code: 'insufficient_balance_diagnosis_failed',
			message: 'Keeping the original gas-estimation error because optional balance diagnosis failed.',
		})
		return undefined
	}
}

export const formSendRawTransaction = async(_ethereumClientService: EthereumClientService, sendRawTransactionParams: SendRawTransactionParams, website: Website, created: Date, transactionIdentifier: EthereumQuantity): Promise<WebsiteCreatedEthereumTransaction> => {
	const parsedTransaction = await parseSendRawTransaction(sendRawTransactionParams.params[0])
	return {
		transaction: parsedTransaction.transaction,
		signedTransaction: parsedTransaction.signedTransaction,
		website,
		created,
		originalRequestParameters: sendRawTransactionParams,
		transactionIdentifier,
		success: true,
	}
}

export type TransactionGasPayment = 'transaction-sender' | 'external-executor'

export const formEthSendTransaction = async(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, activeAddress: bigint | undefined, website: Website, sendTransactionParams: SendTransactionParams, created: Date, transactionIdentifier: EthereumQuantity, simulationMode = true, gasPayment: TransactionGasPayment = 'transaction-sender'): Promise<WebsiteCreatedEthereumTransactionOrFailed> => {
	const simulationState = simulationMode || gasPayment === 'external-executor'
		? await getUpdatedSimulationState(ethereumClientService, await captureSimulationSnapshot())
		: PASSTHROUGH_STATE
	return await formEthSendTransactionOnSimulationState(ethereumClientService, requestAbortController, simulationState, activeAddress, website, sendTransactionParams, created, transactionIdentifier, simulationMode, gasPayment)
}

// Where the transaction's gas is estimated: in a new block after the simulation, or appended to the simulation, in the RPC block that preparation puts it in, which is where wallet_sendCalls approval adds a call.
export type GasEstimationPlacement = 'newBlock' | 'appendedToSimulation'

// Prepares the transaction's nonce, fees and gas limit against the given simulation state instead of the current simulation stack.
export const formEthSendTransactionOnSimulationState = async(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: ResolvedSimulationState, activeAddress: bigint | undefined, website: Website, sendTransactionParams: SendTransactionParams, created: Date, transactionIdentifier: EthereumQuantity, simulationMode: boolean, gasPayment: TransactionGasPayment, gasEstimationPlacement: GasEstimationPlacement = 'newBlock'): Promise<WebsiteCreatedEthereumTransactionOrFailed> => {
	const transactionDetails = sendTransactionParams.params[0]
	if (activeAddress === undefined) throw new Error('Access to active address is denied')
	const from = simulationMode && transactionDetails.from !== undefined ? transactionDetails.from : activeAddress
	const transactionCountPromise = silenceChromeUnCaughtPromise(getSimulatedTransactionCount(ethereumClientService, requestAbortController, simulationState, from))
	const parentBlockPromise = gasPayment === 'transaction-sender'
		? silenceChromeUnCaughtPromise(ethereumClientService.getBlock(requestAbortController)) // the latest real block is the parent of the transaction being prepared
		: undefined
	const balancePromise = gasPayment === 'transaction-sender'
		? silenceChromeUnCaughtPromise(getSimulatedBalance(ethereumClientService, requestAbortController, simulationState, from))
		: undefined
	const parentBlock = parentBlockPromise === undefined ? undefined : await parentBlockPromise
	if (parentBlock === null) throw new Error('The latest block is null')
	if (parentBlock !== undefined && parentBlock.baseFeePerGas === undefined) throw new Error(CANNOT_SIMULATE_OFF_LEGACY_BLOCK)
	const parentBaseFeePerGas = parentBlock?.baseFeePerGas
	const requestedMaxPriorityFeePerGas = transactionDetails.maxPriorityFeePerGas !== undefined && transactionDetails.maxPriorityFeePerGas !== null ? transactionDetails.maxPriorityFeePerGas : 10n**8n // 0.1 nanoeth/gas
	const maxPriorityFeePerGas = gasPayment === 'external-executor' ? 0n : requestedMaxPriorityFeePerGas
	const value = transactionDetails.value !== undefined  ? transactionDetails.value : 0n
	const getFeePerGas = async (gasLimit: bigint) => {
		if (gasPayment === 'external-executor') return { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }
		if (parentBaseFeePerGas === undefined || balancePromise === undefined) throw new Error('Transaction fee context is unavailable')
		return getTransactionFeesForBaseFee(parentBaseFeePerGas, maxPriorityFeePerGas, transactionDetails.maxFeePerGas, await balancePromise, value, gasLimit)
	}
	const getInitialMaxFeePerGas = () => {
		if (gasPayment === 'external-executor') return 0n
		if (hasExplicitMaxFeePerGas(transactionDetails.maxFeePerGas)) return transactionDetails.maxFeePerGas
		if (parentBaseFeePerGas === undefined) throw new Error('Transaction fee context is unavailable')
		return getDesiredMaxFeePerGasForBaseFee(parentBaseFeePerGas, maxPriorityFeePerGas)
	}
	const transactionWithoutGasBase = {
		from,
		chainId: ethereumClientService.getChainId(),
		nonce: await transactionCountPromise,
		maxFeePerGas: getInitialMaxFeePerGas(),
		maxPriorityFeePerGas,
		to: transactionDetails.to === undefined ? null : transactionDetails.to,
		value,
		input: getInputFieldFromDataOrInput(transactionDetails),
		accessList: transactionDetails.accessList ?? [],
	}
	const transactionWithoutGas = await createEip1559Or7702Transaction(transactionWithoutGasBase, transactionDetails)
	const extraParams = {
		website,
		created,
		originalRequestParameters: sendTransactionParams,
		transactionIdentifier,
		error: undefined,
	}
	if (transactionDetails.gas === undefined) {
		try {
			if (gasPayment === 'external-executor' && simulationState.kind === 'passthrough') {
				throw new Error('Gnosis Safe transaction gas estimation requires the Interceptor simulator.')
			}
			const estimateGas = gasEstimationPlacement === 'newBlock'
				? await simulateEstimateGas(ethereumClientService, requestAbortController, simulationState, transactionWithoutGas)
				: await simulateEstimateGasAppendedToSimulation(ethereumClientService, requestAbortController, simulationState, transactionWithoutGas)
			if ('error' in estimateGas) {
				const insufficientBalanceMessage = balancePromise === undefined
					? undefined
					: await resolveInsufficientBalanceMessageForTransaction(ethereumClientService, requestAbortController, simulationState, transactionWithoutGas, balancePromise)
				return {
					...extraParams,
					error: insufficientBalanceMessage === undefined ? estimateGas.error : { ...estimateGas.error, message: insufficientBalanceMessage },
					success: false,
				}
			}
			return { transaction: { ...transactionWithoutGas, ...await getFeePerGas(estimateGas.gas), gas: estimateGas.gas }, ...extraParams, success: true }
		} catch(error: unknown) {
			if (isNewBlockAbort(error)) throw error
			if (error instanceof JsonRpcResponseError) return { ...extraParams, error: { code: error.code, message: error.message, data: typeof error.data === 'string' ? error.data : '0x' }, success: false }
			await reportLocalRecovery(error, { code: 'transaction_gas_estimation_failed', message: 'Returning a typed RPC error to the requesting page.' })
			if (error instanceof Error) return { ...extraParams, error: { code: 123456, message: error.message, data: 'data' in error && typeof error.data === 'string' ? error.data : '0x' }, success: false }
			return { ...extraParams, error: { code: 123456, message: 'Unknown Error', data: '0x' }, success: false }
		}
	}
	return { transaction: { ...transactionWithoutGas, ...await getFeePerGas(transactionDetails.gas), gas: transactionDetails.gas }, ...extraParams, success: true }
}
