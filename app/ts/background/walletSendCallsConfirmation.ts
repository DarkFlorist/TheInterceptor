import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import { getTransactionBatchWebsite, type PendingTransactionBatch } from '../types/accessRequest.js'
import type { ErrorWithCodeAndOptionalData } from '../types/error.js'
import type { TransactionConfirmation } from '../types/interceptor-messages.js'
import type { WalletSendCalls } from '../types/JsonRpc-types.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { type WebsiteCreatedEthereumTransaction, type WebsiteCreatedEthereumTransactionOrFailed, toResolvedSimulationState } from '../types/visualizer-types.js'
import type { PopupOrTabId, Website } from '../types/websiteAccessTypes.js'
import { METAMASK_ERROR_BLANKET_ERROR, METAMASK_ERROR_FAILED_TO_PARSE_REQUEST, METAMASK_ERROR_USER_REJECTED_REQUEST } from '../utils/constants.js'
import { isExpectedInfrastructureError, reportLocalRecovery } from '../utils/errors.js'
import { tryFocusingTabOrWindow } from '../utils/popupOrTab.js'
import { type InterceptedRequest, type UniqueRequestIdentifier, doesUniqueRequestIdentifiersMatch, getUniqueRequestIdentifierString } from '../utils/requests.js'
import { createScopedKeyedSerialExecutor } from '../utils/semaphore.js'
import { assertNever, modifyObject } from '../utils/typescript.js'
import { runConfirmationSimulation, simulateConfirmationRun, toPreSimulationTransaction } from './confirmationSimulationRun.js'
import { captureStackSimulationContext, createSimulationStateWithNonceAndBaseFeeFixing, getSimulationInputForStack, getPreparedGovernanceVote, getStackSimulationContextFingerprint, type PendingGovernanceVote, type StackSimulationContext, toStackSimulationContext } from './simulationUpdating.js'
import { getInterceptorTransactionStack, getPendingTransactionsAndMessages, getUserAddressBookEntriesForChainIdMorePreciseFirst, updateInterceptorTransactionStackUnlessRefused, updatePendingTransactionOrMessage } from './storageVariables.js'
import { getWalletSendCallsTransactionParams, walletSendCallsIdInUseError } from './walletSendCalls.js'
import { addPendingTransactionBatch, getTransactionBatchStackState, getWalletSendCallTransactionIdentifier, isWalletSendCallsIdInUse, releasePendingTransactionBatch, removeApprovedTransactionBatch } from './walletSendCallsBatchIds.js'
import { getWalletSendCallsApprovalError, getWalletSendCallsBindingError, isEthereumClientOnBatchChain, lookUpWalletSendCallsAccount } from './walletSendCallsBinding.js'
import { runWithPendingConfirmationLock } from './confirmationAdmissionLock.js'
import { updateConfirmTransactionView } from './confirmationDialogUpdates.js'
import { refreshConfirmationMetadata, shouldReplacePopupVisualisation } from './confirmationPreviews.js'
import { formRejectMessage } from './confirmationReplies.js'
import { type AnswerRequestsOfClosedWindow, getPendingTransactionWindow, removePendingRequestAndDeliverTerminalReply } from './confirmationWindow.js'
import { formEthSendTransactionOnSimulationState } from './transactionPreparation.js'
import { isSimulationModeSafeAccount } from '../safe/safeExecutionRouting.js'
import { getTransactionBatchCallGasPayment } from '../safe/safePendingFlow.js'

// Confirms simulation-mode wallet_sendCalls batches: admits a batch to the confirmation queue, previews it on top of the simulation stack, and approves or rejects it as a whole. The confirmation window admits every batch through admitTransactionBatch, and its generic dispatch hands every batch to resolvePendingTransactionBatch.

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
		const gasPayment = getTransactionBatchCallGasPayment(pendingBatch.executeCallsThroughSafe === true, transactionParams, pendingBatch.binding.account)
		const transactionToSimulate = await formEthSendTransactionOnSimulationState(ethereumClientService, undefined, simulationState, pendingBatch.binding.account, getTransactionBatchWebsite(pendingBatch), transactionParams, pendingBatch.created, transactionIdentifier, pendingBatch.simulationMode, gasPayment, 'appendedToSimulation')
		transactionsToSimulate.push(transactionToSimulate)
		if (transactionToSimulate.success) preparedOperations.push(toWalletSendCallStackOperation(transactionToSimulate))
	}
	return { transactionsToSimulate, simulationInputWithBatch: getSimulationInputForStack(stackContext, preparedOperations) }
}

