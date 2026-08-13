import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { SendRawTransactionParams, SendTransactionParams } from '../types/JsonRpc-types.js'
import type { SafeEntry } from '../types/addressBookTypes.js'
import type { SafeTransactionSigningRequest } from '../types/safeTypes.js'
import type { WebsiteCreatedEthereumTransaction, WebsiteCreatedEthereumTransactionOrFailed } from '../types/visualizer-types.js'
import { METAMASK_ERROR_FAILED_TO_PARSE_REQUEST, METAMASK_ERROR_METHOD_NOT_SUPPORTED_BY_PROVIDER } from '../utils/constants.js'
import { getErrorMessage, reportLocalRecovery } from '../utils/errors.js'
import { getPendingTransactionsAndMessages, getUserAddressBookEntriesForChainIdMorePreciseFirst } from './storageVariables.js'
import { reconcileStoredSafeState, type ReconciledStoredSafeState } from './safeStackState.js'
import { createSafeContractValidationFailure, createSafeTransactionReviewRequest, createSafeTransactionSigningRequest, isSafeContractValidationFailure, isSafeOwnerValidationFailure } from '../safe/safeCore.js'
import { getSafeExecutionReviewedState, getSafeExecutionSignerRoute, isSafeExecutionRequestForActiveSafe, prepareSafeExecutionSignerRoute } from '../safe/safeExecutionRouting.js'
import { getSafeSignerMismatchApprovalStatus, SAFE_SIGNER_SELECTION_ERROR_CODE } from './safeConfirmationResolver.js'
import { createSafeSignerErrorStatus, type SafeSignerErrorStatus } from './safeSignerErrors.js'
import { getSafePendingFlow } from '../safe/safePendingFlow.js'

type SafeExecutionSignerRoute = NonNullable<Awaited<ReturnType<typeof prepareSafeExecutionSignerRoute>>>

export type SafeTransactionConfirmationPreparation = {
	readonly effectiveTransactionParams: SendTransactionParams | SendRawTransactionParams
	readonly transactionExecutor: bigint
	readonly gasPayment: 'transaction-sender' | 'external-executor'
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
		readonly pendingSafeFields: {
			readonly safeExecutionSignerAddress?: bigint
			readonly safeExecutionOriginalRequestParameters: SendTransactionParams
			readonly safeExecutionReviewedSafeState?: SafeExecutionSignerRoute['safeState']
		} | undefined
	}>
}

export async function prepareSafeTransactionConfirmation(
	ethereum: EthereumClientService,
	transactionParams: SendTransactionParams | SendRawTransactionParams,
	simulationMode: boolean,
	activeAddress: bigint,
	walletSignerAddress: bigint | undefined,
): Promise<SafeTransactionConfirmationPreparation> {
	const configuredSafeEntry = simulationMode
		? undefined
		: (await getUserAddressBookEntriesForChainIdMorePreciseFirst(ethereum.getChainId()))
			.find((entry): entry is SafeEntry => entry.type === 'safe' && entry.address === activeAddress)
	if (configuredSafeEntry !== undefined) {
		if (transactionParams.method === 'eth_sendRawTransaction') {
			return createRejectedPreparation(activeAddress, transactionParams, 'Gnosis Safe wallets do not support eth_sendRawTransaction.')
		}
		const transactionDetails = transactionParams.params[0]
		if (transactionDetails.type === '7702' || transactionDetails.authorizationList !== undefined) {
			return createRejectedPreparation(activeAddress, transactionParams, 'Gnosis Safe wallets do not support EIP-7702 authorization lists.')
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

	const pendingSafeFields = !isDirectSafeExecution || transactionParams.method !== 'eth_sendTransaction'
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
		gasPayment: safeEntry === undefined && !isDirectSafeExecution ? 'transaction-sender' : 'external-executor',
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
			return { transactionToSimulate: finalizedTransaction, safeTransaction, approvalStatus, pendingSafeFields }
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
		gasPayment: 'transaction-sender',
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
	validateOwner = true,
): Promise<SafeTransactionSigningRequest | undefined> {
	if (safeEntry === undefined) return undefined
	if (transactionParams.method !== 'eth_sendTransaction') throw createSafeContractValidationFailure('Gnosis Safe wallets do not support eth_sendRawTransaction.')
	if (transactionToSimulate.transaction.type === '7702') throw createSafeContractValidationFailure('Gnosis Safe wallets do not support EIP-7702 authorization lists.')
	if (transactionToSimulate.transaction.to === null) throw createSafeContractValidationFailure('Gnosis Safe wallets do not support contract-creation transactions.')
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
	const transaction = {
		to: transactionToSimulate.transaction.to,
		value: transactionToSimulate.transaction.value,
		input: transactionToSimulate.transaction.input,
		gas: transactionToSimulate.transaction.gas,
	}
	return validateOwner && walletSignerAddress !== undefined
		? await createSafeTransactionSigningRequest(ethereum, safeEntry.address, walletSignerAddress, transaction, nonce)
		: await createSafeTransactionReviewRequest(ethereum, safeEntry.address, walletSignerAddress, transaction, nonce)
}
