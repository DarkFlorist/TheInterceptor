import * as funtypes from 'funtypes'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { getSimulatedTransactionReceipt } from '../simulation/services/SimulationModeEthereumClientService.js'
import type { AddressBookEntry } from '../types/addressBookTypes.js'
import type { PendingTransactionBatch, PendingTransactionOrSignableMessage, WalletSendCallsBatchIdRecord, WalletSendCallsBinding } from '../types/accessRequest.js'
import type { RPCReply, Settings } from '../types/interceptor-messages.js'
import { type SendTransactionParams, WALLET_SEND_CALLS_VERSION, type WalletCallsReceipt, type WalletGetCallsStatus, type WalletSendCalls, type WalletSendCallsCapabilities, type WalletShowCallsStatus } from '../types/JsonRpc-types.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { InterceptorTransactionStack, ResolvedExecutionSimulationState, WebsiteCreatedEthereumTransactionOrFailed } from '../types/visualizer-types.js'
import { EIP5792_ERROR_ATOMICITY_NOT_SUPPORTED, EIP5792_ERROR_BUNDLE_TOO_LARGE, EIP5792_ERROR_DUPLICATE_ID, EIP5792_ERROR_UNKNOWN_BUNDLE_ID, EIP5792_ERROR_UNSUPPORTED_CHAIN_ID, EIP5792_ERROR_UNSUPPORTED_NON_OPTIONAL_CAPABILITY, JSON_RPC_ERROR_CODE_INVALID_PARAMS, METAMASK_ERROR_METHOD_NOT_SUPPORTED_BY_PROVIDER, METAMASK_ERROR_NOT_AUTHORIZED } from '../utils/constants.js'
import { JsonRpcResponseError } from '../utils/errors.js'
import { keccak256, stringToBytes } from '../utils/ethereumPrimitives.js'
import { doesUniqueRequestIdentifiersMatch, getUniqueRequestIdentifierString, type InterceptedRequest, type UniqueRequestIdentifier } from '../utils/requests.js'
import { areEqualUint8Arrays } from '../utils/typed-arrays.js'
import { haveSameActiveAddressSettings } from './backgroundUtils.js'
import { getSimulationSettingsSnapshot, type SimulationSettingsSnapshot } from './settings.js'
import { getActiveAddressForRequest } from './websiteActiveAddress.js'
import { getInterceptorTransactionStack, getPendingTransactionsAndWalletSendCallsBatchIds, getWalletSendCallsBatchIds, updatePendingTransactionsAndWalletSendCallsBatchIds } from './storageVariables.js'
import { hasAddressAccess } from './websiteAccessPolicy.js'

// EIP-5792 call batches are only supported in simulation mode, where an approved batch becomes separate transactions on the simulation stack, exactly as it was simulated:
// - wallet_sendCalls is validated, canonicalized, simulated and confirmed before its calls are added to the simulation stack. Simulation mode needs an Interceptor RPC to simulate the calls.
// - wallet_getCallsStatus is answered from the simulation stack. wallet_showCallsStatus would open bundle status UI, which the Interceptor does not have.
// - Signing mode refuses all three without forwarding them to the signer (see getSigningModeWalletCallsReply), so websites send each call with eth_sendTransaction, which the Interceptor reviews on its own.
// - wallet_getCapabilities is answered locally in every mode (see walletCapabilities.ts), so websites are never offered the signer's batch capabilities.

// Every call is prepared and simulated sequentially before the batch can be approved, so the batch size is kept to what wallets typically accept.
export const WALLET_SEND_CALLS_MAX_CALLS = 10

type WalletSendCallsError = { readonly code: number, readonly message: string }
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

const getWalletSendCallsIdentifierHash = (uniqueRequestIdentifier: UniqueRequestIdentifier, suffix: string) => keccak256(stringToBytes(`${ getUniqueRequestIdentifierString(uniqueRequestIdentifier) }|wallet_sendCalls|${ suffix }`))

export const getWalletSendCallsBatchId = (uniqueRequestIdentifier: UniqueRequestIdentifier) => getWalletSendCallsIdentifierHash(uniqueRequestIdentifier, 'batch')