// Prepares the batch's calls on top of the current simulation stack and simulates them with the shared run protocol. Like every run, it returns undefined when it was superseded or interrupted, so the previous results stay in place.
async function simulatePendingTransactionBatch(ethereumClientService: EthereumClientService, tokenPriceService: TokenPriceService, pendingBatch: PendingTransactionBatch) {
	return await runConfirmationSimulation(pendingBatch.uniqueRequestIdentifier, async (confirmationRun) => {
		const { context: stackContext } = await captureStackSimulationContext()
		const { transactionsToSimulate, simulationInputWithBatch } = await formWalletSendCallsTransactions(ethereumClientService, pendingBatch, stackContext)
		// Protectors run over each call while the run visualizes the simulation.
		const popupVisualisation = await simulateConfirmationRun({
			ethereum: ethereumClientService,
			tokenPriceService,
			confirmationRun,
			activeAddress: pendingBatch.binding.account,
			simulationMode: pendingBatch.simulationMode,
			getSimulationInput: async () => simulationInputWithBatch,
			calledContracts: pendingBatch.originalRequestParameters.params[0].calls.flatMap((call) => call.to === undefined ? [] : [call.to]),
		})
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

// The batch's part of the governance vote preview lookup: the vote of the prepared call with the identifier. Calls are only prepared with the client of the batch's network, so a call prepared for another network than the client's is a batch preview kept from before a network switch.
export function findGovernanceVoteInTransactionBatch(ethereum: EthereumClientService, pendingBatch: PendingTransactionBatch, transactionIdentifier: bigint): PendingGovernanceVote | undefined {
	if (pendingBatch.transactionOrMessageCreationStatus === 'Crafting') return undefined
	const voteCall = pendingBatch.transactionsToSimulate.find((call): call is WebsiteCreatedEthereumTransaction => call.success && call.transactionIdentifier === transactionIdentifier)
	return voteCall === undefined ? undefined : getPreparedGovernanceVote(ethereum, voteCall)
}

export async function refreshPendingTransactionBatchSimulation(ethereumClientService: EthereumClientService, tokenPriceService: TokenPriceService, pendingBatch: PendingTransactionBatch) {
	// A batch with calls on the simulation stack was approved, and simulating it on top of its own calls would preview something else. Its next resolution answers the website: the user's next action in the confirmation window, or the unanswered answer once the window closes.
	if (getTransactionBatchStackState(pendingBatch, await getInterceptorTransactionStack()) !== 'notOnStack') return
	await refreshUnapprovedTransactionBatchPreview(ethereumClientService, tokenPriceService, pendingBatch)
}

// Finishes an approval whose calls are on the simulation stack: the website gets the batch id, and the batch leaves the confirmation queue keeping its id.
async function finishApprovedTransactionBatch(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, websiteTabConnections: WebsiteTabConnections, pendingBatch: PendingTransactionBatch) {
	return await removePendingRequestAndDeliverTerminalReply(ethereum, tokenPriceService, websiteTabConnections, {
		removedRequest: pendingBatch,
		terminalReply: { ...pendingBatch.originalRequestParameters, type: 'result', result: { id: pendingBatch.batchId }, uniqueRequestIdentifier: pendingBatch.uniqueRequestIdentifier },
		removeFromQueue: async () => await removeApprovedTransactionBatch(pendingBatch),
		simulationStack: 'changed',
	})
}

// Every rejection of a batch, including no response from the user: the batch leaves the confirmation queue and its id is released before the website gets the rejection, so the website can send the same id again as soon as it has it.
async function rejectTransactionBatch(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, websiteTabConnections: WebsiteTabConnections, pendingBatch: PendingTransactionBatch, rejection: { readonly type: 'result', readonly error: ErrorWithCodeAndOptionalData }) {
	return await removePendingRequestAndDeliverTerminalReply(ethereum, tokenPriceService, websiteTabConnections, {
		removedRequest: pendingBatch,
		terminalReply: { ...pendingBatch.originalRequestParameters, ...rejection, uniqueRequestIdentifier: pendingBatch.uniqueRequestIdentifier },
		removeFromQueue: async () => await releasePendingTransactionBatch(pendingBatch),
		simulationStack: 'unchanged',
	})
}

const transactionBatchResolutionScope = {}
const serializeTransactionBatchResolution = createScopedKeyedSerialExecutor<typeof transactionBatchResolutionScope, string>()

const getPendingTransactionBatch = async (uniqueRequestIdentifier: UniqueRequestIdentifier) => (await getPendingTransactionsAndMessages())
	.find((pending): pending is PendingTransactionBatch => pending.type === 'TransactionBatch' && doesUniqueRequestIdentifiersMatch(pending.uniqueRequestIdentifier, uniqueRequestIdentifier))

type TransactionBatchResolution<T> =
	| { readonly kind: 'notPending' }
	| { readonly kind: 'finishedFromStack', readonly delivered: boolean | undefined }
	| { readonly kind: 'resolved', readonly result: T }

// Resolutions of one batch can overlap, for example when duplicate confirmation windows both approve it, so they run one at a time on freshly read state. A batch with calls already on the simulation stack was approved, even if a restart interrupted that approval before it answered the website, so every resolution finishes it from the stack instead of from the user's action: its calls are never added again.
async function resolveTransactionBatchSerially<T>(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, websiteTabConnections: WebsiteTabConnections, uniqueRequestIdentifier: UniqueRequestIdentifier, resolveUnapproved: (pendingBatch: PendingTransactionBatch) => Promise<T>) {
	return await serializeTransactionBatchResolution(transactionBatchResolutionScope, getUniqueRequestIdentifierString(uniqueRequestIdentifier), async (): Promise<TransactionBatchResolution<T>> => {
		const pendingBatch = await getPendingTransactionBatch(uniqueRequestIdentifier)
		if (pendingBatch === undefined) return { kind: 'notPending' }
		// In simulation mode nothing was executed, so an approval stands only while its whole bundle is on the stack (see isWalletSendCallsBundleOnStack). A batch whose calls the user removed after an interrupted approval is not the bundle that was approved: with some calls left it is rejected with 4001 and its id released, because adding its calls again would duplicate the ones left, and with none left it is resolved as not approved.
		const stackState = getTransactionBatchStackState(pendingBatch, await getInterceptorTransactionStack())
		switch (stackState) {
			case 'bundleOnStack': return { kind: 'finishedFromStack', delivered: await finishApprovedTransactionBatch(ethereum, tokenPriceService, websiteTabConnections, pendingBatch) }
			case 'callsPartlyRemoved': return { kind: 'finishedFromStack', delivered: await rejectTransactionBatch(ethereum, tokenPriceService, websiteTabConnections, pendingBatch, formRejectMessage(METAMASK_ERROR_USER_REJECTED_REQUEST, 'Calls of the approved batch were removed from the simulation stack')) }
			case 'notOnStack': return { kind: 'resolved', result: await resolveUnapproved(pendingBatch) }
			default: return assertNever(stackState)
		}
	})
}

// A wallet_sendCalls request that the RPC layer validated and canonicalized for the website's account and network (see canonicalizeWalletSendCalls).
export type TransactionBatchRequest = {
	readonly request: InterceptedRequest
	readonly walletSendCalls: WalletSendCalls
	readonly website: Website
	readonly account: bigint
	readonly chainId: bigint
	readonly batchId: string
}

// Admits a batch to the confirmation queue and shows its preview. Only windows/confirmTransaction.ts calls it, with the answerer that its generic dispatch provides, because answering the requests of a closed window dispatches every kind of request, batches included, back to their owners.
export async function admitTransactionBatch(
	ethereumClientService: EthereumClientService,
	tokenPriceService: TokenPriceService,
	websiteTabConnections: WebsiteTabConnections,
	batchRequest: TransactionBatchRequest,
	answerRequestsOfClosedWindow: AnswerRequestsOfClosedWindow,
) {
	const { request, walletSendCalls, website, batchId } = batchRequest
	// The binding is the batch's only website origin and account; the website's icon and title are kept for display only.
	const binding = { websiteOrigin: website.websiteOrigin, account: batchRequest.account, chainId: batchRequest.chainId }
	// Decided before the confirmation lock, as a single transaction's Gnosis Safe preparation is.
	const executeCallsThroughSafe = await isSimulationModeSafeAccount(ethereumClientService, await getUserAddressBookEntriesForChainIdMorePreciseFirst(ethereumClientService.getChainId()), binding.account)
	// The confirmation lock is held only while the batch is added to the confirmation queue, so the batch's simulation does not hold back the admission of other confirmations.
	const admission = await runWithPendingConfirmationLock(async () => {
		// Checked and recorded while holding the confirmation lock, so two concurrent requests cannot both claim the same batch id.
		if (await isWalletSendCallsIdInUse(binding.websiteOrigin, batchId)) return { admitted: false as const, refusal: formRejectMessage(walletSendCallsIdInUseError.code, walletSendCallsIdInUseError.message) }
		const openedDialog = await getPendingTransactionWindow(answerRequestsOfClosedWindow)
		if (openedDialog === undefined) return { admitted: false as const, refusal: formRejectMessage(METAMASK_ERROR_FAILED_TO_PARSE_REQUEST, 'Failed to get pending transaction window') }
		const pendingBatch = {
			type: 'TransactionBatch' as const,
			popupOrTabId: openedDialog,
			originalRequestParameters: walletSendCalls,
			uniqueRequestIdentifier: request.uniqueRequestIdentifier,
			simulationMode: true as const,
			created: new Date(),
			approvalStatus: { status: 'WaitingForUser' as const },
			binding,
			websiteDisplay: { icon: website.icon, title: website.title },
			batchId,
			...(executeCallsThroughSafe ? { executeCallsThroughSafe: true as const } : {}),
			transactionOrMessageCreationStatus: 'Crafting' as const,
		}
		await addPendingTransactionBatch(pendingBatch)
		return { admitted: true as const, pendingBatch, openedDialog }
	})
	if (!admission.admitted) return admission.refusal
	await showAdmittedTransactionBatch(ethereumClientService, tokenPriceService, websiteTabConnections, admission.pendingBatch, admission.openedDialog)
	return { type: 'doNotReply' as const }
}

// Shows a batch that was added to the confirmation queue in Crafting state, and simulates its preview. It runs without the confirmation lock, so the batch can be resolved while it simulates, as a transaction that is still simulating can: the user can reject it, its window can be closed and answered as unanswered, and approval is refused until its preview is stored. The preview is stored only while the batch is still queued (see storeTransactionBatchSimulation), focusing a closed window does nothing, and the failure rejection below only answers a batch that is still queued unapproved.
async function showAdmittedTransactionBatch(ethereumClientService: EthereumClientService, tokenPriceService: TokenPriceService, websiteTabConnections: WebsiteTabConnections, pendingBatch: PendingTransactionBatch, openedDialog: PopupOrTabId) {
	try {
		await updateConfirmTransactionView(ethereumClientService, tokenPriceService)
		await storeTransactionBatchSimulation(pendingBatch.uniqueRequestIdentifier, await simulatePendingTransactionBatch(ethereumClientService, tokenPriceService, pendingBatch))
		await updateConfirmTransactionView(ethereumClientService, tokenPriceService)
		await tryFocusingTabOrWindow(openedDialog)
	} catch(error: unknown) {
		await reportLocalRecovery(error, { code: 'send_calls_preparation_failed', message: 'Removing the batch confirmation and returning a wallet-compatible rejection to the requesting page.', details: error instanceof Error ? error.stack : undefined })
		// The preparation rejection takes the same durable path as a user's rejection. Only a batch that this cleanup removes unapproved gets it. Otherwise the batch was already approved or rejected once its preview was shown, or resolved while it simulated, and that resolution answered the website. Either way the website has its answer, so the admission itself does not reply.
		await resolveTransactionBatchSerially(ethereumClientService, tokenPriceService, websiteTabConnections, pendingBatch.uniqueRequestIdentifier, async (storedBatch) => await rejectTransactionBatch(ethereumClientService, tokenPriceService, websiteTabConnections, storedBatch, formRejectMessage(METAMASK_ERROR_BLANKET_ERROR, 'The Interceptor failed to simulate the batch of calls')))
	}
}

// A batch is approved or rejected as a whole.
export async function resolvePendingTransactionBatch(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, websiteTabConnections: WebsiteTabConnections, confirmation: TransactionConfirmation) {
	const resolution = await resolveTransactionBatchSerially(ethereum, tokenPriceService, websiteTabConnections, confirmation.data.uniqueRequestIdentifier, async (pendingBatch) => await resolveUnapprovedTransactionBatch(ethereum, tokenPriceService, websiteTabConnections, confirmation, pendingBatch))
	switch (resolution.kind) {
		case 'notPending': return undefined
		case 'finishedFromStack': return resolution.delivered
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
		case 'noResponse':
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
			// The account is looked up before the stack's write lock is taken, so other stack writers never wait for it. getWalletSendCallsBindingError then confirms against the commit snapshot that the settings it was resolved with still hold.
			const accountLookup = await lookUpWalletSendCallsAccount(websiteTabConnections, pendingBatch)
			const commitRefusal = await updateInterceptorTransactionStackUnlessRefused(
				// The commit boundary. Settings writers do not wait for stack writes, so everything the binding and the preview depend on besides the stack (settings, website access, time manipulation and rich addresses) is taken from the snapshot that storageVariables.ts reads under the stack's write lock right before the write: a change saved after that read counts as made after approval.
				(currentStack, snapshot) => {
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
