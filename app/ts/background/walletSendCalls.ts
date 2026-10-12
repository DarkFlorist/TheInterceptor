import * as funtypes from 'funtypes'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { getSimulatedTransactionReceipt } from '../simulation/services/SimulationModeEthereumClientService.js'
import type { PendingTransactionBatch, WalletSendCallsBinding } from '../types/accessRequest.js'
import type { RPCReply } from '../types/interceptor-messages.js'
import { type SendTransactionParams, WALLET_SEND_CALLS_VERSION, type WalletCallsReceipt, type WalletGetCallsStatus, type WalletSendCalls, type WalletSendCallsCapabilities, WalletSendCallsResult, type WalletShowCallsStatus } from '../types/JsonRpc-types.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { ResolvedExecutionSimulationState, WebsiteCreatedEthereumTransactionOrFailed } from '../types/visualizer-types.js'
import { EIP5792_ERROR_ATOMICITY_NOT_SUPPORTED, EIP5792_ERROR_BUNDLE_TOO_LARGE, EIP5792_ERROR_DUPLICATE_ID, EIP5792_ERROR_UNKNOWN_BUNDLE_ID, EIP5792_ERROR_UNSUPPORTED_CHAIN_ID, EIP5792_ERROR_UNSUPPORTED_NON_OPTIONAL_CAPABILITY, JSON_RPC_ERROR_CODE_INVALID_PARAMS, JSON_RPC_ERROR_CODE_METHOD_NOT_FOUND, JSON_RPC_ERROR_CODE_METHOD_NOT_SUPPORTED, METAMASK_ERROR_METHOD_NOT_SUPPORTED_BY_PROVIDER, METAMASK_ERROR_NOT_AUTHORIZED, METAMASK_ERROR_PROVIDER_DISCONNECTED } from '../utils/constants.js'
import { JsonRpcResponseError } from '../utils/errors.js'
import { keccak256, stringToBytes } from '../utils/ethereumPrimitives.js'
import { getUniqueRequestIdentifierString, type InterceptedRequest, type UniqueRequestIdentifier } from '../utils/requests.js'
import { areEqualUint8Arrays } from '../utils/typed-arrays.js'
import { getActiveAddress, getWebsiteSocketConnection } from './backgroundUtils.js'
import { getSettings } from './settings.js'
import { getActiveAddressForCurrentSignerState, getConfirmedSignerStateToken } from './signerStateOwnership.js'
import { getInterceptorTransactionStack, getPendingTransactionsAndMessages } from './storageVariables.js'
import { hasAddressAccess } from './websiteAccessPolicy.js'

// EIP-5792 method classification on networks with an Interceptor RPC:
// - wallet_sendCalls is intercepted: validated, canonicalized, simulated and confirmed before it reaches the signer or the simulation stack.
// - wallet_getCallsStatus is read-only. Signing mode passes it through to the signer that owns the bundle; simulation mode answers it from the simulation stack.
// - wallet_showCallsStatus only opens wallet UI. Signing mode passes it through to the signer; simulation mode has no bundle status UI, so it is unsupported.
// - wallet_getCapabilities is answered locally (see walletCapabilities.ts), so dapps are not offered signer capabilities that the Interceptor does not review.
// On networks without an Interceptor RPC, signing mode forwards all of these methods to the signer, like every other non-account method. A Gnosis Safe signing account rejects all of them (see safeRequestPolicy.ts).

// Every call is prepared and simulated sequentially before the batch can be approved, so the batch size is kept to what wallets typically accept.
export const WALLET_SEND_CALLS_MAX_CALLS = 10

type WalletSendCallsError = { readonly code: number, readonly message: string }
type CanonicalWalletSendCalls = { readonly success: true, readonly value: WalletSendCalls } | { readonly success: false, readonly error: WalletSendCallsError }

const errorReply = (method: string, error: WalletSendCallsError): RPCReply => ({ type: 'result', method, error })

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