export const getWalletSendCallTransactionIdentifier = (uniqueRequestIdentifier: UniqueRequestIdentifier, callIndex: number) => BigInt(getWalletSendCallsIdentifierHash(uniqueRequestIdentifier, `call:${ callIndex }`))

// Batch ids must be unique per website, because wallet_getCallsStatus looks them up by id and origin. One store of records answers both whether an id is in use and which calls wallet_getCallsStatus reports for it. A record is added in the storage write that adds its batch to the confirmation queue, and removed in the write that removes a batch that was not approved. Approval adds the batch's calls to the simulation stack, and that stack write alone commits it: a batch whose calls are on the stack is approved even if a restart interrupted the approval before it answered the website, so nothing has to be written atomically with the stack. A record is therefore in use while its batch is in the queue or any of its calls is on the stack, and each admission drops the records that are neither, so the store holds no more batches than the queue and the stack.
const isRecordOfBatchId = (websiteOrigin: string, batchId: string) => (record: WalletSendCallsBatchIdRecord) => record.websiteOrigin === websiteOrigin && record.batchId === batchId

const hasTransactionOnStack = (transactionIdentifiers: readonly bigint[], stack: InterceptorTransactionStack) => stack.operations.some((operation) => operation.type === 'Transaction' && transactionIdentifiers.includes(operation.preSimulationTransaction.transactionIdentifier))

const getWalletSendCallTransactionIdentifiers = (pendingBatch: PendingTransactionBatch) => pendingBatch.originalRequestParameters.params[0].calls.map((_call, callIndex) => getWalletSendCallTransactionIdentifier(pendingBatch.uniqueRequestIdentifier, callIndex))

// Whether the batch's approval was committed, that is, its calls are on the simulation stack.
export const isTransactionBatchOnStack = (pendingBatch: PendingTransactionBatch, stack: InterceptorTransactionStack) => hasTransactionOnStack(getWalletSendCallTransactionIdentifiers(pendingBatch), stack)

const isWalletSendCallsBatchIdRecordInUse = (record: WalletSendCallsBatchIdRecord, pendingTransactionsAndMessages: readonly PendingTransactionOrSignableMessage[], stack: InterceptorTransactionStack) =>
	pendingTransactionsAndMessages.some((pending) => pending.type === 'TransactionBatch' && isRecordOfBatchId(pending.website.websiteOrigin, pending.batchId)(record))
	|| hasTransactionOnStack(record.transactionIdentifiers, stack)

// Only admissions add records, and they run one at a time while holding the confirmation lock, so an id found free here stays free until the caller adds its batch.
export async function isWalletSendCallsIdInUse(websiteOrigin: string, batchId: string) {
	const { pendingTransactionsAndMessages, walletSendCallsBatchIds } = await getPendingTransactionsAndWalletSendCallsBatchIds()
	// Read after the queue: an approval adds a batch's calls to the stack before it removes the batch from the queue, so a batch that left the queue since the first read is on the stack.
	const stack = await getInterceptorTransactionStack()
	return walletSendCallsBatchIds.some((record) => isRecordOfBatchId(websiteOrigin, batchId)(record) && isWalletSendCallsBatchIdRecordInUse(record, pendingTransactionsAndMessages, stack))
}

export async function addPendingTransactionBatch(pendingBatch: PendingTransactionBatch) {
	const record = { websiteOrigin: pendingBatch.website.websiteOrigin, batchId: pendingBatch.batchId, transactionIdentifiers: getWalletSendCallTransactionIdentifiers(pendingBatch) }
	await updatePendingTransactionsAndWalletSendCallsBatchIds(async ({ pendingTransactionsAndMessages, walletSendCallsBatchIds }) => {
		const stack = await getInterceptorTransactionStack()
		return {
			pendingTransactionsAndMessages: [...pendingTransactionsAndMessages, pendingBatch],
			walletSendCallsBatchIds: [...walletSendCallsBatchIds.filter((existingRecord) => isWalletSendCallsBatchIdRecordInUse(existingRecord, pendingTransactionsAndMessages, stack)), record],
		}
	})
}

