import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import type { SafeEntry } from '../types/addressBookTypes.js'
import type { SafeTx } from '../types/personal-message-definitions.js'
import type { SafeContractStateSnapshot } from '../types/safeTypes.js'
import type { OriginalSendRequestParameters } from '../types/JsonRpc-types.js'
import { getErrorMessage } from '../utils/caughtErrors.js'
import { modifyObject } from '../utils/typescript.js'
import { areEqualUint8Arrays } from '../utils/typed-arrays.js'
import { assertSafeContractStateUnchanged, createSafeContractValidationFailure, createSafeTransactionSigningRequest, isSafeContractValidationFailure, isSafeOwnerValidationFailure, validateSafeTransactionForSigning, type SafeOwnerValidator } from '../safe/safeCore.js'
import { areSafeExecutionSignerRequestsEqual, prepareSafeExecutionSignerRoute } from '../safe/safeExecutionRouting.js'
import { getUserAddressBookEntriesForChainIdMorePreciseFirst, updatePendingTransactionOrMessage } from './storageVariables.js'
import { createSafeSignerErrorStatus, type SafeSignerErrorStatus } from './safeSignerErrors.js'
import { getSafePendingFlow, type DirectSafeExecutionFlow, type SafeMessageCoSignFlow, type SafePendingFlow, type SafeProposalFlow } from './safePendingFlow.js'

export const SAFE_SIGNER_SELECTION_ERROR_CODE = -32010

export type SafeMessageCoSignContext = {
	readonly safeEntry: SafeEntry
	readonly safeSignerAddress: bigint
	readonly safeTx: SafeTx
	readonly safeTxHash: bigint
	readonly ownerValidator: SafeOwnerValidator
}

export type SafeSignerSelectionRefreshResult =
	| { readonly status: 'unchanged', readonly pending: PendingTransactionOrSignableMessage }
	| { readonly status: 'refreshed', readonly pending: PendingTransactionOrSignableMessage }
	| { readonly status: 'blocked', readonly approvalStatus: SafeSignerErrorStatus }

export type SafeSignerSelectionRefreshPersistence = {
	readonly refreshRequired: boolean
	readonly refreshResult: SafeSignerSelectionRefreshResult
	readonly persisted: boolean
	readonly persistedPending: PendingTransactionOrSignableMessage | undefined
}

export async function getCurrentSafeEntry(ethereum: EthereumClientService, safeAddress: bigint) {
	return (await getCurrentSafeEntryAndAddressBookEntries(ethereum, safeAddress)).safeEntry
}

export async function getCurrentSafeEntryAndAddressBookEntries(ethereum: EthereumClientService, safeAddress: bigint) {
	const addressBookEntries = await getUserAddressBookEntriesForChainIdMorePreciseFirst(ethereum.getChainId())
	const safeEntry = addressBookEntries.find((entry) => entry.type === 'safe' && entry.address === safeAddress)
	if (safeEntry?.type !== 'safe') throw createSafeContractValidationFailure('The Gnosis Safe is no longer configured in the address book.')
	return { safeEntry, addressBookEntries }
}

