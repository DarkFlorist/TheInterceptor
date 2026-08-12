import * as funtypes from 'funtypes'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import { EIP712Message } from '../types/eip721.js'
import type { SignMessageParams } from '../types/jsonRpc-signing-types.js'
import { getErrorMessage } from '../utils/caughtErrors.js'
import { reportUnexpectedError } from '../utils/errors.js'
import { getPrettySignerName } from '../utils/signerMetadata.js'
import { getWalletSelectedAccount } from '../utils/activeAddressSelection.js'
import { modifyObject } from '../utils/typescript.js'
import { getPendingTransactionsAndMessages, getSafeTransactionStacks, getTabState } from './storageVariables.js'
import { assertSafeContractStateUnchanged, createSafeTransactionSigningRequest, getSafeContractState, isSafeOwnerValidationFailure, safeTxToTypedDataJson, validateSafeTransactionForSigning } from '../safe/safeCore.js'
import { reconcileSafeTransactionStack } from '../safe/safeStack.js'
import type { SafeTx } from '../types/personal-message-definitions.js'
import type { SafeSignerErrorDetails } from '../types/safeTypes.js'
import { createSafeSignerErrorStatus, type SafeSignerErrorStatus } from './safeSignerErrors.js'
import { createSafeValidationError, hasSafeValidationErrorCode } from '../safe/safeErrors.js'
import { getCurrentSafeEntry, getCurrentSafeEntryAndAddressBookEntries, getSafeMessageCoSignContext, handleSafeExecutionRefreshFailure, refreshSafeExecutionSignerSelection, refreshSafeSignerSelection, SAFE_SIGNER_SELECTION_ERROR_CODE, type SafeMessageCoSignContext } from './safeSignerSelectionRefresh.js'

export { SAFE_SIGNER_SELECTION_ERROR_CODE } from './safeSignerSelectionRefresh.js'

function createSafeSignerSelectionFailure(message: string) {
	return createSafeValidationError(message, 'safe_signer_selection')
}

export function isSafeSignerSelectionFailure(error: unknown) {
	return hasSafeValidationErrorCode(error, 'safe_signer_selection')
}

function createSafeMessageAccountMismatchFailure(message: string, safeSignerErrorDetails: SafeSignerErrorDetails) {
	return Object.assign(createSafeValidationError(message, 'safe_message_account_mismatch'), { safeSignerErrorDetails })
}

export function isSafeMessageAccountMismatchFailure(error: unknown): error is Error & { readonly safeSignerErrorDetails: SafeSignerErrorDetails } {
	return hasSafeValidationErrorCode(error, 'safe_message_account_mismatch')
		&& 'safeSignerErrorDetails' in error
}

export type RefreshedSafeSignerSelection = {
	readonly selectedSigner: bigint | undefined
	readonly verificationError: string | undefined
}

export type SafeConfirmationResolution =
	| {
		readonly status: 'ready'
		readonly pending: PendingTransactionOrSignableMessage
		readonly pendingChanged: boolean
		readonly signerFacingRequest: SignMessageParams | undefined
	}
	| {
		readonly status: 'blocked'
		readonly approvalStatus: SafeSignerErrorStatus
	}
	| {
		readonly status: 'refreshed'
		readonly pending: PendingTransactionOrSignableMessage
	}

export async function getSafeSignerMismatchApprovalStatus(
	tabId: number,
	reviewedSafeSigner: bigint,
	refreshedSelection?: RefreshedSafeSignerSelection,
) {
	const tabState = await getTabState(tabId)
	const signerName = getPrettySignerName(tabState.signerName)
	const selectedSigner = refreshedSelection === undefined
		? getWalletSelectedAccount(tabState)
		: refreshedSelection.selectedSigner
	if (selectedSigner === reviewedSafeSigner) return undefined
	const safeSignerErrorDetails: SafeSignerErrorDetails = {
		kind: 'safeOwnerMismatch',
		expectedOwner: reviewedSafeSigner,
		...(selectedSigner === undefined ? {} : { walletAccount: selectedSigner }),
	}
	if (refreshedSelection?.verificationError !== undefined) {
		return createSafeSignerErrorStatus(
			`The wallet-selected Gnosis Safe owner could not be verified: ${ refreshedSelection.verificationError } Select the expected owner in ${ signerName }, then retry.`,
			SAFE_SIGNER_SELECTION_ERROR_CODE,
			safeSignerErrorDetails,
		)
	}
	const selectedAccountDescription = selectedSigner === undefined
		? 'no account selected'
		: 'a different account selected'
	return createSafeSignerErrorStatus(
		`Gnosis Safe owner mismatch: this request expects a different owner, but ${ signerName } currently has ${ selectedAccountDescription }. Select the expected owner in ${ signerName }, then retry.`,
		SAFE_SIGNER_SELECTION_ERROR_CODE,
		safeSignerErrorDetails,
	)
}

