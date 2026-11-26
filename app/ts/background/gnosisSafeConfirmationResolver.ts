import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import { EIP712Message } from '../types/eip721.js'
import type { SignMessageParams } from '../types/jsonRpc-signing-types.js'
import { getErrorMessage } from '../utils/caughtErrors.js'
import { getPrettySignerName } from '../utils/signerMetadata.js'
import { getWalletSelectedAccount } from '../utils/activeAddressSelection.js'
import { modifyObject } from '../utils/typescript.js'
import { getPendingTransactionsAndMessages, getGnosisSafeTransactionStacks, getTabState } from './storageVariables.js'
import { assertGnosisSafeContractStateUnchanged, assertGnosisSafeProposalChainMatchesConnectedNetwork, createGnosisSafeOwnerValidationFailure, createGnosisSafeTransactionSigningRequest, getGnosisSafeContractState, getGnosisSafeTxSignerFacingTypedData, isGnosisSafeContractValidationFailure, isGnosisSafeOwnerValidationFailure, validateGnosisSafeTransactionForSigning } from '../gnosisSafe/gnosisSafeCore.js'
import { reconcileGnosisSafeTransactionStack } from '../gnosisSafe/gnosisSafeStack.js'
import type { GnosisSafeTx } from '../types/personal-message-definitions.js'
import type { GnosisSafeSignerErrorDetails } from '../types/gnosisSafeTypes.js'
import { createGnosisSafeSignerErrorStatus, type GnosisSafeSignerErrorStatus } from './gnosisSafeSignerErrors.js'
import { createGnosisSafeValidationError, hasGnosisSafeValidationErrorCode } from '../gnosisSafe/gnosisSafeErrors.js'
import { getCurrentGnosisSafeEntry, getCurrentGnosisSafeEntryAndAddressBookEntries, getGnosisSafeMessageCoSignContext, handleGnosisSafeExecutionRefreshFailure, refreshGnosisSafeExecutionSignerSelection, refreshGnosisSafeSignerSelection, GNOSIS_SAFE_SIGNER_SELECTION_ERROR_CODE, type GnosisSafeMessageCoSignContext } from './gnosisSafeSignerSelectionRefresh.js'
import { createCreatedGnosisSafeProposalGnosisSafeFlow, getGnosisSafeFlowSignerAddress, getGnosisSafePendingFlow, type DirectGnosisSafeExecutionFlow, type GnosisSafeMessageCoSignFlow, type GnosisSafePendingFlow, type GnosisSafeProposalFlow } from '../gnosisSafe/gnosisSafePendingFlow.js'

export { GNOSIS_SAFE_SIGNER_SELECTION_ERROR_CODE } from './gnosisSafeSignerSelectionRefresh.js'

function createGnosisSafeSignerSelectionFailure(message: string) {
	return createGnosisSafeValidationError(message, 'safe_signer_selection')
}

function isExpectedGnosisSafeConfirmationFailure(error: unknown) {
	return isGnosisSafeSignerSelectionFailure(error)
		|| isGnosisSafeContractValidationFailure(error)
		|| isGnosisSafeOwnerValidationFailure(error)
}

export function isGnosisSafeSignerSelectionFailure(error: unknown) {
	return hasGnosisSafeValidationErrorCode(error, 'safe_signer_selection')
}

function createGnosisSafeMessageAccountMismatchFailure(message: string, safeSignerErrorDetails: GnosisSafeSignerErrorDetails) {
	return Object.assign(createGnosisSafeValidationError(message, 'safe_message_account_mismatch'), { safeSignerErrorDetails })
}

export function isGnosisSafeMessageAccountMismatchFailure(error: unknown): error is Error & { readonly safeSignerErrorDetails: GnosisSafeSignerErrorDetails } {
	return hasGnosisSafeValidationErrorCode(error, 'safe_message_account_mismatch')
		&& 'safeSignerErrorDetails' in error
}

export function isExpectedGnosisSafeMessageCoSignSnapshotFailure(error: unknown): error is Error {
	return isGnosisSafeMessageAccountMismatchFailure(error) || isGnosisSafeContractValidationFailure(error)
}

