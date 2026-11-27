import type { GnosisSafeMessageReview } from '../types/gnosisSafeReview.js'
import type { SignMessageParams } from '../types/jsonRpc-signing-types.js'
import { stringifyJSONWithBigInts } from '../utils/bigint.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import type { GnosisSafeEntry } from '../types/addressBookTypes.js'
import { GnosisSafeMessage, validateGnosisSafeMessageForSigning } from '../gnosisSafe/gnosisSafeMessage.js'
import type { EIP712Message } from '../types/eip721.js'
import type { GnosisSafeContractStateSnapshot } from '../types/gnosisSafeTypes.js'
import type { OriginalSendRequestParameters } from '../types/JsonRpc-types.js'
import { getErrorMessage } from '../utils/caughtErrors.js'
import { modifyObject } from '../utils/typescript.js'
import { areEqualUint8Arrays } from '../utils/typed-arrays.js'
import { assertGnosisSafeContractStateUnchanged, assertGnosisSafeProposalChainMatchesConnectedNetwork, createGnosisSafeContractValidationFailure, createGnosisSafeTransactionSigningRequest, getGnosisSafeTxSignerFacingTypedData, isGnosisSafeContractValidationFailure, isGnosisSafeOwnerValidationFailure, validateGnosisSafeTransactionForSigning, type GnosisSafeOwnerValidator } from '../gnosisSafe/gnosisSafeCore.js'
import { areGnosisSafeExecutionSignerRequestsEqual, prepareGnosisSafeExecutionSignerRoute } from '../gnosisSafe/gnosisSafeExecutionRouting.js'
import { getUserAddressBookEntriesForChainIdMorePreciseFirst, updatePendingTransactionOrMessageInstance } from './storageVariables.js'
import { createGnosisSafeSignerErrorStatus, type GnosisSafeSignerErrorStatus } from './gnosisSafeSignerErrors.js'
import { createCreatedGnosisSafeProposalGnosisSafeFlow, getGnosisSafePendingFlow, type DirectGnosisSafeExecutionFlow, type GnosisSafeMessageCoSignFlow, type GnosisSafePendingFlow, type GnosisSafeProposalFlow } from '../gnosisSafe/gnosisSafePendingFlow.js'

export const GNOSIS_SAFE_SIGNER_SELECTION_ERROR_CODE = -32010

export type GnosisSafeMessageCoSignContext = {
	readonly safeEntry: GnosisSafeEntry
	readonly safeSignerAddress: bigint
	readonly typedData: EIP712Message
	readonly signingHash: bigint
	readonly ownerValidator: GnosisSafeOwnerValidator
}

export type GnosisSafeSignerSelectionRefreshResult =
	| { readonly status: 'unchanged', readonly pending: PendingTransactionOrSignableMessage }
	| { readonly status: 'refreshed', readonly pending: PendingTransactionOrSignableMessage }
	| { readonly status: 'blocked', readonly approvalStatus: GnosisSafeSignerErrorStatus }

export type GnosisSafeSignerSelectionRefreshPersistence = {
	readonly refreshRequired: boolean
	readonly refreshResult: GnosisSafeSignerSelectionRefreshResult
	readonly persisted: boolean
	readonly persistedPending: PendingTransactionOrSignableMessage | undefined
}

export async function getCurrentGnosisSafeEntry(ethereum: EthereumClientService, safeAddress: bigint) {
	return (await getCurrentGnosisSafeEntryAndAddressBookEntries(ethereum, safeAddress)).safeEntry
}

export async function getCurrentGnosisSafeEntryAndAddressBookEntries(ethereum: EthereumClientService, safeAddress: bigint) {
	const addressBookEntries = await getUserAddressBookEntriesForChainIdMorePreciseFirst(ethereum.getChainId())
	const safeEntry = addressBookEntries.find((entry) => entry.type === 'safe' && entry.address === safeAddress)
	if (safeEntry?.type !== 'safe') throw createGnosisSafeContractValidationFailure('The Gnosis Safe is no longer configured in the address book.')
	return { safeEntry, addressBookEntries }
}

