import { validateGnosisSafeDelegateCode } from './gnosisSafeDelegateCalls.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { getInputFieldFromDataOrInput } from '../simulation/services/SimulationModeEthereumClientService.js'
import type { SendRawTransactionParams, SendTransactionParams } from '../types/JsonRpc-types.js'
import type { EthereumUnsignedTransaction } from '../types/wire-types.js'
import type { GnosisSafeEntry } from '../types/addressBookTypes.js'
import { areEqualUint8Arrays } from '../utils/typed-arrays.js'
import { createGnosisSafeContractValidationFailure, getGnosisSafeContractSnapshot } from './gnosisSafeCore.js'
import { completeGnosisSafeExecutionWithConfiguredSigner, decodeGnosisSafeExecution } from './gnosisSafeExecution.js'

// The selector of a Gnosis Safe's execTransaction.
export const GNOSIS_SAFE_EXEC_TRANSACTION_SELECTOR = Uint8Array.from([0x6a, 0x76, 0x12, 0x02])

export const isGnosisSafeExecTransactionCall = (input: Uint8Array) => GNOSIS_SAFE_EXEC_TRANSACTION_SELECTOR.every((byte, index) => input[index] === byte)

// Why a Gnosis Safe can't make a transaction through execTransaction.
export type GnosisSafeUnsupportedTransactionReason = 'raw-transaction' | 'eip-7702-authorization' | 'contract-creation'

export const GNOSIS_SAFE_UNSUPPORTED_TRANSACTION_MESSAGES: Readonly<Record<GnosisSafeUnsupportedTransactionReason, string>> = {
	'raw-transaction': 'Gnosis Safe wallets do not support eth_sendRawTransaction.',
	'eip-7702-authorization': 'Gnosis Safe wallets do not support EIP-7702 authorization lists.',
	'contract-creation': 'Gnosis Safe wallets do not support contract-creation transactions.',
}

// The request-shape policy for a transaction a page asks a Gnosis Safe to send, checked in this order, before Interceptor forms the transaction. Callers that reject only some of these reasons compare the result themselves.
export function getGnosisSafeUnsupportedRequestReason(transactionParams: SendTransactionParams | SendRawTransactionParams): GnosisSafeUnsupportedTransactionReason | undefined {
	if (transactionParams.method !== 'eth_sendTransaction') return 'raw-transaction'
	const transaction = transactionParams.params[0]
	if (transaction.type === '7702' || transaction.authorizationList !== undefined) return 'eip-7702-authorization'
	if (transaction.to === undefined || transaction.to === null) return 'contract-creation'
	return undefined
}

// The same policy for a transaction Interceptor already formed from an eth_sendTransaction request, whose type and recipient are final.
export function getGnosisSafeUnsupportedFormedTransactionReason(transaction: EthereumUnsignedTransaction): GnosisSafeUnsupportedTransactionReason | undefined {
	if (transaction.type === '7702') return 'eip-7702-authorization'
	if (transaction.to === null) return 'contract-creation'
	return undefined
}

// Whether a request is one the Safe at activeAddress can make through execTransaction as the sender: a supported request shape whose `from`, or else the active address, is the active address. Whether activeAddress is a configured, supported Gnosis Safe is the caller's to check.
export function isGnosisSafeExecutableRequestFromActiveAddress(transactionParams: SendTransactionParams | SendRawTransactionParams, activeAddress: bigint) {
	if (getGnosisSafeUnsupportedRequestReason(transactionParams) !== undefined) return false
	// Already excluded as 'raw-transaction'; repeated so TypeScript narrows the request to eth_sendTransaction.
	if (transactionParams.method !== 'eth_sendTransaction') return false
	return (transactionParams.params[0].from ?? activeAddress) === activeAddress
}

