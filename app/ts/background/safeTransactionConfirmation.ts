import type { TransactionConfirmationRequest } from '../types/confirmationRequest.js'
import { matchesSafeMessageApproval } from '../safe/safeMessageApproval.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { SendRawTransactionParams, SendTransactionParams } from '../types/JsonRpc-types.js'
import type { SafeEntry } from '../types/addressBookTypes.js'
import type { SafeTransactionSigningRequest } from '../types/safeTypes.js'
import type { TransactionGasPayment, WebsiteCreatedEthereumTransaction, WebsiteCreatedEthereumTransactionOrFailed } from '../types/visualizer-types.js'
import { METAMASK_ERROR_FAILED_TO_PARSE_REQUEST, METAMASK_ERROR_METHOD_NOT_SUPPORTED_BY_PROVIDER } from '../utils/constants.js'
import { getErrorMessage, reportLocalRecovery } from '../utils/errors.js'
import { getPendingTransactionsAndMessages, getUserAddressBookEntriesForChainIdMorePreciseFirst } from './storageVariables.js'
import { reconcileStoredSafeState, type ReconciledStoredSafeState } from './safeStackState.js'
import { createSafeContractValidationFailure, createSafeTransactionReviewRequest, createSafeTransactionSigningRequest, getSafeContractSnapshot, isSafeContractValidationFailure, isSafeOwnerValidationFailure } from '../safe/safeCore.js'
import { getSafeExecutionReviewedState, getSafeExecutionSignerRoute, getSafeUnsupportedFormedTransactionReason, getSafeUnsupportedRequestReason, isSafeExecutableRequestFromActiveAddress, isSafeExecutionRequestForActiveSafe, prepareSafeExecutionSignerRoute, SAFE_UNSUPPORTED_TRANSACTION_MESSAGES } from '../safe/safeExecutionRouting.js'
import { getSafeSignerMismatchApprovalStatus, SAFE_SIGNER_SELECTION_ERROR_CODE } from './safeConfirmationResolver.js'
import { createSafeSignerErrorStatus, type SafeSignerErrorStatus } from './safeSignerErrors.js'
import { getSafePendingFlow, getSafeTransactionFlowGasPayment, type SafeTransactionFlowKind } from '../safe/safePendingFlow.js'

type SafeExecutionSignerRoute = NonNullable<Awaited<ReturnType<typeof prepareSafeExecutionSignerRoute>>>

type PendingSafeFields = {
	readonly safeExecutionSignerAddress?: bigint
	readonly safeExecutionOriginalRequestParameters: SendTransactionParams
	readonly safeExecutionReviewedSafeState?: SafeExecutionSignerRoute['safeState']
} | {
	readonly executeThroughSafe: true
} | {
	readonly safeProposalCreationFailed: true
} | {
	readonly unsupportedSafeRequest: true
}

export type SafeTransactionConfirmationPreparation = {
	readonly effectiveTransactionParams: SendTransactionParams | SendRawTransactionParams
	readonly transactionExecutor: bigint
	readonly gasPayment: TransactionGasPayment
	readonly preparationMessage: string | undefined
	readonly rejection: {
		readonly code: number
		readonly message: string
	} | undefined
	readonly finalize: (
		transactionToSimulate: WebsiteCreatedEthereumTransactionOrFailed,
		tabId: number,
	) => Promise<{
		readonly transactionToSimulate: WebsiteCreatedEthereumTransactionOrFailed
		readonly safeTransaction: SafeTransactionSigningRequest | undefined
		readonly approvalStatus: Awaited<ReturnType<typeof getSafeSignerMismatchApprovalStatus>> | undefined
		readonly pendingSafeFields: PendingSafeFields | undefined
	}>
}