async function refreshGnosisSafeTransactionSignerSelection(
	ethereum: EthereumClientService,
	flow: GnosisSafeProposalFlow,
	selectedSigner: bigint,
) {
	const pending = flow.pending
	// The proposal is rebuilt with the connected chain's services, which would silently move a proposal prepared on another chain to this one.
	assertGnosisSafeProposalChainMatchesConnectedNetwork(ethereum, pending.safeFlow.safeTransaction.safeTx)
	const executionGasLimit = pending.safeFlow.safeTransaction.executionGasLimit ?? (
		'transactionToSimulate' in pending && pending.transactionToSimulate.success
			? pending.transactionToSimulate.transaction.gas
			: undefined
	)
	if (executionGasLimit === undefined) throw createGnosisSafeContractValidationFailure('The pending Gnosis Safe proposal is missing its execution gas limit.')
	try {
		const safeTransaction = await createGnosisSafeTransactionSigningRequest(
			ethereum,
			pending.safeFlow.safeTransaction.safeAddress,
			selectedSigner,
			{
				to: pending.safeFlow.safeTransaction.safeTx.message.to,
				value: pending.safeFlow.safeTransaction.safeTx.message.value,
				input: pending.safeFlow.safeTransaction.safeTx.message.data,
				operation: pending.safeFlow.safeTransaction.safeTx.message.operation,
				gas: executionGasLimit,
			},
			pending.safeFlow.safeTransaction.safeTx.message.nonce,
		)
		const reviewedSafeState = pending.safeFlow.safeTransaction.reviewedSafeState
		if (reviewedSafeState === undefined || safeTransaction.reviewedSafeState === undefined) {
			throw createGnosisSafeContractValidationFailure('Review this Gnosis Safe proposal again so its current owners, threshold, nonce, and signer can be verified.')
		}
		assertGnosisSafeContractStateUnchanged(reviewedSafeState, safeTransaction.reviewedSafeState)
		return { safeFlow: createCreatedGnosisSafeProposalGnosisSafeFlow({ ...safeTransaction, ...(pending.safeFlow.safeTransaction.messageReview !== undefined ? { messageReview: pending.safeFlow.safeTransaction.messageReview } : {}) }), approvalStatus: { status: 'WaitingForUser' as const } }
	} catch (error) {
		if (!isGnosisSafeOwnerValidationFailure(error)) throw error
		return {
			safeFlow: pending.safeFlow,
			approvalStatus: createGnosisSafeSignerErrorStatus(
				getErrorMessage(error) ?? 'Select a current Gnosis Safe owner in the signer wallet before signing.',
				GNOSIS_SAFE_SIGNER_SELECTION_ERROR_CODE,
			),
		}
	}
}

export async function createGnosisSafeOffChainMessageSnapshot(ethereum: EthereumClientService, safeAddress: bigint, owner: bigint | undefined, transactionParams: SignMessageParams, review?: GnosisSafeMessageReview) {
	if (transactionParams.method !== 'eth_signTypedData_v4' || transactionParams.params[0] !== safeAddress) throw createGnosisSafeContractValidationFailure('The Gnosis Safe message signing account does not match the active Gnosis Safe.')
	if (owner === undefined) throw createGnosisSafeContractValidationFailure('Select a current Gnosis Safe owner in your signer wallet.')
	const safeEntry = await getCurrentGnosisSafeEntry(ethereum, safeAddress)
	if (safeEntry.safeVersion === undefined) throw createGnosisSafeContractValidationFailure('Re-save the Gnosis Safe address-book entry to verify its version before signing.')
	const parsedMessage = GnosisSafeMessage.safeParse({ typedData: transactionParams.params[1], review })
	if (!parsedMessage.success) throw createGnosisSafeContractValidationFailure('The Gnosis Safe message review data is invalid or changed after review.')
	const message = parsedMessage.value
	try {
		const { signingHash, safeState } = await validateGnosisSafeMessageForSigning(ethereum, safeAddress, owner, message, safeEntry.safeVersion)
		return { safeAddress, safeSignerAddress: owner, safeMessageHash: signingHash, reviewedSafeState: safeState }
	} catch (error) {
		if (isGnosisSafeOwnerValidationFailure(error)) throw createGnosisSafeContractValidationFailure(error.message)
		throw error
	}
}