async function refreshSafeTransactionSignerSelection(
	ethereum: EthereumClientService,
	flow: SafeProposalFlow,
	selectedSigner: bigint,
) {
	const pending = flow.pending
	const executionGasLimit = pending.safeTransaction.executionGasLimit ?? (
		'transactionToSimulate' in pending && pending.transactionToSimulate.success
			? pending.transactionToSimulate.transaction.gas
			: undefined
	)
	if (executionGasLimit === undefined) throw createSafeContractValidationFailure('The pending Gnosis Safe proposal is missing its execution gas limit.')
	try {
		const safeTransaction = await createSafeTransactionSigningRequest(
			ethereum,
			pending.safeTransaction.safeAddress,
			selectedSigner,
			{
				to: pending.safeTransaction.safeTx.message.to,
				value: pending.safeTransaction.safeTx.message.value,
				input: pending.safeTransaction.safeTx.message.data,
				gas: executionGasLimit,
			},
			pending.safeTransaction.safeTx.message.nonce,
		)
		const reviewedSafeState = pending.safeTransaction.reviewedSafeState
		if (reviewedSafeState === undefined || safeTransaction.reviewedSafeState === undefined) {
			throw createSafeContractValidationFailure('Review this Gnosis Safe proposal again so its current owners, threshold, nonce, and signer can be verified.')
		}
		assertSafeContractStateUnchanged(reviewedSafeState, safeTransaction.reviewedSafeState)
		return { safeTransaction, approvalStatus: { status: 'WaitingForUser' as const } }
	} catch (error) {
		if (!isSafeOwnerValidationFailure(error)) throw error
		return {
			safeTransaction: pending.safeTransaction,
			approvalStatus: createSafeSignerErrorStatus(
				getErrorMessage(error) ?? 'Select a current Gnosis Safe owner in the signer wallet before signing.',
				SAFE_SIGNER_SELECTION_ERROR_CODE,
			),
		}
	}
}

export async function getSafeMessageCoSignContext(
	ethereum: EthereumClientService,
	flow: SafeMessageCoSignFlow,
	safeSignerOverride?: bigint,
): Promise<SafeMessageCoSignContext | undefined> {
	const pending = flow.pending
	if (
		pending.simulationMode
		|| pending.transactionOrMessageCreationStatus !== 'Simulated'
		|| pending.visualizedPersonalSignRequest.type !== 'SafeTx'
		|| pending.originalRequestParameters.method !== 'eth_signTypedData_v4'
	) return undefined
	const safeTx = pending.visualizedPersonalSignRequest.message
	const reviewedSnapshot = pending.safeMessageCoSignSnapshot
	const [requestedAccount] = pending.originalRequestParameters.params
	if (requestedAccount !== pending.activeAddress || safeTx.domain.verifyingContract !== pending.activeAddress) {
		throw createSafeContractValidationFailure('The Gnosis Safe transaction signing account does not match the active Gnosis Safe.')
	}
	const safeEntry = await getCurrentSafeEntry(ethereum, pending.activeAddress)
	if (safeEntry.safeVersion === undefined) {
		throw createSafeContractValidationFailure('Re-save the active Gnosis Safe address-book entry to verify and record its current Gnosis Safe version before co-signing.')
	}
	if (reviewedSnapshot.safeAddress !== safeEntry.address) throw createSafeContractValidationFailure('The configured Gnosis Safe changed after this co-signing confirmation opened.')
	const { safeTxHash, safeState, ownerValidator } = await validateSafeTransactionForSigning(
		ethereum,
		safeEntry.address,
		safeSignerOverride ?? reviewedSnapshot.safeSignerAddress,
		safeTx,
		safeEntry.safeVersion,
	)
	if (safeTxHash !== reviewedSnapshot.safeTxHash) throw createSafeContractValidationFailure('The Gnosis Safe transaction changed after this co-signing confirmation opened.')
	assertSafeContractStateUnchanged(reviewedSnapshot.reviewedSafeState, safeState)
	return { safeEntry, safeSignerAddress: safeSignerOverride ?? reviewedSnapshot.safeSignerAddress, safeTx, safeTxHash, ownerValidator }
}

async function refreshSafeMessageCoSignSignerSelection(
	ethereum: EthereumClientService,
	flow: SafeMessageCoSignFlow,
	selectedSigner: bigint,
) {
	const pending = flow.pending
	if (pending.safeMessageCoSignSnapshot.safeSignerAddress === selectedSigner) return pending
	await getSafeMessageCoSignContext(ethereum, flow, selectedSigner)
	return modifyObject(pending, {
		safeMessageCoSignSnapshot: modifyObject(pending.safeMessageCoSignSnapshot, { safeSignerAddress: selectedSigner }),
		approvalStatus: { status: 'WaitingForUser' as const },
	})
}