/**
 * In simulation mode, a transaction the user sends as a Gnosis Safe runs the way the Safe runs it on-chain: through the Safe's execTransaction, sent by an executor that pays the fees (safe/safeExecutionSimulation.ts). That assumes the Safe's owners approved it, so it is only assumed for the Safe the user is simulating as: the sender formEthSendTransaction simulates, the page's `from` or else the active address, must be the active address, which must be a Gnosis Safe configured on this chain. A page naming another configured Safe as `from` gets the ordinary simulation of that sender.
 * Raw transactions, EIP-7702 authorizations and contract creations, which a Safe can't make through execTransaction, and Safes that aren't deployed on this chain or have a version Interceptor doesn't support, keep the ordinary simulation.
 */
async function isSimulationModeSafeExecution(ethereum: EthereumClientService, transactionParams: SendTransactionParams | SendRawTransactionParams, activeAddress: bigint) {
	if (!isSafeExecutableRequestFromActiveAddress(transactionParams, activeAddress)) return false
	const addressBookEntries = await getUserAddressBookEntriesForChainIdMorePreciseFirst(ethereum.getChainId())
	if (!addressBookEntries.some((entry) => entry.type === 'safe' && entry.address === activeAddress)) return false
	try {
		await getSafeContractSnapshot(ethereum, activeAddress)
		return true
	} catch (error) {
		if (!isSafeContractValidationFailure(error)) throw error
		await reportLocalRecovery(error, {
			code: 'simulated_safe_execution_unavailable',
			message: 'Simulating the Gnosis Safe\'s transaction as an ordinary transaction.',
			details: error instanceof Error ? error.stack : undefined,
		})
		return false
	}
}

