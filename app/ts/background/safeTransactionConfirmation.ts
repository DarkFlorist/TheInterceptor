import type { TransactionConfirmationRequest } from '../types/confirmationRequest.js'
import { matchesSafeMessageApproval } from '../safe/safeMessageApproval.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { SendRawTransactionParams, SendTransactionParams } from '../types/JsonRpc-types.js'
import type { SafeEntry } from '../types/addressBookTypes.js'
import type { SafeTransactionSigningRequest } from '../types/safeTypes.js'
import type { InterceptorStackOperation, TransactionGasPayment, WebsiteCreatedEthereumTransaction, WebsiteCreatedEthereumTransactionOrFailed } from '../types/visualizer-types.js'
import { METAMASK_ERROR_FAILED_TO_PARSE_REQUEST, METAMASK_ERROR_METHOD_NOT_SUPPORTED_BY_PROVIDER } from '../utils/constants.js'
import { getErrorMessage, reportLocalRecovery } from '../utils/errors.js'
import { getPendingTransactionsAndMessages, getUserAddressBookEntriesForChainIdMorePreciseFirst } from './storageVariables.js'
import { reconcileStoredSafeState, type ReconciledStoredSafeState } from './safeStackState.js'
import { createSafeContractValidationFailure, createSafeTransactionReviewRequest, createSafeTransactionSigningRequest, getSafeContractSnapshot, isSafeContractValidationFailure, isSafeOwnerValidationFailure } from '../safe/safeCore.js'
import { getSafeExecutionReviewedState, getSafeExecutionSignerRoute, isSafeExecutionRequestForActiveSafe, prepareSafeExecutionSignerRoute } from '../safe/safeExecutionRouting.js'
import { getSafeSignerMismatchApprovalStatus, SAFE_SIGNER_SELECTION_ERROR_CODE } from './safeConfirmationResolver.js'
import { createSafeSignerErrorStatus, type SafeSignerErrorStatus } from './safeSignerErrors.js'
import { getSafePendingFlow } from '../safe/safePendingFlow.js'
import { modifyObject } from '../utils/typescript.js'

type SafeExecutionSignerRoute = NonNullable<Awaited<ReturnType<typeof prepareSafeExecutionSignerRoute>>>

type PendingSafeFields = {
	readonly safeExecutionSignerAddress?: bigint
	readonly safeExecutionOriginalRequestParameters: SendTransactionParams
	readonly safeExecutionReviewedSafeState?: SafeExecutionSignerRoute['safeState']
} | {
	readonly executeThroughSafe: true
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

// Simulation mode runs a transaction from `sender` through the Gnosis Safe's execTransaction if the sender is a Gnosis Safe configured on this chain, deployed with a version Interceptor supports.
async function isSimulatedGnosisSafe(ethereum: EthereumClientService, sender: bigint) {
	const addressBookEntries = await getUserAddressBookEntriesForChainIdMorePreciseFirst(ethereum.getChainId())
	if (!addressBookEntries.some((entry) => entry.type === 'safe' && entry.address === sender)) return false
	try {
		await getSafeContractSnapshot(ethereum, sender)
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

/**
 * In simulation mode, a transaction whose sender is a Gnosis Safe configured on this chain runs the way the Safe runs it on-chain: through the Safe's execTransaction, sent by an executor that pays the fees (safe/safeExecutionSimulation.ts). The sender is the page's `from` or else the active address, as formEthSendTransaction simulates it. Simulation mode simulates any sender the page names without a signature, so naming a Safe gives the page nothing new: it only makes the simulation run the Safe's way.
 * Raw transactions, EIP-7702 authorizations and contract creations, which a Safe can't make through execTransaction, and Safes that aren't deployed on this chain or have a version Interceptor doesn't support, keep the ordinary simulation.
 */
async function isSimulationModeSafeExecution(ethereum: EthereumClientService, transactionParams: SendTransactionParams | SendRawTransactionParams, activeAddress: bigint) {
	if (transactionParams.method !== 'eth_sendTransaction') return false
	const transactionDetails = transactionParams.params[0]
	if (transactionDetails.type === '7702' || transactionDetails.authorizationList !== undefined) return false
	if (transactionDetails.to === undefined || transactionDetails.to === null) return false
	return await isSimulatedGnosisSafe(ethereum, transactionDetails.from ?? activeAddress)
}

/**
 * Running a transaction through a Gnosis Safe makes the simulation assume the Safe's owners approved it, so an imported simulation stack doesn't get to choose it: every imported transaction's executeThroughSafe is dropped and decided again as isSimulationModeSafeExecution decides it for a confirmation.
 * Re-deciding rather than rejecting the flag needs no confirmation context: an imported transaction is already formed with an explicit sender, and a confirmation runs only an EIP-1559 call that formEthSendTransaction formed for this chain through a Safe. So a stack exported in simulation mode imports as it was, while a transaction from a sender that isn't a Gnosis Safe configured here runs as an ordinary transaction.
 */
export async function decideImportedGnosisSafeExecutions(ethereum: EthereumClientService, operations: readonly InterceptorStackOperation[]): Promise<readonly InterceptorStackOperation[]> {
	const chainId = ethereum.getChainId()
	const decisionsBySender = new Map<bigint, Promise<boolean>>()
	const isSimulatedGnosisSafeOnce = (sender: bigint) => {
		const decision = decisionsBySender.get(sender) ?? isSimulatedGnosisSafe(ethereum, sender)
		decisionsBySender.set(sender, decision)
		return decision
	}
	return await Promise.all(operations.map(async (operation) => {
		if (operation.type !== 'Transaction') return operation
		const transaction = operation.preSimulationTransaction
		const { signedTransaction, simulationOptions } = transaction
		const isSafeExecution = transaction.originalRequestParameters.method === 'eth_sendTransaction'
			&& signedTransaction.type === '1559'
			&& signedTransaction.to !== null
			&& signedTransaction.chainId === chainId
			&& await isSimulatedGnosisSafeOnce(signedTransaction.from)
		// The options formEthSendTransaction gives a simulation-mode Gnosis Safe execution.
		if (isSafeExecution) return modifyObject(operation, { preSimulationTransaction: modifyObject(transaction, { simulationOptions: { requiredChainId: chainId, executeThroughSafe: true } }) })
		if (simulationOptions?.executeThroughSafe === undefined) return operation
		const { executeThroughSafe: _importedExecuteThroughSafe, ...ordinarySimulationOptions } = simulationOptions
		return modifyObject(operation, { preSimulationTransaction: modifyObject(transaction, { simulationOptions: ordinarySimulationOptions }) })
	}))
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

	const executeThroughSafe = simulationMode && await isSimulationModeSafeExecution(ethereum, transactionParams, activeAddress)
	const getGasPayment = (): TransactionGasPayment => {
		// A direct Safe execution is the signer's own execTransaction call.
		if (isDirectSafeExecution) return 'external-executor'
		// A Safe proposal, or in simulation mode a Safe's own call, runs through the Safe's execTransaction.
		if (safeEntry !== undefined || executeThroughSafe) return 'simulated-safe-executor'
		return 'transaction-sender'
	}
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
		gasPayment: getGasPayment(),
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
	safeTransaction: TransactionConfirmationRequest['safeTransaction'],
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
	const review = safeTransaction?.messageReview
	const transaction = {
		to: transactionToSimulate.transaction.to,
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