const withoutPendingBatch = (pendingTransactionsAndMessages: readonly PendingTransactionOrSignableMessage[], pendingBatch: PendingTransactionBatch) => pendingTransactionsAndMessages.filter((pending) => !doesUniqueRequestIdentifiersMatch(pending.uniqueRequestIdentifier, pendingBatch.uniqueRequestIdentifier))

// Removes a batch that was not approved from the confirmation queue and releases its id.
export async function releasePendingTransactionBatch(pendingBatch: PendingTransactionBatch) {
	const isRecordOfThisBatch = isRecordOfBatchId(pendingBatch.website.websiteOrigin, pendingBatch.batchId)
	await updatePendingTransactionsAndWalletSendCallsBatchIds(async ({ pendingTransactionsAndMessages, walletSendCallsBatchIds }) => ({
		pendingTransactionsAndMessages: withoutPendingBatch(pendingTransactionsAndMessages, pendingBatch),
		walletSendCallsBatchIds: walletSendCallsBatchIds.filter((record) => !isRecordOfThisBatch(record)),
	}))
}

// Removes an approved batch, whose calls are on the simulation stack, from the confirmation queue. Its id stays in use while its calls are on the stack.
export async function removeApprovedTransactionBatch(pendingBatch: PendingTransactionBatch) {
	await updatePendingTransactionsAndWalletSendCallsBatchIds(async ({ pendingTransactionsAndMessages, walletSendCallsBatchIds }) => ({
		pendingTransactionsAndMessages: withoutPendingBatch(pendingTransactionsAndMessages, pendingBatch),
		walletSendCallsBatchIds,
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

const approvalInvalidated = (code: number, reason: string): WalletSendCallsError => ({ code, message: `${ reason } Reject this batch and send the request again.` })

const activeAccountChangedError = approvalInvalidated(METAMASK_ERROR_NOT_AUTHORIZED, 'The active account changed after this batch was requested.')

// A batch is only prepared, simulated and visualized with the client of the network it was requested for. After a network switch its preview is kept unchanged, and approval is refused until the user switches back.
export const isEthereumClientOnBatchChain = (ethereum: EthereumClientService, pendingBatch: PendingTransactionBatch) => ethereum.getChainId() === pendingBatch.binding.chainId

type SimulatedPendingTransactionBatch = Exclude<PendingTransactionBatch, { readonly transactionOrMessageCreationStatus: 'Crafting' }>

// The same contract address can behave differently on another network, so every prepared call and the visualized simulation must come from the network of the canonical request. A failed batch simulation records no network, so it cannot be approved.
function isTransactionBatchPreviewOnRequestedChain(pendingBatch: SimulatedPendingTransactionBatch) {
	const requestedChainId = pendingBatch.originalRequestParameters.params[0].chainId
	const { popupVisualisation } = pendingBatch
	return requestedChainId === pendingBatch.binding.chainId
		&& popupVisualisation.statusCode === 'success'
		&& popupVisualisation.data.simulationState.rpcNetwork.chainId === requestedChainId
		&& pendingBatch.transactionsToSimulate.every((transactionToSimulate) => transactionToSimulate.success && transactionToSimulate.transaction.chainId === requestedChainId)
}

const getModeOrNetworkBindingError = (settings: Settings, binding: WalletSendCallsBinding) => {
	if (settings.activeRpcNetwork.chainId !== binding.chainId) return approvalInvalidated(EIP5792_ERROR_UNSUPPORTED_CHAIN_ID, 'The active network changed after this batch was requested.')
	// Batches are only added to the simulation stack, which signing mode does not use, and signing mode refuses new batches.
	if (!settings.simulationMode) return approvalInvalidated(METAMASK_ERROR_NOT_AUTHORIZED, 'The Interceptor switched to signing mode after this batch was requested.')
	return undefined
}

export type WalletSendCallsAccountLookup = { readonly snapshot: SimulationSettingsSnapshot, readonly activeAddress: AddressBookEntry | undefined }

// Looks up the active account with the settings of one snapshot. getWalletSendCallsBindingError then confirms against a later snapshot that those settings still hold.
export async function lookUpWalletSendCallsAccount(websiteTabConnections: WebsiteTabConnections, pendingBatch: PendingTransactionBatch): Promise<WalletSendCallsAccountLookup> {
	const tabId = pendingBatch.uniqueRequestIdentifier.requestSocket.tabId
	const snapshot = await getSimulationSettingsSnapshot()
	return { snapshot, activeAddress: await getActiveAddressForRequest(snapshot.settings, websiteTabConnections, tabId) }
}

// Checks the admission binding (network, simulation mode, active account and website access) against one settings snapshot, read after the account lookup. It awaits nothing, so a caller can write right after reading the snapshot, which makes the snapshot the point the approval takes effect: a change saved later counts as made after approval. The signer's accounts in the tab state are only read during the account lookup, which is acceptable because the wallet reports them on its own schedule, so a change landing just after that lookup cannot be told apart from one landing just after approval.
export function getWalletSendCallsBindingError(pendingBatch: PendingTransactionBatch, accountLookup: WalletSendCallsAccountLookup, latestSnapshot: SimulationSettingsSnapshot): WalletSendCallsError | undefined {
	const { binding } = pendingBatch
	const latestSettings = latestSnapshot.settings
	const settingsError = getModeOrNetworkBindingError(latestSettings, binding)
	if (settingsError !== undefined) return settingsError
	const { activeAddress } = accountLookup
	if (activeAddress === undefined || activeAddress.address !== binding.account || !haveSameActiveAddressSettings(accountLookup.snapshot.settings, latestSettings)) return activeAccountChangedError
	// The persisted website access decides alone. A connection's approval only mirrors it and is reconciled after an access change is saved, so it could still allow a website whose access was just revoked.
	if (hasAddressAccess(latestSettings.websiteAccess, binding.websiteOrigin, activeAddress) !== 'hasAccess') return approvalInvalidated(METAMASK_ERROR_NOT_AUTHORIZED, 'This website is no longer authorized to use the active account.')
	return undefined
}

// Re-checks the admission binding at approval time. Any change to the network, mode, account, website access or batch payload invalidates the approval.
export async function getWalletSendCallsApprovalError(
	websiteTabConnections: WebsiteTabConnections,
	ethereum: EthereumClientService,
	pendingBatch: SimulatedPendingTransactionBatch,
): Promise<WalletSendCallsError | undefined> {
	if (ethereum.getChainId() !== pendingBatch.binding.chainId) return approvalInvalidated(EIP5792_ERROR_UNSUPPORTED_CHAIN_ID, 'The active network changed after this batch was requested.')
	const accountLookup = await lookUpWalletSendCallsAccount(websiteTabConnections, pendingBatch)
	const bindingError = getWalletSendCallsBindingError(pendingBatch, accountLookup, await getSimulationSettingsSnapshot())
	if (bindingError !== undefined) return bindingError
	if (!isTransactionBatchPreviewOnRequestedChain(pendingBatch)) return approvalInvalidated(EIP5792_ERROR_UNSUPPORTED_CHAIN_ID, 'The batch preview was not simulated on the network the batch was requested for.')
	if (!doWalletSendCallsMatchSimulatedTransactions(pendingBatch.originalRequestParameters, pendingBatch.binding.account, pendingBatch.transactionsToSimulate)) return approvalInvalidated(JSON_RPC_ERROR_CODE_INVALID_PARAMS, 'The batch calls no longer match the simulated transactions.')
	return undefined
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
	const batchIdRecord = (await getWalletSendCallsBatchIds()).find(isRecordOfBatchId(websiteOrigin, id))
	if (batchIdRecord === undefined) return errorReply(request.method, unknownBundleIdError)
	const batchTransactions = currentState.simulatedBlocks
		.flatMap((block) => block.simulatedTransactions)
		.map((simulatedTransaction) => simulatedTransaction.preSimulationTransaction)
		.filter((transaction) => batchIdRecord.transactionIdentifiers.includes(transaction.transactionIdentifier))
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