export function getPendingSafeSignerAddress(pending: PendingTransactionOrSignableMessage) {
	if (pending.type === 'Transaction') {
		return pending.safeTransaction?.safeSignerAddress ?? pending.safeExecutionSignerAddress
	}
	return pending.safeMessageCoSignSnapshot?.safeSignerAddress
}

export async function createSafeMessageCoSignSnapshot(
	ethereum: EthereumClientService,
	activeAddress: bigint,
	walletSignerAddress: bigint | undefined,
	transactionParams: SignMessageParams,
	safeTx: SafeTx,
) {
	if (transactionParams.method !== 'eth_signTypedData_v4') throw new Error('Gnosis Safe co-signing requires an EIP-712 typed-data request.')
	const [requestedAccount] = transactionParams.params
	const { safeEntry, addressBookEntries } = await getCurrentSafeEntryAndAddressBookEntries(ethereum, activeAddress)
	if (requestedAccount !== activeAddress || safeTx.domain.verifyingContract !== activeAddress) {
		let safeOwners: readonly bigint[] = []
		let safeOwnersUnavailableReason: string | undefined
		try {
			safeOwners = (await getSafeContractState(ethereum, activeAddress)).owners
		} catch (error) {
			await reportUnexpectedError(error, {
				source: 'safe_signer_owner_lookup',
				code: 'safe_signer_owner_lookup_failed',
				displayMessage: 'Failed to load the active Gnosis Safe owners.',
			})
			safeOwnersUnavailableReason = getErrorMessage(error) ?? 'The current owner list could not be loaded.'
		}
		const safeOwnerSet = new Set(safeOwners)
		throw createSafeMessageAccountMismatchFailure(
			'The Gnosis Safe transaction signing account does not match the active Gnosis Safe.',
			{
				kind: 'safeSigningAccountMismatch',
				requestedSigningAccount: requestedAccount,
				activeSafe: activeAddress,
				requestedSafe: safeTx.domain.verifyingContract,
				safeOwners,
				safeOwnerAddressBookEntries: addressBookEntries.filter((entry) => safeOwnerSet.has(entry.address)),
				...(safeOwnersUnavailableReason === undefined ? {} : { safeOwnersUnavailableReason }),
			},
		)
	}
	// Signing deliberately ignores stored simulation/owner preferences: the wallet selection is refreshed before forwarding and validated against current on-chain Safe state.
	if (walletSignerAddress === undefined) {
		throw createSafeSignerSelectionFailure('Connect a signer wallet and select a Gnosis Safe owner before co-signing.')
	}
	if (safeEntry.safeVersion === undefined) {
		throw new Error('Re-save the active Gnosis Safe address-book entry to verify and record its current Gnosis Safe version before co-signing.')
	}
	let validatedSafeTransaction: Awaited<ReturnType<typeof validateSafeTransactionForSigning>>
	try {
		validatedSafeTransaction = await validateSafeTransactionForSigning(
			ethereum,
			safeEntry.address,
			walletSignerAddress,
			safeTx,
			safeEntry.safeVersion,
		)
	} catch(error) {
		if (isSafeOwnerValidationFailure(error)) {
			throw createSafeSignerSelectionFailure(getErrorMessage(error) ?? 'Select a current Gnosis Safe owner in the signer wallet before co-signing.')
		}
		throw error
	}
	const { safeTxHash, safeState } = validatedSafeTransaction
	return {
		safeAddress: safeEntry.address,
		safeSignerAddress: walletSignerAddress,
		safeTxHash,
		reviewedSafeState: safeState,
	}
}