export async function getGnosisSafeMessageCoSignContext(
	ethereum: EthereumClientService,
	flow: GnosisSafeMessageCoSignFlow,
	safeSignerOverride?: bigint,
): Promise<GnosisSafeMessageCoSignContext | undefined> {
	const pending = flow.pending
	if (
		pending.simulationMode
		|| pending.transactionOrMessageCreationStatus !== 'Simulated'
		|| pending.originalRequestParameters.method !== 'eth_signTypedData_v4'
	) return undefined
	if ('safeMessageHash' in pending.safeMessageCoSignSnapshot) {
		const snapshot = pending.safeMessageCoSignSnapshot
		const safeEntry = await getCurrentGnosisSafeEntry(ethereum, pending.activeAddress)
		if (safeEntry.safeVersion === undefined || snapshot.safeAddress !== pending.activeAddress || pending.originalRequestParameters.params[0] !== pending.activeAddress) throw createGnosisSafeContractValidationFailure('The Gnosis Safe message account or version changed after review.')
		const parsedMessage = GnosisSafeMessage.safeParse({ typedData: pending.originalRequestParameters.params[1], review: pending.signedMessageTransaction.safeMessageReview })
		if (!parsedMessage.success) throw createGnosisSafeContractValidationFailure('The Gnosis Safe message review data is invalid or changed after review.')
		const message = parsedMessage.value
		const context = await validateGnosisSafeMessageForSigning(ethereum, pending.activeAddress, safeSignerOverride ?? snapshot.safeSignerAddress, message, safeEntry.safeVersion)
		if (context.signingHash !== snapshot.safeMessageHash) throw createGnosisSafeContractValidationFailure('The Gnosis Safe message changed after review.')
		assertGnosisSafeContractStateUnchanged(snapshot.reviewedSafeState, context.safeState)
		return { ...context, safeEntry, safeSignerAddress: safeSignerOverride ?? snapshot.safeSignerAddress }
	}
	if (pending.visualizedPersonalSignRequest.type !== 'SafeTx') return undefined
	const safeTx = pending.visualizedPersonalSignRequest.message
	const reviewedSnapshot = pending.safeMessageCoSignSnapshot
	const [requestedAccount] = pending.originalRequestParameters.params
	if (requestedAccount !== pending.activeAddress || safeTx.domain.verifyingContract !== pending.activeAddress) {
		throw createGnosisSafeContractValidationFailure('The Gnosis Safe transaction signing account does not match the active Gnosis Safe.')
	}
	const safeEntry = await getCurrentGnosisSafeEntry(ethereum, pending.activeAddress)
	if (safeEntry.safeVersion === undefined) {
		throw createGnosisSafeContractValidationFailure('Re-save the active Gnosis Safe address-book entry to verify and record its current Gnosis Safe version before co-signing.')
	}
	if (reviewedSnapshot.safeAddress !== safeEntry.address) throw createGnosisSafeContractValidationFailure('The configured Gnosis Safe changed after this co-signing confirmation opened.')
	const { safeTxHash, safeState, ownerValidator } = await validateGnosisSafeTransactionForSigning(
		ethereum,
		safeEntry.address,
		safeSignerOverride ?? reviewedSnapshot.safeSignerAddress,
		safeTx,
		safeEntry.safeVersion,
	)
	if (safeTxHash !== reviewedSnapshot.safeTxHash) throw createGnosisSafeContractValidationFailure('The Gnosis Safe transaction changed after this co-signing confirmation opened.')
	assertGnosisSafeContractStateUnchanged(reviewedSnapshot.reviewedSafeState, safeState)
	return { safeEntry, safeSignerAddress: safeSignerOverride ?? reviewedSnapshot.safeSignerAddress, typedData: getGnosisSafeTxSignerFacingTypedData(safeTx), signingHash: safeTxHash, ownerValidator }
}