export type RefreshedGnosisSafeSignerSelection = {
	readonly selectedSigner: bigint | undefined
	readonly verificationError: string | undefined
}

export type GnosisSafeConfirmationResolution =
	| {
		readonly status: 'ready'
		readonly pending: PendingTransactionOrSignableMessage
		readonly pendingChanged: boolean
		readonly signerFacingRequest: SignMessageParams | undefined
	}
	| {
		readonly status: 'blocked'
		readonly approvalStatus: GnosisSafeSignerErrorStatus
	}
	| {
		readonly status: 'refreshed'
		readonly pending: PendingTransactionOrSignableMessage
	}

export async function getGnosisSafeSignerMismatchApprovalStatus(
	tabId: number,
	reviewedSafeSigner: bigint,
	refreshedSelection?: RefreshedGnosisSafeSignerSelection,
) {
	const tabState = await getTabState(tabId)
	const signerName = getPrettySignerName(tabState.signerName)
	const selectedSigner = refreshedSelection === undefined
		? getWalletSelectedAccount(tabState)
		: refreshedSelection.selectedSigner
	if (selectedSigner === reviewedSafeSigner) return undefined
	const safeSignerErrorDetails: GnosisSafeSignerErrorDetails = {
		kind: 'safeOwnerMismatch',
		expectedOwner: reviewedSafeSigner,
		...(selectedSigner === undefined ? {} : { walletAccount: selectedSigner }),
	}
	if (refreshedSelection?.verificationError !== undefined) {
		return createGnosisSafeSignerErrorStatus(
			`The wallet-selected Gnosis Safe owner could not be verified: ${ refreshedSelection.verificationError } Select the expected owner in ${ signerName }, then retry.`,
			GNOSIS_SAFE_SIGNER_SELECTION_ERROR_CODE,
			safeSignerErrorDetails,
		)
	}
	const selectedAccountDescription = selectedSigner === undefined
		? 'no account selected'
		: 'a different account selected'
	return createGnosisSafeSignerErrorStatus(
		`Gnosis Safe owner mismatch: this request expects a different owner, but ${ signerName } currently has ${ selectedAccountDescription }. Select the expected owner in ${ signerName }, then retry.`,
		GNOSIS_SAFE_SIGNER_SELECTION_ERROR_CODE,
		safeSignerErrorDetails,
	)
}

export function getPendingGnosisSafeSignerAddress(pending: PendingTransactionOrSignableMessage) {
	const flow = getGnosisSafePendingFlow(pending)
	return flow === undefined ? undefined : getGnosisSafeFlowSignerAddress(flow)
}

