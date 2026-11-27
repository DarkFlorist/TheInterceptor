import type { TransactionConfirmationRequest } from '../types/confirmationRequest.js'
import { matchesGnosisSafeMessageApproval } from '../gnosisSafe/gnosisSafeMessageApproval.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { SendRawTransactionParams, SendTransactionParams } from '../types/JsonRpc-types.js'
import type { GnosisSafeEntry } from '../types/addressBookTypes.js'
import type { GnosisSafeTransactionSigningRequest } from '../types/gnosisSafeTypes.js'
import type { TransactionGasPayment, WebsiteCreatedEthereumTransaction, WebsiteCreatedEthereumTransactionOrFailed } from '../types/visualizer-types.js'
import { METAMASK_ERROR_FAILED_TO_PARSE_REQUEST, METAMASK_ERROR_METHOD_NOT_SUPPORTED_BY_PROVIDER } from '../utils/constants.js'
import { getErrorMessage, reportLocalRecovery } from '../utils/errors.js'
import { getPendingTransactionsAndMessages, getUserAddressBookEntriesForChainIdMorePreciseFirst } from './storageVariables.js'
import { reconcileStoredGnosisSafeState, type ReconciledStoredGnosisSafeState } from './gnosisSafeStackState.js'
import { createGnosisSafeContractValidationFailure, createGnosisSafeTransactionReviewRequest, createGnosisSafeTransactionSigningRequest, getGnosisSafeContractSnapshot, isGnosisSafeContractValidationFailure, isGnosisSafeOwnerValidationFailure } from '../gnosisSafe/gnosisSafeCore.js'
import { getGnosisSafeExecutionReviewedState, getGnosisSafeExecutionSignerRoute, getGnosisSafeUnsupportedFormedTransactionReason, getGnosisSafeUnsupportedRequestReason, isGnosisSafeExecutableRequestFromActiveAddress, isGnosisSafeExecutionRequestForActiveGnosisSafe, prepareGnosisSafeExecutionSignerRoute, GNOSIS_SAFE_UNSUPPORTED_TRANSACTION_MESSAGES } from '../gnosisSafe/gnosisSafeExecutionRouting.js'
import { getGnosisSafeSignerMismatchApprovalStatus, GNOSIS_SAFE_SIGNER_SELECTION_ERROR_CODE } from './gnosisSafeConfirmationResolver.js'
import { createGnosisSafeSignerErrorStatus, type GnosisSafeSignerErrorStatus } from './gnosisSafeSignerErrors.js'
import { createCreatedGnosisSafeProposalGnosisSafeFlow, getGnosisSafePendingFlow, getGnosisSafeTransactionFlowGasPayment, type GnosisSafeTransactionFlowKind } from '../gnosisSafe/gnosisSafePendingFlow.js'
import type { PendingTransactionGnosisSafeFlow } from '../types/accessRequest.js'

type GnosisSafeExecutionSignerRoute = NonNullable<Awaited<ReturnType<typeof prepareGnosisSafeExecutionSignerRoute>>>

// The flow decided when the confirmation opens. A Gnosis Safe proposal's state is only known once finalize has tried to create it from the formed transaction.
type OpenedGnosisSafeFlow = Exclude<PendingTransactionGnosisSafeFlow, { readonly kind: 'proposal' }> | { readonly kind: 'proposal' }

export type GnosisSafeTransactionConfirmationPreparation = {
	readonly effectiveTransactionParams: SendTransactionParams | SendRawTransactionParams
	readonly transactionExecutor: bigint
	readonly flowKind: GnosisSafeTransactionFlowKind
	readonly gasPayment: TransactionGasPayment
	readonly safeOperation?: 1
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
		readonly safeFlow: PendingTransactionGnosisSafeFlow
		readonly approvalStatus: Awaited<ReturnType<typeof getGnosisSafeSignerMismatchApprovalStatus>> | undefined
	}>
}