export async function refreshSafeExecutionSignerSelection(
	ethereum: EthereumClientService,
	flow: DirectSafeExecutionFlow,
	selectedSigner?: bigint,
): Promise<PendingTransactionOrSignableMessage | undefined> {
	const pending = flow.pending
	if (pending.simulationMode) return undefined
	const originalRequest = pending.safeExecutionOriginalRequestParameters
	const reviewedSafeState = pending.safeExecutionReviewedSafeState
	if (reviewedSafeState === undefined) throw createSafeContractValidationFailure('Review this Gnosis Safe execution again so its current owner and threshold state can be verified.')
	const safeAddress = originalRequest.params[0].from
	if (safeAddress === undefined) throw createSafeContractValidationFailure('The original Gnosis Safe execution request is missing its Gnosis Safe address.')
	const safeEntry = await getCurrentSafeEntry(ethereum, safeAddress)
	const refreshedRoute = await prepareSafeExecutionSignerRoute(ethereum, originalRequest, safeEntry, selectedSigner ?? pending.safeExecutionSignerAddress)
	if (refreshedRoute === undefined) throw createSafeContractValidationFailure('The configured Gnosis Safe execution route is no longer available.')
	assertSafeContractStateUnchanged(reviewedSafeState, refreshedRoute.safeState)
	if (selectedSigner === undefined && (
		pending.originalRequestParameters.method !== 'eth_sendTransaction'
		|| !areSafeExecutionSignerRequestsEqual(pending.originalRequestParameters, refreshedRoute.transactionParams)
	)) throw createSafeContractValidationFailure('The Gnosis Safe execution changed after this confirmation opened. Review the refreshed transaction before submitting it.')
	return modifyObject(pending, {
		activeAddress: refreshedRoute.executor,
		originalRequestParameters: refreshedRoute.transactionParams,
		safeExecutionSignerAddress: refreshedRoute.executor,
		safeExecutionReviewedSafeState: refreshedRoute.safeState,
		approvalStatus: { status: 'WaitingForUser' as const },
	})
}

export function handleSafeExecutionRefreshFailure(error: unknown): { readonly status: 'blocked', readonly approvalStatus: SafeSignerErrorStatus } {
	if (!isSafeContractValidationFailure(error) && !isSafeOwnerValidationFailure(error)) throw error
	return {
		status: 'blocked',
		approvalStatus: createSafeSignerErrorStatus(
			`Gnosis Safe execution could not be prepared: ${ getErrorMessage(error) ?? 'The current Gnosis Safe state could not be validated.' }`,
			SAFE_SIGNER_SELECTION_ERROR_CODE,
		),
	}
}

async function handleSafeSignerSelectionRefreshFailure(
	error: unknown,
	messagePrefix: string | undefined,
	fallbackMessage: string,
): Promise<{ readonly status: 'blocked', readonly approvalStatus: SafeSignerErrorStatus }> {
	return {
		status: 'blocked',
		approvalStatus: createSafeSignerErrorStatus(
			messagePrefix === undefined
				? getErrorMessage(error) ?? fallbackMessage
				: `${ messagePrefix }: ${ getErrorMessage(error) ?? fallbackMessage }`,
			SAFE_SIGNER_SELECTION_ERROR_CODE,
		),
	}
}

async function refreshSafeProposalSignerSelection(
	ethereum: EthereumClientService,
	flow: SafeProposalFlow,
	selectedSigner: bigint,
): Promise<SafeSignerSelectionRefreshResult> {
	const pending = flow.pending
	try {
		const refreshedTransaction = await refreshSafeTransactionSignerSelection(ethereum, flow, selectedSigner)
		if (refreshedTransaction.approvalStatus.status === 'SignerError') {
			return { status: 'blocked', approvalStatus: refreshedTransaction.approvalStatus }
		}
		return { status: 'refreshed', pending: modifyObject(pending, refreshedTransaction) }
		} catch(error) {
			if (!isSafeContractValidationFailure(error) && !isSafeOwnerValidationFailure(error)) throw error
			return await handleSafeSignerSelectionRefreshFailure(
			error,
			'Gnosis Safe proposal could not be prepared',
			'The wallet-selected Safe owner could not be validated.',
			)
	}
}