const getWalletSendCallsIdentifierHash = (uniqueRequestIdentifier: UniqueRequestIdentifier, suffix: string) => keccak256(stringToBytes(`${ getUniqueRequestIdentifierString(uniqueRequestIdentifier) }|wallet_sendCalls|${ suffix }`))

export const getWalletSendCallsBatchId = (uniqueRequestIdentifier: UniqueRequestIdentifier) => getWalletSendCallsIdentifierHash(uniqueRequestIdentifier, 'batch')

export const getWalletSendCallTransactionIdentifier = (uniqueRequestIdentifier: UniqueRequestIdentifier, callIndex: number) => BigInt(getWalletSendCallsIdentifierHash(uniqueRequestIdentifier, `call:${ callIndex }`))

// Simulation-mode batch ids must be unique per website, because wallet_getCallsStatus looks them up by id and origin.
export async function isWalletSendCallsIdInUse(websiteOrigin: string, id: string) {
	const stack = await getInterceptorTransactionStack()
	const inStack = stack.operations.some((operation) => operation.type === 'Transaction'
		&& operation.preSimulationTransaction.walletSendCallsBatchId === id
		&& operation.preSimulationTransaction.website.websiteOrigin === websiteOrigin)
	if (inStack) return true
	return (await getPendingTransactionsAndMessages()).some((pending) => pending.type === 'TransactionBatch' && pending.batchId === id && pending.website.websiteOrigin === websiteOrigin)
}

// Wallets on the earlier EIP-5792 draft return the bundle id as a bare string instead of { id }.
export function parseWalletSendCallsSignerResult(signerReply: unknown): WalletSendCallsResult | undefined {
	const result = WalletSendCallsResult.safeParse(signerReply)
	if (result.success) return result.value
	const bareId = WalletSendCallsResult.fields.id.safeParse(signerReply)
	return bareId.success ? { id: bareId.value } : undefined
}

// Wallets without EIP-5792 support answer wallet_sendCalls with one of these codes, which websites use to fall back to sending each call with eth_sendTransaction.
const SIGNER_METHOD_UNSUPPORTED_ERROR_CODES: ReadonlySet<number> = new Set([JSON_RPC_ERROR_CODE_METHOD_NOT_FOUND, JSON_RPC_ERROR_CODE_METHOD_NOT_SUPPORTED, METAMASK_ERROR_METHOD_NOT_SUPPORTED_BY_PROVIDER])
export const isSignerMethodUnsupportedError = (error: { readonly code: number }) => SIGNER_METHOD_UNSUPPORTED_ERROR_CODES.has(error.code)

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

export function getWalletSendCallsSignerBinding(websiteTabConnections: WebsiteTabConnections, tabId: number): WalletSendCallsBinding['signer'] {
	const signerStateToken = getConfirmedSignerStateToken(websiteTabConnections, tabId)
	if (signerStateToken === undefined) return undefined
	return {
		connectionName: signerStateToken.socket.connectionName,
		ownerGeneration: signerStateToken.ownerGeneration,
		signerProviderGeneration: signerStateToken.signerProviderGeneration,
	}
}

const approvalInvalidated = (code: number, reason: string): WalletSendCallsError => ({ code, message: `${ reason } Reject this batch and send the request again.` })

