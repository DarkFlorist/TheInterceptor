import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import { EIP712Message } from '../types/eip721.js'
import type { SignMessageParams } from '../types/jsonRpc-signing-types.js'
import { getErrorMessage } from '../utils/caughtErrors.js'
import { getPrettySignerName } from '../utils/signerMetadata.js'
import { getWalletSelectedAccount } from '../utils/activeAddressSelection.js'
import { modifyObject } from '../utils/typescript.js'
import { getPendingTransactionsAndMessages, getSafeTransactionStacks, getTabState } from './storageVariables.js'
import { assertSafeContractStateUnchanged, createSafeOwnerValidationFailure, createSafeTransactionSigningRequest, getSafeContractState, isSafeContractValidationFailure, isSafeOwnerValidationFailure, safeTxToTypedDataJson, validateSafeTransactionForSigning } from '../safe/safeCore.js'
import { reconcileSafeTransactionStack } from '../safe/safeStack.js'
import type { SafeTx } from '../types/personal-message-definitions.js'
import type { SafeSignerErrorDetails } from '../types/safeTypes.js'
import { createSafeSignerErrorStatus, type SafeSignerErrorStatus } from './safeSignerErrors.js'
import { createSafeValidationError, hasSafeValidationErrorCode } from '../safe/safeErrors.js'
import { getCurrentSafeEntry, getCurrentSafeEntryAndAddressBookEntries, getSafeMessageCoSignContext, handleSafeExecutionRefreshFailure, refreshSafeExecutionSignerSelection, refreshSafeSignerSelection, SAFE_SIGNER_SELECTION_ERROR_CODE, type SafeMessageCoSignContext } from './safeSignerSelectionRefresh.js'
import { getSafeFlowSignerAddress, getSafePendingFlow, type DirectSafeExecutionFlow, type SafeMessageCoSignFlow, type SafePendingFlow, type SafeProposalFlow } from '../safe/safePendingFlow.js'

export { SAFE_SIGNER_SELECTION_ERROR_CODE } from './safeSignerSelectionRefresh.js'

function createSafeSignerSelectionFailure(message: string) {
	return createSafeValidationError(message, 'safe_signer_selection')
}

