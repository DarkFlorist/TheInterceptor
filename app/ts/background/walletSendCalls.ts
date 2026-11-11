import { type SendTransactionParams, WALLET_SEND_CALLS_VERSION, type WalletCallsReceipt, type WalletSendCalls, type WalletSendCallsCapabilities } from '../types/JsonRpc-types.js'
import type { WebsiteCreatedEthereumTransactionOrFailed } from '../types/visualizer-types.js'
import { EIP5792_ERROR_ATOMICITY_NOT_SUPPORTED, EIP5792_ERROR_BUNDLE_TOO_LARGE, EIP5792_ERROR_DUPLICATE_ID, EIP5792_ERROR_UNKNOWN_BUNDLE_ID, EIP5792_ERROR_UNSUPPORTED_CHAIN_ID, EIP5792_ERROR_UNSUPPORTED_NON_OPTIONAL_CAPABILITY, JSON_RPC_ERROR_CODE_INVALID_PARAMS, METAMASK_ERROR_NOT_AUTHORIZED } from '../utils/constants.js'
import { areEqualUint8Arrays } from '../utils/typed-arrays.js'

// The EIP-5792 wire contract of wallet_sendCalls: canonicalizing a batch, the transactions its calls become, matching them to what was simulated, its errors and its status codes. It depends only on types and utilities; walletSendCallsRpc.ts holds the per-mode refusals and walletSendCallsStatus.ts the simulation-backed wallet_getCallsStatus.

// Every call is prepared and simulated sequentially before the batch can be approved, so the batch size is kept to what wallets typically accept.
export const WALLET_SEND_CALLS_MAX_CALLS = 10

export type WalletSendCallsError = { readonly code: number, readonly message: string }
type CanonicalWalletSendCalls = { readonly success: true, readonly value: WalletSendCalls } | { readonly success: false, readonly error: WalletSendCallsError }

export const walletSendCallsUnknownBundleIdError: WalletSendCallsError = { code: EIP5792_ERROR_UNKNOWN_BUNDLE_ID, message: 'This wallet_sendCalls bundle id is unknown to the Interceptor.' }

const getRequiredCapabilityName = (capabilities: WalletSendCallsCapabilities | undefined) => Object.entries(capabilities ?? {}).find(([_name, capability]) => capability?.optional !== true)?.[0]

// Rebuilds the request from the fields the Interceptor reviews. The sender and chain are pinned to the bound account and chain, and optional capabilities are dropped because none are implemented.
export function canonicalizeWalletSendCalls(request: WalletSendCalls, account: bigint, chainId: bigint): CanonicalWalletSendCalls {
	const [batch] = request.params
	const failure = (code: number, message: string): CanonicalWalletSendCalls => ({ success: false, error: { code, message } })
	if (batch.from !== undefined && batch.from !== account) return failure(METAMASK_ERROR_NOT_AUTHORIZED, 'The wallet_sendCalls from address is not the account connected to this website.')
	if (batch.chainId !== chainId) return failure(EIP5792_ERROR_UNSUPPORTED_CHAIN_ID, `The wallet_sendCalls chain id 0x${ batch.chainId.toString(16) } does not match the active chain 0x${ chainId.toString(16) }.`)
	if (batch.calls.length === 0) return failure(JSON_RPC_ERROR_CODE_INVALID_PARAMS, 'wallet_sendCalls requires at least one call.')
	if (batch.calls.length > WALLET_SEND_CALLS_MAX_CALLS) return failure(EIP5792_ERROR_BUNDLE_TOO_LARGE, `The Interceptor accepts at most ${ WALLET_SEND_CALLS_MAX_CALLS } calls per wallet_sendCalls request.`)
	// The calls are simulated as separate sequential transactions, so atomic execution cannot be promised.
	if (batch.atomicRequired) return failure(EIP5792_ERROR_ATOMICITY_NOT_SUPPORTED, 'The Interceptor simulates batched calls as sequential transactions and cannot guarantee atomic execution.')
	const requiredCapabilityName = getRequiredCapabilityName(batch.capabilities) ?? batch.calls.map((call) => getRequiredCapabilityName(call.capabilities)).find((name) => name !== undefined)
	if (requiredCapabilityName !== undefined) return failure(EIP5792_ERROR_UNSUPPORTED_NON_OPTIONAL_CAPABILITY, `The Interceptor does not support the non-optional wallet_sendCalls capability "${ requiredCapabilityName }".`)
	return {
		success: true,
		value: {
			method: 'wallet_sendCalls',
			params: [{
				version: WALLET_SEND_CALLS_VERSION,
				...(batch.id === undefined ? {} : { id: batch.id }),
				from: account,
				chainId,
				atomicRequired: false,
				calls: batch.calls.map((call) => ({
					...(call.to === undefined ? {} : { to: call.to }),
					data: call.data ?? new Uint8Array(),
					value: call.value ?? 0n,
				})),
			}],
		},
	}
}

// Each call is reviewed as the transaction the bound account would send. A missing `to` deploys a contract, like in eth_sendTransaction.
export function getWalletSendCallsTransactionParams(request: WalletSendCalls, account: bigint): readonly SendTransactionParams[] {
	return request.params[0].calls.map((call) => ({
		method: 'eth_sendTransaction',
		params: [{
			from: account,
			...(call.to === undefined ? {} : { to: call.to }),
			value: call.value ?? 0n,
			data: call.data ?? new Uint8Array(),
		}],
	}))
}

export const walletSendCallsIdInUseError: WalletSendCallsError = { code: EIP5792_ERROR_DUPLICATE_ID, message: 'A wallet_sendCalls bundle with this id was already submitted by this website.' }

// The approved payload must still be exactly the transactions that were simulated and shown to the user, in the same order.
export function doWalletSendCallsMatchSimulatedTransactions(request: WalletSendCalls, account: bigint, transactionsToSimulate: readonly WebsiteCreatedEthereumTransactionOrFailed[]) {
	const [batch] = request.params
	if (batch.from !== account || batch.calls.length !== transactionsToSimulate.length) return false
	return batch.calls.every((call, callIndex) => {
		const transactionToSimulate = transactionsToSimulate[callIndex]
		if (transactionToSimulate === undefined || !transactionToSimulate.success) return false
		const transaction = transactionToSimulate.transaction
		return transaction.from === account
			&& transaction.to === (call.to ?? null)
			&& transaction.value === (call.value ?? 0n)
			&& areEqualUint8Arrays(transaction.input, call.data ?? new Uint8Array())
	})
}

// EIP-5792 status codes: 200 when every call succeeded, 500 when every call reverted and 600 when only some did.
export const getCallsStatusCode = (receipts: readonly Pick<WalletCallsReceipt, 'status'>[]) => {
	if (receipts.every((receipt) => receipt.status === 'success')) return 200
	// The EIP-5792 status table defines 500 as "Batch reverted completely" and 600 as "Batch reverted partially".
	if (receipts.every((receipt) => receipt.status === 'failure')) return 500
	return 600
}
