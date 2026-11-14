import { validateSafeDelegateCode } from './safeDelegateCalls.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { getInputFieldFromDataOrInput } from '../simulation/services/SimulationModeEthereumClientService.js'
import type { SendRawTransactionParams, SendTransactionParams } from '../types/JsonRpc-types.js'
import type { EthereumUnsignedTransaction } from '../types/wire-types.js'
import type { AddressBookEntry, SafeEntry } from '../types/addressBookTypes.js'
import { areEqualUint8Arrays } from '../utils/typed-arrays.js'
import { createSafeContractValidationFailure, getSafeContractSnapshot, isSafeContractValidationFailure } from './safeCore.js'
import { completeSafeExecutionWithConfiguredSigner, decodeSafeExecution } from './safeExecution.js'

const SAFE_EXEC_TRANSACTION_SELECTOR = Uint8Array.from([0x6a, 0x76, 0x12, 0x02])

export const isSafeExecTransactionCall = (input: Uint8Array) => SAFE_EXEC_TRANSACTION_SELECTOR.every((byte, index) => input[index] === byte)

// Why a Gnosis Safe can't make a transaction through execTransaction.
export type SafeUnsupportedTransactionReason = 'raw-transaction' | 'eip-7702-authorization' | 'contract-creation'

export const SAFE_UNSUPPORTED_TRANSACTION_MESSAGES: Readonly<Record<SafeUnsupportedTransactionReason, string>> = {
	'raw-transaction': 'Gnosis Safe wallets do not support eth_sendRawTransaction.',
	'eip-7702-authorization': 'Gnosis Safe wallets do not support EIP-7702 authorization lists.',
	'contract-creation': 'Gnosis Safe wallets do not support contract-creation transactions.',
}

// The request-shape policy for a transaction a page asks a Gnosis Safe to send, checked in this order, before Interceptor forms the transaction. Callers that reject only some of these reasons compare the result themselves.
export function getSafeUnsupportedRequestReason(transactionParams: SendTransactionParams | SendRawTransactionParams): SafeUnsupportedTransactionReason | undefined {
	if (transactionParams.method !== 'eth_sendTransaction') return 'raw-transaction'
	const transaction = transactionParams.params[0]
	if (transaction.type === '7702' || transaction.authorizationList !== undefined) return 'eip-7702-authorization'
	if (transaction.to === undefined || transaction.to === null) return 'contract-creation'
	return undefined
}

// The same policy for a transaction Interceptor already formed from an eth_sendTransaction request, whose type and recipient are final.
export function getSafeUnsupportedFormedTransactionReason(transaction: EthereumUnsignedTransaction): SafeUnsupportedTransactionReason | undefined {
	if (transaction.type === '7702') return 'eip-7702-authorization'
	if (transaction.to === null) return 'contract-creation'
	return undefined
}

// Whether the simulation runs the transactions an account sends through the Gnosis Safe it is: a Gnosis Safe among the address book entries of the client's chain ('safe'), deployed with a version Interceptor supports, or else why not. A Safe that is configured but not deployed or not supported ('unsupportedSafe') carries its validation failure, so the caller can record the fallback; this layer decides only, without writing diagnostics or reading extension storage.
export type SimulationModeSafeAccount =
	| { readonly kind: 'safe' }
	| { readonly kind: 'notConfiguredSafe' }
	| { readonly kind: 'unsupportedSafe', readonly validationFailure: unknown }

export async function getSimulationModeSafeAccount(ethereum: EthereumClientService, chainAddressBookEntries: readonly AddressBookEntry[], account: bigint): Promise<SimulationModeSafeAccount> {
	if (!chainAddressBookEntries.some((entry) => entry.type === 'safe' && entry.address === account)) return { kind: 'notConfiguredSafe' }
	try {
		await getSafeContractSnapshot(ethereum, account)
		return { kind: 'safe' }
	} catch (error) {
		if (!isSafeContractValidationFailure(error)) throw error
		return { kind: 'unsupportedSafe', validationFailure: error }
	}
}

