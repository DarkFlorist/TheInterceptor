import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { SendRawTransactionParams, SendTransactionParams } from '../types/JsonRpc-types.js'
import type { SafeEntry } from '../types/addressBookTypes.js'
import type { SafeTransactionSigningRequest } from '../types/safeTypes.js'
import type { WebsiteCreatedEthereumTransaction, WebsiteCreatedEthereumTransactionOrFailed } from '../types/visualizer-types.js'
import { METAMASK_ERROR_FAILED_TO_PARSE_REQUEST, METAMASK_ERROR_METHOD_NOT_SUPPORTED_BY_PROVIDER } from '../utils/constants.js'
import { getErrorMessage, reportLocalRecovery } from '../utils/errors.js'
import { getPendingTransactionsAndMessages, getUserAddressBookEntriesForChainIdMorePreciseFirst } from './storageVariables.js'
import { reconcileStoredSafeState, type ReconciledStoredSafeState } from './safeStackState.js'
import { createSafeTransactionReviewRequest, createSafeTransactionSigningRequest, isSafeOwnerValidationFailure } from '../safe/safeCore.js'
import { getSafeExecutionSignerRoute, prepareSafeExecutionSignerRoute } from '../safe/safeExecutionRouting.js'
import { getSafeSignerMismatchApprovalStatus, SAFE_SIGNER_SELECTION_ERROR_CODE } from './safeConfirmationResolver.js'
import { createSafeSignerErrorStatus, type SafeSignerErrorStatus } from './safeSignerErrors.js'

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
			readonly safeExecutionSignerAddress: bigint
			readonly safeExecutionOriginalRequestParameters: SendTransactionParams
			readonly safeExecutionReviewedSafeState: SafeExecutionSignerRoute['safeState']
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
	let safeExecutionSignerRoute: SafeExecutionSignerRoute | undefined
	let executionPreparationMessage: string | undefined
	if (basicExecutionRoute !== undefined && transactionParams.method === 'eth_sendTransaction') {
		try {
			safeExecutionSignerRoute = await prepareSafeExecutionSignerRoute(ethereum, transactionParams, configuredSafeEntry, walletSignerAddress)
		} catch (error) {
			executionPreparationMessage = getErrorMessage(error) ?? 'The Gnosis Safe execution transaction could not be prepared.'
			await reportLocalRecovery(error, {
				code: 'safe_execution_preparation_failed',
				message: 'Showing the Gnosis Safe execution preparation failure in the confirmation window.',
				details: error instanceof Error ? error.stack : undefined,
			})
		}
	}

	const safeEntry = safeExecutionSignerRoute === undefined ? configuredSafeEntry : undefined
	let reconciledStoredSafeState: ReconciledStoredSafeState | undefined
	let reconciliationMessage: string | undefined
	if (safeEntry !== undefined) {
		try {
			reconciledStoredSafeState = await reconcileStoredSafeState(ethereum, safeEntry.address)
		} catch (error) {
			reconciliationMessage = getErrorMessage(error) ?? 'The local Gnosis Safe stack could not be reconciled with the current on-chain nonce.'
			await reportLocalRecovery(error, {
				code: 'safe_stack_reconciliation_failed',
				message: 'Showing the Gnosis Safe stack reconciliation failure in the confirmation window.',
				details: error instanceof Error ? error.stack : undefined,
			})
		}
	}

	const pendingSafeFields = safeExecutionSignerRoute === undefined || transactionParams.method !== 'eth_sendTransaction'
		? undefined
		: {
			safeExecutionSignerAddress: safeExecutionSignerRoute.executor,
			safeExecutionOriginalRequestParameters: transactionParams,
			safeExecutionReviewedSafeState: safeExecutionSignerRoute.safeState,
		}
	return {
		effectiveTransactionParams: safeExecutionSignerRoute?.transactionParams ?? transactionParams,
		transactionExecutor: safeExecutionSignerRoute?.executor ?? activeAddress,
		gasPayment: safeEntry === undefined ? 'transaction-sender' : 'external-executor',
		preparationMessage: executionPreparationMessage ?? reconciliationMessage,
		rejection: undefined,
		async finalize(transactionToSimulate, tabId) {
			let finalizedTransaction = transactionToSimulate
			let safeTransaction: SafeTransactionSigningRequest | undefined
			let safeSignerSelectionError: SafeSignerErrorStatus | undefined
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
						safeTransaction = await createSafeSigningRequestForTransaction(
							ethereum,
							safeExecutionSignerRoute?.transactionParams ?? transactionParams,
							finalizedTransaction,
							safeEntry,
							walletSignerAddress,
							reconciledStoredSafeState,
							false,
						)
						safeSignerSelectionError = createSafeSignerErrorStatus(
							getErrorMessage(error) ?? 'Select a current Gnosis Safe owner in the signer wallet before signing.',
							SAFE_SIGNER_SELECTION_ERROR_CODE,
						)
					} else {
						const message = getErrorMessage(error) ?? 'The Gnosis Safe transaction could not be prepared.'
						await reportLocalRecovery(error, {
							code: 'safe_transaction_preparation_failed',
							message: 'Showing the Gnosis Safe preparation failure in the confirmation window.',
							details: error instanceof Error ? error.stack : undefined,
						})
						finalizedTransaction = {
							website: finalizedTransaction.website,
							created: finalizedTransaction.created,
							originalRequestParameters: safeExecutionSignerRoute?.transactionParams ?? transactionParams,
							transactionIdentifier: finalizedTransaction.transactionIdentifier,
							success: false,
							error: { code: METAMASK_ERROR_FAILED_TO_PARSE_REQUEST, message },
						}
					}
				}
			}
			const approvalStatus = safeSignerSelectionError ?? (safeTransaction === undefined
				? safeExecutionSignerRoute === undefined
					? undefined
					: await getSafeSignerMismatchApprovalStatus(tabId, safeExecutionSignerRoute.executor)
				: await getSafeSignerMismatchApprovalStatus(tabId, safeTransaction.safeSignerAddress)
			)
			return { transactionToSimulate: finalizedTransaction, safeTransaction, approvalStatus, pendingSafeFields }
		},
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
	if (transactionParams.method !== 'eth_sendTransaction') throw new Error('Gnosis Safe wallets do not support eth_sendRawTransaction.')
	if (transactionToSimulate.transaction.type === '7702') throw new Error('Gnosis Safe wallets do not support EIP-7702 authorization lists.')
	if (transactionToSimulate.transaction.to === null) throw new Error('Gnosis Safe wallets do not support contract-creation transactions.')
	if (walletSignerAddress === undefined) throw new Error('Connect a signer wallet and select a Gnosis Safe owner before using signing mode.')
	if (reconciledStoredSafeState === undefined) throw new Error('The Gnosis Safe stack was not reconciled before preparing the transaction.')

	const { safeState, storedStack } = reconciledStoredSafeState
	const firstUncommittedNonce = safeState.nonce + BigInt(storedStack?.transactions.length ?? 0)
	const pendingSafeTransactionNonces = new Set((await getPendingTransactionsAndMessages()).flatMap((pending) =>
		pending.type === 'Transaction'
		&& pending.safeTransaction?.safeAddress === safeEntry.address
		&& pending.safeTransaction.safeTx.domain.chainId === ethereum.getChainId()
		&& pending.safeTransaction.safeTx.message.nonce >= firstUncommittedNonce
			? [pending.safeTransaction.safeTx.message.nonce]
			: []
	))
	let nonce = firstUncommittedNonce
	while (pendingSafeTransactionNonces.has(nonce)) nonce += 1n
	const createRequest = validateOwner ? createSafeTransactionSigningRequest : createSafeTransactionReviewRequest
	return await createRequest(
		ethereum,
		safeEntry.address,
		walletSignerAddress,
		{
			to: transactionToSimulate.transaction.to,
			value: transactionToSimulate.transaction.value,
			input: transactionToSimulate.transaction.input,
			gas: transactionToSimulate.transaction.gas,
		},
		nonce,
	)
}
