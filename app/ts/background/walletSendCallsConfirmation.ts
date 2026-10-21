import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import type { ConfirmTransactionBatchVisualization, PendingTransactionBatch, WalletSendCallsBinding } from '../types/accessRequest.js'
import type { ErrorWithCodeAndOptionalData } from '../types/error.js'
import type { TransactionConfirmation } from '../types/interceptor-messages.js'
import type { WalletSendCalls } from '../types/JsonRpc-types.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { type SimulationStateInput, type WebsiteCreatedEthereumTransaction, type WebsiteCreatedEthereumTransactionOrFailed, toResolvedSimulationState } from '../types/visualizer-types.js'
import type { Website } from '../types/websiteAccessTypes.js'
import { JSON_RPC_ERROR_CODE_INTERNAL_ERROR, METAMASK_ERROR_BLANKET_ERROR, METAMASK_ERROR_FAILED_TO_PARSE_REQUEST, METAMASK_ERROR_USER_REJECTED_REQUEST } from '../utils/constants.js'
import { JsonRpcResponseError, isExpectedInfrastructureError, reportLocalRecovery, reportUnexpectedError } from '../utils/errors.js'
import { tryFocusingTabOrWindow } from '../utils/popupOrTab.js'
import { type InterceptedRequest, type UniqueRequestIdentifier, doesUniqueRequestIdentifiersMatch, getUniqueRequestIdentifierString } from '../utils/requests.js'
import { createScopedKeyedSerialExecutor } from '../utils/semaphore.js'
import { assertNever, modifyObject } from '../utils/typescript.js'
import { runConfirmationSimulation, startConfirmTransactionSimulation, toPreSimulationTransaction } from './confirmationSimulationRun.js'
import { updatePopupVisualisationIfNeeded } from './popupVisualisationUpdater.js'
import { getSimulationSettingsSnapshot } from './settings.js'
import { captureStackSimulationContext, createSimulationStateWithNonceAndBaseFeeFixing, getSimulationInputForStack, getStackSimulationContextFingerprint, type StackSimulationContext, toStackSimulationContext, visualizeSimulatorState } from './simulationUpdating.js'
import { getInterceptorTransactionStack, getPendingTransactionsAndMessages, getTabState, updateInterceptorTransactionStackUnlessRefused, updatePendingTransactionOrMessage } from './storageVariables.js'
import { attemptQueuedTerminalReplyDelivery, queueTerminalReply, queueTerminalReplyAndAttemptDelivery } from './terminalReplyDelivery.js'
import { getWalletSendCallsTransactionParams, walletSendCallsIdInUseError } from './walletSendCalls.js'
import { addPendingTransactionBatch, getWalletSendCallTransactionIdentifier, isTransactionBatchOnStack, isWalletSendCallsIdInUse, releasePendingTransactionBatch, removeApprovedTransactionBatch } from './walletSendCallsBatchIds.js'
import { getWalletSendCallsApprovalError, getWalletSendCallsBindingError, isEthereumClientOnBatchChain, lookUpWalletSendCallsAccount } from './walletSendCallsBinding.js'
import { runWithPendingConfirmationLock } from './confirmationAdmissionLock.js'
import { updateConfirmTransactionView } from './confirmationDialogUpdates.js'
import { refreshConfirmationMetadata, shouldReplacePopupVisualisation } from './confirmationPreviews.js'
import { formRejectMessage } from './confirmationReplies.js'
import { type AnswerRequestsOfClosedWindow, getPendingTransactionWindow, updateViewAfterPendingRequestRemoved } from './confirmationWindow.js'
import { formEthSendTransactionOnSimulationState } from './transactionPreparation.js'

// Confirms simulation-mode wallet_sendCalls batches: admits a batch to the confirmation queue, previews it on top of the simulation stack, and approves or rejects it as a whole. The confirmation window's generic dispatch hands every batch to resolvePendingTransactionBatch.

// The stack operation that approval adds for one prepared call of a batch.
const toWalletSendCallStackOperation = (transaction: WebsiteCreatedEthereumTransaction) => ({ type: 'Transaction' as const, preSimulationTransaction: toPreSimulationTransaction(transaction) })