export async function validateSafeMessageCoSignature(
	ethereum: EthereumClientService,
	pending: PendingTransactionOrSignableMessage,
	signerReply: unknown,
) {
	const currentCoSignContext = await getSafeMessageCoSignContext(ethereum, pending)
	if (currentCoSignContext === undefined) throw new Error('This Gnosis Safe transaction is not eligible for Interceptor co-signing.')
	const ownerSignature = await currentCoSignContext.ownerValidator.validateSignature(
		currentCoSignContext.safeTxHash,
		funtypes.String.parse(signerReply),
		currentCoSignContext.safeSignerAddress,
	)
	return ownerSignature.signature
}

async function getRequiredSafeCoSignContext(
	ethereum: EthereumClientService,
	pending: PendingTransactionOrSignableMessage,
) {
	if (
		pending.type !== 'SignableMessage'
		|| pending.transactionOrMessageCreationStatus !== 'Simulated'
		|| pending.visualizedPersonalSignRequest.type !== 'SafeTx'
		|| pending.safeMessageCoSignSnapshot === undefined
	) return undefined
	const context = await getSafeMessageCoSignContext(ethereum, pending)
	if (context === undefined) throw new Error('This Gnosis Safe transaction is not eligible for Interceptor co-signing.')
	return context
}

async function assertSafeProposalReviewPrerequisites(
	ethereum: EthereumClientService,
	pending: PendingTransactionOrSignableMessage,
) {
	if (pending.simulationMode) return undefined
	if (pending.type === 'Transaction' && pending.safeTransaction !== undefined) {
		if (pending.safeTransaction.reviewedSafeState === undefined) {
			throw new Error('Review this Gnosis Safe proposal again so its current owners, threshold, nonce, and signer can be verified.')
		}
		await getCurrentSafeEntry(ethereum, pending.safeTransaction.safeAddress)
	}
	return undefined
}

async function getSafeSignerSelectionError(
	pending: PendingTransactionOrSignableMessage,
	refreshedSafeSignerSelection?: RefreshedSafeSignerSelection,
) {
	if (pending.simulationMode) return undefined
	const safeSignerAddress = getPendingSafeSignerAddress(pending)
	if (safeSignerAddress === undefined) {
		if (pending.type !== 'Transaction' || pending.safeTransaction === undefined) return undefined
		return createSafeSignerErrorStatus(
			refreshedSafeSignerSelection?.verificationError === undefined
				? 'Connect a signer wallet and select a current Gnosis Safe owner before signing.'
				: `The wallet-selected Gnosis Safe owner could not be verified: ${ refreshedSafeSignerSelection.verificationError }`,
			SAFE_SIGNER_SELECTION_ERROR_CODE,
		)
	}
	return await getSafeSignerMismatchApprovalStatus(
		pending.uniqueRequestIdentifier.requestSocket.tabId,
		safeSignerAddress,
		refreshedSafeSignerSelection,
	)
}

async function refreshSafeProposalNonce(
	ethereum: EthereumClientService,
	pending: PendingTransactionOrSignableMessage,
) {
	if (pending.simulationMode || pending.type !== 'Transaction' || pending.safeTransaction === undefined) return undefined
	const currentRequest = pending.safeTransaction
	const safeState = await getSafeContractState(ethereum, currentRequest.safeAddress)
	if (currentRequest.reviewedSafeState === undefined) throw new Error('The reviewed Gnosis Safe state is unavailable.')
	assertSafeContractStateUnchanged(currentRequest.reviewedSafeState, safeState)
	const storedStackBeforeReconciliation = (await getSafeTransactionStacks()).find((stack) =>
		stack.chainId === ethereum.getChainId() && stack.safeAddress === currentRequest.safeAddress
	)
	const storedStack = storedStackBeforeReconciliation === undefined
		? undefined
		: reconcileSafeTransactionStack(storedStackBeforeReconciliation, safeState.nonce)
	const firstUncommittedNonce = safeState.nonce + BigInt(storedStack?.transactions.length ?? 0)
	const precedingPendingCount = (await getPendingTransactionsAndMessages()).filter((candidate) =>
		candidate.type === 'Transaction'
		&& candidate.safeTransaction?.safeAddress === currentRequest.safeAddress
		&& candidate.safeTransaction.safeTx.domain.chainId === ethereum.getChainId()
		&& candidate.safeTransaction.safeTx.message.nonce >= firstUncommittedNonce
		&& candidate.safeTransaction.safeTx.message.nonce < currentRequest.safeTx.message.nonce
	).length
	if (precedingPendingCount > 0) throw new Error('Approve or reject the earlier pending Gnosis Safe proposals before signing this one.')
	if (currentRequest.safeTx.message.nonce === firstUncommittedNonce) return undefined
	const executionGasLimit = currentRequest.executionGasLimit ?? (
		'transactionToSimulate' in pending && pending.transactionToSimulate.success
			? pending.transactionToSimulate.transaction.gas
			: undefined
	)
	if (executionGasLimit === undefined) throw new Error('The pending Gnosis Safe proposal is missing its execution gas limit.')
	if (currentRequest.safeSignerAddress === undefined) throw new Error('Connect a signer wallet and select a current Gnosis Safe owner before signing.')
	const refreshedSafeRequest = await createSafeTransactionSigningRequest(
		ethereum,
		currentRequest.safeAddress,
		currentRequest.safeSignerAddress,
		{
			to: currentRequest.safeTx.message.to,
			value: currentRequest.safeTx.message.value,
			input: currentRequest.safeTx.message.data,
			gas: executionGasLimit,
		},
		firstUncommittedNonce,
	)
	return modifyObject(pending, { safeTransaction: refreshedSafeRequest })
}