async function refreshSafeCoSignSignerSelection(
	ethereum: EthereumClientService,
	flow: SafeMessageCoSignFlow,
	selectedSigner: bigint,
): Promise<SafeSignerSelectionRefreshResult> {
	const pending = flow.pending
	try {
		const refreshedCoSign = await refreshSafeMessageCoSignSignerSelection(ethereum, flow, selectedSigner)
		return refreshedCoSign === pending
			? { status: 'unchanged', pending }
			: { status: 'refreshed', pending: refreshedCoSign }
	} catch(error) {
		if (!isSafeContractValidationFailure(error) && !isSafeOwnerValidationFailure(error)) throw error
		return await handleSafeSignerSelectionRefreshFailure(
			error,
			undefined,
			'Select a current Gnosis Safe owner in the signer wallet before co-signing.',
		)
	}
}

export async function refreshSafeSignerSelection(
	ethereum: EthereumClientService,
	flow: SafePendingFlow,
	selectedSigner: bigint,
): Promise<SafeSignerSelectionRefreshResult> {
	const pending = flow.pending
	switch (flow.kind) {
		case 'directExecution': {
			try {
				const refreshedExecution = await refreshSafeExecutionSignerSelection(ethereum, flow, selectedSigner)
				return refreshedExecution === undefined
					? { status: 'unchanged', pending }
					: { status: 'refreshed', pending: refreshedExecution }
			} catch(error) {
				return handleSafeExecutionRefreshFailure(error)
			}
		}
		case 'messageCoSign': return await refreshSafeCoSignSignerSelection(ethereum, flow, selectedSigner)
		case 'proposal': return await refreshSafeProposalSignerSelection(ethereum, flow, selectedSigner)
	}
}

function shouldRefreshSafeSignerSelection(flow: SafePendingFlow, selectedSigner: bigint) {
	if (flow.pending.approvalStatus.status === 'WaitingForSigner') return false
	switch (flow.kind) {
		case 'directExecution': return flow.pending.safeExecutionSignerAddress !== selectedSigner
		case 'messageCoSign': return flow.pending.safeMessageCoSignSnapshot.safeSignerAddress !== selectedSigner
		case 'proposal': return (
			flow.pending.approvalStatus.status === 'WaitingForUser'
			|| flow.pending.approvalStatus.status === 'SignerError' && flow.pending.approvalStatus.code === SAFE_SIGNER_SELECTION_ERROR_CODE
		) && (
			flow.pending.safeTransaction.safeSignerAddress !== selectedSigner
			|| flow.pending.approvalStatus.status === 'SignerError'
		)
	}
}

function isSameSafeSignerError(pending: PendingTransactionOrSignableMessage, refreshResult: SafeSignerSelectionRefreshResult) {
	return refreshResult.status === 'blocked'
		&& pending.approvalStatus.status === 'SignerError'
		&& pending.approvalStatus.code === refreshResult.approvalStatus.code
		&& pending.approvalStatus.message === refreshResult.approvalStatus.message
}