// Each call is prepared on top of the calls before it, so later calls see the approvals, transfers and nonces of earlier calls in the same batch.
async function formWalletSendCallsTransactions(ethereumClientService: EthereumClientService, pendingBatch: PendingTransactionBatch, stackContext: StackSimulationContext) {
	const preparedOperations: ReturnType<typeof toWalletSendCallStackOperation>[] = []
	const transactionsToSimulate: WebsiteCreatedEthereumTransactionOrFailed[] = []
	for (const [callIndex, transactionParams] of getWalletSendCallsTransactionParams(pendingBatch.originalRequestParameters, pendingBatch.binding.account).entries()) {
		// The batch is previewed exactly where approval commits it: its calls are appended to the stack's operations, and each call is estimated in the block that approval adds it to.
		const simulationState = toResolvedSimulationState(await createSimulationStateWithNonceAndBaseFeeFixing(getSimulationInputForStack(stackContext, preparedOperations, true), ethereumClientService))
		const transactionIdentifier = getWalletSendCallTransactionIdentifier(pendingBatch.uniqueRequestIdentifier, callIndex)
		const transactionToSimulate = await formEthSendTransactionOnSimulationState(ethereumClientService, undefined, simulationState, pendingBatch.binding.account, pendingBatch.website, transactionParams, pendingBatch.created, transactionIdentifier, pendingBatch.simulationMode, 'transaction-sender', 'appendedToSimulation')
		transactionsToSimulate.push(transactionToSimulate)
		if (transactionToSimulate.success) preparedOperations.push(toWalletSendCallStackOperation(transactionToSimulate))
	}
	return { transactionsToSimulate, simulationInputWithBatch: getSimulationInputForStack(stackContext, preparedOperations) }
}

// Simulates and visualizes a simulation input that already contains every prepared batch call. Protectors run over each call while the simulation is visualized. Like the single-transaction simulation, it returns undefined when it was superseded or the RPC was unreachable, so the previous results stay in place.
async function simulateConfirmTransactionBatch(
	ethereum: EthereumClientService,
	tokenPriceService: TokenPriceService,
	activeAddress: bigint,
	simulationMode: boolean,
	uniqueRequestIdentifier: UniqueRequestIdentifier,
	confirmationRunId: number,
	simulationInputWithBatch: SimulationStateInput,
): Promise<ConfirmTransactionBatchVisualization | undefined> {
	const info = {
		uniqueRequestIdentifier,
		simulationMode,
		activeAddress,
		signerName: (await getTabState(uniqueRequestIdentifier.requestSocket.tabId)).signerName,
		simulationStartedTimestamp: new Date(),
		confirmationRunId,
	}
	const thisConfirmTransactionAbortController = startConfirmTransactionSimulation(uniqueRequestIdentifier, confirmationRunId)
	if (thisConfirmTransactionAbortController === undefined) return undefined
	try {
		const visualizedSimulatorState = await visualizeSimulatorState(await createSimulationStateWithNonceAndBaseFeeFixing(simulationInputWithBatch, ethereum), ethereum, tokenPriceService, thisConfirmTransactionAbortController)
		if (visualizedSimulatorState.visualizedSimulationState.success === false) {
			const error = visualizedSimulatorState.visualizedSimulationState.jsonRpcError.error
			return { statusCode: 'failed', data: { ...info, error: { ...error, decodedErrorMessage: error.message }, simulationState: { blockNumber: visualizedSimulatorState.simulationState.blockNumber, simulationConductedTimestamp: new Date() } } }
		}
		return { statusCode: 'success', data: { ...info, ...visualizedSimulatorState } }
	} catch (error) {
		if (isExpectedInfrastructureError(error)) return undefined
		if (!(error instanceof JsonRpcResponseError)) await reportUnexpectedError(error, { code: 'confirm_transaction_batch_simulation_failed' })
		const message = error instanceof Error ? error.message : 'Unknown simulation error'
		const code = error instanceof JsonRpcResponseError ? error.code : JSON_RPC_ERROR_CODE_INTERNAL_ERROR
		return { statusCode: 'failed', data: { ...info, error: { code, message, decodedErrorMessage: message }, simulationState: { blockNumber: 0n, simulationConductedTimestamp: new Date() } } }
	}
}