async function refreshGnosisSafeMessageCoSignSignerSelection(
	ethereum: EthereumClientService,
	flow: GnosisSafeMessageCoSignFlow,
	selectedSigner: bigint,
) {
	const pending = flow.pending
	if (pending.safeMessageCoSignSnapshot.safeSignerAddress === selectedSigner) return pending
	await getGnosisSafeMessageCoSignContext(ethereum, flow, selectedSigner)
	return modifyObject(pending, {
		safeMessageCoSignSnapshot: modifyObject(pending.safeMessageCoSignSnapshot, { safeSignerAddress: selectedSigner }),
		approvalStatus: { status: 'WaitingForUser' as const },
	})
}

export async function refreshGnosisSafeExecutionSignerSelection(
	ethereum: EthereumClientService,
	flow: DirectGnosisSafeExecutionFlow,
	selectedSigner?: bigint,
): Promise<PendingTransactionOrSignableMessage | undefined> {
	const pending = flow.pending
	if (pending.simulationMode) return undefined
	const originalRequest = pending.safeFlow.safeExecutionOriginalRequestParameters
	const reviewedSafeState = pending.safeFlow.safeExecutionReviewedSafeState
	if (reviewedSafeState === undefined) throw createGnosisSafeContractValidationFailure('Review this Gnosis Safe execution again so its current owner and threshold state can be verified.')
	const safeAddress = originalRequest.params[0].from
	if (safeAddress === undefined) throw createGnosisSafeContractValidationFailure('The original Gnosis Safe execution request is missing its Gnosis Safe address.')
	const safeEntry = await getCurrentGnosisSafeEntry(ethereum, safeAddress)
	const refreshedRoute = await prepareGnosisSafeExecutionSignerRoute(ethereum, originalRequest, safeEntry, selectedSigner ?? pending.safeFlow.safeExecutionSignerAddress)
	if (refreshedRoute === undefined) throw createGnosisSafeContractValidationFailure('The configured Gnosis Safe execution route is no longer available.')
	assertGnosisSafeContractStateUnchanged(reviewedSafeState, refreshedRoute.safeState)
	if (selectedSigner === undefined && (
		pending.originalRequestParameters.method !== 'eth_sendTransaction'
		|| !areGnosisSafeExecutionSignerRequestsEqual(pending.originalRequestParameters, refreshedRoute.transactionParams)
	)) throw createGnosisSafeContractValidationFailure('The Gnosis Safe execution changed after this confirmation opened. Review the refreshed transaction before submitting it.')
	return modifyObject(pending, {
		activeAddress: refreshedRoute.executor,
		originalRequestParameters: refreshedRoute.transactionParams,
		safeFlow: modifyObject(pending.safeFlow, { safeExecutionSignerAddress: refreshedRoute.executor, safeExecutionReviewedSafeState: refreshedRoute.safeState }),
		approvalStatus: { status: 'WaitingForUser' as const },
	})
}

export function handleGnosisSafeExecutionRefreshFailure(error: unknown): { readonly status: 'blocked', readonly approvalStatus: GnosisSafeSignerErrorStatus } {
	if (!isGnosisSafeContractValidationFailure(error) && !isGnosisSafeOwnerValidationFailure(error)) throw error
	return {
		status: 'blocked',
		approvalStatus: createGnosisSafeSignerErrorStatus(
			`Gnosis Safe execution could not be prepared: ${ getErrorMessage(error) ?? 'The current Gnosis Safe state could not be validated.' }`,
			GNOSIS_SAFE_SIGNER_SELECTION_ERROR_CODE,
		),
	}
}

async function handleGnosisSafeSignerSelectionRefreshFailure(
	error: unknown,
	messagePrefix: string | undefined,
	fallbackMessage: string,
): Promise<{ readonly status: 'blocked', readonly approvalStatus: GnosisSafeSignerErrorStatus }> {
	return {
		status: 'blocked',
		approvalStatus: createGnosisSafeSignerErrorStatus(
			messagePrefix === undefined
				? getErrorMessage(error) ?? fallbackMessage
				: `${ messagePrefix }: ${ getErrorMessage(error) ?? fallbackMessage }`,
			GNOSIS_SAFE_SIGNER_SELECTION_ERROR_CODE,
		),
	}
}