function isExpectedSafeConfirmationFailure(error: unknown) {
	return isSafeSignerSelectionFailure(error)
		|| isSafeContractValidationFailure(error)
		|| isSafeOwnerValidationFailure(error)
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

export function isExpectedSafeMessageCoSignSnapshotFailure(error: unknown): error is Error {
	return isSafeMessageAccountMismatchFailure(error) || isSafeContractValidationFailure(error)
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
	const flow = getSafePendingFlow(pending)
	return flow === undefined ? undefined : getSafeFlowSignerAddress(flow)
}

export async function createSafeMessageCoSignSnapshot(
	ethereum: EthereumClientService,
	activeAddress: bigint,
	walletSignerAddress: bigint | undefined,
	transactionParams: SignMessageParams,
	safeTx: SafeTx,
) {
	if (transactionParams.method !== 'eth_signTypedData_v4') throw createSafeSignerSelectionFailure('Gnosis Safe co-signing requires eth_signTypedData_v4.')
	const [requestedAccount] = transactionParams.params
	const { safeEntry, addressBookEntries } = await getCurrentSafeEntryAndAddressBookEntries(ethereum, activeAddress)
	if (requestedAccount !== activeAddress || safeTx.domain.verifyingContract !== activeAddress) {
		let safeOwners: readonly bigint[] = []
		let safeOwnersUnavailableReason: string | undefined
			try {
				safeOwners = (await getSafeContractState(ethereum, activeAddress)).owners
			} catch (error) {
				if (!isSafeContractValidationFailure(error)) throw error
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
		throw createSafeSignerSelectionFailure('Re-save the active Gnosis Safe address-book entry to verify and record its current Gnosis Safe version before co-signing.')
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
	const flow = getSafePendingFlow(pending)
	const currentCoSignContext = flow?.kind === 'messageCoSign'
		? await getSafeMessageCoSignContext(ethereum, flow)
		: undefined
	if (currentCoSignContext === undefined) throw createSafeSignerSelectionFailure('This Gnosis Safe transaction is not eligible for Interceptor co-signing.')
	if (typeof signerReply !== 'string') throw createSafeOwnerValidationFailure('The signer returned a non-string Gnosis Safe owner signature.')
	const ownerSignature = await currentCoSignContext.ownerValidator.validateSignature(
		currentCoSignContext.safeTxHash,
		signerReply,
		currentCoSignContext.safeSignerAddress,
	)
	return ownerSignature.signature
}

async function getRequiredSafeCoSignContext(
	ethereum: EthereumClientService,
	flow: SafeMessageCoSignFlow,
) {
	const pending = flow.pending
	if (
		pending.transactionOrMessageCreationStatus !== 'Simulated'
		|| pending.visualizedPersonalSignRequest.type !== 'SafeTx'
	) return undefined
	const context = await getSafeMessageCoSignContext(ethereum, flow)
	if (context === undefined) throw createSafeSignerSelectionFailure('This Gnosis Safe transaction is not eligible for Interceptor co-signing.')
	return context
}

async function assertSafeProposalReviewPrerequisites(
	ethereum: EthereumClientService,
	flow: SafeProposalFlow,
) {
	const pending = flow.pending
	if (pending.simulationMode) return undefined
	if (pending.safeTransaction.reviewedSafeState === undefined) {
		throw createSafeSignerSelectionFailure('Review this Gnosis Safe proposal again so its current owners, threshold, nonce, and signer can be verified.')
	}
	await getCurrentSafeEntry(ethereum, pending.safeTransaction.safeAddress)
	return undefined
}

async function getSafeSignerSelectionError(
	pending: PendingTransactionOrSignableMessage,
	refreshedSafeSignerSelection?: RefreshedSafeSignerSelection,
) {
	if (pending.simulationMode) return undefined
	const flow = getSafePendingFlow(pending)
	if (flow === undefined) return undefined
	const safeSignerAddress = getSafeFlowSignerAddress(flow)
	if (safeSignerAddress === undefined) {
		if (flow.kind !== 'proposal') return undefined
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
	flow: SafeProposalFlow,
) {
	const pending = flow.pending
	if (pending.simulationMode) return undefined
	const currentRequest = pending.safeTransaction
	const safeState = await getSafeContractState(ethereum, currentRequest.safeAddress)
	if (currentRequest.reviewedSafeState === undefined) throw createSafeSignerSelectionFailure('The reviewed Gnosis Safe state is unavailable.')
	assertSafeContractStateUnchanged(currentRequest.reviewedSafeState, safeState)
	const storedStackBeforeReconciliation = (await getSafeTransactionStacks()).find((stack) =>
		stack.chainId === ethereum.getChainId() && stack.safeAddress === currentRequest.safeAddress
	)
	const storedStack = storedStackBeforeReconciliation === undefined
		? undefined
		: reconcileSafeTransactionStack(storedStackBeforeReconciliation, safeState.nonce)
	const firstUncommittedNonce = safeState.nonce + BigInt(storedStack?.transactions.length ?? 0)
	const precedingPendingCount = (await getPendingTransactionsAndMessages()).filter((candidate) => {
		const candidateFlow = getSafePendingFlow(candidate)
		if (candidateFlow?.kind !== 'proposal') return false
		const candidateRequest = candidateFlow.pending.safeTransaction
		return candidateRequest.safeAddress === currentRequest.safeAddress
			&& candidateRequest.safeTx.domain.chainId === ethereum.getChainId()
			&& candidateRequest.safeTx.message.nonce >= firstUncommittedNonce
			&& candidateRequest.safeTx.message.nonce < currentRequest.safeTx.message.nonce
	}).length
	if (precedingPendingCount > 0) throw createSafeSignerSelectionFailure('Approve or reject the earlier pending Gnosis Safe proposals before signing this one.')
	if (currentRequest.safeTx.message.nonce === firstUncommittedNonce) return undefined
	const executionGasLimit = currentRequest.executionGasLimit ?? (
		'transactionToSimulate' in pending && pending.transactionToSimulate.success
			? pending.transactionToSimulate.transaction.gas
			: undefined
	)
	if (executionGasLimit === undefined) throw createSafeSignerSelectionFailure('The pending Gnosis Safe proposal is missing its execution gas limit.')
	if (currentRequest.safeSignerAddress === undefined) throw createSafeSignerSelectionFailure('Connect a signer wallet and select a current Gnosis Safe owner before signing.')
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
	flow: SafePendingFlow,
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
	if (flow.kind !== 'proposal' || flow.pending.safeTransaction.safeSignerAddress === undefined) return undefined
	return {
		method: 'eth_signTypedData_v4',
		params: [
			flow.pending.safeTransaction.safeSignerAddress,
			EIP712Message.parse(safeTxToTypedDataJson(flow.pending.safeTransaction.safeTx)),
		],
	}
}

async function resolveDirectSafeExecutionConfirmation(
	ethereum: EthereumClientService,
	flow: DirectSafeExecutionFlow,
	refreshedSafeSignerSelection?: RefreshedSafeSignerSelection,
): Promise<SafeConfirmationResolution> {
	const pending = flow.pending
	try {
		const refreshedExecution = await refreshSafeExecutionSignerSelection(ethereum, flow)
		if (refreshedExecution === undefined) return { status: 'ready', pending, pendingChanged: false, signerFacingRequest: undefined }
		const mismatch = await getSafeSignerSelectionError(refreshedExecution, refreshedSafeSignerSelection)
		if (mismatch !== undefined) return { status: 'blocked', approvalStatus: mismatch }
		return { status: 'ready', pending: refreshedExecution, pendingChanged: true, signerFacingRequest: undefined }
	} catch(error) {
		return handleSafeExecutionRefreshFailure(error)
	}
}

async function resolveSafeCoSignConfirmation(
	ethereum: EthereumClientService,
	flowInput: SafeMessageCoSignFlow,
	refreshedSafeSignerSelection?: RefreshedSafeSignerSelection,
): Promise<SafeConfirmationResolution> {
	let flow = flowInput
	let pending: PendingTransactionOrSignableMessage = flow.pending
	let pendingChanged = false
	const selectedSigner = refreshedSafeSignerSelection?.verificationError === undefined
		? refreshedSafeSignerSelection?.selectedSigner
		: undefined
	if (selectedSigner !== undefined && flow.pending.safeMessageCoSignSnapshot.safeSignerAddress !== selectedSigner) {
		const coSignRefresh = await refreshSafeSignerSelection(ethereum, flow, selectedSigner)
		if (coSignRefresh.status === 'blocked') return coSignRefresh
		if (coSignRefresh.status === 'refreshed') {
			pending = coSignRefresh.pending
			const refreshedFlow = getSafePendingFlow(pending)
			if (refreshedFlow?.kind !== 'messageCoSign') {
				return { status: 'blocked', approvalStatus: createSafeSignerErrorStatus('The Gnosis Safe co-signing request changed while its signer was refreshed.') }
			}
			flow = refreshedFlow
			pendingChanged = true
		}
	}

	let coSignContext: SafeMessageCoSignContext | undefined
	try {
		coSignContext = await getRequiredSafeCoSignContext(ethereum, flow)
	} catch (error) {
		if (!isExpectedSafeConfirmationFailure(error)) throw error
		return {
			status: 'blocked',
			approvalStatus: createSafeSignerErrorStatus(`Gnosis Safe co-signing request was rejected: ${ getErrorMessage(error) ?? 'The Gnosis Safe transaction could not be validated.' }`),
		}
	}
	const mismatch = await getSafeSignerSelectionError(pending, refreshedSafeSignerSelection)
	if (mismatch !== undefined) return { status: 'blocked', approvalStatus: mismatch }
	return { status: 'ready', pending, pendingChanged, signerFacingRequest: getSafeSignerFacingRequest(flow, coSignContext) }
}

async function resolveSafeProposalConfirmation(
	ethereum: EthereumClientService,
	flowInput: SafeProposalFlow,
	refreshedSafeSignerSelection?: RefreshedSafeSignerSelection,
): Promise<SafeConfirmationResolution> {
	let flow = flowInput
	let pending: PendingTransactionOrSignableMessage = flow.pending
	let pendingChanged = false
	const selectedSigner = refreshedSafeSignerSelection?.verificationError === undefined
		? refreshedSafeSignerSelection?.selectedSigner
		: undefined

	try {
		await assertSafeProposalReviewPrerequisites(ethereum, flow)
	} catch(error) {
		if (!isExpectedSafeConfirmationFailure(error)) throw error
		return {
			status: 'blocked',
			approvalStatus: createSafeSignerErrorStatus(`Gnosis Safe proposal could not be prepared: ${ getErrorMessage(error) ?? 'The wallet-selected Safe owner changed.' }`),
		}
	}
	if (
		!flow.pending.simulationMode
		&& selectedSigner !== undefined
		&& (
			flow.pending.safeTransaction.safeSignerAddress !== selectedSigner
			|| flow.pending.approvalStatus.status === 'SignerError' && flow.pending.approvalStatus.code === SAFE_SIGNER_SELECTION_ERROR_CODE
		)
	) {
		const proposalRefresh = await refreshSafeSignerSelection(ethereum, flow, selectedSigner)
		if (proposalRefresh.status === 'blocked') return proposalRefresh
		if (proposalRefresh.status === 'refreshed') {
			pending = proposalRefresh.pending
			const refreshedFlow = getSafePendingFlow(pending)
			if (refreshedFlow?.kind !== 'proposal') {
				return { status: 'blocked', approvalStatus: createSafeSignerErrorStatus('The Gnosis Safe proposal changed while its signer was refreshed.') }
			}
			flow = refreshedFlow
			pendingChanged = true
		}
	}

	const mismatch = await getSafeSignerSelectionError(pending, refreshedSafeSignerSelection)
	if (mismatch !== undefined) return { status: 'blocked', approvalStatus: mismatch }

	try {
		const refreshedProposal = await refreshSafeProposalNonce(ethereum, flow)
		if (refreshedProposal !== undefined) return { status: 'refreshed', pending: refreshedProposal }
	} catch (error) {
		if (!isExpectedSafeConfirmationFailure(error)) throw error
		return {
			status: 'blocked',
			approvalStatus: createSafeSignerErrorStatus(`Gnosis Safe proposal could not be prepared: ${ getErrorMessage(error) ?? 'Failed to refresh the Gnosis Safe nonce.' }`),
		}
	}

	return { status: 'ready', pending, pendingChanged, signerFacingRequest: getSafeSignerFacingRequest(flow, undefined) }
}

export async function resolveSafeConfirmation(
	ethereum: EthereumClientService,
	pending: PendingTransactionOrSignableMessage,
	action: TransactionConfirmationAction,
	refreshedSafeSignerSelection?: RefreshedSafeSignerSelection,
): Promise<SafeConfirmationResolution> {
	if (action !== 'accept') return { status: 'ready', pending, pendingChanged: false, signerFacingRequest: undefined }
	const flow = getSafePendingFlow(pending)
	if (flow === undefined) return { status: 'ready', pending, pendingChanged: false, signerFacingRequest: undefined }
	switch (flow.kind) {
		case 'directExecution': return await resolveDirectSafeExecutionConfirmation(ethereum, flow, refreshedSafeSignerSelection)
		case 'messageCoSign': return await resolveSafeCoSignConfirmation(ethereum, flow, refreshedSafeSignerSelection)
		case 'proposal': return await resolveSafeProposalConfirmation(ethereum, flow, refreshedSafeSignerSelection)
	}
}

type TransactionConfirmationAction = 'accept' | 'reject' | 'noResponse' | 'signerIncluded'