async function simulatePendingTransactionBatch(ethereumClientService: EthereumClientService, tokenPriceService: TokenPriceService, pendingBatch: PendingTransactionBatch) {
	return await runConfirmationSimulation(async (confirmationRunId) => {
		const { context: stackContext } = await captureStackSimulationContext()
		const { transactionsToSimulate, simulationInputWithBatch } = await formWalletSendCallsTransactions(ethereumClientService, pendingBatch, stackContext)
		const popupVisualisation = await simulateConfirmTransactionBatch(ethereumClientService, tokenPriceService, pendingBatch.activeAddress, pendingBatch.simulationMode, pendingBatch.uniqueRequestIdentifier, confirmationRunId, simulationInputWithBatch)
		if (popupVisualisation === undefined) return undefined
		return {
			transactionsToSimulate,
			popupVisualisation,
			simulatedContextFingerprint: getStackSimulationContextFingerprint(stackContext),
			transactionOrMessageCreationStatus: transactionsToSimulate.every((transaction) => transaction.success) ? 'Simulated' as const : 'FailedToSimulate' as const,
		}
	})
}

// An interrupted simulation stores nothing: the previous results, or the Crafting state of a new batch, stay until the next block retries it.
async function storeTransactionBatchSimulation(uniqueRequestIdentifier: UniqueRequestIdentifier, simulatedBatch: Awaited<ReturnType<typeof simulatePendingTransactionBatch>>) {
	if (simulatedBatch === undefined) return
	await updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (pending) => {
		if (pending.type !== 'TransactionBatch') return pending
		if ('popupVisualisation' in pending && !shouldReplacePopupVisualisation(pending.popupVisualisation, simulatedBatch.popupVisualisation)) return pending
		return { ...pending, ...simulatedBatch }
	})
}

// Simulates the preview of a batch that was not approved again, on top of the current simulation stack.
async function refreshUnapprovedTransactionBatchPreview(ethereumClientService: EthereumClientService, tokenPriceService: TokenPriceService, pendingBatch: PendingTransactionBatch) {
	// The same calls can do something else on another network, so after a network switch the batch keeps the preview of the network it was requested for. A client serves one network for its whole lifetime, so a refresh that passes this check only stores results from that network, even if the user switches networks while it runs.
	if (!isEthereumClientOnBatchChain(ethereumClientService, pendingBatch)) return
	try {
		await storeTransactionBatchSimulation(pendingBatch.uniqueRequestIdentifier, await simulatePendingTransactionBatch(ethereumClientService, tokenPriceService, pendingBatch))
	} catch(error: unknown) {
		// The previous simulation stays visible and the next block retries the refresh.
		if (isExpectedInfrastructureError(error)) return
		throw error
	}
	await updateConfirmTransactionView(ethereumClientService, tokenPriceService, true)
}

// The batch's part of the metadata refresh. Protectors and metadata of another network would describe different contracts, so a batch is only re-visualized on the network it was requested for.
export async function refreshPendingTransactionBatchMetadata(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, requestAbortController: AbortController | undefined, pendingBatch: PendingTransactionBatch, updateConfirmationWindow: () => Promise<void>) {
	if (pendingBatch.transactionOrMessageCreationStatus === 'Crafting' || pendingBatch.popupVisualisation.statusCode === 'failed' || !isEthereumClientOnBatchChain(ethereum, pendingBatch)) return
	await refreshConfirmationMetadata(ethereum, tokenPriceService, requestAbortController, pendingBatch.uniqueRequestIdentifier, pendingBatch.popupVisualisation, (current) => current.type === 'TransactionBatch' && current.transactionOrMessageCreationStatus !== 'Crafting'
		? { visualisation: current.popupVisualisation, withVisualisation: (popupVisualisation) => modifyObject(current, { popupVisualisation }) }
		: undefined, updateConfirmationWindow)
}

export async function refreshPendingTransactionBatchSimulation(ethereumClientService: EthereumClientService, tokenPriceService: TokenPriceService, pendingBatch: PendingTransactionBatch) {
	// A batch whose calls are on the simulation stack was approved, and simulating it on top of its own calls would preview something else. Its next resolution finishes the approval and answers the website: the user's next action in the confirmation window, or the unanswered answer once the window closes.
	if (isTransactionBatchOnStack(pendingBatch, await getInterceptorTransactionStack())) return
	await refreshUnapprovedTransactionBatchPreview(ethereumClientService, tokenPriceService, pendingBatch)
}

// Updates the confirmation window once a batch has left the confirmation queue: the simulation stack view when approval changed the stack, and the queue view, which focuses the website's tab or closes the window once the queue is empty. The website's answer never waits for this view work, so a failure in it is reported instead of reaching the caller.
async function updateViewAfterTransactionBatchRemoved(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, pendingBatch: PendingTransactionBatch, simulationStack: 'changed' | 'unchanged') {
	try {
		if (simulationStack === 'changed') await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService)
		await updateViewAfterPendingRequestRemoved(ethereum, tokenPriceService, pendingBatch)
	} catch(error: unknown) {
		await reportUnexpectedError(error, { code: 'wallet_send_calls_confirmation_view_update_failed' })
	}
}