/**
 * In simulation mode, a transaction the user sends as a Gnosis Safe runs the way the Safe runs it on-chain: through the Safe's execTransaction, sent by an executor that pays the fees (safe/safeExecutionSimulation.ts). That assumes the Safe's owners approved it, so it is only assumed for the Safe the user is simulating as: the sender formEthSendTransaction simulates, the page's `from` or else the active address, must be the active address, which must be a Gnosis Safe configured on this chain. A page naming another configured Safe as `from` gets the ordinary simulation of that sender.
 * Raw transactions, EIP-7702 authorizations and contract creations, which a Safe can't make through execTransaction, and Safes that aren't deployed on this chain or have a version Interceptor doesn't support, keep the ordinary simulation for ordinary RPC requests. Explicit Safe Apps operations instead reject when the Safe execution is unavailable.
 */
async function isSimulationModeGnosisSafeExecution(ethereum: EthereumClientService, transactionParams: SendTransactionParams | SendRawTransactionParams, activeAddress: bigint) {
	if (!isGnosisSafeExecutableRequestFromActiveAddress(transactionParams, activeAddress)) return false
	const addressBookEntries = await getUserAddressBookEntriesForChainIdMorePreciseFirst(ethereum.getChainId())
	if (!addressBookEntries.some((entry) => entry.type === 'safe' && entry.address === activeAddress)) return false
	try {
		await getGnosisSafeContractSnapshot(ethereum, activeAddress)
		return true
	} catch (error) {
		if (!isGnosisSafeContractValidationFailure(error)) throw error
		await reportLocalRecovery(error, {
			code: 'simulated_safe_execution_unavailable',
			message: 'The configured Gnosis Safe cannot be used for this simulation.',
			details: error instanceof Error ? error.stack : undefined,
		})
		return false
	}
}

