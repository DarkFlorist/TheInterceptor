import * as funtypes from 'funtypes'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import type { SafeEntryWithSafeSigner } from '../types/addressBookTypes.js'
import { isSafeEntryWithSafeSigner } from '../types/addressBookTypes.js'
import { EIP712Message } from '../types/eip721.js'
import type { SignMessageParams } from '../types/jsonRpc-signing-types.js'
import type { SafeTransactionSigningRequest } from '../types/safeTypes.js'
import { METAMASK_ERROR_FAILED_TO_PARSE_REQUEST } from '../utils/constants.js'
import { checksummedAddress } from '../utils/bigint.js'
import { getErrorMessage } from '../utils/errors.js'
import { getPrettySignerName } from '../utils/signerMetadata.js'
import { modifyObject } from '../utils/typescript.js'
import { getPendingTransactionsAndMessages, getSafeTransactionStacks, getTabState, getUserAddressBookEntriesForChainIdMorePreciseFirst } from './storageVariables.js'
import { assertSafeContractStateUnchanged, createSafeTransactionSigningRequest, getSafeContractState, safeTxToTypedDataJson, validateSafeOwnerSignature, validateSafeTransactionForSigning } from '../safe/safeCore.js'
import { areSafeExecutionSignerRequestsEqual, prepareSafeExecutionSignerRoute } from '../safe/safeExecutionRouting.js'
import { reconcileSafeTransactionStack } from '../safe/safeStack.js'
import type { SafeTx } from '../types/personal-message-definitions.js'

export const SAFE_SIGNER_SELECTION_ERROR_CODE = -32010

type SafeMessageCoSignContext = {
	readonly safeEntry: SafeEntryWithSafeSigner
	readonly safeTx: SafeTx
	readonly safeTxHash: bigint
}

export type RefreshedSafeSignerSelection = {
	readonly selectedSigner: bigint | undefined
	readonly verificationError: string | undefined
}