export async function createGnosisSafeMessageCoSignSnapshot(
	ethereum: EthereumClientService,
	activeAddress: bigint,
	walletSignerAddress: bigint | undefined,
	transactionParams: SignMessageParams,
	safeTx: GnosisSafeTx,
) {
	if (transactionParams.method !== 'eth_signTypedData_v4') throw createGnosisSafeSignerSelectionFailure('Gnosis Safe co-signing requires eth_signTypedData_v4.')
	const [requestedAccount] = transactionParams.params
	const { safeEntry, addressBookEntries } = await getCurrentGnosisSafeEntryAndAddressBookEntries(ethereum, activeAddress)
	if (requestedAccount !== activeAddress || safeTx.domain.verifyingContract !== activeAddress) {
		let safeOwners: readonly bigint[] = []
		let safeOwnersUnavailableReason: string | undefined
			try {
				safeOwners = (await getGnosisSafeContractState(ethereum, activeAddress)).owners
			} catch (error) {
				if (!isGnosisSafeContractValidationFailure(error)) throw error
				safeOwnersUnavailableReason = getErrorMessage(error) ?? 'The current owner list could not be loaded.'
		}
		const safeOwnerSet = new Set(safeOwners)
		throw createGnosisSafeMessageAccountMismatchFailure(
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
	// Signing deliberately ignores stored simulation/owner preferences: the wallet selection is refreshed before forwarding and validated against current on-chain Gnosis Safe state.
	if (walletSignerAddress === undefined) {
		throw createGnosisSafeSignerSelectionFailure('Connect a signer wallet and select a Gnosis Safe owner before co-signing.')
	}
	if (safeEntry.safeVersion === undefined) {
		throw createGnosisSafeSignerSelectionFailure('Re-save the active Gnosis Safe address-book entry to verify and record its current Gnosis Safe version before co-signing.')
	}
	let validatedSafeTransaction: Awaited<ReturnType<typeof validateGnosisSafeTransactionForSigning>>
	try {
		validatedSafeTransaction = await validateGnosisSafeTransactionForSigning(
			ethereum,
			safeEntry.address,
			walletSignerAddress,
			safeTx,
			safeEntry.safeVersion,
		)
	} catch(error) {
		if (isGnosisSafeOwnerValidationFailure(error)) {
			throw createGnosisSafeSignerSelectionFailure(getErrorMessage(error) ?? 'Select a current Gnosis Safe owner in the signer wallet before co-signing.')
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

export async function validateGnosisSafeMessageCoSignature(
	ethereum: EthereumClientService,
	pending: PendingTransactionOrSignableMessage,
	signerReply: unknown,
) {
	const flow = getGnosisSafePendingFlow(pending)
	const currentCoSignContext = flow?.kind === 'messageCoSign'
		? await getGnosisSafeMessageCoSignContext(ethereum, flow)
		: undefined
	if (currentCoSignContext === undefined) throw createGnosisSafeSignerSelectionFailure('This Gnosis Safe transaction is not eligible for Interceptor co-signing.')
	if (typeof signerReply !== 'string') throw createGnosisSafeOwnerValidationFailure('The signer returned a non-string Gnosis Safe owner signature.')
	const ownerSignature = await currentCoSignContext.ownerValidator.validateSignature(
		currentCoSignContext.signingHash,
		signerReply,
		currentCoSignContext.safeSignerAddress,
	)
	return ownerSignature.signature
}

async function getRequiredGnosisSafeCoSignContext(
	ethereum: EthereumClientService,
	flow: GnosisSafeMessageCoSignFlow,
) {
	const pending = flow.pending
	if (pending.transactionOrMessageCreationStatus !== 'Simulated') return undefined
	const context = await getGnosisSafeMessageCoSignContext(ethereum, flow)
	if (context === undefined) throw createGnosisSafeSignerSelectionFailure('This Gnosis Safe transaction is not eligible for Interceptor co-signing.')
	return context
}

async function assertGnosisSafeProposalReviewPrerequisites(
	ethereum: EthereumClientService,
	flow: GnosisSafeProposalFlow,
) {
	const pending = flow.pending
	assertGnosisSafeProposalChainMatchesConnectedNetwork(ethereum, pending.safeFlow.safeTransaction.safeTx)
	if (pending.simulationMode) return undefined
	if (pending.safeFlow.safeTransaction.reviewedSafeState === undefined) {
		throw createGnosisSafeSignerSelectionFailure('Review this Gnosis Safe proposal again so its current owners, threshold, nonce, and signer can be verified.')
	}
	await getCurrentGnosisSafeEntry(ethereum, pending.safeFlow.safeTransaction.safeAddress)
	return undefined
}

async function getGnosisSafeSignerSelectionError(
	pending: PendingTransactionOrSignableMessage,
	refreshedSafeSignerSelection?: RefreshedGnosisSafeSignerSelection,
) {
	if (pending.simulationMode) return undefined
	const flow = getGnosisSafePendingFlow(pending)
	if (flow === undefined) return undefined
	const safeSignerAddress = getGnosisSafeFlowSignerAddress(flow)
	if (safeSignerAddress === undefined) {
		if (flow.kind !== 'proposal') return undefined
		return createGnosisSafeSignerErrorStatus(
			refreshedSafeSignerSelection?.verificationError === undefined
				? 'Connect a signer wallet and select a current Gnosis Safe owner before signing.'
				: `The wallet-selected Gnosis Safe owner could not be verified: ${ refreshedSafeSignerSelection.verificationError }`,
			GNOSIS_SAFE_SIGNER_SELECTION_ERROR_CODE,
		)
	}
	return await getGnosisSafeSignerMismatchApprovalStatus(
		pending.uniqueRequestIdentifier.requestSocket.tabId,
		safeSignerAddress,
		refreshedSafeSignerSelection,
	)
}

async function refreshGnosisSafeProposalNonce(
	ethereum: EthereumClientService,
	flow: GnosisSafeProposalFlow,
) {
	const pending = flow.pending
	if (pending.simulationMode) return undefined
	const currentRequest = pending.safeFlow.safeTransaction
	const safeState = await getGnosisSafeContractState(ethereum, currentRequest.safeAddress)
	if (currentRequest.reviewedSafeState === undefined) throw createGnosisSafeSignerSelectionFailure('The reviewed Gnosis Safe state is unavailable.')
	assertGnosisSafeContractStateUnchanged(currentRequest.reviewedSafeState, safeState)
	const storedStackBeforeReconciliation = (await getGnosisSafeTransactionStacks()).find((stack) =>
		stack.chainId === ethereum.getChainId() && stack.safeAddress === currentRequest.safeAddress
	)
	const storedStack = storedStackBeforeReconciliation === undefined
		? undefined
		: reconcileGnosisSafeTransactionStack(storedStackBeforeReconciliation, safeState.nonce)
	const firstUncommittedNonce = safeState.nonce + BigInt(storedStack?.transactions.length ?? 0)
	const precedingPendingCount = (await getPendingTransactionsAndMessages()).filter((candidate) => {
		const candidateFlow = getGnosisSafePendingFlow(candidate)
		if (candidateFlow?.kind !== 'proposal') return false
		const candidateRequest = candidateFlow.pending.safeFlow.safeTransaction
		return candidateRequest.safeAddress === currentRequest.safeAddress
			&& candidateRequest.safeTx.domain.chainId === ethereum.getChainId()
			&& candidateRequest.safeTx.message.nonce >= firstUncommittedNonce
			&& candidateRequest.safeTx.message.nonce < currentRequest.safeTx.message.nonce
	}).length
	if (precedingPendingCount > 0) throw createGnosisSafeSignerSelectionFailure('Approve or reject the earlier pending Gnosis Safe proposals before signing this one.')
	if (currentRequest.safeTx.message.nonce === firstUncommittedNonce) return undefined
	const executionGasLimit = currentRequest.executionGasLimit ?? (
		'transactionToSimulate' in pending && pending.transactionToSimulate.success
			? pending.transactionToSimulate.transaction.gas
			: undefined
	)
	if (executionGasLimit === undefined) throw createGnosisSafeSignerSelectionFailure('The pending Gnosis Safe proposal is missing its execution gas limit.')
	if (currentRequest.safeSignerAddress === undefined) throw createGnosisSafeSignerSelectionFailure('Connect a signer wallet and select a current Gnosis Safe owner before signing.')
	const refreshedSafeRequest = await createGnosisSafeTransactionSigningRequest(
		ethereum,
		currentRequest.safeAddress,
		currentRequest.safeSignerAddress,
		{
			to: currentRequest.safeTx.message.to,
			value: currentRequest.safeTx.message.value,
			input: currentRequest.safeTx.message.data,
			operation: currentRequest.safeTx.message.operation,
			gas: executionGasLimit,
		},
		firstUncommittedNonce,
	)
	return modifyObject(pending, { safeFlow: createCreatedGnosisSafeProposalGnosisSafeFlow({ ...refreshedSafeRequest, ...(currentRequest.messageReview !== undefined ? { messageReview: currentRequest.messageReview } : {}) }) })
}

function getGnosisSafeSignerFacingRequest(
	flow: GnosisSafePendingFlow,
	coSignContext: GnosisSafeMessageCoSignContext | undefined,
): SignMessageParams | undefined {
	if (coSignContext !== undefined) {
		const { types, primaryType, domain, message } = coSignContext.typedData
		return {
			method: 'eth_signTypedData_v4',
			params: [
				coSignContext.safeSignerAddress,
				EIP712Message.parse(JSON.stringify({ types, primaryType, domain, message })),
			],
		}
	}
	if (flow.kind !== 'proposal' || flow.pending.safeFlow.safeTransaction.safeSignerAddress === undefined) return undefined
	return {
		method: 'eth_signTypedData_v4',
		params: [
			flow.pending.safeFlow.safeTransaction.safeSignerAddress,
			getGnosisSafeTxSignerFacingTypedData(flow.pending.safeFlow.safeTransaction.safeTx),
		],
	}
}

async function resolveDirectGnosisSafeExecutionConfirmation(
	ethereum: EthereumClientService,
	flow: DirectGnosisSafeExecutionFlow,
	refreshedSafeSignerSelection?: RefreshedGnosisSafeSignerSelection,
): Promise<GnosisSafeConfirmationResolution> {
	const pending = flow.pending
	try {
		const refreshedExecution = await refreshGnosisSafeExecutionSignerSelection(ethereum, flow)
		if (refreshedExecution === undefined) return { status: 'ready', pending, pendingChanged: false, signerFacingRequest: undefined }
		const mismatch = await getGnosisSafeSignerSelectionError(refreshedExecution, refreshedSafeSignerSelection)
		if (mismatch !== undefined) return { status: 'blocked', approvalStatus: mismatch }
		return { status: 'ready', pending: refreshedExecution, pendingChanged: true, signerFacingRequest: undefined }
	} catch(error) {
		return handleGnosisSafeExecutionRefreshFailure(error)
	}
}

async function resolveGnosisSafeCoSignConfirmation(
	ethereum: EthereumClientService,
	flowInput: GnosisSafeMessageCoSignFlow,
	refreshedSafeSignerSelection?: RefreshedGnosisSafeSignerSelection,
): Promise<GnosisSafeConfirmationResolution> {
	let flow = flowInput
	let pending: PendingTransactionOrSignableMessage = flow.pending
	let pendingChanged = false
	const selectedSigner = refreshedSafeSignerSelection?.verificationError === undefined
		? refreshedSafeSignerSelection?.selectedSigner
		: undefined
	if (selectedSigner !== undefined && flow.pending.safeMessageCoSignSnapshot.safeSignerAddress !== selectedSigner) {
		const coSignRefresh = await refreshGnosisSafeSignerSelection(ethereum, flow, selectedSigner)
		if (coSignRefresh.status === 'blocked') return coSignRefresh
		if (coSignRefresh.status === 'refreshed') {
			pending = coSignRefresh.pending
			const refreshedFlow = getGnosisSafePendingFlow(pending)
			if (refreshedFlow?.kind !== 'messageCoSign') {
				return { status: 'blocked', approvalStatus: createGnosisSafeSignerErrorStatus('The Gnosis Safe co-signing request changed while its signer was refreshed.') }
			}
			flow = refreshedFlow
			pendingChanged = true
		}
	}

	let coSignContext: GnosisSafeMessageCoSignContext | undefined
	try {
		coSignContext = await getRequiredGnosisSafeCoSignContext(ethereum, flow)
	} catch (error) {
		if (!isExpectedGnosisSafeConfirmationFailure(error)) throw error
		return {
			status: 'blocked',
			approvalStatus: createGnosisSafeSignerErrorStatus(`Gnosis Safe co-signing request was rejected: ${ getErrorMessage(error) ?? 'The Gnosis Safe transaction could not be validated.' }`),
		}
	}
	const mismatch = await getGnosisSafeSignerSelectionError(pending, refreshedSafeSignerSelection)
	if (mismatch !== undefined) return { status: 'blocked', approvalStatus: mismatch }
	return { status: 'ready', pending, pendingChanged, signerFacingRequest: getGnosisSafeSignerFacingRequest(flow, coSignContext) }
}

async function resolveGnosisSafeProposalConfirmation(
	ethereum: EthereumClientService,
	flowInput: GnosisSafeProposalFlow,
	refreshedSafeSignerSelection?: RefreshedGnosisSafeSignerSelection,
): Promise<GnosisSafeConfirmationResolution> {
	let flow = flowInput
	let pending: PendingTransactionOrSignableMessage = flow.pending
	let pendingChanged = false
	const selectedSigner = refreshedSafeSignerSelection?.verificationError === undefined
		? refreshedSafeSignerSelection?.selectedSigner
		: undefined

	try {
		await assertGnosisSafeProposalReviewPrerequisites(ethereum, flow)
	} catch(error) {
		if (!isExpectedGnosisSafeConfirmationFailure(error)) throw error
		return {
			status: 'blocked',
			approvalStatus: createGnosisSafeSignerErrorStatus(`Gnosis Safe proposal could not be prepared: ${ getErrorMessage(error) ?? 'The wallet-selected Gnosis Safe owner changed.' }`),
		}
	}
	if (
		!flow.pending.simulationMode
		&& selectedSigner !== undefined
		&& (
			flow.pending.safeFlow.safeTransaction.safeSignerAddress !== selectedSigner
			|| flow.pending.approvalStatus.status === 'SignerError' && flow.pending.approvalStatus.code === GNOSIS_SAFE_SIGNER_SELECTION_ERROR_CODE
		)
	) {
		const proposalRefresh = await refreshGnosisSafeSignerSelection(ethereum, flow, selectedSigner)
		if (proposalRefresh.status === 'blocked') return proposalRefresh
		if (proposalRefresh.status === 'refreshed') {
			pending = proposalRefresh.pending
			const refreshedFlow = getGnosisSafePendingFlow(pending)
			if (refreshedFlow?.kind !== 'proposal') {
				return { status: 'blocked', approvalStatus: createGnosisSafeSignerErrorStatus('The Gnosis Safe proposal changed while its signer was refreshed.') }
			}
			flow = refreshedFlow
			pendingChanged = true
		}
	}

	const mismatch = await getGnosisSafeSignerSelectionError(pending, refreshedSafeSignerSelection)
	if (mismatch !== undefined) return { status: 'blocked', approvalStatus: mismatch }

	try {
		const refreshedProposal = await refreshGnosisSafeProposalNonce(ethereum, flow)
		if (refreshedProposal !== undefined) return { status: 'refreshed', pending: refreshedProposal }
	} catch (error) {
		if (!isExpectedGnosisSafeConfirmationFailure(error)) throw error
		return {
			status: 'blocked',
			approvalStatus: createGnosisSafeSignerErrorStatus(`Gnosis Safe proposal could not be prepared: ${ getErrorMessage(error) ?? 'Failed to refresh the Gnosis Safe nonce.' }`),
		}
	}

	return { status: 'ready', pending, pendingChanged, signerFacingRequest: getGnosisSafeSignerFacingRequest(flow, undefined) }
}

export async function resolveGnosisSafeConfirmation(
	ethereum: EthereumClientService,
	pending: PendingTransactionOrSignableMessage,
	action: TransactionConfirmationAction,
	refreshedSafeSignerSelection?: RefreshedGnosisSafeSignerSelection,
): Promise<GnosisSafeConfirmationResolution> {
	if (action !== 'accept') return { status: 'ready', pending, pendingChanged: false, signerFacingRequest: undefined }
	const flow = getGnosisSafePendingFlow(pending)
	if (flow === undefined) return { status: 'ready', pending, pendingChanged: false, signerFacingRequest: undefined }
	switch (flow.kind) {
		case 'directExecution': return await resolveDirectGnosisSafeExecutionConfirmation(ethereum, flow, refreshedSafeSignerSelection)
		case 'messageCoSign': return await resolveGnosisSafeCoSignConfirmation(ethereum, flow, refreshedSafeSignerSelection)
		case 'proposal': return await resolveGnosisSafeProposalConfirmation(ethereum, flow, refreshedSafeSignerSelection)
	}
}

type TransactionConfirmationAction = 'accept' | 'addToSafeStack' | 'reject' | 'noResponse' | 'signerIncluded'