async function releaseTransactionBatchAndUpdateView(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, pendingBatch: PendingTransactionBatch) {
	await releasePendingTransactionBatch(pendingBatch)
	await updateViewAfterTransactionBatchRemoved(ethereum, tokenPriceService, pendingBatch, 'unchanged')
}

// Finishes an approval whose calls are on the simulation stack. The reply with the batch id is queued and the batch is removed from the confirmation queue, keeping its id, so after a restart at most the reply's delivery is left. The reply is delivered before the view work, which cannot hold it back.
async function finishApprovedTransactionBatch(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, websiteTabConnections: WebsiteTabConnections, pendingBatch: PendingTransactionBatch) {
	const terminalReply = { ...pendingBatch.originalRequestParameters, type: 'result' as const, result: { id: pendingBatch.batchId }, uniqueRequestIdentifier: pendingBatch.uniqueRequestIdentifier }
	await queueTerminalReply(terminalReply)
	await removeApprovedTransactionBatch(pendingBatch)
	const delivered = await attemptQueuedTerminalReplyDelivery(websiteTabConnections, terminalReply)
	await updateViewAfterTransactionBatchRemoved(ethereum, tokenPriceService, pendingBatch, 'changed')
	return delivered
}

// The rejection is queued, the batch is removed and its id released, and the rejection is delivered before the view work, which cannot hold it back.
async function rejectTransactionBatch(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, websiteTabConnections: WebsiteTabConnections, pendingBatch: PendingTransactionBatch, rejection: { readonly type: 'result', readonly error: ErrorWithCodeAndOptionalData }) {
	const terminalReply = { ...pendingBatch.originalRequestParameters, ...rejection, uniqueRequestIdentifier: pendingBatch.uniqueRequestIdentifier }
	await queueTerminalReply(terminalReply)
	await releasePendingTransactionBatch(pendingBatch)
	const delivered = await attemptQueuedTerminalReplyDelivery(websiteTabConnections, terminalReply)
	await updateViewAfterTransactionBatchRemoved(ethereum, tokenPriceService, pendingBatch, 'unchanged')
	return delivered
}

const transactionBatchResolutionScope = {}
const serializeTransactionBatchResolution = createScopedKeyedSerialExecutor<typeof transactionBatchResolutionScope, string>()

const getPendingTransactionBatch = async (uniqueRequestIdentifier: UniqueRequestIdentifier) => (await getPendingTransactionsAndMessages())
	.find((pending): pending is PendingTransactionBatch => pending.type === 'TransactionBatch' && doesUniqueRequestIdentifiersMatch(pending.uniqueRequestIdentifier, uniqueRequestIdentifier))

type TransactionBatchResolution<T> =
	| { readonly kind: 'notPending' }
	| { readonly kind: 'finishedAsApproved', readonly delivered: boolean | undefined }
	| { readonly kind: 'resolved', readonly result: T }

// Resolutions of one batch can overlap, for example when duplicate confirmation windows both approve it, so they run one at a time on freshly read state. A batch whose calls are already on the simulation stack was approved, even if a restart interrupted that approval before it answered the website, so every resolution finishes it as approved instead: it is never rejected, its id is never released and its calls are never added again.
async function resolveTransactionBatchSerially<T>(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, websiteTabConnections: WebsiteTabConnections, uniqueRequestIdentifier: UniqueRequestIdentifier, resolveUnapproved: (pendingBatch: PendingTransactionBatch) => Promise<T>) {
	return await serializeTransactionBatchResolution(transactionBatchResolutionScope, getUniqueRequestIdentifierString(uniqueRequestIdentifier), async (): Promise<TransactionBatchResolution<T>> => {
		const pendingBatch = await getPendingTransactionBatch(uniqueRequestIdentifier)
		if (pendingBatch === undefined) return { kind: 'notPending' }
		// Approval is recognised only while its calls are on the stack: in simulation mode nothing was executed, so a batch whose calls the user removed after an interrupted approval has nothing left to report and is resolved as not approved, a rejection answering 4001 and releasing its id.
		if (isTransactionBatchOnStack(pendingBatch, await getInterceptorTransactionStack())) return { kind: 'finishedAsApproved', delivered: await finishApprovedTransactionBatch(ethereum, tokenPriceService, websiteTabConnections, pendingBatch) }
		return { kind: 'resolved', result: await resolveUnapproved(pendingBatch) }
	})
}