export async function prepareSafeTransactionConfirmation(
	ethereum: EthereumClientService,
	confirmation: TransactionConfirmationRequest,
	simulationMode: boolean,
	activeAddress: bigint,
	walletSignerAddress: bigint | undefined,
): Promise<SafeTransactionConfirmationPreparation> {
	const transactionParams = confirmation.parameters
	const configuredSafeEntry = simulationMode
		? undefined
		: (await getUserAddressBookEntriesForChainIdMorePreciseFirst(ethereum.getChainId()))
			.find((entry): entry is SafeEntry => entry.type === 'safe' && entry.address === activeAddress)
	if (configuredSafeEntry !== undefined) {
		// A contract creation is not rejected here: its flow kind is 'unsupportedSafeRequest', and createSafeSigningRequestForTransaction fails it once the transaction is formed, so the window shows the failure.
		const unsupportedReason = getSafeUnsupportedRequestReason(transactionParams)
		if (unsupportedReason === 'raw-transaction' || unsupportedReason === 'eip-7702-authorization') {
			return createRejectedPreparation(activeAddress, transactionParams, SAFE_UNSUPPORTED_TRANSACTION_MESSAGES[unsupportedReason])
		}
	}

	const basicExecutionRoute = transactionParams.method === 'eth_sendTransaction'
		? getSafeExecutionSignerRoute(transactionParams, configuredSafeEntry, walletSignerAddress)
		: undefined
	const isDirectSafeExecution = transactionParams.method === 'eth_sendTransaction'
		&& isSafeExecutionRequestForActiveSafe(transactionParams, configuredSafeEntry)
	let safeExecutionSignerRoute: SafeExecutionSignerRoute | undefined
	let safeExecutionReviewedState: SafeExecutionSignerRoute['safeState'] | undefined
	let executionPreparationMessage: string | undefined
	if (isDirectSafeExecution && transactionParams.method === 'eth_sendTransaction') {
		try {
			if (basicExecutionRoute === undefined) {
				safeExecutionReviewedState = await getSafeExecutionReviewedState(ethereum, transactionParams, configuredSafeEntry)
			} else {
				safeExecutionSignerRoute = await prepareSafeExecutionSignerRoute(ethereum, transactionParams, configuredSafeEntry, walletSignerAddress)
				safeExecutionReviewedState = safeExecutionSignerRoute?.safeState
			}
			} catch (error) {
				if (!isSafeContractValidationFailure(error) && !isSafeOwnerValidationFailure(error)) throw error
				executionPreparationMessage = getErrorMessage(error) ?? 'The Gnosis Safe execution transaction could not be prepared.'
			await reportLocalRecovery(error, {
				code: 'safe_execution_preparation_failed',
				message: 'Showing the Gnosis Safe execution preparation failure in the confirmation window.',
				details: error instanceof Error ? error.stack : undefined,
			})
		}
	}

	const safeEntry = isDirectSafeExecution ? undefined : configuredSafeEntry
	let reconciledStoredSafeState: ReconciledStoredSafeState | undefined
	let reconciliationMessage: string | undefined
	if (safeEntry !== undefined) {
		try {
			reconciledStoredSafeState = await reconcileStoredSafeState(ethereum, safeEntry.address)
		} catch (error) {
			if (!isSafeContractValidationFailure(error)) throw error
			reconciliationMessage = getErrorMessage(error) ?? 'The local Gnosis Safe stack could not be reconciled with the current on-chain nonce.'
			await reportLocalRecovery(error, {
				code: 'safe_stack_reconciliation_failed',
				message: 'Showing the Gnosis Safe stack reconciliation failure in the confirmation window.',
				details: error instanceof Error ? error.stack : undefined,
			})
		}
	}

	const executeThroughSafe = simulationMode && await isSimulationModeSafeExecution(ethereum, transactionParams, activeAddress)
	// Stored in the pending transaction through pendingSafeFields and the Safe proposal, or its creation failure, from which every refresh reads it back (getPendingTransactionFlowKind).
	const flowKind: SafeTransactionFlowKind = isDirectSafeExecution ? 'directExecution'
		: safeEntry !== undefined ? getSafeUnsupportedRequestReason(transactionParams) === undefined ? 'proposal' : 'unsupportedSafeRequest'
		: executeThroughSafe ? 'simulationModeSafeExecution'
		: 'ordinary'
	const pendingSafeFields: PendingSafeFields | undefined = executeThroughSafe
		? { executeThroughSafe: true }
		: !isDirectSafeExecution || transactionParams.method !== 'eth_sendTransaction'
		? undefined
		: {
			safeExecutionOriginalRequestParameters: transactionParams,
			...(safeExecutionSignerRoute === undefined ? {} : { safeExecutionSignerAddress: safeExecutionSignerRoute.executor }),
			...(safeExecutionReviewedState === undefined ? {} : { safeExecutionReviewedSafeState: safeExecutionReviewedState }),
		}
	const directSignerSelectionMessage = isDirectSafeExecution && safeExecutionSignerRoute === undefined
		? executionPreparationMessage ?? 'Connect a signer wallet and select a current Gnosis Safe owner before signing.'
		: undefined
	return {
		effectiveTransactionParams: safeExecutionSignerRoute?.transactionParams ?? transactionParams,
		transactionExecutor: safeExecutionSignerRoute?.executor ?? activeAddress,
		gasPayment: getSafeTransactionFlowGasPayment(flowKind),
		preparationMessage: directSignerSelectionMessage ?? executionPreparationMessage ?? reconciliationMessage,
		rejection: undefined,
		async finalize(transactionToSimulate, tabId) {
			let finalizedTransaction = transactionToSimulate
			let safeTransaction: SafeTransactionSigningRequest | undefined
			let safeSignerSelectionError: SafeSignerErrorStatus | undefined
			if (isDirectSafeExecution && safeExecutionSignerRoute === undefined) {
				safeSignerSelectionError = createSafeSignerErrorStatus(
					directSignerSelectionMessage ?? 'Connect a signer wallet and select a current Gnosis Safe owner before signing.',
					SAFE_SIGNER_SELECTION_ERROR_CODE,
				)
			}
			if (finalizedTransaction.success) {
				try {
					safeTransaction = await createSafeSigningRequestForTransaction(
						ethereum,
						safeExecutionSignerRoute?.transactionParams ?? transactionParams,
						finalizedTransaction,
						safeEntry,
						walletSignerAddress,
						reconciledStoredSafeState,
						confirmation.safeTransaction,
					)
				} catch (error) {
					if (isSafeOwnerValidationFailure(error)) {
						safeSignerSelectionError = createSafeSignerErrorStatus(
							getErrorMessage(error) ?? 'Select a current Gnosis Safe owner in the signer wallet before signing.',
							SAFE_SIGNER_SELECTION_ERROR_CODE,
						)
						try {
							safeTransaction = await createSafeSigningRequestForTransaction(
								ethereum,
								safeExecutionSignerRoute?.transactionParams ?? transactionParams,
								finalizedTransaction,
								safeEntry,
								walletSignerAddress,
								reconciledStoredSafeState,
								confirmation.safeTransaction,
								false,
							)
						} catch (reviewError) {
							if (!isSafeContractValidationFailure(reviewError)) throw reviewError
							finalizedTransaction = await createFailedSafeTransaction(finalizedTransaction, transactionParams, safeExecutionSignerRoute, reviewError)
						}
					} else if (isSafeContractValidationFailure(error)) {
						finalizedTransaction = await createFailedSafeTransaction(finalizedTransaction, transactionParams, safeExecutionSignerRoute, error)
					} else {
						throw error
					}
				}
			}
			if (safeTransaction !== undefined && safeTransaction.safeSignerAddress === undefined) {
				safeSignerSelectionError = createSafeSignerErrorStatus(
					'Connect a signer wallet and select a current Gnosis Safe owner before signing.',
					SAFE_SIGNER_SELECTION_ERROR_CODE,
				)
			}
			const approvalStatus = safeSignerSelectionError ?? (safeTransaction === undefined
				? safeExecutionSignerRoute === undefined
					? undefined
					: await getSafeSignerMismatchApprovalStatus(tabId, safeExecutionSignerRoute.executor)
				: safeTransaction.safeSignerAddress === undefined
					? undefined
					: await getSafeSignerMismatchApprovalStatus(tabId, safeTransaction.safeSignerAddress)
			)
			// A Safe proposal that could not be created, or a request the Safe can't make, leaves the confirmation a failure, which is kept with its flow kind, so a refresh neither forms nor shows it as another kind of transaction.
			const finalizedPendingSafeFields: PendingSafeFields | undefined = flowKind === 'unsupportedSafeRequest' ? { unsupportedSafeRequest: true }
				: flowKind === 'proposal' && safeTransaction === undefined ? { safeProposalCreationFailed: true }
				: pendingSafeFields
			return { transactionToSimulate: finalizedTransaction, safeTransaction, approvalStatus, pendingSafeFields: finalizedPendingSafeFields }
		},
	}
}

