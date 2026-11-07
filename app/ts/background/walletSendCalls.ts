import * as funtypes from 'funtypes'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { getSimulatedTransactionReceipt } from '../simulation/services/SimulationModeEthereumClientService.js'
import type { RPCReply } from '../types/interceptor-messages.js'
import { type SendTransactionParams, WALLET_SEND_CALLS_VERSION, type WalletCallsReceipt, type WalletGetCallsStatus, type WalletSendCalls, type WalletSendCallsCapabilities, type WalletShowCallsStatus } from '../types/JsonRpc-types.js'
import type { ResolvedExecutionSimulationState, WebsiteCreatedEthereumTransactionOrFailed } from '../types/visualizer-types.js'
import { EIP5792_ERROR_ATOMICITY_NOT_SUPPORTED, EIP5792_ERROR_BUNDLE_TOO_LARGE, EIP5792_ERROR_DUPLICATE_ID, EIP5792_ERROR_UNKNOWN_BUNDLE_ID, EIP5792_ERROR_UNSUPPORTED_CHAIN_ID, EIP5792_ERROR_UNSUPPORTED_NON_OPTIONAL_CAPABILITY, JSON_RPC_ERROR_CODE_INVALID_PARAMS, METAMASK_ERROR_METHOD_NOT_SUPPORTED_BY_PROVIDER, METAMASK_ERROR_NOT_AUTHORIZED } from '../utils/constants.js'
import { JsonRpcResponseError } from '../utils/errors.js'
import type { InterceptedRequest } from '../utils/requests.js'
import { areEqualUint8Arrays } from '../utils/typed-arrays.js'
import { getWalletSendCallsBatchTransactionIdentifiers } from './walletSendCallsBatchIds.js'

// EIP-5792 call batches are only supported in simulation mode, where an approved batch becomes separate transactions on the simulation stack, exactly as it was simulated:
// - wallet_sendCalls is validated, canonicalized, simulated and confirmed before its calls are added to the simulation stack. Simulation mode needs an Interceptor RPC to simulate the calls.
// - wallet_getCallsStatus is answered from the simulation stack. wallet_showCallsStatus would open bundle status UI, which the Interceptor does not have.
// - Signing mode refuses all three without forwarding them to the signer (see getSigningModeWalletCallsReply), so websites send each call with eth_sendTransaction, which the Interceptor reviews on its own.
// - wallet_getCapabilities is answered locally in every mode (see walletCapabilities.ts), so websites are never offered the signer's batch capabilities.

// Every call is prepared and simulated sequentially before the batch can be approved, so the batch size is kept to what wallets typically accept.
export const WALLET_SEND_CALLS_MAX_CALLS = 10

export type WalletSendCallsError = { readonly code: number, readonly message: string }
type CanonicalWalletSendCalls = { readonly success: true, readonly value: WalletSendCalls } | { readonly success: false, readonly error: WalletSendCallsError }

const errorReply = (method: string, error: WalletSendCallsError): RPCReply => ({ type: 'result', method, error })

const unknownBundleIdError: WalletSendCallsError = { code: EIP5792_ERROR_UNKNOWN_BUNDLE_ID, message: 'This wallet_sendCalls bundle id is unknown to the Interceptor.' }

// The Interceptor simulates each call as a separate transaction, but a wallet may execute an atomicRequired: false batch atomically in one transaction, where state such as transient storage carries over between the calls. Such a preview cannot be bound to what the wallet executes, so signing mode refuses the batch and knows no bundles.
export function getSigningModeWalletCallsReply(request: InterceptedRequest): RPCReply | undefined {
	switch (request.method) {
		// viem falls back to eth_sendTransaction when the error message contains MetaMask's "does not exist / is not available" wording for unsupported methods; the 4200 code alone does not trigger its fallback.
		case 'wallet_sendCalls': return errorReply(request.method, {
			code: METAMASK_ERROR_METHOD_NOT_SUPPORTED_BY_PROVIDER,
			message: 'wallet_sendCalls does not exist / is not available in Interceptor signing mode. The Interceptor reviews each call as a separate transaction, but a wallet may execute a batch atomically, where state such as transient storage carries over between the calls. Send each call with eth_sendTransaction instead.',
		})
		case 'wallet_getCallsStatus':
		case 'wallet_showCallsStatus': return errorReply(request.method, unknownBundleIdError)
		default: return undefined
	}
}