export async function openConfirmTransactionDialogForTransactionBatch(
	ethereumClientService: EthereumClientService,
	tokenPriceService: TokenPriceService,
	request: InterceptedRequest,
	walletSendCalls: WalletSendCalls,
	binding: WalletSendCallsBinding,
	batchId: string,
	website: Website,
	websiteTabConnections: WebsiteTabConnections,
	// Passed in by the caller: answering the requests of a closed window dispatches every kind of request, batches included, back to this module.
	answerRequestsOfClosedWindow: AnswerRequestsOfClosedWindow,
) {
	const outcome = await runWithPendingConfirmationLock(async () => {
		// Checked and recorded while holding the confirmation lock, so two concurrent requests cannot both claim the same batch id.
		if (await isWalletSendCallsIdInUse(website.websiteOrigin, batchId)) return formRejectMessage(walletSendCallsIdInUseError.code, walletSendCallsIdInUseError.message)
		const openedDialog = await getPendingTransactionWindow(answerRequestsOfClosedWindow)
		if (openedDialog === undefined) return formRejectMessage(METAMASK_ERROR_FAILED_TO_PARSE_REQUEST, 'Failed to get pending transaction window')
		const pendingBatch = {
			type: 'TransactionBatch' as const,
			popupOrTabId: openedDialog,
			originalRequestParameters: walletSendCalls,
			uniqueRequestIdentifier: request.uniqueRequestIdentifier,
			simulationMode: true as const,
			activeAddress: binding.account,
			created: new Date(),
			website,
			approvalStatus: { status: 'WaitingForUser' as const },
			binding,
			batchId,
			transactionOrMessageCreationStatus: 'Crafting' as const,
		}
		await addPendingTransactionBatch(pendingBatch)
		try {
			await updateConfirmTransactionView(ethereumClientService, tokenPriceService)
			await storeTransactionBatchSimulation(pendingBatch.uniqueRequestIdentifier, await simulatePendingTransactionBatch(ethereumClientService, tokenPriceService, pendingBatch))
			await updateConfirmTransactionView(ethereumClientService, tokenPriceService)
			await tryFocusingTabOrWindow(openedDialog)
			return { success: true }
		} catch(error: unknown) {
			await reportLocalRecovery(error, { code: 'send_calls_preparation_failed', message: 'Removing the batch confirmation and returning a wallet-compatible rejection to the requesting page.', details: error instanceof Error ? error.stack : undefined })
			const ending = await resolveTransactionBatchSerially(ethereumClientService, tokenPriceService, websiteTabConnections, pendingBatch.uniqueRequestIdentifier, async (storedBatch) => await releaseTransactionBatchAndUpdateView(ethereumClientService, tokenPriceService, storedBatch))
			// Only a batch that this cleanup removed unapproved gets the preparation rejection. Otherwise the batch was already approved or rejected once its preview was shown, and that resolution answers the website.
			if (ending.kind !== 'resolved') return { success: true }
			return formRejectMessage(METAMASK_ERROR_BLANKET_ERROR, 'The Interceptor failed to simulate the batch of calls')
		}
	})
	if (!('success' in outcome)) return formRejectMessage(outcome.error.code, outcome.error.message)
	return { type: 'doNotReply' as const }
}

// A batch is approved or rejected as a whole.
export async function resolvePendingTransactionBatch(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, websiteTabConnections: WebsiteTabConnections, confirmation: TransactionConfirmation) {
	const resolution = await resolveTransactionBatchSerially(ethereum, tokenPriceService, websiteTabConnections, confirmation.data.uniqueRequestIdentifier, async (pendingBatch) => await resolveUnapprovedTransactionBatch(ethereum, tokenPriceService, websiteTabConnections, confirmation, pendingBatch))
	switch (resolution.kind) {
		case 'notPending': return undefined
		case 'finishedAsApproved': return resolution.delivered
		case 'resolved': return resolution.result
		default: return assertNever(resolution)
	}
}

async function setPendingApprovalStatus(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, uniqueRequestIdentifier: UniqueRequestIdentifier, approvalStatus: PendingTransactionBatch['approvalStatus']) {
	await updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (pending) => modifyObject(pending, { approvalStatus }))
	await updateConfirmTransactionView(ethereum, tokenPriceService)
}