async function refreshGnosisSafeProposalSignerSelection(
	ethereum: EthereumClientService,
	flow: GnosisSafeProposalFlow,
	selectedSigner: bigint,
): Promise<GnosisSafeSignerSelectionRefreshResult> {
	const pending = flow.pending
	try {
		const refreshedTransaction = await refreshGnosisSafeTransactionSignerSelection(ethereum, flow, selectedSigner)
		if (refreshedTransaction.approvalStatus.status === 'SignerError') {
			return { status: 'blocked', approvalStatus: refreshedTransaction.approvalStatus }
		}
		return { status: 'refreshed', pending: modifyObject(pending, refreshedTransaction) }
		} catch(error) {
			if (!isGnosisSafeContractValidationFailure(error) && !isGnosisSafeOwnerValidationFailure(error)) throw error
			return await handleGnosisSafeSignerSelectionRefreshFailure(
			error,
			'Gnosis Safe proposal could not be prepared',
			'The wallet-selected Gnosis Safe owner could not be validated.',
			)
	}
}

async function refreshGnosisSafeCoSignSignerSelection(
	ethereum: EthereumClientService,
	flow: GnosisSafeMessageCoSignFlow,
	selectedSigner: bigint,
): Promise<GnosisSafeSignerSelectionRefreshResult> {
	const pending = flow.pending
	try {
		const refreshedCoSign = await refreshGnosisSafeMessageCoSignSignerSelection(ethereum, flow, selectedSigner)
		return refreshedCoSign === pending
			? { status: 'unchanged', pending }
			: { status: 'refreshed', pending: refreshedCoSign }
	} catch(error) {
		if (!isGnosisSafeContractValidationFailure(error) && !isGnosisSafeOwnerValidationFailure(error)) throw error
		return await handleGnosisSafeSignerSelectionRefreshFailure(
			error,
			undefined,
			'Select a current Gnosis Safe owner in the signer wallet before co-signing.',
		)
	}
}

export async function refreshGnosisSafeSignerSelection(
	ethereum: EthereumClientService,
	flow: GnosisSafePendingFlow,
	selectedSigner: bigint,
): Promise<GnosisSafeSignerSelectionRefreshResult> {
	const pending = flow.pending
	switch (flow.kind) {
		case 'directExecution': {
			try {
				const refreshedExecution = await refreshGnosisSafeExecutionSignerSelection(ethereum, flow, selectedSigner)
				return refreshedExecution === undefined
					? { status: 'unchanged', pending }
					: { status: 'refreshed', pending: refreshedExecution }
			} catch(error) {
				return handleGnosisSafeExecutionRefreshFailure(error)
			}
		}
		case 'messageCoSign': return await refreshGnosisSafeCoSignSignerSelection(ethereum, flow, selectedSigner)
		case 'proposal': return await refreshGnosisSafeProposalSignerSelection(ethereum, flow, selectedSigner)
	}
}

function shouldRefreshGnosisSafeSignerSelection(flow: GnosisSafePendingFlow, selectedSigner: bigint) {
	if (flow.pending.approvalStatus.status === 'WaitingForSigner') return false
	switch (flow.kind) {
		case 'directExecution': return flow.pending.safeFlow.safeExecutionSignerAddress !== selectedSigner
		case 'messageCoSign': return flow.pending.safeMessageCoSignSnapshot.safeSignerAddress !== selectedSigner
		case 'proposal': return (
			flow.pending.approvalStatus.status === 'WaitingForUser'
			|| flow.pending.approvalStatus.status === 'SignerError' && flow.pending.approvalStatus.code === GNOSIS_SAFE_SIGNER_SELECTION_ERROR_CODE
		) && (
			flow.pending.safeFlow.safeTransaction.safeSignerAddress !== selectedSigner
			|| flow.pending.approvalStatus.status === 'SignerError'
		)
	}
}

function isSameGnosisSafeSignerError(pending: PendingTransactionOrSignableMessage, refreshResult: GnosisSafeSignerSelectionRefreshResult) {
	return refreshResult.status === 'blocked'
		&& pending.approvalStatus.status === 'SignerError'
		&& pending.approvalStatus.code === refreshResult.approvalStatus.code
		&& pending.approvalStatus.message === refreshResult.approvalStatus.message
}