const RequestedWalletSendCallsVersion = funtypes.ReadonlyObject({ params: funtypes.ReadonlyTuple(funtypes.ReadonlyObject({ version: funtypes.String })) })

export function getWalletSendCallsParseFailureReply(request: InterceptedRequest): RPCReply | undefined {
	switch (request.method) {
		case 'wallet_sendCalls': {
			const requestedVersion = RequestedWalletSendCallsVersion.safeParse(request)
			const message = requestedVersion.success && requestedVersion.value.params[0].version !== WALLET_SEND_CALLS_VERSION
				? `Unsupported wallet_sendCalls version ${ requestedVersion.value.params[0].version }. The Interceptor supports EIP-5792 version ${ WALLET_SEND_CALLS_VERSION }.`
				: `Invalid wallet_sendCalls version ${ WALLET_SEND_CALLS_VERSION } parameters: chainId, atomicRequired and calls are required, calls may only contain to, data, value and capabilities, hex values must be 0x-prefixed, and unknown fields are rejected.`
			return errorReply(request.method, { code: JSON_RPC_ERROR_CODE_INVALID_PARAMS, message })
		}
		case 'wallet_getCallsStatus':
		case 'wallet_showCallsStatus': return errorReply(request.method, { code: JSON_RPC_ERROR_CODE_INVALID_PARAMS, message: `Invalid ${ request.method } parameters.` })
		default: return undefined
	}
}

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
const getCallsStatusCode = (receipts: readonly WalletCallsReceipt[]) => {
	if (receipts.every((receipt) => receipt.status === 'success')) return 200
	if (receipts.every((receipt) => receipt.status === 'failure')) return 500
	return 600
}

// Answers wallet_getCallsStatus for batches that an approved simulation-mode wallet_sendCalls added to the simulation stack.
export async function getSimulatedCallsStatus(ethereum: EthereumClientService, simulationState: ResolvedExecutionSimulationState, request: WalletGetCallsStatus, websiteOrigin: string): Promise<RPCReply> {
	const [id] = request.params
	if (simulationState.kind === 'passthrough') return errorReply(request.method, unknownBundleIdError)
	const currentState = simulationState.value
	if (currentState.success === false) throw new JsonRpcResponseError(currentState.jsonRpcError)
	const batchTransactionIdentifiers = await getWalletSendCallsBatchTransactionIdentifiers(websiteOrigin, id)
	if (batchTransactionIdentifiers === undefined) return errorReply(request.method, unknownBundleIdError)
	const batchTransactions = currentState.simulatedBlocks
		.flatMap((block) => block.simulatedTransactions)
		.map((simulatedTransaction) => simulatedTransaction.preSimulationTransaction)
		.filter((transaction) => batchTransactionIdentifiers.includes(transaction.transactionIdentifier))
	const [firstTransaction] = batchTransactions
	if (firstTransaction === undefined) return errorReply(request.method, unknownBundleIdError)
	const receipts: WalletCallsReceipt[] = []
	for (const transaction of batchTransactions) {
		const receipt = await getSimulatedTransactionReceipt(ethereum, undefined, simulationState, transaction.signedTransaction.hash)
		if (receipt === null) return errorReply(request.method, unknownBundleIdError)
		receipts.push({
			logs: receipt.logs.map((log) => ({ address: log.address, data: log.data, topics: log.topics })),
			status: receipt.status,
			blockHash: receipt.blockHash,
			blockNumber: receipt.blockNumber,
			gasUsed: receipt.gasUsed,
			transactionHash: receipt.transactionHash,
		})
	}
	return {
		type: 'result',
		method: request.method,
		result: {
			version: WALLET_SEND_CALLS_VERSION,
			id,
			chainId: firstTransaction.signedTransaction.chainId ?? ethereum.getChainId(),
			status: getCallsStatusCode(receipts),
			// Simulation-mode batches are separate stack transactions, so they are never atomic.
			atomic: false,
			receipts,
		},
	}
}

export const getSimulatedShowCallsStatusReply = (request: WalletShowCallsStatus) => errorReply(request.method, {
	code: METAMASK_ERROR_METHOD_NOT_SUPPORTED_BY_PROVIDER,
	message: 'wallet_showCallsStatus is not supported in simulation mode. Simulated batches are shown in the Interceptor simulation stack.',
})