function mergeSafeSignerSelectionRefresh(
	current: PendingTransactionOrSignableMessage,
	refreshed: PendingTransactionOrSignableMessage,
): PendingTransactionOrSignableMessage {
	const currentFlow = getSafePendingFlow(current)
	const refreshedFlow = getSafePendingFlow(refreshed)
	if (currentFlow === undefined || refreshedFlow === undefined || currentFlow.kind !== refreshedFlow.kind) return current
	if (currentFlow.kind === 'messageCoSign' && refreshedFlow.kind === 'messageCoSign') return modifyObject(currentFlow.pending, {
		safeMessageCoSignSnapshot: refreshedFlow.pending.safeMessageCoSignSnapshot,
		approvalStatus: refreshedFlow.pending.approvalStatus,
	})
	if (currentFlow.kind === 'directExecution' && refreshedFlow.kind === 'directExecution') return modifyObject(currentFlow.pending, {
		activeAddress: refreshedFlow.pending.activeAddress,
		originalRequestParameters: refreshedFlow.pending.originalRequestParameters,
		safeExecutionSignerAddress: refreshedFlow.pending.safeExecutionSignerAddress,
		safeExecutionReviewedSafeState: refreshedFlow.pending.safeExecutionReviewedSafeState,
		approvalStatus: refreshedFlow.pending.approvalStatus,
		...refreshedFlow.pending.transactionOrMessageCreationStatus === 'Simulated' || refreshedFlow.pending.transactionOrMessageCreationStatus === 'FailedToSimulate'
			? {
				transactionOrMessageCreationStatus: refreshedFlow.pending.transactionOrMessageCreationStatus,
				transactionToSimulate: refreshedFlow.pending.transactionToSimulate,
				popupVisualisation: refreshedFlow.pending.popupVisualisation,
			}
			: {},
	})
	if (currentFlow.kind === 'proposal' && refreshedFlow.kind === 'proposal') return modifyObject(currentFlow.pending, {
		safeTransaction: refreshedFlow.pending.safeTransaction,
		approvalStatus: refreshedFlow.pending.approvalStatus,
	})
	return current
}

type RefreshDirectSafeExecutionSimulation = (
	pending: PendingTransactionOrSignableMessage,
) => Promise<PendingTransactionOrSignableMessage>

function areSafeContractStateSnapshotsEqual(first: SafeContractStateSnapshot | undefined, second: SafeContractStateSnapshot | undefined) {
	if (first === undefined || second === undefined) return first === second
	return first.version === second.version
		&& first.nonce === second.nonce
		&& first.threshold === second.threshold
		&& first.owners.length === second.owners.length
		&& first.owners.every((owner, index) => owner === second.owners[index])
}

function areOriginalSendRequestsEqual(first: OriginalSendRequestParameters, second: OriginalSendRequestParameters) {
	if (first.method === 'eth_sendTransaction' && second.method === 'eth_sendTransaction') {
		return areSafeExecutionSignerRequestsEqual(first, second)
	}
	if (first.method === 'eth_sendRawTransaction' && second.method === 'eth_sendRawTransaction') {
		return areEqualUint8Arrays(first.params[0], second.params[0])
	}
	return false
}