export function areGnosisSafeExecutionSignerRequestsEqual(first: SendTransactionParams, second: SendTransactionParams) {
	const firstTransaction = first.params[0]
	const secondTransaction = second.params[0]
	return firstTransaction.type === secondTransaction.type
		&& firstTransaction.from === secondTransaction.from
		&& firstTransaction.to === secondTransaction.to
		&& firstTransaction.gas === secondTransaction.gas
		&& firstTransaction.value === secondTransaction.value
		&& firstTransaction.gasPrice === secondTransaction.gasPrice
		&& firstTransaction.maxPriorityFeePerGas === secondTransaction.maxPriorityFeePerGas
		&& firstTransaction.maxFeePerGas === secondTransaction.maxFeePerGas
		&& areEqualUint8Arrays(firstTransaction.data, secondTransaction.data)
		&& areEqualUint8Arrays(firstTransaction.input, secondTransaction.input)
}

export function isGnosisSafeExecutionRequestForActiveGnosisSafe(transactionParams: SendTransactionParams, safeEntry: GnosisSafeEntry | undefined) {
	if (safeEntry === undefined) return false
	const transaction = transactionParams.params[0]
	if (transaction.from !== safeEntry.address || transaction.to !== safeEntry.address) return false
	return isGnosisSafeExecTransactionCall(getInputFieldFromDataOrInput(transaction))
}

export async function getGnosisSafeExecutionReviewedState(
	ethereumClientService: EthereumClientService,
	transactionParams: SendTransactionParams,
	safeEntry: GnosisSafeEntry | undefined,
) {
	if (!isGnosisSafeExecutionRequestForActiveGnosisSafe(transactionParams, safeEntry) || safeEntry === undefined) return undefined
	const transaction = transactionParams.params[0]
	if (transaction.value !== undefined && transaction.value !== 0n) {
		throw createGnosisSafeContractValidationFailure('A direct Gnosis Safe execution transaction must have zero outer ETH value. The value transferred by the Gnosis Safe belongs inside execTransaction.')
	}
	const { state: safeState, blockNumber } = await getGnosisSafeContractSnapshot(ethereumClientService, safeEntry.address)
	// Direct executions (including fully signed ones) use the same verified-library gate as local proposals.
	const { safeTx } = decodeGnosisSafeExecution(ethereumClientService.getChainId(), safeEntry.address, safeState.nonce, getInputFieldFromDataOrInput(transaction))
	await validateGnosisSafeDelegateCode(ethereumClientService, safeTx, blockNumber)
	if (safeEntry.safeVersion !== undefined && safeEntry.safeVersion !== safeState.version) {
		throw createGnosisSafeContractValidationFailure(`The Gnosis Safe version is now ${ safeState.version }, but the address-book entry records ${ safeEntry.safeVersion }.`)
	}
	return safeState
}

export function getGnosisSafeExecutionSignerRoute(transactionParams: SendTransactionParams, safeEntry: GnosisSafeEntry | undefined, walletSignerAddress: bigint | undefined) {
	if (safeEntry === undefined || walletSignerAddress === undefined || !isGnosisSafeExecutionRequestForActiveGnosisSafe(transactionParams, safeEntry)) return undefined
	return {
		executor: walletSignerAddress,
		transactionParams: {
			...transactionParams,
			params: [{
				...transactionParams.params[0],
				from: walletSignerAddress,
			}] as const,
		},
	}
}

export async function prepareGnosisSafeExecutionSignerRoute(
	ethereumClientService: EthereumClientService,
	transactionParams: SendTransactionParams,
	safeEntry: GnosisSafeEntry | undefined,
	walletSignerAddress: bigint | undefined,
) {
	const route = getGnosisSafeExecutionSignerRoute(transactionParams, safeEntry, walletSignerAddress)
	if (route === undefined || safeEntry === undefined || walletSignerAddress === undefined) return undefined
	const transaction = route.transactionParams.params[0]
	const input = getInputFieldFromDataOrInput(transaction)
	const safeState = await getGnosisSafeExecutionReviewedState(ethereumClientService, transactionParams, safeEntry)
	if (safeState === undefined) return undefined
	const completedInput = await completeGnosisSafeExecutionWithConfiguredSigner(
		ethereumClientService.getChainId(),
		safeEntry.address,
		walletSignerAddress,
		safeState,
		input,
	)
	return {
		...route,
		safeState,
		transactionParams: {
			...route.transactionParams,
			params: [{
				...transaction,
				...(transaction.data === undefined ? {} : { data: completedInput }),
				...(transaction.input === undefined ? {} : { input: completedInput }),
			}] as const,
		},
	}
}
