import * as funtypes from 'funtypes'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import type { SafeEntry } from '../types/addressBookTypes.js'
import { EIP712Message } from '../types/eip721.js'
import type { SignMessageParams } from '../types/jsonRpc-signing-types.js'
import { checksummedAddress } from '../utils/bigint.js'
import { getErrorMessage } from '../utils/errors.js'
import { getPrettySignerName, getWalletSelectedAccount } from '../utils/signerMetadata.js'
import { modifyObject } from '../utils/typescript.js'
import { getPendingTransactionsAndMessages, getSafeTransactionStacks, getTabState, getUserAddressBookEntriesForChainIdMorePreciseFirst } from './storageVariables.js'
import { assertSafeContractStateUnchanged, createSafeTransactionSigningRequest, getSafeContractState, safeTxToTypedDataJson, type SafeOwnerValidator, validateSafeTransactionForSigning } from '../safe/safeCore.js'
import { areSafeExecutionSignerRequestsEqual, prepareSafeExecutionSignerRoute } from '../safe/safeExecutionRouting.js'
import { reconcileSafeTransactionStack } from '../safe/safeStack.js'
import type { SafeTx } from '../types/personal-message-definitions.js'
import { createSafeSignerErrorStatus, type SafeSignerErrorStatus } from './safeSignerErrors.js'

export const SAFE_SIGNER_SELECTION_ERROR_CODE = -32010