function pendingSafeRefreshBaseMatches(
	current: PendingTransactionOrSignableMessage,
	refreshBase: PendingTransactionOrSignableMessage,
) {
	const currentFlow = getSafePendingFlow(current)
	const refreshBaseFlow = getSafePendingFlow(refreshBase)
	if (currentFlow === undefined || refreshBaseFlow === undefined || currentFlow.kind !== refreshBaseFlow.kind) return false
	if (currentFlow.kind === 'messageCoSign' && refreshBaseFlow.kind === 'messageCoSign') {
		const currentSnapshot = currentFlow.pending.safeMessageCoSignSnapshot
		const baseSnapshot = refreshBaseFlow.pending.safeMessageCoSignSnapshot
		return currentSnapshot.safeAddress === baseSnapshot.safeAddress
			&& currentSnapshot.safeSignerAddress === baseSnapshot.safeSignerAddress
			&& currentSnapshot.safeTxHash === baseSnapshot.safeTxHash
			&& areSafeContractStateSnapshotsEqual(currentSnapshot.reviewedSafeState, baseSnapshot.reviewedSafeState)
	}
	if (currentFlow.kind === 'directExecution' && refreshBaseFlow.kind === 'directExecution') {
		return areSafeExecutionSignerRequestsEqual(currentFlow.pending.safeExecutionOriginalRequestParameters, refreshBaseFlow.pending.safeExecutionOriginalRequestParameters)
			&& currentFlow.pending.originalRequestParameters.method === 'eth_sendTransaction'
			&& refreshBaseFlow.pending.originalRequestParameters.method === 'eth_sendTransaction'
			&& areSafeExecutionSignerRequestsEqual(currentFlow.pending.originalRequestParameters, refreshBaseFlow.pending.originalRequestParameters)
			&& currentFlow.pending.safeExecutionSignerAddress === refreshBaseFlow.pending.safeExecutionSignerAddress
			&& areSafeContractStateSnapshotsEqual(currentFlow.pending.safeExecutionReviewedSafeState, refreshBaseFlow.pending.safeExecutionReviewedSafeState)
	}
	if (currentFlow.kind !== 'proposal' || refreshBaseFlow.kind !== 'proposal') return false
	const currentSafeTransaction = currentFlow.pending.safeTransaction
	const baseSafeTransaction = refreshBaseFlow.pending.safeTransaction
	return currentSafeTransaction.safeAddress === baseSafeTransaction.safeAddress
		&& currentSafeTransaction.safeTxHash === baseSafeTransaction.safeTxHash
		&& currentSafeTransaction.safeSignerAddress === baseSafeTransaction.safeSignerAddress
		&& currentSafeTransaction.executionGasLimit === baseSafeTransaction.executionGasLimit
		&& areSafeContractStateSnapshotsEqual(currentSafeTransaction.reviewedSafeState, baseSafeTransaction.reviewedSafeState)
		&& areOriginalSendRequestsEqual(currentFlow.pending.originalRequestParameters, refreshBaseFlow.pending.originalRequestParameters)
}

export async function refreshAndPersistSafeSignerSelection(
	ethereum: EthereumClientService,
	pending: PendingTransactionOrSignableMessage,
	selectedSigner: bigint,
	refreshDirectSafeExecutionSimulation: RefreshDirectSafeExecutionSimulation,
): Promise<SafeSignerSelectionRefreshPersistence> {
	const flow = getSafePendingFlow(pending)
	if (flow === undefined || !shouldRefreshSafeSignerSelection(flow, selectedSigner)) {
		return {
			refreshRequired: false,
			refreshResult: { status: 'unchanged', pending },
			persisted: false,
			persistedPending: undefined,
		}
	}

	let refreshResult = await refreshSafeSignerSelection(ethereum, flow, selectedSigner)
	if (
		refreshResult.status === 'refreshed'
		&& flow.kind === 'directExecution'
	) {
		try {
			refreshResult = {
				status: 'refreshed',
				pending: await refreshDirectSafeExecutionSimulation(refreshResult.pending),
			}
		} catch(error) {
			if (!isSafeContractValidationFailure(error) && !isSafeOwnerValidationFailure(error)) throw error
			refreshResult = handleSafeExecutionRefreshFailure(error)
		}
	}

	if (refreshResult.status === 'unchanged' || isSameSafeSignerError(pending, refreshResult)) {
		return { refreshRequired: true, refreshResult, persisted: false, persistedPending: undefined }
	}
	let persistedPending: PendingTransactionOrSignableMessage | undefined
	await updatePendingTransactionOrMessage(pending.uniqueRequestIdentifier, async (current) => {
		const currentFlow = getSafePendingFlow(current)
		if (currentFlow === undefined || !shouldRefreshSafeSignerSelection(currentFlow, selectedSigner)) return current
		if (!pendingSafeRefreshBaseMatches(current, pending)) return current
		persistedPending = refreshResult.status === 'refreshed'
			? mergeSafeSignerSelectionRefresh(current, refreshResult.pending)
			: modifyObject(current, { approvalStatus: refreshResult.approvalStatus })
		return persistedPending
	})
	return { refreshRequired: true, refreshResult, persisted: persistedPending !== undefined, persistedPending }
}