// Whether a request is one the Safe at activeAddress can make through execTransaction as the sender: a supported request shape whose `from`, or else the active address, is the active address. Whether activeAddress is a configured, supported Gnosis Safe is the caller's to check (isSimulationModeSafeAccount).
export function isSafeExecutableRequestFromActiveAddress(transactionParams: SendTransactionParams | SendRawTransactionParams, activeAddress: bigint) {
	if (getSafeUnsupportedRequestReason(transactionParams) !== undefined) return false
	// Already excluded as 'raw-transaction'; repeated so TypeScript narrows the request to eth_sendTransaction.
	if (transactionParams.method !== 'eth_sendTransaction') return false
	return (transactionParams.params[0].from ?? activeAddress) === activeAddress
}

export function areSafeExecutionSignerRequestsEqual(first: SendTransactionParams, second: SendTransactionParams) {
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

export function isSafeExecutionRequestForActiveSafe(transactionParams: SendTransactionParams, safeEntry: SafeEntry | undefined) {
	if (safeEntry === undefined) return false
	const transaction = transactionParams.params[0]
	if (transaction.from !== safeEntry.address || transaction.to !== safeEntry.address) return false
	return isSafeExecTransactionCall(getInputFieldFromDataOrInput(transaction))
}

export async function getSafeExecutionReviewedState(
	ethereumClientService: EthereumClientService,
	transactionParams: SendTransactionParams,
	safeEntry: SafeEntry | undefined,
) {
	if (!isSafeExecutionRequestForActiveSafe(transactionParams, safeEntry) || safeEntry === undefined) return undefined
	const transaction = transactionParams.params[0]
	if (transaction.value !== undefined && transaction.value !== 0n) {
		throw createSafeContractValidationFailure('A direct Gnosis Safe execution transaction must have zero outer ETH value. The value transferred by the Gnosis Safe belongs inside execTransaction.')
	}
	const { state: safeState, blockNumber } = await getSafeContractSnapshot(ethereumClientService, safeEntry.address)
	// Direct executions (including fully signed ones) use the same verified-library gate as local proposals.
	const { safeTx } = decodeSafeExecution(ethereumClientService.getChainId(), safeEntry.address, safeState.nonce, getInputFieldFromDataOrInput(transaction))
	await validateSafeDelegateCode(ethereumClientService, safeTx, blockNumber)
	if (safeEntry.safeVersion !== undefined && safeEntry.safeVersion !== safeState.version) {
		throw createSafeContractValidationFailure(`The Gnosis Safe version is now ${ safeState.version }, but the address-book entry records ${ safeEntry.safeVersion }.`)
	}
	return safeState
}

export function getSafeExecutionSignerRoute(transactionParams: SendTransactionParams, safeEntry: SafeEntry | undefined, walletSignerAddress: bigint | undefined) {
	if (safeEntry === undefined || walletSignerAddress === undefined || !isSafeExecutionRequestForActiveSafe(transactionParams, safeEntry)) return undefined
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

export async function prepareSafeExecutionSignerRoute(
	ethereumClientService: EthereumClientService,
	transactionParams: SendTransactionParams,
	safeEntry: SafeEntry | undefined,
	walletSignerAddress: bigint | undefined,
) {
	const route = getSafeExecutionSignerRoute(transactionParams, safeEntry, walletSignerAddress)
	if (route === undefined || safeEntry === undefined || walletSignerAddress === undefined) return undefined
	const transaction = route.transactionParams.params[0]
	const input = getInputFieldFromDataOrInput(transaction)
	const safeState = await getSafeExecutionReviewedState(ethereumClientService, transactionParams, safeEntry)
	if (safeState === undefined) return undefined
	const completedInput = await completeSafeExecutionWithConfiguredSigner(
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