async function createFailedSafeTransaction(
	transaction: WebsiteCreatedEthereumTransaction,
	transactionParams: SendTransactionParams | SendRawTransactionParams,
	safeExecutionSignerRoute: SafeExecutionSignerRoute | undefined,
	error: unknown,
): Promise<WebsiteCreatedEthereumTransactionOrFailed> {
	const message = getErrorMessage(error) ?? 'The Gnosis Safe transaction could not be prepared.'
	await reportLocalRecovery(error, {
		code: 'safe_transaction_preparation_failed',
		message: 'Showing the Gnosis Safe preparation failure in the confirmation window.',
		details: error instanceof Error ? error.stack : undefined,
	})
	return {
		website: transaction.website,
		created: transaction.created,
		originalRequestParameters: safeExecutionSignerRoute?.transactionParams ?? transactionParams,
		transactionIdentifier: transaction.transactionIdentifier,
		success: false,
		error: { code: METAMASK_ERROR_FAILED_TO_PARSE_REQUEST, message },
	}
}

function createRejectedPreparation(
	activeAddress: bigint,
	transactionParams: SendTransactionParams | SendRawTransactionParams,
	message: string,
): SafeTransactionConfirmationPreparation {
	return {
		effectiveTransactionParams: transactionParams,
		transactionExecutor: activeAddress,
		// A rejected request forms no transaction, so it gets the ordinary fee mode.
		gasPayment: getSafeTransactionFlowGasPayment('ordinary'),
		preparationMessage: undefined,
		rejection: { code: METAMASK_ERROR_METHOD_NOT_SUPPORTED_BY_PROVIDER, message },
		async finalize(transactionToSimulate) {
			return {
				transactionToSimulate,
				safeTransaction: undefined,
				approvalStatus: undefined,
				pendingSafeFields: undefined,
			}
		},
	}
}