function getSafeSignerFacingRequest(
	pending: PendingTransactionOrSignableMessage,
	coSignContext: SafeMessageCoSignContext | undefined,
): SignMessageParams | undefined {
	if (coSignContext !== undefined) {
		return {
			method: 'eth_signTypedData_v4',
			params: [
				coSignContext.safeSignerAddress,
				EIP712Message.parse(safeTxToTypedDataJson(coSignContext.safeTx)),
			],
		}
	}
	if (pending.type !== 'Transaction' || pending.safeTransaction?.safeSignerAddress === undefined) return undefined
	return {
		method: 'eth_signTypedData_v4',
		params: [
			pending.safeTransaction.safeSignerAddress,
			EIP712Message.parse(safeTxToTypedDataJson(pending.safeTransaction.safeTx)),
		],
	}
}

async function resolveDirectSafeExecutionConfirmation(
	ethereum: EthereumClientService,
	pending: PendingTransactionOrSignableMessage,
	refreshedSafeSignerSelection?: RefreshedSafeSignerSelection,
): Promise<SafeConfirmationResolution> {
	try {
		const refreshedExecution = await refreshSafeExecutionSignerSelection(ethereum, pending)
		if (refreshedExecution === undefined) return { status: 'ready', pending, pendingChanged: false, signerFacingRequest: undefined }
		const mismatch = await getSafeSignerSelectionError(refreshedExecution, refreshedSafeSignerSelection)
		if (mismatch !== undefined) return { status: 'blocked', approvalStatus: mismatch }
		return { status: 'ready', pending: refreshedExecution, pendingChanged: true, signerFacingRequest: undefined }
	} catch(error) {
		return await handleSafeExecutionRefreshFailure(error)
	}
}

async function resolveSafeCoSignConfirmation(
	ethereum: EthereumClientService,
	pendingInput: PendingTransactionOrSignableMessage,
	refreshedSafeSignerSelection?: RefreshedSafeSignerSelection,
): Promise<SafeConfirmationResolution> {
	let pending = pendingInput
	let pendingChanged = false
	const selectedSigner = refreshedSafeSignerSelection?.verificationError === undefined
		? refreshedSafeSignerSelection?.selectedSigner
		: undefined
	if (
		pending.type === 'SignableMessage'
		&& pending.safeMessageCoSignSnapshot !== undefined
		&& selectedSigner !== undefined
		&& pending.safeMessageCoSignSnapshot.safeSignerAddress !== selectedSigner
	) {
		const coSignRefresh = await refreshSafeSignerSelection(ethereum, pending, selectedSigner)
		if (coSignRefresh.status === 'blocked') return coSignRefresh
		if (coSignRefresh.status === 'refreshed') {
			pending = coSignRefresh.pending
			pendingChanged = true
		}
	}

	let coSignContext: SafeMessageCoSignContext | undefined
	try {
		coSignContext = await getRequiredSafeCoSignContext(ethereum, pending)
	} catch (error) {
		return {
			status: 'blocked',
			approvalStatus: createSafeSignerErrorStatus(`Gnosis Safe co-signing request was rejected: ${ getErrorMessage(error) ?? 'The Gnosis Safe transaction could not be validated.' }`),
		}
	}
	const mismatch = await getSafeSignerSelectionError(pending, refreshedSafeSignerSelection)
	if (mismatch !== undefined) return { status: 'blocked', approvalStatus: mismatch }
	return { status: 'ready', pending, pendingChanged, signerFacingRequest: getSafeSignerFacingRequest(pending, coSignContext) }
}

