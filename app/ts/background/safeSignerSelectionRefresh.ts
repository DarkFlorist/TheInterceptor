import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import type { SafeEntry } from '../types/addressBookTypes.js'
import type { SafeTx } from '../types/personal-message-definitions.js'
import type { SafeContractStateSnapshot } from '../types/safeTypes.js'
import type { OriginalSendRequestParameters } from '../types/JsonRpc-types.js'
import { getErrorMessage } from '../utils/caughtErrors.js'
import { reportUnexpectedError } from '../utils/errors.js'
import { modifyObject } from '../utils/typescript.js'
import { areEqualUint8Arrays } from '../utils/typed-arrays.js'
import { assertSafeContractStateUnchanged, createSafeContractValidationFailure, createSafeTransactionSigningRequest, isSafeOwnerValidationFailure, validateSafeTransactionForSigning, type SafeOwnerValidator } from '../safe/safeCore.js'
import { areSafeExecutionSignerRequestsEqual, prepareSafeExecutionSignerRoute } from '../safe/safeExecutionRouting.js'
import { getUserAddressBookEntriesForChainIdMorePreciseFirst, updatePendingTransactionOrMessage } from './storageVariables.js'
import { createSafeSignerErrorStatus, type SafeSignerErrorStatus } from './safeSignerErrors.js'

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
	pending: PendingTransactionOrSignableMessage,
	selectedSigner: bigint,
) {
	if (pending.type !== 'Transaction' || pending.safeTransaction === undefined) return undefined
	const executionGasLimit = pending.safeTransaction.executionGasLimit ?? (
		'transactionToSimulate' in pending && pending.transactionToSimulate.success
			? pending.transactionToSimulate.transaction.gas
			: undefined
	)
	if (executionGasLimit === undefined) throw new Error('The pending Gnosis Safe proposal is missing its execution gas limit.')
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
	pending: PendingTransactionOrSignableMessage,
	safeSignerOverride?: bigint,
): Promise<SafeMessageCoSignContext | undefined> {
	if (
		pending.type !== 'SignableMessage'
		|| pending.simulationMode
		|| pending.transactionOrMessageCreationStatus !== 'Simulated'
		|| pending.visualizedPersonalSignRequest.type !== 'SafeTx'
		|| pending.safeMessageCoSignSnapshot === undefined
		|| pending.originalRequestParameters.method !== 'eth_signTypedData_v4'
	) return undefined
	const safeTx = pending.visualizedPersonalSignRequest.message
	const reviewedSnapshot = pending.safeMessageCoSignSnapshot
	const [requestedAccount] = pending.originalRequestParameters.params
	if (requestedAccount !== pending.activeAddress || safeTx.domain.verifyingContract !== pending.activeAddress) {
		throw new Error('The Gnosis Safe transaction signing account does not match the active Gnosis Safe.')
	}
	const safeEntry = await getCurrentSafeEntry(ethereum, pending.activeAddress)
	if (safeEntry.safeVersion === undefined) {
		throw new Error('Re-save the active Gnosis Safe address-book entry to verify and record its current Gnosis Safe version before co-signing.')
	}
	if (reviewedSnapshot.safeAddress !== safeEntry.address) throw new Error('The configured Gnosis Safe changed after this co-signing confirmation opened.')
	const { safeTxHash, safeState, ownerValidator } = await validateSafeTransactionForSigning(
		ethereum,
		safeEntry.address,
		safeSignerOverride ?? reviewedSnapshot.safeSignerAddress,
		safeTx,
		safeEntry.safeVersion,
	)
	if (safeTxHash !== reviewedSnapshot.safeTxHash) throw new Error('The Gnosis Safe transaction changed after this co-signing confirmation opened.')
	assertSafeContractStateUnchanged(reviewedSnapshot.reviewedSafeState, safeState)
	return { safeEntry, safeSignerAddress: safeSignerOverride ?? reviewedSnapshot.safeSignerAddress, safeTx, safeTxHash, ownerValidator }
}