async function createSafeSigningRequestForTransaction(
	ethereum: EthereumClientService,
	transactionParams: SendTransactionParams | SendRawTransactionParams,
	transactionToSimulate: WebsiteCreatedEthereumTransaction,
	safeEntry: SafeEntry | undefined,
	walletSignerAddress: bigint | undefined,
	reconciledStoredSafeState: ReconciledStoredSafeState | undefined,
	safeTransaction: TransactionConfirmationRequest['safeTransaction'],
	validateOwner = true,
): Promise<SafeTransactionSigningRequest | undefined> {
	if (safeEntry === undefined) return undefined
	// The request decides only whether it is a raw transaction; the rest is checked on the formed transaction, whose type and recipient are final.
	const unsupportedReason = getSafeUnsupportedRequestReason(transactionParams) === 'raw-transaction' ? 'raw-transaction' : getSafeUnsupportedFormedTransactionReason(transactionToSimulate.transaction)
	if (unsupportedReason !== undefined) throw createSafeContractValidationFailure(SAFE_UNSUPPORTED_TRANSACTION_MESSAGES[unsupportedReason])
	const recipient = transactionToSimulate.transaction.to
	// Already rejected as 'contract-creation' above; repeated so TypeScript narrows the recipient.
	if (recipient === null) throw createSafeContractValidationFailure(SAFE_UNSUPPORTED_TRANSACTION_MESSAGES['contract-creation'])
	if (reconciledStoredSafeState === undefined) throw createSafeContractValidationFailure('The Gnosis Safe stack was not reconciled before preparing the transaction.')

	const { safeState, storedStack } = reconciledStoredSafeState
	const firstUncommittedNonce = safeState.nonce + BigInt(storedStack?.transactions.length ?? 0)
	const pendingSafeTransactionNonces = new Set((await getPendingTransactionsAndMessages()).flatMap((pending) => {
		const flow = getSafePendingFlow(pending)
		if (flow?.kind !== 'proposal') return []
		const pendingRequest = flow.pending.safeTransaction
		return pendingRequest.safeAddress === safeEntry.address
			&& pendingRequest.safeTx.domain.chainId === ethereum.getChainId()
			&& pendingRequest.safeTx.message.nonce >= firstUncommittedNonce
			? [pendingRequest.safeTx.message.nonce]
			: []
	}))
	let nonce = firstUncommittedNonce
	while (pendingSafeTransactionNonces.has(nonce)) nonce += 1n
	const review = safeTransaction?.messageReview
	const transaction = {
		to: recipient,
		value: transactionToSimulate.transaction.value,
		input: transactionToSimulate.transaction.input,
		gas: transactionToSimulate.transaction.gas,
		operation: BigInt(safeTransaction?.operation ?? 0),
	}
	if (review !== undefined && !matchesSafeMessageApproval({ ...transaction, data: transaction.input }, review)) throw createSafeContractValidationFailure('The Safe message review text does not match the on-chain approval.')
	const signingRequest = validateOwner && walletSignerAddress !== undefined
		? await createSafeTransactionSigningRequest(ethereum, safeEntry.address, walletSignerAddress, transaction, nonce)
		: await createSafeTransactionReviewRequest(ethereum, safeEntry.address, walletSignerAddress, transaction, nonce)
	return { ...signingRequest, ...(review !== undefined ? { messageReview: review } : {}) }
}