function mergeGnosisSafeSignerSelectionRefresh(
	current: PendingTransactionOrSignableMessage,
	refreshed: PendingTransactionOrSignableMessage,
): PendingTransactionOrSignableMessage {
	const currentFlow = getGnosisSafePendingFlow(current)
	const refreshedFlow = getGnosisSafePendingFlow(refreshed)
	if (currentFlow === undefined || refreshedFlow === undefined || currentFlow.kind !== refreshedFlow.kind) return current
	if (currentFlow.kind === 'messageCoSign' && refreshedFlow.kind === 'messageCoSign') return modifyObject(currentFlow.pending, {
		safeMessageCoSignSnapshot: refreshedFlow.pending.safeMessageCoSignSnapshot,
		approvalStatus: refreshedFlow.pending.approvalStatus,
	})
	if (currentFlow.kind === 'directExecution' && refreshedFlow.kind === 'directExecution') return modifyObject(currentFlow.pending, {
		activeAddress: refreshedFlow.pending.activeAddress,
		originalRequestParameters: refreshedFlow.pending.originalRequestParameters,
		safeFlow: refreshedFlow.pending.safeFlow,
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
		safeFlow: refreshedFlow.pending.safeFlow,
		approvalStatus: refreshedFlow.pending.approvalStatus,
	})
	return current
}

// Stores a Gnosis Safe confirmation refresh on the request as it is stored now: only the Gnosis Safe fields and approval status the refresh rebuilt, so other changes made meanwhile are kept. A request forwarded to the signer meanwhile is left for the signer's reply. Returns whether the refresh was stored.
export async function persistGnosisSafeConfirmationRefresh(refreshed: PendingTransactionOrSignableMessage) {
	let persisted = false
	await updatePendingTransactionOrMessageInstance(refreshed, async (current) => {
		if (current.approvalStatus.status === 'WaitingForSigner') return undefined
		persisted = true
		return mergeGnosisSafeSignerSelectionRefresh(current, refreshed)
	})
	return persisted
}

type RefreshDirectGnosisSafeExecutionSimulation = (
	pending: PendingTransactionOrSignableMessage,
) => Promise<PendingTransactionOrSignableMessage>

function areGnosisSafeContractStateSnapshotsEqual(first: GnosisSafeContractStateSnapshot | undefined, second: GnosisSafeContractStateSnapshot | undefined) {
	if (first === undefined || second === undefined) return first === second
	return first.version === second.version
		&& first.nonce === second.nonce
		&& first.threshold === second.threshold
		&& first.owners.length === second.owners.length
		&& first.owners.every((owner, index) => owner === second.owners[index])
}

function areOriginalSendRequestsEqual(first: OriginalSendRequestParameters, second: OriginalSendRequestParameters) {
	if (first.method === 'eth_sendTransaction' && second.method === 'eth_sendTransaction') {
		return areGnosisSafeExecutionSignerRequestsEqual(first, second)
	}
	if (first.method === 'eth_sendRawTransaction' && second.method === 'eth_sendRawTransaction') {
		return areEqualUint8Arrays(first.params[0], second.params[0])
	}
	return false
}