// Re-checks the admission binding at approval time. Any change to the network, account, website access, signer connection or batch payload invalidates the approval.
export async function getWalletSendCallsApprovalError(
	websiteTabConnections: WebsiteTabConnections,
	ethereum: EthereumClientService,
	pendingBatch: PendingTransactionBatch,
	transactionsToSimulate: readonly WebsiteCreatedEthereumTransactionOrFailed[],
): Promise<WalletSendCallsError | undefined> {
	const { binding } = pendingBatch
	const requestSocket = pendingBatch.uniqueRequestIdentifier.requestSocket
	const settings = await getSettings()
	if (settings.activeRpcNetwork.chainId !== binding.chainId || ethereum.getChainId() !== binding.chainId) return approvalInvalidated(EIP5792_ERROR_UNSUPPORTED_CHAIN_ID, 'The active network changed after this batch was requested.')
	// Switching modes would change what approval does: sign the batch with the wallet, or only add it to the simulation stack.
	if (pendingBatch.simulationMode !== settings.simulationMode) return approvalInvalidated(METAMASK_ERROR_NOT_AUTHORIZED, 'The Interceptor mode changed after this batch was requested.')
	if (!pendingBatch.simulationMode) {
		const currentSigner = getWalletSendCallsSignerBinding(websiteTabConnections, requestSocket.tabId)
		if (binding.signer === undefined
			|| currentSigner === undefined
			|| currentSigner.connectionName !== binding.signer.connectionName
			|| currentSigner.ownerGeneration !== binding.signer.ownerGeneration
			|| currentSigner.signerProviderGeneration !== binding.signer.signerProviderGeneration
		) return approvalInvalidated(METAMASK_ERROR_PROVIDER_DISCONNECTED, 'The signer wallet connection changed after this batch was requested.')
	}
	const activeAddress = await getActiveAddressForCurrentSignerState(websiteTabConnections, settings, requestSocket.tabId, async () => await getActiveAddress(settings, requestSocket.tabId))
	if (activeAddress === undefined || activeAddress.address !== binding.account) return approvalInvalidated(METAMASK_ERROR_NOT_AUTHORIZED, 'The active account changed after this batch was requested.')
	const connection = getWebsiteSocketConnection(websiteTabConnections, requestSocket)
	const connectionApproved = connection?.approved === true && connection.websiteOrigin === binding.websiteOrigin
	if (!connectionApproved && hasAddressAccess(settings.websiteAccess, binding.websiteOrigin, activeAddress) !== 'hasAccess') return approvalInvalidated(METAMASK_ERROR_NOT_AUTHORIZED, 'This website is no longer authorized to use the active account.')
	if (!doWalletSendCallsMatchSimulatedTransactions(pendingBatch.originalRequestParameters, binding.account, transactionsToSimulate)) return approvalInvalidated(JSON_RPC_ERROR_CODE_INVALID_PARAMS, 'The batch calls no longer match the simulated transactions.')
	return undefined
}

// EIP-5792 status codes: 200 when every call succeeded, 500 when every call reverted and 600 when only some did.
const getCallsStatusCode = (receipts: readonly WalletCallsReceipt[]) => {
	if (receipts.every((receipt) => receipt.status === 'success')) return 200
	if (receipts.every((receipt) => receipt.status === 'failure')) return 500
	return 600
}

const unknownBundleIdError: WalletSendCallsError = { code: EIP5792_ERROR_UNKNOWN_BUNDLE_ID, message: 'This wallet_sendCalls bundle id is unknown to the Interceptor.' }

// Answers wallet_getCallsStatus for batches that an approved simulation-mode wallet_sendCalls added to the simulation stack.
export async function getSimulatedCallsStatus(ethereum: EthereumClientService, simulationState: ResolvedExecutionSimulationState, request: WalletGetCallsStatus, websiteOrigin: string): Promise<RPCReply> {
	const [id] = request.params
	if (simulationState.kind === 'passthrough') return errorReply(request.method, unknownBundleIdError)
	const currentState = simulationState.value
	if (currentState.success === false) throw new JsonRpcResponseError(currentState.jsonRpcError)
	const batchTransactions = currentState.simulatedBlocks
		.flatMap((block) => block.simulatedTransactions)
		.map((simulatedTransaction) => simulatedTransaction.preSimulationTransaction)
		.filter((transaction) => transaction.walletSendCallsBatchId === id && transaction.website.websiteOrigin === websiteOrigin)
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