type SafeMessageCoSignContext = {
	readonly safeEntry: SafeEntry
	readonly safeSignerAddress: bigint
	readonly safeTx: SafeTx
	readonly safeTxHash: bigint
	readonly ownerValidator: SafeOwnerValidator
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

async function getCurrentSafeEntry(ethereum: EthereumClientService, safeAddress: bigint) {
	const safeEntry = (await getUserAddressBookEntriesForChainIdMorePreciseFirst(ethereum.getChainId()))
		.find((entry) => entry.type === 'safe' && entry.address === safeAddress)
	if (safeEntry?.type !== 'safe') throw new Error('The Gnosis Safe is no longer configured in the address book.')
	return safeEntry
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
	const reviewedAddress = checksummedAddress(reviewedSafeSigner)
	if (refreshedSelection?.verificationError !== undefined) {
		return createSafeSignerErrorStatus(
			`The wallet-selected Gnosis Safe owner could not be verified: ${ refreshedSelection.verificationError } Select ${ reviewedAddress } in ${ signerName }, then retry.`,
			SAFE_SIGNER_SELECTION_ERROR_CODE,
		)
	}
	const selectedAccountDescription = selectedSigner === undefined
		? 'no account selected'
		: `${ checksummedAddress(selectedSigner) } selected`
	return createSafeSignerErrorStatus(
		`Gnosis Safe owner mismatch: this request was prepared for ${ reviewedAddress }, but ${ signerName } currently has ${ selectedAccountDescription }. Select ${ reviewedAddress } in ${ signerName }, then retry.`,
		SAFE_SIGNER_SELECTION_ERROR_CODE,
	)
}

export function getPendingSafeSignerAddress(pending: PendingTransactionOrSignableMessage) {
	if (pending.type === 'Transaction') {
		return pending.safeTransaction?.safeSignerAddress ?? pending.safeExecutionSignerAddress
	}
	return pending.safeMessageCoSignSnapshot?.safeSignerAddress
}

async function getSafeMessageCoSignContext(
	ethereum: EthereumClientService,
	pending: PendingTransactionOrSignableMessage,
): Promise<SafeMessageCoSignContext | undefined> {
	if (
		pending.type !== 'SignableMessage'
		|| pending.simulationMode
		|| pending.transactionOrMessageCreationStatus !== 'Simulated'
		|| pending.visualizedPersonalSignRequest.type !== 'SafeTx'
		|| pending.originalRequestParameters.method !== 'eth_signTypedData_v4'
	) return undefined
	const safeTx = pending.visualizedPersonalSignRequest.message
	const reviewedSnapshot = pending.safeMessageCoSignSnapshot
	if (reviewedSnapshot === undefined) {
		throw new Error('Review this Gnosis Safe co-signing request again so its current owners, threshold, nonce, and signer can be verified.')
	}
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
		reviewedSnapshot.safeSignerAddress,
		safeTx,
		safeEntry.safeVersion,
	)
	if (safeTxHash !== reviewedSnapshot.safeTxHash) throw new Error('The Gnosis Safe transaction changed after this co-signing confirmation opened.')
	assertSafeContractStateUnchanged(reviewedSnapshot.reviewedSafeState, safeState)
	return { safeEntry, safeSignerAddress: reviewedSnapshot.safeSignerAddress, safeTx, safeTxHash, ownerValidator }
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
	if (requestedAccount !== activeAddress || safeTx.domain.verifyingContract !== activeAddress) {
		throw new Error('The Gnosis Safe transaction signing account does not match the active Gnosis Safe.')
	}
	const safeEntry = await getCurrentSafeEntry(ethereum, activeAddress)
	if (walletSignerAddress === undefined) throw new Error('Connect a signer wallet and select a Gnosis Safe owner before co-signing.')
	if (safeEntry.safeVersion === undefined) {
		throw new Error('Re-save the active Gnosis Safe address-book entry to verify and record its current Gnosis Safe version before co-signing.')
	}
	const { safeTxHash, safeState } = await validateSafeTransactionForSigning(
		ethereum,
		safeEntry.address,
		walletSignerAddress,
		safeTx,
		safeEntry.safeVersion,
	)
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

async function refreshSafeExecutionRoute(
	ethereum: EthereumClientService,
	pending: PendingTransactionOrSignableMessage,
): Promise<PendingTransactionOrSignableMessage | undefined> {
	if (
		pending.type !== 'Transaction'
		|| pending.simulationMode
		|| pending.safeExecutionOriginalRequestParameters === undefined
	) return undefined
	const originalRequest = pending.safeExecutionOriginalRequestParameters
	const reviewedSafeState = pending.safeExecutionReviewedSafeState
	if (reviewedSafeState === undefined) throw new Error('Review this Gnosis Safe execution again so its current owner and threshold state can be verified.')
	const safeAddress = originalRequest.params[0].from
	if (safeAddress === undefined) throw new Error('The original Gnosis Safe execution request is missing its Gnosis Safe address.')
	const safeEntry = await getCurrentSafeEntry(ethereum, safeAddress)
	const refreshedRoute = await prepareSafeExecutionSignerRoute(ethereum, originalRequest, safeEntry, pending.safeExecutionSignerAddress)
	if (refreshedRoute === undefined) throw new Error('The configured Gnosis Safe execution route is no longer available.')
	assertSafeContractStateUnchanged(reviewedSafeState, refreshedRoute.safeState)
	if (
		pending.originalRequestParameters.method !== 'eth_sendTransaction'
		|| !areSafeExecutionSignerRequestsEqual(pending.originalRequestParameters, refreshedRoute.transactionParams)
	) throw new Error('The Gnosis Safe execution changed after this confirmation opened. Review the refreshed transaction before submitting it.')
	return modifyObject(pending, {
		activeAddress: refreshedRoute.executor,
		originalRequestParameters: refreshedRoute.transactionParams,
		safeExecutionSignerAddress: refreshedRoute.executor,
	})
}

async function getRequiredSafeCoSignContext(
	ethereum: EthereumClientService,
	pending: PendingTransactionOrSignableMessage,
) {
	if (
		pending.type !== 'SignableMessage'
		|| pending.transactionOrMessageCreationStatus !== 'Simulated'
		|| pending.visualizedPersonalSignRequest.type !== 'SafeTx'
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
	if (safeSignerAddress === undefined) return undefined
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
	if (pending.type !== 'Transaction' || pending.safeTransaction === undefined) return undefined
	return {
		method: 'eth_signTypedData_v4',
		params: [
			pending.safeTransaction.safeSignerAddress,
			EIP712Message.parse(safeTxToTypedDataJson(pending.safeTransaction.safeTx)),
		],
	}
}

export async function resolveSafeConfirmation(
	ethereum: EthereumClientService,
	pendingInput: PendingTransactionOrSignableMessage,
	action: TransactionConfirmationAction,
	refreshedSafeSignerSelection?: RefreshedSafeSignerSelection,
): Promise<SafeConfirmationResolution> {
	let pending = pendingInput
	let pendingChanged = false
	if (action !== 'accept') return { status: 'ready', pending, pendingChanged, signerFacingRequest: undefined }

	try {
		const refreshedExecution = await refreshSafeExecutionRoute(ethereum, pending)
		if (refreshedExecution !== undefined) {
			pending = refreshedExecution
			pendingChanged = true
		}
	} catch (error) {
		return {
			status: 'blocked',
			approvalStatus: createSafeSignerErrorStatus(`Gnosis Safe execution could not be prepared: ${ getErrorMessage(error) ?? 'The current Gnosis Safe state could not be validated.' }`),
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

	try {
		await assertSafeProposalReviewPrerequisites(ethereum, pending)
	} catch (error) {
		return {
			status: 'blocked',
			approvalStatus: createSafeSignerErrorStatus(`Gnosis Safe proposal could not be prepared: ${ getErrorMessage(error) ?? 'The wallet-selected Safe owner changed.' }`),
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

	return { status: 'ready', pending, pendingChanged, signerFacingRequest: getSafeSignerFacingRequest(pending, coSignContext) }
}

type TransactionConfirmationAction = 'accept' | 'reject' | 'noResponse' | 'signerIncluded'