function pendingGnosisSafeRefreshBaseMatches(
	current: PendingTransactionOrSignableMessage,
	refreshBase: PendingTransactionOrSignableMessage,
) {
	const currentFlow = getGnosisSafePendingFlow(current)
	const refreshBaseFlow = getGnosisSafePendingFlow(refreshBase)
	if (currentFlow === undefined || refreshBaseFlow === undefined || currentFlow.kind !== refreshBaseFlow.kind) return false
	if (currentFlow.kind === 'messageCoSign' && refreshBaseFlow.kind === 'messageCoSign') {
		const currentSnapshot = currentFlow.pending.safeMessageCoSignSnapshot
		const baseSnapshot = refreshBaseFlow.pending.safeMessageCoSignSnapshot
		return currentSnapshot.safeAddress === baseSnapshot.safeAddress
			&& currentSnapshot.safeSignerAddress === baseSnapshot.safeSignerAddress
			&& ('safeTxHash' in currentSnapshot && 'safeTxHash' in baseSnapshot ? currentSnapshot.safeTxHash === baseSnapshot.safeTxHash : 'safeMessageHash' in currentSnapshot && 'safeMessageHash' in baseSnapshot && currentSnapshot.safeMessageHash === baseSnapshot.safeMessageHash)
			&& areGnosisSafeContractStateSnapshotsEqual(currentSnapshot.reviewedSafeState, baseSnapshot.reviewedSafeState)
	}
	if (currentFlow.kind === 'directExecution' && refreshBaseFlow.kind === 'directExecution') {
		return areGnosisSafeExecutionSignerRequestsEqual(currentFlow.pending.safeFlow.safeExecutionOriginalRequestParameters, refreshBaseFlow.pending.safeFlow.safeExecutionOriginalRequestParameters)
			&& currentFlow.pending.originalRequestParameters.method === 'eth_sendTransaction'
			&& refreshBaseFlow.pending.originalRequestParameters.method === 'eth_sendTransaction'
			&& areGnosisSafeExecutionSignerRequestsEqual(currentFlow.pending.originalRequestParameters, refreshBaseFlow.pending.originalRequestParameters)
			&& currentFlow.pending.safeFlow.safeExecutionSignerAddress === refreshBaseFlow.pending.safeFlow.safeExecutionSignerAddress
			&& areGnosisSafeContractStateSnapshotsEqual(currentFlow.pending.safeFlow.safeExecutionReviewedSafeState, refreshBaseFlow.pending.safeFlow.safeExecutionReviewedSafeState)
	}
	if (currentFlow.kind !== 'proposal' || refreshBaseFlow.kind !== 'proposal') return false
	const currentSafeTransaction = currentFlow.pending.safeFlow.safeTransaction
	const baseSafeTransaction = refreshBaseFlow.pending.safeFlow.safeTransaction
	return currentSafeTransaction.safeAddress === baseSafeTransaction.safeAddress
		&& currentSafeTransaction.safeTxHash === baseSafeTransaction.safeTxHash
		&& currentSafeTransaction.safeSignerAddress === baseSafeTransaction.safeSignerAddress
		&& currentSafeTransaction.executionGasLimit === baseSafeTransaction.executionGasLimit
		&& areGnosisSafeContractStateSnapshotsEqual(currentSafeTransaction.reviewedSafeState, baseSafeTransaction.reviewedSafeState)
		&& areOriginalSendRequestsEqual(currentFlow.pending.originalRequestParameters, refreshBaseFlow.pending.originalRequestParameters)
}