async function resolveSafeProposalConfirmation(
	ethereum: EthereumClientService,
	pendingInput: PendingTransactionOrSignableMessage,
	refreshedSafeSignerSelection?: RefreshedSafeSignerSelection,
): Promise<SafeConfirmationResolution> {
	let pending = pendingInput
	let pendingChanged = false
	const selectedSigner = refreshedSafeSignerSelection?.verificationError === undefined
		? refreshedSafeSignerSelection?.selectedSigner
		: undefined

	try {
		await assertSafeProposalReviewPrerequisites(ethereum, pending)
	} catch(error) {
		return {
			status: 'blocked',
			approvalStatus: createSafeSignerErrorStatus(`Gnosis Safe proposal could not be prepared: ${ getErrorMessage(error) ?? 'The wallet-selected Safe owner changed.' }`),
		}
	}
	if (
		!pending.simulationMode
		&& pending.type === 'Transaction'
		&& pending.safeTransaction !== undefined
		&& selectedSigner !== undefined
		&& (
			pending.safeTransaction.safeSignerAddress !== selectedSigner
			|| pending.approvalStatus.status === 'SignerError' && pending.approvalStatus.code === SAFE_SIGNER_SELECTION_ERROR_CODE
		)
	) {
		const proposalRefresh = await refreshSafeSignerSelection(ethereum, pending, selectedSigner)
		if (proposalRefresh.status === 'blocked') return proposalRefresh
		if (proposalRefresh.status === 'refreshed') {
			pending = proposalRefresh.pending
			pendingChanged = true
		}
	}

	const mismatch = await getSafeSignerSelectionError(pending, refreshedSafeSignerSelection)
	if (mismatch !== undefined) return { status: 'blocked', approvalStatus: mismatch }

	try {
		const refreshedProposal = await refreshSafeProposalNonce(ethereum, pending)
		if (refreshedProposal !== undefined) return { status: 'refreshed', pending: refreshedProposal }
	} catch (error) {
		return {
			status: 'blocked',
			approvalStatus: createSafeSignerErrorStatus(`Gnosis Safe proposal could not be prepared: ${ getErrorMessage(error) ?? 'Failed to refresh the Gnosis Safe nonce.' }`),
		}
	}

	return { status: 'ready', pending, pendingChanged, signerFacingRequest: getSafeSignerFacingRequest(pending, undefined) }
}

export async function resolveSafeConfirmation(
	ethereum: EthereumClientService,
	pending: PendingTransactionOrSignableMessage,
	action: TransactionConfirmationAction,
	refreshedSafeSignerSelection?: RefreshedSafeSignerSelection,
): Promise<SafeConfirmationResolution> {
	if (action !== 'accept') return { status: 'ready', pending, pendingChanged: false, signerFacingRequest: undefined }
	if (pending.type === 'Transaction' && pending.safeExecutionOriginalRequestParameters !== undefined) {
		return await resolveDirectSafeExecutionConfirmation(ethereum, pending, refreshedSafeSignerSelection)
	}
	if (pending.type === 'SignableMessage' && pending.safeMessageCoSignSnapshot !== undefined) {
		return await resolveSafeCoSignConfirmation(ethereum, pending, refreshedSafeSignerSelection)
	}
	if (pending.type === 'Transaction' && pending.safeTransaction !== undefined) {
		return await resolveSafeProposalConfirmation(ethereum, pending, refreshedSafeSignerSelection)
	}
	return { status: 'ready', pending, pendingChanged: false, signerFacingRequest: undefined }
}

type TransactionConfirmationAction = 'accept' | 'reject' | 'noResponse' | 'signerIncluded'