export async function prepareGnosisSafeTransactionConfirmation(
	ethereum: EthereumClientService,
	confirmation: TransactionConfirmationRequest,
	simulationMode: boolean,
	activeAddress: bigint,
	walletSignerAddress: bigint | undefined,
): Promise<GnosisSafeTransactionConfirmationPreparation> {
	const transactionParams = confirmation.parameters
	const configuredSafeEntry = simulationMode
		? undefined
		: (await getUserAddressBookEntriesForChainIdMorePreciseFirst(ethereum.getChainId()))
			.find((entry): entry is GnosisSafeEntry => entry.type === 'safe' && entry.address === activeAddress)
	if (configuredSafeEntry !== undefined) {
		// A contract creation is not rejected here: its flow kind is 'unsupportedSafeRequest', whose preparation message shows the rejection in the window.
		const unsupportedReason = getGnosisSafeUnsupportedRequestReason(transactionParams)
		if (unsupportedReason === 'raw-transaction' || unsupportedReason === 'eip-7702-authorization') {
			return createRejectedPreparation(activeAddress, transactionParams, GNOSIS_SAFE_UNSUPPORTED_TRANSACTION_MESSAGES[unsupportedReason])
		}
	}

	const basicExecutionRoute = transactionParams.method === 'eth_sendTransaction'
		? getGnosisSafeExecutionSignerRoute(transactionParams, configuredSafeEntry, walletSignerAddress)
		: undefined
	const isDirectSafeExecution = transactionParams.method === 'eth_sendTransaction'
		&& isGnosisSafeExecutionRequestForActiveGnosisSafe(transactionParams, configuredSafeEntry)
	let safeExecutionSignerRoute: GnosisSafeExecutionSignerRoute | undefined
	let safeExecutionReviewedState: GnosisSafeExecutionSignerRoute['safeState'] | undefined
	let executionPreparationMessage: string | undefined
	if (isDirectSafeExecution && transactionParams.method === 'eth_sendTransaction') {
		try {
			if (basicExecutionRoute === undefined) {
				safeExecutionReviewedState = await getGnosisSafeExecutionReviewedState(ethereum, transactionParams, configuredSafeEntry)
			} else {
				safeExecutionSignerRoute = await prepareGnosisSafeExecutionSignerRoute(ethereum, transactionParams, configuredSafeEntry, walletSignerAddress)
				safeExecutionReviewedState = safeExecutionSignerRoute?.safeState
			}
			} catch (error) {
				if (!isGnosisSafeContractValidationFailure(error) && !isGnosisSafeOwnerValidationFailure(error)) throw error
				executionPreparationMessage = getErrorMessage(error) ?? 'The Gnosis Safe execution transaction could not be prepared.'
			await reportLocalRecovery(error, {
				code: 'safe_execution_preparation_failed',
				message: 'Showing the Gnosis Safe execution preparation failure in the confirmation window.',
				details: error instanceof Error ? error.stack : undefined,
			})
		}
	}

	const safeEntry = isDirectSafeExecution ? undefined : configuredSafeEntry
	let reconciledStoredSafeState: ReconciledStoredGnosisSafeState | undefined
	let reconciliationMessage: string | undefined
	if (safeEntry !== undefined) {
		try {
			reconciledStoredSafeState = await reconcileStoredGnosisSafeState(ethereum, safeEntry.address)
		} catch (error) {
			if (!isGnosisSafeContractValidationFailure(error)) throw error
			reconciliationMessage = getErrorMessage(error) ?? 'The local Gnosis Safe stack could not be reconciled with the current on-chain nonce.'
			await reportLocalRecovery(error, {
				code: 'safe_stack_reconciliation_failed',
				message: 'Showing the Gnosis Safe stack reconciliation failure in the confirmation window.',
				details: error instanceof Error ? error.stack : undefined,
			})
		}
	}

	const executeThroughSafe = simulationMode && await isSimulationModeGnosisSafeExecution(ethereum, transactionParams, activeAddress)
	// Explicit Gnosis Safe Apps operations must never degrade to an ordinary CALL when Gnosis Safe execution is unavailable.
	if (simulationMode && confirmation.safeTransaction !== undefined && !executeThroughSafe) return createRejectedPreparation(activeAddress, transactionParams, 'Gnosis Safe Apps simulation requires a deployed, supported Gnosis Safe on the selected chain.')
	// Why the configured Gnosis Safe can't make the request through execTransaction. Only a contract creation gets this far; the other reasons are rejected above.
	const unsupportedSafeRequestReason = safeEntry === undefined ? undefined : getGnosisSafeUnsupportedRequestReason(transactionParams)
	// finalize stores it in the pending transaction as its safeFlow, from which every refresh reads it back (getPendingTransactionFlowKind).
	const openedSafeFlow: OpenedGnosisSafeFlow = isDirectSafeExecution && transactionParams.method === 'eth_sendTransaction'
		? {
			kind: 'directExecution',
			safeExecutionOriginalRequestParameters: transactionParams,
			...(safeExecutionSignerRoute === undefined ? {} : { safeExecutionSignerAddress: safeExecutionSignerRoute.executor }),
			...(safeExecutionReviewedState === undefined ? {} : { safeExecutionReviewedSafeState: safeExecutionReviewedState }),
		}
		: safeEntry !== undefined ? unsupportedSafeRequestReason === undefined ? { kind: 'proposal' } : { kind: 'unsupportedSafeRequest' }
		: executeThroughSafe ? { kind: 'simulationModeSafeExecution', ...(confirmation.safeTransaction?.operation === 1 ? { operation: 1 as const } : {}) }
		: { kind: 'ordinary' }
	// The window shows an unsupported request's rejection without forming the transaction, so no gas estimate or other formation failure can stand in for it.
	const unsupportedSafeRequestMessage = unsupportedSafeRequestReason === undefined ? undefined : GNOSIS_SAFE_UNSUPPORTED_TRANSACTION_MESSAGES[unsupportedSafeRequestReason]
	const directSignerSelectionMessage = isDirectSafeExecution && safeExecutionSignerRoute === undefined
		? executionPreparationMessage ?? 'Connect a signer wallet and select a current Gnosis Safe owner before signing.'
		: undefined
	return {
		effectiveTransactionParams: safeExecutionSignerRoute?.transactionParams ?? transactionParams,
		transactionExecutor: safeExecutionSignerRoute?.executor ?? activeAddress,
		flowKind: openedSafeFlow.kind,
		gasPayment: getGnosisSafeTransactionFlowGasPayment(openedSafeFlow.kind),
		safeOperation: openedSafeFlow.kind === 'simulationModeSafeExecution' ? openedSafeFlow.operation : undefined,
		preparationMessage: unsupportedSafeRequestMessage ?? directSignerSelectionMessage ?? executionPreparationMessage ?? reconciliationMessage,
		rejection: undefined,
		async finalize(transactionToSimulate, tabId) {
			let finalizedTransaction = transactionToSimulate
			let safeTransaction: GnosisSafeTransactionSigningRequest | undefined
			let safeSignerSelectionError: GnosisSafeSignerErrorStatus | undefined
			if (isDirectSafeExecution && safeExecutionSignerRoute === undefined) {
				safeSignerSelectionError = createGnosisSafeSignerErrorStatus(
					directSignerSelectionMessage ?? 'Connect a signer wallet and select a current Gnosis Safe owner before signing.',
					GNOSIS_SAFE_SIGNER_SELECTION_ERROR_CODE,
				)
			}
			if (finalizedTransaction.success) {
				try {
					const review = confirmation.safeTransaction?.messageReview
					if (simulationMode && review !== undefined && (finalizedTransaction.transaction.to === null || !matchesGnosisSafeMessageApproval({ to: finalizedTransaction.transaction.to, value: finalizedTransaction.transaction.value, data: finalizedTransaction.transaction.input, operation: BigInt(confirmation.safeTransaction?.operation ?? 0) }, review))) throw createGnosisSafeContractValidationFailure('The Gnosis Safe message review text does not match the on-chain approval.')
					safeTransaction = await createGnosisSafeSigningRequestForTransaction(
						ethereum,
						safeExecutionSignerRoute?.transactionParams ?? transactionParams,
						finalizedTransaction,
						safeEntry,
						walletSignerAddress,
						reconciledStoredSafeState,
						confirmation.safeTransaction,
					)
				} catch (error) {
					if (isGnosisSafeOwnerValidationFailure(error)) {
						safeSignerSelectionError = createGnosisSafeSignerErrorStatus(
							getErrorMessage(error) ?? 'Select a current Gnosis Safe owner in the signer wallet before signing.',
							GNOSIS_SAFE_SIGNER_SELECTION_ERROR_CODE,
						)
						try {
							safeTransaction = await createGnosisSafeSigningRequestForTransaction(
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
							if (!isGnosisSafeContractValidationFailure(reviewError)) throw reviewError
							finalizedTransaction = await createFailedGnosisSafeTransaction(finalizedTransaction, transactionParams, safeExecutionSignerRoute, reviewError)
						}
					} else if (isGnosisSafeContractValidationFailure(error)) {
						finalizedTransaction = await createFailedGnosisSafeTransaction(finalizedTransaction, transactionParams, safeExecutionSignerRoute, error)
					} else {
						throw error
					}
				}
			}
			if (safeTransaction !== undefined && safeTransaction.safeSignerAddress === undefined) {
				safeSignerSelectionError = createGnosisSafeSignerErrorStatus(
					'Connect a signer wallet and select a current Gnosis Safe owner before signing.',
					GNOSIS_SAFE_SIGNER_SELECTION_ERROR_CODE,
				)
			}
			const approvalStatus = safeSignerSelectionError ?? (safeTransaction === undefined
				? safeExecutionSignerRoute === undefined
					? undefined
					: await getGnosisSafeSignerMismatchApprovalStatus(tabId, safeExecutionSignerRoute.executor)
				: safeTransaction.safeSignerAddress === undefined
					? undefined
					: await getGnosisSafeSignerMismatchApprovalStatus(tabId, safeTransaction.safeSignerAddress)
			)
			const safeFlow: PendingTransactionGnosisSafeFlow = openedSafeFlow.kind !== 'proposal' ? openedSafeFlow
				: safeTransaction !== undefined ? createCreatedGnosisSafeProposalGnosisSafeFlow(safeTransaction)
				// The transaction did not form, so no proposal was attempted: every refresh prepares the confirmation again until it forms.
				: !transactionToSimulate.success ? { kind: 'proposal', state: 'formationFailed', ...(confirmation.safeTransaction === undefined ? {} : { safeRequestContext: confirmation.safeTransaction }) }
				// The transaction formed but the Gnosis Safe transaction could not be made from it, so the confirmation keeps that failure.
				: { kind: 'proposal', state: 'creationFailed' }
			return { transactionToSimulate: finalizedTransaction, safeFlow, approvalStatus }
		},
	}
}

async function createFailedGnosisSafeTransaction(
	transaction: WebsiteCreatedEthereumTransaction,
	transactionParams: SendTransactionParams | SendRawTransactionParams,
	safeExecutionSignerRoute: GnosisSafeExecutionSignerRoute | undefined,
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
): GnosisSafeTransactionConfirmationPreparation {
	return {
		effectiveTransactionParams: transactionParams,
		transactionExecutor: activeAddress,
		// A rejected request forms no transaction, so it gets the ordinary fee mode.
		flowKind: 'ordinary',
		gasPayment: getGnosisSafeTransactionFlowGasPayment('ordinary'),
		preparationMessage: undefined,
		rejection: { code: METAMASK_ERROR_METHOD_NOT_SUPPORTED_BY_PROVIDER, message },
		async finalize(transactionToSimulate) {
			return {
				transactionToSimulate,
				safeFlow: { kind: 'ordinary' },
				approvalStatus: undefined,
			}
		},
	}
}

async function createGnosisSafeSigningRequestForTransaction(
	ethereum: EthereumClientService,
	transactionParams: SendTransactionParams | SendRawTransactionParams,
	transactionToSimulate: WebsiteCreatedEthereumTransaction,
	safeEntry: GnosisSafeEntry | undefined,
	walletSignerAddress: bigint | undefined,
	reconciledStoredSafeState: ReconciledStoredGnosisSafeState | undefined,
	safeTransaction: TransactionConfirmationRequest['safeTransaction'],
	validateOwner = true,
): Promise<GnosisSafeTransactionSigningRequest | undefined> {
	if (safeEntry === undefined) return undefined
	// The request decides only whether it is a raw transaction; the rest is checked on the formed transaction, whose type and recipient are final.
	const unsupportedReason = getGnosisSafeUnsupportedRequestReason(transactionParams) === 'raw-transaction' ? 'raw-transaction' : getGnosisSafeUnsupportedFormedTransactionReason(transactionToSimulate.transaction)
	if (unsupportedReason !== undefined) throw createGnosisSafeContractValidationFailure(GNOSIS_SAFE_UNSUPPORTED_TRANSACTION_MESSAGES[unsupportedReason])
	const recipient = transactionToSimulate.transaction.to
	// Already rejected as 'contract-creation' above; repeated so TypeScript narrows the recipient.
	if (recipient === null) throw createGnosisSafeContractValidationFailure(GNOSIS_SAFE_UNSUPPORTED_TRANSACTION_MESSAGES['contract-creation'])
	if (reconciledStoredSafeState === undefined) throw createGnosisSafeContractValidationFailure('The Gnosis Safe stack was not reconciled before preparing the transaction.')

	const { safeState, storedStack } = reconciledStoredSafeState
	const firstUncommittedNonce = safeState.nonce + BigInt(storedStack?.transactions.length ?? 0)
	const pendingSafeTransactionNonces = new Set((await getPendingTransactionsAndMessages()).flatMap((pending) => {
		const flow = getGnosisSafePendingFlow(pending)
		if (flow?.kind !== 'proposal') return []
		const pendingRequest = flow.pending.safeFlow.safeTransaction
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
	if (review !== undefined && !matchesGnosisSafeMessageApproval({ ...transaction, data: transaction.input }, review)) throw createGnosisSafeContractValidationFailure('The Gnosis Safe message review text does not match the on-chain approval.')
	const signingRequest = validateOwner && walletSignerAddress !== undefined
		? await createGnosisSafeTransactionSigningRequest(ethereum, safeEntry.address, walletSignerAddress, transaction, nonce)
		: await createGnosisSafeTransactionReviewRequest(ethereum, safeEntry.address, walletSignerAddress, transaction, nonce)
	return { ...signingRequest, ...(review !== undefined ? { messageReview: review } : {}) }
}