async function refreshSafeMessageCoSignSignerSelection(
	ethereum: EthereumClientService,
	pending: PendingTransactionOrSignableMessage,
	selectedSigner: bigint,
) {
	if (pending.type !== 'SignableMessage' || pending.safeMessageCoSignSnapshot === undefined) return undefined
	if (pending.safeMessageCoSignSnapshot.safeSignerAddress === selectedSigner) return pending
	await getSafeMessageCoSignContext(ethereum, pending, selectedSigner)
	return modifyObject(pending, {
		safeMessageCoSignSnapshot: modifyObject(pending.safeMessageCoSignSnapshot, { safeSignerAddress: selectedSigner }),
		approvalStatus: { status: 'WaitingForUser' as const },
	})
}

export async function refreshSafeExecutionSignerSelection(
	ethereum: EthereumClientService,
	pending: PendingTransactionOrSignableMessage,
	selectedSigner?: bigint,
): Promise<PendingTransactionOrSignableMessage | undefined> {
	if (
		pending.type !== 'Transaction'
		|| pending.simulationMode
		|| pending.safeExecutionOriginalRequestParameters === undefined
	) return undefined
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

async function reportUnexpectedDirectSafeExecutionRecovery(error: unknown) {
	await reportUnexpectedError(error, {
		source: 'direct_safe_execution_recovery',
		code: 'direct_safe_execution_recovery_failed',
		displayMessage: 'Failed to recover the direct Gnosis Safe execution.',
	})
}

export async function handleSafeExecutionRefreshFailure(error: unknown): Promise<{ readonly status: 'blocked', readonly approvalStatus: SafeSignerErrorStatus }> {
	await reportUnexpectedDirectSafeExecutionRecovery(error)
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
	source: 'safe_proposal_signer_refresh' | 'safe_cosign_signer_refresh',
): Promise<{ readonly status: 'blocked', readonly approvalStatus: SafeSignerErrorStatus }> {
	await reportUnexpectedError(error, {
		source,
		code: `${ source }_failed`,
		displayMessage: `${ messagePrefix ?? 'Gnosis Safe signer refresh failed' } due to an unexpected error.`,
	})
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
	pending: PendingTransactionOrSignableMessage,
	selectedSigner: bigint,
): Promise<SafeSignerSelectionRefreshResult> {
	try {
		const refreshedTransaction = await refreshSafeTransactionSignerSelection(ethereum, pending, selectedSigner)
		if (refreshedTransaction === undefined) return { status: 'unchanged', pending }
		if (refreshedTransaction.approvalStatus.status === 'SignerError') {
			return { status: 'blocked', approvalStatus: refreshedTransaction.approvalStatus }
		}
		return { status: 'refreshed', pending: modifyObject(pending, refreshedTransaction) }
	} catch(error) {
		return await handleSafeSignerSelectionRefreshFailure(
			error,
			'Gnosis Safe proposal could not be prepared',
			'The wallet-selected Safe owner could not be validated.',
			'safe_proposal_signer_refresh',
		)
	}
}

async function refreshSafeCoSignSignerSelection(
	ethereum: EthereumClientService,
	pending: PendingTransactionOrSignableMessage,
	selectedSigner: bigint,
): Promise<SafeSignerSelectionRefreshResult> {
	try {
		const refreshedCoSign = await refreshSafeMessageCoSignSignerSelection(ethereum, pending, selectedSigner)
		return refreshedCoSign === undefined || refreshedCoSign === pending
			? { status: 'unchanged', pending }
			: { status: 'refreshed', pending: refreshedCoSign }
	} catch(error) {
		return await handleSafeSignerSelectionRefreshFailure(
			error,
			undefined,
			'Select a current Gnosis Safe owner in the signer wallet before co-signing.',
			'safe_cosign_signer_refresh',
		)
	}
}

export async function refreshSafeSignerSelection(
	ethereum: EthereumClientService,
	pending: PendingTransactionOrSignableMessage,
	selectedSigner: bigint,
): Promise<SafeSignerSelectionRefreshResult> {
	if (pending.type === 'Transaction' && pending.safeExecutionOriginalRequestParameters !== undefined) {
		try {
			const refreshedExecution = await refreshSafeExecutionSignerSelection(ethereum, pending, selectedSigner)
			return refreshedExecution === undefined
				? { status: 'unchanged', pending }
				: { status: 'refreshed', pending: refreshedExecution }
		} catch(error) {
			return await handleSafeExecutionRefreshFailure(error)
		}
	}
	if (pending.type === 'SignableMessage' && pending.safeMessageCoSignSnapshot !== undefined) {
		return await refreshSafeCoSignSignerSelection(ethereum, pending, selectedSigner)
	}
	if (pending.type === 'Transaction' && pending.safeTransaction !== undefined) {
		return await refreshSafeProposalSignerSelection(ethereum, pending, selectedSigner)
	}
	return { status: 'unchanged', pending }
}

function shouldRefreshSafeSignerSelection(pending: PendingTransactionOrSignableMessage, selectedSigner: bigint) {
	if (pending.approvalStatus.status === 'WaitingForSigner') return false
	if (pending.type === 'Transaction' && pending.safeExecutionOriginalRequestParameters !== undefined) {
		return pending.safeExecutionSignerAddress !== selectedSigner
	}
	if (pending.type === 'SignableMessage' && pending.safeMessageCoSignSnapshot !== undefined) {
		return pending.safeMessageCoSignSnapshot.safeSignerAddress !== selectedSigner
	}
	if (pending.type !== 'Transaction' || pending.safeTransaction === undefined) return false
	return (
		pending.approvalStatus.status === 'WaitingForUser'
		|| pending.approvalStatus.status === 'SignerError' && pending.approvalStatus.code === SAFE_SIGNER_SELECTION_ERROR_CODE
	) && (
		pending.safeTransaction.safeSignerAddress !== selectedSigner
		|| pending.approvalStatus.status === 'SignerError'
	)
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
	if (
		current.type === 'SignableMessage'
		&& refreshed.type === 'SignableMessage'
		&& current.safeMessageCoSignSnapshot !== undefined
		&& refreshed.safeMessageCoSignSnapshot !== undefined
	) return modifyObject(current, {
		safeMessageCoSignSnapshot: refreshed.safeMessageCoSignSnapshot,
		approvalStatus: refreshed.approvalStatus,
	})
	if (
		current.type === 'Transaction'
		&& refreshed.type === 'Transaction'
		&& current.safeExecutionOriginalRequestParameters !== undefined
		&& refreshed.safeExecutionOriginalRequestParameters !== undefined
	) return modifyObject(current, {
		activeAddress: refreshed.activeAddress,
		originalRequestParameters: refreshed.originalRequestParameters,
		safeExecutionSignerAddress: refreshed.safeExecutionSignerAddress,
		safeExecutionReviewedSafeState: refreshed.safeExecutionReviewedSafeState,
		approvalStatus: refreshed.approvalStatus,
		...refreshed.transactionOrMessageCreationStatus === 'Simulated' || refreshed.transactionOrMessageCreationStatus === 'FailedToSimulate'
			? {
				transactionOrMessageCreationStatus: refreshed.transactionOrMessageCreationStatus,
				transactionToSimulate: refreshed.transactionToSimulate,
				popupVisualisation: refreshed.popupVisualisation,
			}
			: {},
	})
	if (
		current.type === 'Transaction'
		&& refreshed.type === 'Transaction'
		&& current.safeTransaction !== undefined
		&& refreshed.safeTransaction !== undefined
	) return modifyObject(current, {
		safeTransaction: refreshed.safeTransaction,
		approvalStatus: refreshed.approvalStatus,
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
	if (current.type !== refreshBase.type) return false
	if (current.type === 'SignableMessage' && refreshBase.type === 'SignableMessage') {
		const currentSnapshot = current.safeMessageCoSignSnapshot
		const baseSnapshot = refreshBase.safeMessageCoSignSnapshot
		if (currentSnapshot === undefined || baseSnapshot === undefined) return currentSnapshot === baseSnapshot
		return currentSnapshot.safeAddress === baseSnapshot.safeAddress
			&& currentSnapshot.safeSignerAddress === baseSnapshot.safeSignerAddress
			&& currentSnapshot.safeTxHash === baseSnapshot.safeTxHash
			&& areSafeContractStateSnapshotsEqual(currentSnapshot.reviewedSafeState, baseSnapshot.reviewedSafeState)
	}
	if (current.type !== 'Transaction' || refreshBase.type !== 'Transaction') return false
	if (current.safeExecutionOriginalRequestParameters !== undefined || refreshBase.safeExecutionOriginalRequestParameters !== undefined) {
		return current.safeExecutionOriginalRequestParameters !== undefined
			&& refreshBase.safeExecutionOriginalRequestParameters !== undefined
			&& areSafeExecutionSignerRequestsEqual(current.safeExecutionOriginalRequestParameters, refreshBase.safeExecutionOriginalRequestParameters)
			&& current.originalRequestParameters.method === 'eth_sendTransaction'
			&& refreshBase.originalRequestParameters.method === 'eth_sendTransaction'
			&& areSafeExecutionSignerRequestsEqual(current.originalRequestParameters, refreshBase.originalRequestParameters)
			&& current.safeExecutionSignerAddress === refreshBase.safeExecutionSignerAddress
			&& areSafeContractStateSnapshotsEqual(current.safeExecutionReviewedSafeState, refreshBase.safeExecutionReviewedSafeState)
	}
	const currentSafeTransaction = current.safeTransaction
	const baseSafeTransaction = refreshBase.safeTransaction
	if (currentSafeTransaction === undefined || baseSafeTransaction === undefined) return currentSafeTransaction === baseSafeTransaction
	return currentSafeTransaction.safeAddress === baseSafeTransaction.safeAddress
		&& currentSafeTransaction.safeTxHash === baseSafeTransaction.safeTxHash
		&& currentSafeTransaction.safeSignerAddress === baseSafeTransaction.safeSignerAddress
		&& currentSafeTransaction.executionGasLimit === baseSafeTransaction.executionGasLimit
		&& areSafeContractStateSnapshotsEqual(currentSafeTransaction.reviewedSafeState, baseSafeTransaction.reviewedSafeState)
		&& areOriginalSendRequestsEqual(current.originalRequestParameters, refreshBase.originalRequestParameters)
}

export async function refreshAndPersistSafeSignerSelection(
	ethereum: EthereumClientService,
	pending: PendingTransactionOrSignableMessage,
	selectedSigner: bigint,
	refreshDirectSafeExecutionSimulation: RefreshDirectSafeExecutionSimulation,
): Promise<SafeSignerSelectionRefreshPersistence> {
	if (!shouldRefreshSafeSignerSelection(pending, selectedSigner)) {
		return {
			refreshRequired: false,
			refreshResult: { status: 'unchanged', pending },
			persisted: false,
			persistedPending: undefined,
		}
	}

	let refreshResult = await refreshSafeSignerSelection(ethereum, pending, selectedSigner)
	if (
		refreshResult.status === 'refreshed'
		&& pending.type === 'Transaction'
		&& pending.safeExecutionOriginalRequestParameters !== undefined
	) {
		try {
			refreshResult = {
				status: 'refreshed',
				pending: await refreshDirectSafeExecutionSimulation(refreshResult.pending),
			}
		} catch(error) {
			refreshResult = await handleSafeExecutionRefreshFailure(error)
		}
	}

	if (refreshResult.status === 'unchanged' || isSameSafeSignerError(pending, refreshResult)) {
		return { refreshRequired: true, refreshResult, persisted: false, persistedPending: undefined }
	}
	let persistedPending: PendingTransactionOrSignableMessage | undefined
	await updatePendingTransactionOrMessage(pending.uniqueRequestIdentifier, async (current) => {
		if (!shouldRefreshSafeSignerSelection(current, selectedSigner)) return current
		if (!pendingSafeRefreshBaseMatches(current, pending)) return current
		persistedPending = refreshResult.status === 'refreshed'
			? mergeSafeSignerSelectionRefresh(current, refreshResult.pending)
			: modifyObject(current, { approvalStatus: refreshResult.approvalStatus })
		return persistedPending
	})
	return { refreshRequired: true, refreshResult, persisted: persistedPending !== undefined, persistedPending }
}