// Approval re-validates the admission binding, then adds every call to the simulation stack.
async function resolveUnapprovedTransactionBatch(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, websiteTabConnections: WebsiteTabConnections, confirmation: TransactionConfirmation, pendingBatch: PendingTransactionBatch) {
	const uniqueRequestIdentifier = confirmation.data.uniqueRequestIdentifier
	// A batch in SignerError had its approval invalidated, for example by a network or account change. Rejecting it passes that reason to the website.
	const rejection = pendingBatch.approvalStatus.status === 'SignerError'
		? formRejectMessage(pendingBatch.approvalStatus.code, pendingBatch.approvalStatus.message)
		: formRejectMessage(METAMASK_ERROR_USER_REJECTED_REQUEST, 'User rejected the batch of calls')
	switch (confirmation.data.action) {
		case 'noResponse': {
			const noResponseDelivery = await queueTerminalReplyAndAttemptDelivery(websiteTabConnections, {
				...pendingBatch.originalRequestParameters,
				...rejection,
				uniqueRequestIdentifier,
			})
			await releaseTransactionBatchAndUpdateView(ethereum, tokenPriceService, pendingBatch)
			return noResponseDelivery
		}
		case 'reject': return await rejectTransactionBatch(ethereum, tokenPriceService, websiteTabConnections, pendingBatch, rejection)
		case 'addToSafeStack': return false
		// Batches are never forwarded to a signer, so a signer reply cannot complete one.
		case 'signerIncluded': return false
		case 'accept': {
			if (pendingBatch.transactionOrMessageCreationStatus !== 'Simulated') return false
			// The approval names the preview the user saw. A refresh stores its replacement before the popup shows it, and a duplicate window can still show an older preview, so approving any other preview is refused and the stored one is shown for a fresh approval.
			if (confirmation.data.approvedConfirmationRunId === undefined || confirmation.data.approvedConfirmationRunId !== pendingBatch.popupVisualisation.data.confirmationRunId) {
				await updateConfirmTransactionView(ethereum, tokenPriceService)
				return false
			}
			const invalidateApproval = async (approvalError: { readonly code: number, readonly message: string }) => {
				await setPendingApprovalStatus(ethereum, tokenPriceService, uniqueRequestIdentifier, { status: 'SignerError', ...approvalError })
				return false
			}
			const approvalError = await getWalletSendCallsApprovalError(websiteTabConnections, ethereum, pendingBatch)
			if (approvalError !== undefined) return await invalidateApproval(approvalError)
			const batchOperations = pendingBatch.transactionsToSimulate
				.filter((transaction): transaction is WebsiteCreatedEthereumTransaction => transaction.success)
				.map(toWalletSendCallStackOperation)
			const commitRefusal = await updateInterceptorTransactionStackUnlessRefused(
				async (currentStack) => {
					const accountLookup = await lookUpWalletSendCallsAccount(websiteTabConnections, pendingBatch)
					// The commit boundary. Settings writers do not wait for stack writes, so everything the binding and the preview depend on besides the stack (settings, website access, time manipulation and rich addresses) is taken from this one storage read, after every other lookup, and nothing is awaited between it and the write: a change saved after this read counts as made after approval.
					const snapshot = await getSimulationSettingsSnapshot()
					// A changed binding means the batch cannot be approved at all, so it takes precedence over a preview that only needs simulating again.
					const bindingError = getWalletSendCallsBindingError(pendingBatch, accountLookup, snapshot)
					if (bindingError !== undefined) return { reason: 'bindingChanged' as const, error: bindingError }
					// Another approval, or a change to the time manipulation or rich addresses, may have changed what the batch would run on since the preview.
					return getStackSimulationContextFingerprint(toStackSimulationContext(snapshot, currentStack)) === pendingBatch.simulatedContextFingerprint ? undefined : { reason: 'simulationContextChanged' as const }
				},
				(prevStack) => ({ operations: [...prevStack.operations, ...batchOperations] }),
			)
			if (commitRefusal?.reason === 'bindingChanged') return await invalidateApproval(commitRefusal.error)
			if (commitRefusal?.reason === 'simulationContextChanged') {
				// The batch is simulated again on top of the current stack, and the user approves that preview instead.
				await refreshUnapprovedTransactionBatchPreview(ethereum, tokenPriceService, pendingBatch)
				return false
			}
			return await finishApprovedTransactionBatch(ethereum, tokenPriceService, websiteTabConnections, pendingBatch)
		}
		default: assertNever(confirmation.data)
	}
}