type SafeSignerErrorStatus = {
	readonly status: 'SignerError'
	readonly code: number
	readonly message: string
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

async function getCurrentSafeEntryWithSigner(ethereum: EthereumClientService, safeAddress: bigint) {
	const safeEntry = (await getUserAddressBookEntriesForChainIdMorePreciseFirst(ethereum.getChainId()))
		.find((entry) => entry.type === 'safe' && entry.address === safeAddress)
	if (!isSafeEntryWithSafeSigner(safeEntry)) {
		throw new Error('The Gnosis Safe no longer has an active signer configured in the address book.')
	}
	return safeEntry
}

export async function assertReviewedSafeSignerIsStillConfigured(ethereum: EthereumClientService, safeSigningRequest: SafeTransactionSigningRequest) {
	const currentSafeEntry = await getCurrentSafeEntryWithSigner(ethereum, safeSigningRequest.safeAddress)
	if (currentSafeEntry.safeSignerAddress !== safeSigningRequest.safeSignerAddress) {
		throw new Error(`The configured Gnosis Safe signer changed from ${ checksummedAddress(safeSigningRequest.safeSignerAddress) } to ${ checksummedAddress(currentSafeEntry.safeSignerAddress) } after this confirmation opened.`)
	}
}

export async function getSafeSignerMismatchApprovalStatus(
	tabId: number,
	configuredSafeSigner: bigint,
	refreshedSelection?: RefreshedSafeSignerSelection,
) {
	const tabState = await getTabState(tabId)
	const signerName = getPrettySignerName(tabState.signerName)
	const selectedSigner = refreshedSelection === undefined
		? tabState.activeSigningAddress ?? tabState.signerAccounts[0]
		: refreshedSelection.selectedSigner
	if (selectedSigner === configuredSafeSigner) return undefined
	const configuredAddress = checksummedAddress(configuredSafeSigner)
	if (refreshedSelection?.verificationError !== undefined) {
		return {
			status: 'SignerError' as const,
			code: SAFE_SIGNER_SELECTION_ERROR_CODE,
			message: `Gnosis Safe signer could not be verified: ${ refreshedSelection.verificationError } Select ${ configuredAddress } in ${ signerName }, then retry.`,
		}
	}
	const selectedAccountDescription = selectedSigner === undefined
		? 'no account selected'
		: `${ checksummedAddress(selectedSigner) } selected`
	return {
		status: 'SignerError' as const,
		code: SAFE_SIGNER_SELECTION_ERROR_CODE,
		message: `Gnosis Safe signer mismatch: this Gnosis Safe is configured to use ${ configuredAddress }, but ${ signerName } currently has ${ selectedAccountDescription }. Select ${ configuredAddress } in ${ signerName }, then retry.`,
	}
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
	const safeEntry = await getCurrentSafeEntryWithSigner(ethereum, pending.activeAddress)
	if (safeEntry.safeVersion === undefined) {
		throw new Error('Re-save the active Gnosis Safe address-book entry to verify and record its current Gnosis Safe version before co-signing.')
	}
	if (reviewedSnapshot.safeAddress !== safeEntry.address || reviewedSnapshot.safeSignerAddress !== safeEntry.safeSignerAddress) {
		throw new Error('The configured Gnosis Safe signer changed after this co-signing confirmation opened.')
	}
	const { safeTxHash, safeState } = await validateSafeTransactionForSigning(
		ethereum,
		safeEntry.address,
		safeEntry.safeSignerAddress,
		safeTx,
		safeEntry.safeVersion,
	)
	if (safeTxHash !== reviewedSnapshot.safeTxHash) throw new Error('The Gnosis Safe transaction changed after this co-signing confirmation opened.')
	assertSafeContractStateUnchanged(reviewedSnapshot.reviewedSafeState, safeState)
	return { safeEntry, safeTx, safeTxHash }
}

export async function createSafeMessageCoSignSnapshot(
	ethereum: EthereumClientService,
	activeAddress: bigint,
	transactionParams: SignMessageParams,
	safeTx: SafeTx,
) {
	if (transactionParams.method !== 'eth_signTypedData_v4') throw new Error('Gnosis Safe co-signing requires an EIP-712 typed-data request.')
	const [requestedAccount] = transactionParams.params
	if (requestedAccount !== activeAddress || safeTx.domain.verifyingContract !== activeAddress) {
		throw new Error('The Gnosis Safe transaction signing account does not match the active Gnosis Safe.')
	}
	const safeEntry = await getCurrentSafeEntryWithSigner(ethereum, activeAddress)
	if (safeEntry.safeVersion === undefined) {
		throw new Error('Re-save the active Gnosis Safe address-book entry to verify and record its current Gnosis Safe version before co-signing.')
	}
	const { safeTxHash, safeState } = await validateSafeTransactionForSigning(
		ethereum,
		safeEntry.address,
		safeEntry.safeSignerAddress,
		safeTx,
		safeEntry.safeVersion,
	)
	return {
		safeAddress: safeEntry.address,
		safeSignerAddress: safeEntry.safeSignerAddress,
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
	const ownerSignature = await validateSafeOwnerSignature(
		ethereum,
		currentCoSignContext.safeEntry.address,
		currentCoSignContext.safeTxHash,
		funtypes.String.parse(signerReply),
		currentCoSignContext.safeEntry.safeSignerAddress,
	)
	return ownerSignature.signature
}

const signerError = (message: string): SafeSignerErrorStatus => ({
	status: 'SignerError',
	code: METAMASK_ERROR_FAILED_TO_PARSE_REQUEST,
	message,
})

export async function resolveSafeConfirmation(
	ethereum: EthereumClientService,
	pendingInput: PendingTransactionOrSignableMessage,
	action: TransactionConfirmationAction,
	refreshedSafeSignerSelection?: RefreshedSafeSignerSelection,
): Promise<SafeConfirmationResolution> {
	let pending = pendingInput
	let pendingChanged = false
	if (action !== 'accept') return { status: 'ready', pending, pendingChanged, signerFacingRequest: undefined }

	if (
		pending.type === 'Transaction'
		&& !pending.simulationMode
		&& pending.safeExecutionOriginalRequestParameters !== undefined
	) {
		try {
			const originalRequest = pending.safeExecutionOriginalRequestParameters
			const reviewedSafeState = pending.safeExecutionReviewedSafeState
			if (reviewedSafeState === undefined) throw new Error('Review this Gnosis Safe execution again so its current owner and threshold state can be verified.')
			const safeAddress = originalRequest.params[0].from
			if (safeAddress === undefined) throw new Error('The original Gnosis Safe execution request is missing its Gnosis Safe address.')
			const safeEntry = await getCurrentSafeEntryWithSigner(ethereum, safeAddress)
			const refreshedRoute = await prepareSafeExecutionSignerRoute(ethereum, originalRequest, safeEntry)
			if (refreshedRoute === undefined) throw new Error('The configured Gnosis Safe execution route is no longer available.')
			assertSafeContractStateUnchanged(reviewedSafeState, refreshedRoute.safeState)
			if (
				pending.originalRequestParameters.method !== 'eth_sendTransaction'
				|| !areSafeExecutionSignerRequestsEqual(pending.originalRequestParameters, refreshedRoute.transactionParams)
			) throw new Error('The Gnosis Safe execution changed after this confirmation opened. Review the refreshed transaction before submitting it.')
			pending = modifyObject(pending, {
				activeAddress: refreshedRoute.executor,
				originalRequestParameters: refreshedRoute.transactionParams,
				safeExecutionSignerAddress: refreshedRoute.executor,
			})
			pendingChanged = true
		} catch (error) {
			return {
				status: 'blocked',
				approvalStatus: signerError(`Gnosis Safe execution could not be prepared: ${ getErrorMessage(error) ?? 'The current Gnosis Safe state could not be validated.' }`),
			}
		}
	}

	let coSignContext: SafeMessageCoSignContext | undefined
	if (
		pending.type === 'SignableMessage'
		&& pending.transactionOrMessageCreationStatus === 'Simulated'
		&& pending.visualizedPersonalSignRequest.type === 'SafeTx'
	) {
		try {
			coSignContext = await getSafeMessageCoSignContext(ethereum, pending)
			if (coSignContext === undefined) throw new Error('This Gnosis Safe transaction is not eligible for Interceptor co-signing.')
		} catch (error) {
			return {
				status: 'blocked',
				approvalStatus: signerError(`Gnosis Safe co-signing request was rejected: ${ getErrorMessage(error) ?? 'The Gnosis Safe transaction could not be validated.' }`),
			}
		}
	}

	if (!pending.simulationMode) {
		if (pending.type === 'Transaction' && pending.safeTransaction !== undefined) {
			try {
				if (pending.safeTransaction.reviewedSafeState === undefined) {
					throw new Error('Review this Gnosis Safe proposal again so its current owners, threshold, nonce, and signer can be verified.')
				}
				await assertReviewedSafeSignerIsStillConfigured(ethereum, pending.safeTransaction)
			} catch (error) {
				return {
					status: 'blocked',
					approvalStatus: signerError(`Gnosis Safe proposal could not be prepared: ${ getErrorMessage(error) ?? 'The configured signer changed.' }`),
				}
			}
		}
		const safeSignerAddress = getPendingSafeSignerAddress(pending)
		if (safeSignerAddress !== undefined) {
			const mismatch = await getSafeSignerMismatchApprovalStatus(
				pending.uniqueRequestIdentifier.requestSocket.tabId,
				safeSignerAddress,
				refreshedSafeSignerSelection,
			)
			if (mismatch !== undefined) return { status: 'blocked', approvalStatus: mismatch }
		}
	}

	if (!pending.simulationMode && pending.type === 'Transaction' && pending.safeTransaction !== undefined) {
		try {
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
			if (currentRequest.safeTx.message.nonce !== firstUncommittedNonce) {
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
				return { status: 'refreshed', pending: modifyObject(pending, { safeTransaction: refreshedSafeRequest }) }
			}
		} catch (error) {
			return {
				status: 'blocked',
				approvalStatus: signerError(`Gnosis Safe proposal could not be prepared: ${ getErrorMessage(error) ?? 'Failed to refresh the Gnosis Safe nonce.' }`),
			}
		}
	}

	const signerFacingRequest = coSignContext !== undefined
		? {
			method: 'eth_signTypedData_v4' as const,
			params: [
				coSignContext.safeEntry.safeSignerAddress,
				EIP712Message.parse(safeTxToTypedDataJson(coSignContext.safeTx)),
			] as const,
		}
		: pending.type === 'Transaction' && pending.safeTransaction !== undefined
			? {
				method: 'eth_signTypedData_v4' as const,
				params: [
					pending.safeTransaction.safeSignerAddress,
					EIP712Message.parse(safeTxToTypedDataJson(pending.safeTransaction.safeTx)),
				] as const,
			}
			: undefined
	return { status: 'ready', pending, pendingChanged, signerFacingRequest }
}

type TransactionConfirmationAction = 'accept' | 'reject' | 'noResponse' | 'signerIncluded'