// A recognized message can precede owner validation. Keep it blocked until a selected owner validates a complete snapshot.
async function recoverGnosisSafeMessageReview(ethereum: EthereumClientService, pending: PendingTransactionOrSignableMessage, selectedSigner: bigint): Promise<GnosisSafeSignerSelectionRefreshPersistence | undefined> {
	if (pending.type !== 'SignableMessage' || pending.simulationMode || pending.safeMessageCoSignSnapshot !== undefined
		|| pending.transactionOrMessageCreationStatus !== 'Simulated' || pending.visualizedPersonalSignRequest.type !== 'SafeMessage'
		|| pending.approvalStatus.status !== 'SignerError' || pending.approvalStatus.code !== GNOSIS_SAFE_SIGNER_SELECTION_ERROR_CODE) return undefined
	let refreshResult: GnosisSafeSignerSelectionRefreshResult
	try {
		const snapshot = await createGnosisSafeOffChainMessageSnapshot(ethereum, pending.activeAddress, selectedSigner, pending.originalRequestParameters, pending.signedMessageTransaction.safeMessageReview)
		refreshResult = { status: 'refreshed', pending: { ...pending, safeMessageCoSignSnapshot: snapshot, approvalStatus: { status: 'WaitingForUser' } } }
	} catch (error) {
		if (!isGnosisSafeContractValidationFailure(error) && !isGnosisSafeOwnerValidationFailure(error)) throw error
		refreshResult = await handleGnosisSafeSignerSelectionRefreshFailure(error, undefined, 'Select a current Gnosis Safe owner in the signer wallet before co-signing.')
	}
	let persistedPending: PendingTransactionOrSignableMessage | undefined
	await updatePendingTransactionOrMessageInstance(pending, async (current) => {
		// Do not overwrite a cancellation, another completed refresh, or changed review data while the owner lookup was pending.
		if (current.type !== 'SignableMessage' || current.safeMessageCoSignSnapshot !== undefined || current.activeAddress !== pending.activeAddress
			|| current.approvalStatus.status !== 'SignerError' || current.approvalStatus.code !== GNOSIS_SAFE_SIGNER_SELECTION_ERROR_CODE
			|| stringifyJSONWithBigInts(current.signedMessageTransaction.safeMessageReview) !== stringifyJSONWithBigInts(pending.signedMessageTransaction.safeMessageReview)
			|| stringifyJSONWithBigInts(current.originalRequestParameters) !== stringifyJSONWithBigInts(pending.originalRequestParameters)) return current
		if (refreshResult.status === 'refreshed' && refreshResult.pending.type === 'SignableMessage') {
			persistedPending = { ...current, safeMessageCoSignSnapshot: refreshResult.pending.safeMessageCoSignSnapshot, approvalStatus: refreshResult.pending.approvalStatus }
		} else if (refreshResult.status === 'blocked' && !isSameGnosisSafeSignerError(current, refreshResult)) {
			persistedPending = { ...current, approvalStatus: refreshResult.approvalStatus }
		}
		return persistedPending ?? current
	})
	return { refreshRequired: true, refreshResult, persisted: persistedPending !== undefined, persistedPending }
}

export async function refreshAndPersistGnosisSafeSignerSelection(
	ethereum: EthereumClientService,
	pending: PendingTransactionOrSignableMessage,
	selectedSigner: bigint,
	refreshDirectGnosisSafeExecutionSimulation: RefreshDirectGnosisSafeExecutionSimulation,
): Promise<GnosisSafeSignerSelectionRefreshPersistence> {
	const recoveredMessage = await recoverGnosisSafeMessageReview(ethereum, pending, selectedSigner)
	if (recoveredMessage !== undefined) return recoveredMessage
	const flow = getGnosisSafePendingFlow(pending)
	if (flow === undefined || !shouldRefreshGnosisSafeSignerSelection(flow, selectedSigner)) {
		return {
			refreshRequired: false,
			refreshResult: { status: 'unchanged', pending },
			persisted: false,
			persistedPending: undefined,
		}
	}

	let refreshResult = await refreshGnosisSafeSignerSelection(ethereum, flow, selectedSigner)
	if (
		refreshResult.status === 'refreshed'
		&& flow.kind === 'directExecution'
	) {
		try {
			refreshResult = {
				status: 'refreshed',
				pending: await refreshDirectGnosisSafeExecutionSimulation(refreshResult.pending),
			}
		} catch(error) {
			if (!isGnosisSafeContractValidationFailure(error) && !isGnosisSafeOwnerValidationFailure(error)) throw error
			refreshResult = handleGnosisSafeExecutionRefreshFailure(error)
		}
	}

	if (refreshResult.status === 'unchanged' || isSameGnosisSafeSignerError(pending, refreshResult)) {
		return { refreshRequired: true, refreshResult, persisted: false, persistedPending: undefined }
	}
	let persistedPending: PendingTransactionOrSignableMessage | undefined
	await updatePendingTransactionOrMessageInstance(pending, async (current) => {
		const currentFlow = getGnosisSafePendingFlow(current)
		if (currentFlow === undefined || !shouldRefreshGnosisSafeSignerSelection(currentFlow, selectedSigner)) return current
		if (!pendingGnosisSafeRefreshBaseMatches(current, pending)) return current
		persistedPending = refreshResult.status === 'refreshed'
			? mergeGnosisSafeSignerSelectionRefresh(current, refreshResult.pending)
			: modifyObject(current, { approvalStatus: refreshResult.approvalStatus })
		return persistedPending
	})
	return { refreshRequired: true, refreshResult, persisted: persistedPending !== undefined, persistedPending }
}
