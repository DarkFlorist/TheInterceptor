import type { MessageConfirmationRequest, TransactionConfirmationRequest } from '../../types/confirmationRequest.js'
import { SafeMessage } from '../../safe/safeMessage.js'
import { isSafeMessageCoSignRequest } from '../../safe/safeRequestPolicy.js'
import type { EthereumClientService } from '../../simulation/services/EthereumClientService.js'
import { getInputFieldFromDataOrInput, getSimulatedBalance, getSimulatedErc20Balance, getSimulatedTransactionCount, simulateEstimateGas } from '../../simulation/services/SimulationModeEthereumClientService.js'
import { simulatePersonalSign } from '../../simulation/services/simulationPersonalSigning.js'
import { toPreSimulationTransaction } from '../../simulation/services/simulationTransactionSigning.js'
import { CANNOT_SIMULATE_OFF_LEGACY_BLOCK, ERROR_INTERCEPTOR_NO_ACTIVE_ADDRESS, METAMASK_ERROR_BLANKET_ERROR, METAMASK_ERROR_FAILED_TO_PARSE_REQUEST, METAMASK_ERROR_USER_REJECTED_REQUEST } from '../../utils/constants.js'
import { type InterceptedRequestForward, type TransactionConfirmation, UpdateConfirmTransactionDialog, UpdateConfirmTransactionDialogPendingTransactions } from '../../types/interceptor-messages.js'
import { Semaphore } from '../../utils/semaphore.js'
import type { WebsiteTabConnections } from '../../types/user-interface-types.js'
import { type InterceptorTransactionStack, PASSTHROUGH_STATE, type PreSimulationTransaction, type TransactionGasPayment, type TransactionSimulationOptions, type WebsiteCreatedEthereumTransaction, type WebsiteCreatedEthereumTransactionOrFailed, createPassthroughCompleteVisualizedSimulation } from '../../types/visualizer-types.js'
import type { SendRawTransactionParams, SendTransactionParams } from '../../types/JsonRpc-types.js'
import { refreshConfirmTransactionSimulation } from '../confirmTransactionSimulation.js'
import { captureSimulationSnapshot, getExecutedCallFormation, getUpdatedSimulationState } from '../simulationUpdating.js'
import { getHtmlFile, sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { appendPendingTransactionOrMessage, getInterceptorTransactionStack, getPendingTransactionsAndMessages, getRpcConnectionStatus, getTabState, getUserAddressBookEntriesForChainIdMorePreciseFirst, removePendingTransactionOrMessage, updateInterceptorTransactionStack, updateInterceptorTransactionStackWithResult, updatePendingTransactionOrMessage } from '../storageVariables.js'
import { allocateSimulationHashReservation, appendAcceptedTransactionToStack, stacksTransactionOnAccept, withSimulationHashLock } from '../simulationStackHashes.js'
import { type InterceptedRequest, type UniqueRequestIdentifier, doesTabExist, doesUniqueRequestIdentifiersMatch, getUniqueRequestIdentifierString, silenceChromeUnCaughtPromise } from '../../utils/requests.js'
import { replyToInterceptedRequestAfterManifestV2Reconnect } from '../messageSending.js'
import { attachTerminalReplyWindow, attemptQueuedTerminalReplyDelivery, forgetTerminalReplyWindow, getQueuedTerminalReply, queueTerminalReply, retireTerminalReply, setCommittedRequestFinisher } from '../terminalReplyDelivery.js'
import { getPendingTerminalReplies } from '../pendingTerminalReplies.js'
import { stringToBytes, keccak256 } from '../../utils/ethereumPrimitives.js'
import { EthereumBytes32, EthereumQuantity, serialize } from '../../types/wire-types.js'
import type { PopupOrTabId, Website } from '../../types/websiteAccessTypes.js'
import { getErrorMessage, JsonRpcResponseError, reportUnexpectedError, isExpectedInfrastructureError, isNewBlockAbort, reportLocalRecovery } from '../../utils/errors.js'
import type { PendingTransactionOrSignableMessage, PopupPendingTransactionOrSignableMessage } from '../../types/accessRequest.js'
import type { SignMessageParams } from '../../types/jsonRpc-signing-types.js'
import type { SafeSignerErrorDetails } from '../../types/safeTypes.js'
import { craftPersonalSignPopupMessage } from './personalSign.js'
import { getSettings } from '../settings.js'
import * as funtypes from 'funtypes'
import { assertNever, modifyObject } from '../../utils/typescript.js'
import { simulateGnosisSafeTransactionOnPass } from '../popupMessageHandlers.js'
import { updatePopupVisualisationIfNeeded } from '../popupVisualisationUpdater.js'
import { POPUP_PERFORMANCE_MARKS, markPerformance } from '../../utils/popupPerformance.js'
import type { TokenPriceService } from '../../simulation/services/priceEstimator.js'
import { closePopupOrTabById, getPopupOrTabById, openPopupOrTab, tryFocusingTabOrWindow } from '../../utils/popupOrTab.js'
import { getDesiredMaxFeePerGasForBaseFee, getTransactionFeesForBaseFee, hasExplicitMaxFeePerGas } from '../../utils/transactionFees.js'
import { parseSendRawTransaction } from '../../utils/sendRawTransactionParsing.js'
import { createEip1559Or7702Transaction } from '../../utils/eip7702Authorization.js'
import { identifyAddress } from '../metadataUtils.js'
import { resolveInsufficientBalanceMessage } from '../../utils/insufficientBalance.js'
import { prepareSafeTransactionConfirmation } from '../safeTransactionConfirmation.js'
import { createSafeMessageCoSignSnapshot, getPendingSafeSignerAddress, getSafeSignerMismatchApprovalStatus, isExpectedSafeMessageCoSignSnapshotFailure, isSafeMessageAccountMismatchFailure, isSafeSignerSelectionFailure, resolveSafeConfirmation, SAFE_SIGNER_SELECTION_ERROR_CODE, type RefreshedSafeSignerSelection } from '../safeConfirmationResolver.js'
import { createSafeOffChainMessageSnapshot, refreshAndPersistSafeSignerSelection } from '../safeSignerSelectionRefresh.js'
import { getSafePendingFlow } from '../../safe/safePendingFlow.js'
import { persistUnsignedSafeTransaction, resolveSafeSignerReply } from '../safeConfirmationPersistence.js'
import { getWalletSelectedAccount } from '../../utils/activeAddressSelection.js'
import { createSafeSignerErrorStatus } from '../safeSignerErrors.js'

// Serializes choosing a confirmation window and registering a request in it with deciding to close a window after its last request (updateConfirmationWindowAfterRemoving). Lock order: this lock, then the hash lock (simulationStackHashes.ts), then the terminal-reply lock (terminalReplyDelivery.ts), then the storage locks. A resolution claim is not a lock: a resolution run while this lock is held (the orphans of getPendingTransactionWindow) is told so and does not take it again, and scheduled retries run without it.
const pendingConfirmationSemaphore = new Semaphore(1)

async function refreshDirectSafeExecutionSimulation(
	ethereum: EthereumClientService,
	tokenPriceService: TokenPriceService,
	pending: PendingTransactionOrSignableMessage,
): Promise<PendingTransactionOrSignableMessage> {
	const flow = getSafePendingFlow(pending)
	if (flow?.kind !== 'directExecution') return pending
	pending = flow.pending
	const originalRequestParameters = pending.originalRequestParameters
	if (originalRequestParameters.method !== 'eth_sendTransaction') return pending
	const transactionToSimulate = await formEthSendTransaction(
		ethereum,
		undefined,
		pending.activeAddress,
		pending.website,
		originalRequestParameters,
		pending.created,
		pending.transactionIdentifier,
		false,
		'external-executor',
	)
	const popupVisualisation = await refreshConfirmTransactionSimulation(
		ethereum,
		tokenPriceService,
		pending.activeAddress,
		false,
		pending.uniqueRequestIdentifier,
		transactionToSimulate,
	)
	if (popupVisualisation === undefined) throw new Error('The refreshed Gnosis Safe execution simulation did not complete.')
	return transactionToSimulate.success
		? { ...pending, transactionToSimulate, popupVisualisation, transactionOrMessageCreationStatus: 'Simulated' }
		: { ...pending, transactionToSimulate, popupVisualisation, transactionOrMessageCreationStatus: 'FailedToSimulate' }
}

export async function refreshPendingSafeSignerSelectionErrors(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, tabId: number) {
	const tabState = await getTabState(tabId)
	const refreshedSelection = {
		selectedSigner: getWalletSelectedAccount(tabState),
		verificationError: undefined,
	}
	let pendingStateChanged = false
	for (const pending of await getPendingTransactionsAndMessages()) {
		const safeSignerAddress = getPendingSafeSignerAddress(pending)
		if (pending.uniqueRequestIdentifier.requestSocket.tabId !== tabId) continue
		if (refreshedSelection.selectedSigner !== undefined) {
			const refresh = await refreshAndPersistSafeSignerSelection(
				ethereum,
				pending,
				refreshedSelection.selectedSigner,
				async (refreshedPending) => await refreshDirectSafeExecutionSimulation(ethereum, tokenPriceService, refreshedPending),
			)
			if (refresh.persisted) pendingStateChanged = true
			if (refresh.refreshRequired && refresh.refreshResult.status !== 'unchanged') continue
		}
		if (
			safeSignerAddress === undefined
			|| pending.uniqueRequestIdentifier.requestSocket.tabId !== tabId
			|| pending.approvalStatus.status === 'WaitingForSigner'
			|| pending.approvalStatus.status === 'SignerError' && pending.approvalStatus.code !== SAFE_SIGNER_SELECTION_ERROR_CODE
		) continue
		const signerMismatch = await getSafeSignerMismatchApprovalStatus(tabId, safeSignerAddress, refreshedSelection)
		if (pending.approvalStatus.status === 'WaitingForUser' && signerMismatch === undefined) continue
		await updatePendingTransactionOrMessage(pending.uniqueRequestIdentifier, async (current) => {
			if (current.approvalStatus.status === 'WaitingForSigner') return current
			if (current.approvalStatus.status === 'SignerError' && current.approvalStatus.code !== SAFE_SIGNER_SELECTION_ERROR_CODE) return current
			pendingStateChanged = true
			return modifyObject(current, {
				approvalStatus: signerMismatch ?? { status: 'WaitingForUser' as const },
			})
		})
	}
	if (pendingStateChanged) await updateConfirmTransactionView(ethereum, tokenPriceService)
}

type TimestampedPopupVisualisation = {
	statusCode: 'success' | 'failed'
	data: {
		simulationStartedTimestamp: Date
		simulationState: {
			simulationConductedTimestamp: Date
		}
	}
}

const getSimulationStartedTimestamp = (popupVisualisation: TimestampedPopupVisualisation) => popupVisualisation.data.simulationStartedTimestamp

const shouldReplacePopupVisualisation = (
	currentPopupVisualisation: TimestampedPopupVisualisation | undefined,
	nextPopupVisualisation: TimestampedPopupVisualisation,
) => {
	const currentTimestamp = currentPopupVisualisation === undefined ? undefined : getSimulationStartedTimestamp(currentPopupVisualisation)
	const nextTimestamp = getSimulationStartedTimestamp(nextPopupVisualisation)
	if (currentTimestamp === undefined || nextTimestamp === undefined) return true
	return nextTimestamp.getTime() >= currentTimestamp.getTime()
}

export function toPopupPendingTransactionOrSignableMessage(pending: PendingTransactionOrSignableMessage): PopupPendingTransactionOrSignableMessage {
	switch (pending.type) {
		case 'Transaction':
			return pending
		case 'SignableMessage': {
			const base = {
				type: pending.type,
				popupOrTabId: pending.popupOrTabId,
				originalRequestParameters: pending.originalRequestParameters,
				simulationMode: pending.simulationMode,
				uniqueRequestIdentifier: pending.uniqueRequestIdentifier,
				created: pending.created,
				website: pending.website,
				activeAddress: pending.activeAddress,
				approvalStatus: pending.approvalStatus,
			}
			const transactionOrMessageCreationStatus = pending.transactionOrMessageCreationStatus
			switch (transactionOrMessageCreationStatus) {
				case 'Simulated':
					return {
						...base,
						transactionOrMessageCreationStatus,
						visualizedPersonalSignRequest: pending.visualizedPersonalSignRequest,
					}
				case 'Crafting':
				case 'Simulating':
					return {
						...base,
						transactionOrMessageCreationStatus,
					}
				default:
					return assertNever(transactionOrMessageCreationStatus)
			}
		}
		default:
			return assertNever(pending)
	}
}

export async function updateConfirmTransactionView(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, onlyIfNotAlreadyUpdating = false) {
	try {
		const settingsPromise = getSettings()
		const currentBlockNumberPromise = silenceChromeUnCaughtPromise(ethereum.getBlockNumber(undefined))
		const rpcConnectionStatusPromise = silenceChromeUnCaughtPromise(getRpcConnectionStatus())
		const pendingTransactionAndSignableMessages = await getPendingTransactionsAndMessages()
		if (pendingTransactionAndSignableMessages.length === 0) return false
		const settings = await settingsPromise
		const visualizedSimulatorState = settings.simulationMode
			? await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, { onlyIfNotAlreadyUpdating })
			: createPassthroughCompleteVisualizedSimulation()
		const message: UpdateConfirmTransactionDialog = { method: 'popup_update_confirm_transaction_dialog', data: {
			currentBlockNumber: await currentBlockNumberPromise,
			rpcConnectionStatus: await rpcConnectionStatusPromise,
			visualizedSimulatorState,
		} }
		const messagePendingTransactions: UpdateConfirmTransactionDialogPendingTransactions = {
			method: 'popup_update_confirm_transaction_dialog_pending_transactions' as const,
			data: {
				pendingTransactionAndSignableMessages: pendingTransactionAndSignableMessages.map(toPopupPendingTransactionOrSignableMessage),
				currentBlockNumber: await currentBlockNumberPromise,
				rpcConnectionStatus: await rpcConnectionStatusPromise,
			}
		}
		await Promise.all([
			sendPopupMessageToOpenWindows(serialize(UpdateConfirmTransactionDialogPendingTransactions, messagePendingTransactions), 'confirmTransaction'),
			sendPopupMessageToOpenWindows(serialize(UpdateConfirmTransactionDialog, message), 'confirmTransaction')
		])
		return true
	} catch(error: unknown) {
		if (isExpectedInfrastructureError(error)) return false
		await reportUnexpectedError(error)
	}
	return false
}

export const isConfirmTransactionFocused = async () => {
	const pendingTransactions = await getPendingTransactionsAndMessages()
	if (pendingTransactions[0] === undefined) return false
	const popup = await getPopupOrTabById(pendingTransactions[0].popupOrTabId)
	if (popup === undefined) return false
	if (popup.type === 'popup') return popup.window.focused
	return popup.tab.active
}

const getPendingTransactionOrMessageByidentifier = async (uniqueRequestIdentifier: UniqueRequestIdentifier) => {
	return (await getPendingTransactionsAndMessages()).find((tx) => doesUniqueRequestIdentifiersMatch(tx.uniqueRequestIdentifier, uniqueRequestIdentifier))
}

export const setGasLimitForTransaction = async (transactionIdentifier: bigint, gasLimit: bigint) => {
	const pendingTransaction = (await getPendingTransactionsAndMessages()).find((tx) => tx.type === 'Transaction' && tx.transactionIdentifier === transactionIdentifier)
	if (pendingTransaction === undefined) {
		const theTransactionIsAlreadyInStack = (await getInterceptorTransactionStack()).operations.some((transaction) => transaction.type === 'Transaction' && transaction.preSimulationTransaction.transactionIdentifier === transactionIdentifier)
		if (!theTransactionIsAlreadyInStack) return undefined
		await updateInterceptorTransactionStack((prevStack: InterceptorTransactionStack) => {
			return { operations: prevStack.operations.map((operation) => {
				if (operation.type !== 'Transaction') return operation
				if (operation.preSimulationTransaction.transactionIdentifier !== transactionIdentifier) return operation
				if (operation.preSimulationTransaction.originalRequestParameters.method !== 'eth_sendTransaction') return operation
				const originalParams = operation.preSimulationTransaction.originalRequestParameters
				const originalRequestParameters = modifyObject(originalParams, { params: [modifyObject(originalParams.params[0], { gas: gasLimit })] })
				return modifyObject(operation, { preSimulationTransaction: modifyObject(operation.preSimulationTransaction, { originalRequestParameters, signedTransaction: modifyObject(operation.preSimulationTransaction.signedTransaction, { gas: gasLimit })  }) })
			}) }
		})
		return
	}
	await updatePendingTransactionOrMessage(pendingTransaction.uniqueRequestIdentifier, async (transaction) => {
		if (transaction.originalRequestParameters.method === 'eth_sendTransaction') {
			const originalRequestParameters = modifyObject(transaction.originalRequestParameters, { params: [modifyObject(transaction.originalRequestParameters.params[0], { gas: gasLimit })] })
			return modifyObject(transaction, { originalRequestParameters: originalRequestParameters })
		}
		return transaction
	})
}

// automatic marks a resolution no user started (a scheduled retry, a reconnect flush, startup, a follow-up on claim release): it only runs while the request's retry budget lasts (withResolutionClaim).
type ResolutionContext = { readonly ethereum: EthereumClientService, readonly tokenPriceService: TokenPriceService, readonly websiteTabConnections: WebsiteTabConnections, readonly holdsPendingConfirmationLock?: true, readonly automatic?: true }
// The context for a retry that runs later: without the caller's locks, and automatic.
const withoutHeldLocks = ({ ethereum, tokenPriceService, websiteTabConnections }: ResolutionContext): ResolutionContext => ({ ethereum, tokenPriceService, websiteTabConnections, automatic: true })

// Updates the confirmation window that showed a removed request: it moves to the next of its own requests, or closes after its last. A window the user already closed counts as closed; any other failure throws, for the finishing to retry. Deciding and closing hold the pending-confirmation lock, as choosing a window and registering a new request in it do, so a request never registers in a window that is being closed: it either registers first, and the window moves to it, or chooses its window after the close and opens a new one. A resolution that runs while its caller holds the lock (holdsPendingConfirmationLock) does not take it again.
async function updateConfirmationWindowAfterRemoving(confirmationWindow: PopupOrTabId, tabId: number, context: ResolutionContext) {
	const decideAndUpdate = async () => {
		const pendingRequests = await getPendingTransactionsAndMessages()
		// Decided for this window: requests in another window never keep it open.
		if (pendingRequests.some((pending) => pending.popupOrTabId.type === confirmationWindow.type && pending.popupOrTabId.id === confirmationWindow.id)) {
			if (!(await updateConfirmTransactionView(context.ethereum, context.tokenPriceService))) throw new Error('The confirmation window could not be moved to the next request.')
			return
		}
		if (pendingRequests.length === 0) await tryFocusingTabOrWindow({ type: 'tab', id: tabId })
		await closePopupOrTabById(confirmationWindow)
	}
	if (context.holdsPendingConfirmationLock === true) await decideAndUpdate()
	else await pendingConfirmationSemaphore.execute(decideAndUpdate)
}

// A reply a resolution chose for a request whose commitment write failed: finishing the request commits it, so the request keeps that outcome.
const chosenUncommittedReplies = new Map<string, { readonly reply: InterceptedRequestForward, readonly confirmationWindow: PopupOrTabId }>()
const FINISHING_RETRY_BASE_DELAY_MS = 50
const FINISHING_RETRY_LIMIT = 6
// The one retry owner of each request, shared by finishing and declining it: one attempt budget and at most one scheduled retry. A completed resolution drops it; an exhausted budget stays exhausted, so automatic follow-ups (deferrals, finishers) never extend it, and only a user action or startup resets it (resetRequestRetryBudget).
const requestRetries = new Map<string, { readonly failedAttempts: number, readonly generation: number, readonly timer?: ReturnType<typeof setTimeout> }>()
const clearRequestRetry = (claim: string) => {
	clearTimeout(requestRetries.get(claim)?.timer)
	requestRetries.delete(claim)
}
const retryBudgetLasts = (claim: string) => (requestRetries.get(claim)?.failedAttempts ?? 0) < FINISHING_RETRY_LIMIT
const resetRequestRetryBudget = (uniqueRequestIdentifier: UniqueRequestIdentifier) => clearRequestRetry(getUniqueRequestIdentifierString(uniqueRequestIdentifier))
// The requests whose budget startup recovery already reset: the startup recovery's own retries are automatic, so only its first pass over a request gives it a new budget. A startup begins with none (beginStartupRecovery).
const requestsResetByStartup = new Set<string>()
export const beginStartupRecovery = () => requestsResetByStartup.clear()
const resetRequestRetryBudgetAtStartup = (uniqueRequestIdentifier: UniqueRequestIdentifier) => {
	const claim = getUniqueRequestIdentifierString(uniqueRequestIdentifier)
	if (requestsResetByStartup.has(claim)) return
	requestsResetByStartup.add(claim)
	clearRequestRetry(claim)
}
// The decline each request was asked for in this session, which its retries run (declineRequest); the stored declineRequested of the pending request carries it across a restart.
const declineIntents = new Map<string, DeclineReason>()

// Schedules the request's one retry for a failed resolution step, unless its budget is exhausted, then reports the failure. The attempt and the timer are reserved synchronously, before the report is awaited, so concurrent failures each count once against the one budget and a timer is never overwritten without being cleared. Each schedule has its own generation: completion or a budget reset deletes the entry, so a stale timer finds its generation gone and does nothing. The retry declines the request if a decline was asked for, else finishes it.
let nextRetryGeneration = 0
async function scheduleRequestRetry(uniqueRequestIdentifier: UniqueRequestIdentifier, context: ResolutionContext, error: unknown) {
	const claim = getUniqueRequestIdentifierString(uniqueRequestIdentifier)
	const previous = requestRetries.get(claim)
	clearTimeout(previous?.timer)
	const failedAttempts = (previous?.failedAttempts ?? 0) + 1
	const retrying = failedAttempts < FINISHING_RETRY_LIMIT
	const generation = nextRetryGeneration++
	requestRetries.set(claim, {
		failedAttempts,
		generation,
		...(!retrying ? {} : {
			timer: setTimeout(() => {
				if (requestRetries.get(claim)?.generation !== generation) return
				requestRetries.set(claim, { failedAttempts, generation })
				// While another resolution holds the request, the retry is parked on its claim, counting no attempt, and runs once when the claim is released.
				if (resolutionClaims.has(claim)) {
					const parked = deferredResolutions.get(claim)
					deferredResolutions.set(claim, { ...(parked ?? { automaticOnly: true, followUp: false }), parkedRetryGeneration: generation })
					return
				}
				void runRequestRetry(uniqueRequestIdentifier, withoutHeldLocks(context))
			}, FINISHING_RETRY_BASE_DELAY_MS * 2 ** (failedAttempts - 1)),
		}),
	})
	await reportLocalRecovery(error, retrying
		? { code: 'request_resolution_retrying', message: 'Retrying the resolution of a request.' }
		: { code: 'request_resolution_gave_up', message: 'Stopped retrying the resolution of a request until the user acts on it or the extension restarts.' })
}

// A retry of the request, automatic so it passes the budget gate: it declines the request if a decline was asked for, else finishes it.
async function runRequestRetry(uniqueRequestIdentifier: UniqueRequestIdentifier, retryContext: ResolutionContext) {
	const decline = declineIntents.get(getUniqueRequestIdentifierString(uniqueRequestIdentifier))
	return decline === undefined ? await resumeRequest(uniqueRequestIdentifier, retryContext) : await declineRequest(uniqueRequestIdentifier, decline, retryContext)
}

type FinishingOutcome =
	| { readonly kind: 'uncommitted', readonly request: PendingTransactionOrSignableMessage }
	| { readonly kind: 'absent' }
	| { readonly kind: 'finished', readonly delivered: boolean | undefined }
	| { readonly kind: 'retrying' }

/**
 * Finishes a request committed to its terminal reply, under its claim, in resumable steps that each check the stored state: commit a chosen reply whose commitment write failed; deliver the reply unless it was delivered (a disconnected page gets it from the queue when it reconnects); store the request's confirmation window with the reply and remove the pending request; update that window, then forget it; and delete the delivered reply last, the only deletion of a reply (retireTerminalReply). An uncommitted pending request is left to be resolved.
 * Every step, lookups included, is guarded: a failure is reported and the request retried by its one retry owner (scheduleRequestRetry), up to its budget, after which a later user action or restart resumes it.
 */
async function finishCommittedRequest(uniqueRequestIdentifier: UniqueRequestIdentifier, context: ResolutionContext): Promise<FinishingOutcome> {
	const claim = getUniqueRequestIdentifierString(uniqueRequestIdentifier)
	try {
		const chosen = chosenUncommittedReplies.get(claim)
		if (chosen !== undefined) {
			await queueTerminalReply(chosen.reply, chosen.confirmationWindow)
			chosenUncommittedReplies.delete(claim)
		}
		const committedReply = await getQueuedTerminalReply(uniqueRequestIdentifier)
		const pending = await getPendingTransactionOrMessageByidentifier(uniqueRequestIdentifier)
		if (committedReply === undefined) {
			if (pending !== undefined) return { kind: 'uncommitted', request: pending }
			clearRequestRetry(claim)
			declineIntents.delete(claim)
			return { kind: 'absent' }
		}
		const delivered = committedReply.delivered === true ? true : await attemptQueuedTerminalReplyDelivery(context.websiteTabConnections, committedReply)
		// An undelivered reply whose requesting tab is gone can never be delivered, and is finished without it.
		const requestingTabGone = delivered !== true && !(await doesTabExist(uniqueRequestIdentifier.requestSocket.tabId))
		// The window is stored with the reply before the request is removed, also for a reply stored before windows were, so its cleanup survives a failure or restart.
		const confirmationWindow = committedReply.confirmationWindow ?? pending?.popupOrTabId
		if (pending !== undefined) {
			await attachTerminalReplyWindow(uniqueRequestIdentifier, pending.popupOrTabId)
			await removePendingTransactionOrMessage(uniqueRequestIdentifier)
		}
		if (confirmationWindow !== undefined) {
			await updateConfirmationWindowAfterRemoving(confirmationWindow, uniqueRequestIdentifier.requestSocket.tabId, context)
			await forgetTerminalReplyWindow(uniqueRequestIdentifier)
		}
		await retireTerminalReply(uniqueRequestIdentifier, requestingTabGone)
		clearRequestRetry(claim)
		declineIntents.delete(claim)
		return { kind: 'finished', delivered }
	} catch (error) {
		await scheduleRequestRetry(uniqueRequestIdentifier, context, error)
		return { kind: 'retrying' }
	}
}

// Commits the request to the reply a resolution chose and finishes it. A failed commitment write is retried by finishing, with the same reply.
async function commitAndFinish(request: PendingTransactionOrSignableMessage, reply: InterceptedRequestForward, context: ResolutionContext) {
	chosenUncommittedReplies.set(getUniqueRequestIdentifierString(request.uniqueRequestIdentifier), { reply, confirmationWindow: request.popupOrTabId })
	const outcome = await finishCommittedRequest(request.uniqueRequestIdentifier, context)
	return outcome.kind === 'finished' ? outcome.delivered : undefined
}

// Finishes a committed request under its claim; it never throws, so a scheduled retry or startup can run it unattended.
const resumeRequest = async (uniqueRequestIdentifier: UniqueRequestIdentifier, context: ResolutionContext): Promise<boolean | undefined> => await withResolutionClaim(uniqueRequestIdentifier, context, async () => false, { whenClaimed: 'finish-again' })

// The size of the in-memory resolution activity: claims held, follow-ups deferred and retries scheduled, which is empty whenever no resolution is in flight or awaiting a retry. Intent kept for a later user action or startup (chosen replies, decline intents, exhausted budgets) is not activity.
export const getResolutionBookkeepingSize = () => resolutionClaims.size + deferredResolutions.size + [...requestRetries.values()].filter((retry) => retry.timer !== undefined).length

// Lets a reconnect flush finish the requests whose replies it delivered, with the background's current services.
export const registerCommittedRequestFinisher = (getServices: () => { readonly ethereum: EthereumClientService, readonly tokenPriceService: TokenPriceService }) => {
	setCommittedRequestFinisher(async (uniqueRequestIdentifier, websiteTabConnections) => await resumeRequest(uniqueRequestIdentifier, { ...getServices(), websiteTabConnections, automatic: true }))
}

// When a tab closes, finishes its requests' committed replies, which it can no longer receive.
export async function finishCommittedRequestsOfTab(tabId: number, ethereum: EthereumClientService, tokenPriceService: TokenPriceService, websiteTabConnections: WebsiteTabConnections) {
	await finishCommittedRequestsOfClosedTab(tabId, { ethereum, tokenPriceService, websiteTabConnections })
}

// Runs work whose effect recovery depends on, so its intent is never dropped before the work succeeded: a failure is reported and the work retried with the finishing's backoff and limit. The first attempt runs in the caller's context; retries run later, without the caller's locks.
async function runWithBoundedRetry(work: (context: ResolutionContext) => Promise<void>, context: ResolutionContext, failure: { readonly code: string, readonly description: string }, failedAttempts: number): Promise<void> {
	try {
		await work(context)
	} catch (error) {
		const retrying = failedAttempts + 1 < FINISHING_RETRY_LIMIT
		// Scheduled before the report is awaited.
		if (retrying) setTimeout(() => { void runWithBoundedRetry(work, withoutHeldLocks(context), failure, failedAttempts + 1) }, FINISHING_RETRY_BASE_DELAY_MS * 2 ** failedAttempts)
		await reportLocalRecovery(error, retrying
			? { code: `${ failure.code }_retrying`, message: `Retrying ${ failure.description }.` }
			: { code: `${ failure.code }_gave_up`, message: `Stopped retrying ${ failure.description }; startup recovery handles it.` })
	}
}

// Lists the closed tab's committed replies and finishes each request.
async function finishCommittedRequestsOfClosedTab(tabId: number, context: ResolutionContext) {
	await runWithBoundedRetry(async (attemptContext) => {
		for (const committedReply of await getPendingTerminalReplies()) {
			if (committedReply.uniqueRequestIdentifier.requestSocket.tabId !== tabId) continue
			resetRequestRetryBudget(committedReply.uniqueRequestIdentifier)
			await resumeRequest(committedReply.uniqueRequestIdentifier, attemptContext)
		}
	}, context, { code: 'closed_tab_resolution', description: 'the cleanup of a closed tab\'s committed requests' }, 0)
}

// At startup, finishes every request with a committed reply or an asked-for decline, whatever its confirmation window's state, with a new retry budget.
export async function resumeCommittedRequests(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, websiteTabConnections: WebsiteTabConnections) {
	const context: ResolutionContext = { ethereum, tokenPriceService, websiteTabConnections, automatic: true }
	for (const committedReply of await getPendingTerminalReplies()) {
		resetRequestRetryBudgetAtStartup(committedReply.uniqueRequestIdentifier)
		await resumeRequest(committedReply.uniqueRequestIdentifier, context)
	}
	// An interrupted decline is finished whatever its window's state; other requests with live windows are left to the user.
	for (const pending of await getPendingTransactionsAndMessages()) {
		if (pending.declineRequested === undefined) continue
		resetRequestRetryBudgetAtStartup(pending.uniqueRequestIdentifier)
		await declineRequest(pending.uniqueRequestIdentifier, pending.declineRequested, context)
	}
}

// The requests whose terminal outcome an accept, reject or close has claimed and is carrying out. A claim is taken synchronously, so of racing resolutions of a request exactly one stacks it or replies; the others return false without either. Under the claim, a committed request is only finished (finishCommittedRequest); only an uncommitted pending request gets an outcome chosen (resolve).
const resolutionClaims = new Set<string>()
// What to run for a request once its claim is released, recorded by a resolution that found it claimed, coalesced into one entry. Only data: the claim holder runs it in its own context (which knows whether it holds the pending-confirmation lock). The request is always finished again first, so that pass sees what changed meanwhile (its requesting tab closing, say); then a requested decline runs (declineRequest), which rejects a request still pending and uncommitted, such as one whose claimed accept failed, and does nothing for one that was resolved. Each follow-up runs once per recording, so the passes stop once nothing records more. automaticOnly: every resolution that recorded it was automatic, so it runs only while the budget lasts. followUp: a resolution recorded work to follow; parkedRetryGeneration: a scheduled retry came due meanwhile, which runs on release if it is still the request's current one. Parked retries collapse into one entry.
type DeferredResolution = { readonly decline?: DeclineReason, readonly automaticOnly: boolean, readonly followUp: boolean, readonly parkedRetryGeneration?: number }
const deferredResolutions = new Map<string, DeferredResolution>()
type WhenClaimed = 'finish-again' | 'nothing' | { readonly decline: DeclineReason }
// Thrown for a decline whose finishing could not tell whether the request is committed (finishCommittedRequest returned retrying): the finishing's own retry only finishes committed requests, so the decline retries itself.
const RESOLUTION_RETRYING_ERROR_NAME = 'ResolutionRetrying'
// afterClaiming runs as soon as the claim is taken, before any lookup that can fail.
type ClaimOptions = { readonly whenClaimed?: WhenClaimed, readonly retryActionWhenFinishingRetries?: true, readonly afterClaiming?: () => Promise<void> }
async function withResolutionClaim<Result>(uniqueRequestIdentifier: UniqueRequestIdentifier, context: ResolutionContext, resolve: () => Promise<Result>, options: ClaimOptions = {}) {
	const whenClaimed = options.whenClaimed ?? 'nothing'
	const claim = getUniqueRequestIdentifierString(uniqueRequestIdentifier)
	// The one gate of automatic attempts: none runs once the request's retry budget is spent; only a user action or the first startup pass renews it.
	if (context.automatic === true && !retryBudgetLasts(claim)) return false
	if (resolutionClaims.has(claim)) {
		if (whenClaimed !== 'nothing') {
			const previous = deferredResolutions.get(claim)
			const decline = whenClaimed === 'finish-again' ? previous?.decline : whenClaimed.decline
			const automaticOnly = (previous?.automaticOnly ?? true) && context.automatic === true
			deferredResolutions.set(claim, {
				automaticOnly,
				followUp: true,
				...(decline === undefined ? {} : { decline }),
				...(previous?.parkedRetryGeneration === undefined ? {} : { parkedRetryGeneration: previous.parkedRetryGeneration }),
			})
		}
		return false
	}
	resolutionClaims.add(claim)
	try {
		await options.afterClaiming?.()
		const outcome = await finishCommittedRequest(uniqueRequestIdentifier, context)
		switch (outcome.kind) {
			case 'uncommitted': return await resolve()
			case 'absent': return false
			case 'finished': return outcome.delivered
			case 'retrying': {
				if (options.retryActionWhenFinishingRetries === true) throw Object.assign(new Error('The resolution of the request is retried'), { name: RESOLUTION_RETRYING_ERROR_NAME })
				return undefined
			}
			default: return assertNever(outcome)
		}
	} finally {
		resolutionClaims.delete(claim)
		const deferred = deferredResolutions.get(claim)
		deferredResolutions.delete(claim)
		const parkedRetryIsCurrent = deferred?.parkedRetryGeneration !== undefined && requestRetries.get(claim)?.generation === deferred.parkedRetryGeneration
		if (deferred?.followUp === true) {
			// Follow-ups only automatic resolutions recorded are automatic, and pass the budget gate; one a user action recorded runs regardless. A parked retry's decline joins them.
			const followUpContext: ResolutionContext = deferred.automaticOnly ? { ...context, automatic: true } : { ethereum: context.ethereum, tokenPriceService: context.tokenPriceService, websiteTabConnections: context.websiteTabConnections, ...(context.holdsPendingConfirmationLock === true ? { holdsPendingConfirmationLock: true } : {}) }
			await resumeRequest(uniqueRequestIdentifier, followUpContext)
			const decline = deferred.decline ?? (parkedRetryIsCurrent ? declineIntents.get(claim) : undefined)
			if (decline !== undefined) await declineRequest(uniqueRequestIdentifier, decline, followUpContext)
		} else if (parkedRetryIsCurrent) {
			await runRequestRetry(uniqueRequestIdentifier, { ...context, automatic: true })
		}
	}
}

// Why a request is declined: the user rejected it, or its confirmation window closed. Both answer it with the user's rejection, except a reject of a request that never finished simulating, answered as unprocessable.
type DeclineReason = 'reject' | 'close'

// Answers a request that is declined: a rejection, unless it is already stacked in simulation mode (an accept stacked it and failed before its reply was committed, or its commitment and queued reply were lost), when it gets what accepting gives it: a transaction's stacked hash, a message's simulated signature.
async function rejectUnlessStacked(request: PendingTransactionOrSignableMessage, reason: DeclineReason, context: ResolutionContext) {
	const rejection = reason === 'reject' && request.transactionOrMessageCreationStatus !== 'Simulated'
		? formRejectMessage(METAMASK_ERROR_BLANKET_ERROR, 'The Interceptor failed to process the transaction')
		: formRejectMessage(METAMASK_ERROR_USER_REJECTED_REQUEST, 'User denied transaction signature')
	const replyWithRejection = async () => await commitAndFinish(request, { ...request.originalRequestParameters, ...rejection, uniqueRequestIdentifier: request.uniqueRequestIdentifier }, context)
	if (!request.simulationMode) return await replyWithRejection()
	const operations = (await getInterceptorTransactionStack()).operations
	if (request.type === 'Transaction') {
		const stacked = operations.find((operation) => operation.type === 'Transaction' && operation.preSimulationTransaction.transactionIdentifier === request.transactionIdentifier)
		if (stacked?.type !== 'Transaction') return await replyWithRejection()
		return await commitAndFinish(request, { ...request.originalRequestParameters, type: 'result', result: stacked.preSimulationTransaction.signedTransaction.hash, uniqueRequestIdentifier: request.uniqueRequestIdentifier }, context)
	}
	if (!operations.some((operation) => operation.type === 'Message' && operation.signedMessageTransaction.messageIdentifier === request.signedMessageTransaction.messageIdentifier)) return await replyWithRejection()
	const signature = (await simulatePersonalSign(request.originalRequestParameters, request.signedMessageTransaction.fakeSignedFor)).signature
	return await commitAndFinish(request, { ...request.originalRequestParameters, type: 'result', result: funtypes.String.parse(signature), uniqueRequestIdentifier: request.uniqueRequestIdentifier }, context)
}

/**
 * The one entry point of a decline, an explicit reject or a closed confirmation window. It records the intent first in memory, for its retries and a claim holder; under the request's claim, the request is finished first; a committed request is only finished, a gone one left alone, and a pending uncommitted one rejected (rejectUnlessStacked). As soon as the claim is taken, before any lookup that can fail, the intent is stored on the pending request (declineRequested, which only means "reject it if uncommitted", so a commitment always wins, and lets startup finish an interrupted decline). Any failure goes to the request's one retry owner (scheduleRequestRetry). A request claimed by another resolution (an accept, say) records the decline, which its claim holder runs on release.
 * Never throws. An accept is never retried this way; it stays the user's to repeat.
 */
async function declineRequest(uniqueRequestIdentifier: UniqueRequestIdentifier, reason: DeclineReason, context: ResolutionContext): Promise<boolean | undefined> {
	const claim = getUniqueRequestIdentifierString(uniqueRequestIdentifier)
	declineIntents.set(claim, reason)
	const storeIntent = async () => await updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (request) => request.declineRequested === undefined ? { ...request, declineRequested: reason } : request)
	// Checked synchronously with the claim attempt below: another resolution (an accept, say) holds the request.
	const claimedElsewhere = resolutionClaims.has(claim)
	try {
		const result = await withResolutionClaim(uniqueRequestIdentifier, context, async () => {
			const request = await getPendingTransactionOrMessageByidentifier(uniqueRequestIdentifier)
			return request === undefined ? false : await rejectUnlessStacked(request, reason, context)
		}, {
			whenClaimed: { decline: reason },
			retryActionWhenFinishingRetries: true,
			// Stored before the commitment is looked up, so it survives any failure after it.
			afterClaiming: storeIntent,
		})
		// The claim holder runs the decline on release; storing it, only intent, outside the claim lets a restart before then still decline the request. A commitment the holder makes still wins. Not awaited, so the decline never waits on the holder's storage writes; a failure goes to the request's retry.
		if (claimedElsewhere) void (async () => {
			try {
				await storeIntent()
			} catch (error) {
				await scheduleRequestRetry(uniqueRequestIdentifier, context, error)
			}
		})()
		return result
	} catch (error) {
		// A retrying finishing already scheduled the request's retry.
		if (!(error instanceof Error && error.name === RESOLUTION_RETRYING_ERROR_NAME)) await scheduleRequestRetry(uniqueRequestIdentifier, context, error)
		return undefined
	}
}

// What accepting a simulation-mode transaction did: stacked it (or found it stacked), found its hash taken, or found the request resolved meanwhile.
type AcceptedTransactionStacking = { readonly kind: 'stacked', readonly transaction: PreSimulationTransaction } | { readonly kind: 'hash-taken' } | { readonly kind: 'resolved' }

export async function resolvePendingTransactionOrMessage(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, websiteTabConnections: WebsiteTabConnections, confirmation: TransactionConfirmation, refreshedSafeSignerSelection?: RefreshedSafeSignerSelection) {
	// A user's action on the request gives its resolution a new retry budget.
	resetRequestRetryBudget(confirmation.data.uniqueRequestIdentifier)
	return await resolvePendingRequest({ ethereum, tokenPriceService, websiteTabConnections }, confirmation, refreshedSafeSignerSelection)
}

async function resolvePendingRequest(resolutionContext: ResolutionContext, confirmation: TransactionConfirmation, refreshedSafeSignerSelection?: RefreshedSafeSignerSelection) {
	const { ethereum, tokenPriceService, websiteTabConnections } = resolutionContext
	// A reject and a closed window are one decline, with its own retries.
	if (confirmation.data.action === 'reject' || confirmation.data.action === 'noResponse') return await declineRequest(confirmation.data.uniqueRequestIdentifier, confirmation.data.action === 'reject' ? 'reject' : 'close', resolutionContext)
	let pendingTransactionOrMessage = await getPendingTransactionOrMessageByidentifier(confirmation.data.uniqueRequestIdentifier)
	if (pendingTransactionOrMessage === undefined) return // no need to resolve as it doesn't exist anymore
	// A request committed to a reply is only finished, whatever the action, so an accept never follows a delivered rejection.
	if (await getQueuedTerminalReply(confirmation.data.uniqueRequestIdentifier) !== undefined) return await resumeRequest(confirmation.data.uniqueRequestIdentifier, resolutionContext)
	if (
		confirmation.data.action === 'accept'
		&& refreshedSafeSignerSelection?.selectedSigner !== undefined
		&& refreshedSafeSignerSelection.verificationError === undefined
	) {
		const directSafeExecution = getSafePendingFlow(pendingTransactionOrMessage)?.kind === 'directExecution'
		const refresh = await refreshAndPersistSafeSignerSelection(
			ethereum,
			pendingTransactionOrMessage,
			refreshedSafeSignerSelection.selectedSigner,
			async (refreshedPending) => await refreshDirectSafeExecutionSimulation(ethereum, tokenPriceService, refreshedPending),
		)
		const refreshResult = refresh.refreshResult
		if (refresh.refreshRequired && refreshResult.status !== 'unchanged' && !refresh.persisted) {
			await updateConfirmTransactionView(ethereum, tokenPriceService)
			return false
		}
		if (refresh.refreshRequired && (refreshResult.status === 'blocked' || directSafeExecution && refreshResult.status === 'refreshed')) {
			await updateConfirmTransactionView(ethereum, tokenPriceService)
			return false
		}
		if (refresh.persistedPending !== undefined) pendingTransactionOrMessage = refresh.persistedPending
	}
	const safeResolution = await resolveSafeConfirmation(
		ethereum,
		pendingTransactionOrMessage,
		confirmation.data.action,
		refreshedSafeSignerSelection,
	)
	if (safeResolution.status === 'blocked') {
		await updatePendingTransactionOrMessage(confirmation.data.uniqueRequestIdentifier, async (pending) => modifyObject(pending, {
			approvalStatus: safeResolution.approvalStatus,
		}))
		await updateConfirmTransactionView(ethereum, tokenPriceService)
		return false
	}
	if (safeResolution.status === 'refreshed') {
		pendingTransactionOrMessage = safeResolution.pending
		await updatePendingTransactionOrMessage(confirmation.data.uniqueRequestIdentifier, async () => pendingTransactionOrMessage)
		await updateConfirmTransactionView(ethereum, tokenPriceService)
		return false
	}
	pendingTransactionOrMessage = safeResolution.pending
	if (safeResolution.pendingChanged) {
		await updatePendingTransactionOrMessage(confirmation.data.uniqueRequestIdentifier, async () => pendingTransactionOrMessage)
	}
	const signerFacingRequest: SendTransactionParams | SendRawTransactionParams | SignMessageParams = safeResolution.signerFacingRequest
		?? pendingTransactionOrMessage.originalRequestParameters
	const removePendingRequestAndUpdateView = async () => {
		await removePendingTransactionOrMessage(confirmation.data.uniqueRequestIdentifier)
		if ((await getPendingTransactionsAndMessages()).length === 0) await tryFocusingTabOrWindow({ type: 'tab', id: pendingTransactionOrMessage.uniqueRequestIdentifier.requestSocket.tabId })
		if (!(await updateConfirmTransactionView(ethereum, tokenPriceService))) await closePopupOrTabById(pendingTransactionOrMessage.popupOrTabId)
	}
	const finishWithReply = async (terminalReply: InterceptedRequestForward) => await commitAndFinish(pendingTransactionOrMessage, terminalReply, resolutionContext)
	const reply = async (message: { type: 'forwardToSigner' } | { type: 'result', error: { code: number, message: string } } | { type: 'result', result: unknown }) => {
		if (message.type === 'result' && !('error' in message)) {
			if (pendingTransactionOrMessage.originalRequestParameters.method === 'eth_sendRawTransaction' || pendingTransactionOrMessage.originalRequestParameters.method === 'eth_sendTransaction') {
				return await finishWithReply({ ...pendingTransactionOrMessage.originalRequestParameters, ...message, result: EthereumBytes32.parse(message.result), uniqueRequestIdentifier: confirmation.data.uniqueRequestIdentifier })
			}
			return await finishWithReply({ ...pendingTransactionOrMessage.originalRequestParameters, ...message, result: funtypes.String.parse(message.result), uniqueRequestIdentifier: confirmation.data.uniqueRequestIdentifier })
		}
		if (message.type === 'result') {
			return await finishWithReply({ ...pendingTransactionOrMessage.originalRequestParameters, ...message, uniqueRequestIdentifier: confirmation.data.uniqueRequestIdentifier })
		}
		await removePendingRequestAndUpdateView()
		return await replyToInterceptedRequestAfterManifestV2Reconnect(websiteTabConnections, { ...pendingTransactionOrMessage.originalRequestParameters, ...message, uniqueRequestIdentifier: confirmation.data.uniqueRequestIdentifier })
	}
	if (confirmation.data.action === 'addToSafeStack') {
		if (pendingTransactionOrMessage.approvalStatus.status === 'WaitingForSigner') return false
		const safeReply = await persistUnsignedSafeTransaction(ethereum, tokenPriceService, pendingTransactionOrMessage)
		if (safeReply.status === 'error') {
			await updatePendingTransactionOrMessage(confirmation.data.uniqueRequestIdentifier, async (pending) => modifyObject(pending, {
				approvalStatus: safeReply.approvalStatus,
			}))
			await updateConfirmTransactionView(ethereum, tokenPriceService)
			return false
		}
		if (safeReply.status === 'success') return reply({ type: 'result', result: safeReply.result })
		return false
	}
	if (
		confirmation.data.action === 'accept'
		&& pendingTransactionOrMessage.transactionOrMessageCreationStatus !== 'Simulated'
	) return false
	if (confirmation.data.action === 'accept' && pendingTransactionOrMessage.simulationMode === false) {
		await updatePendingTransactionOrMessage(confirmation.data.uniqueRequestIdentifier, async (transaction) => modifyObject(transaction, { approvalStatus: { status: 'WaitingForSigner' } }))
		await updateConfirmTransactionView(ethereum, tokenPriceService)
		const requestWasForwarded = await replyToInterceptedRequestAfterManifestV2Reconnect(websiteTabConnections, { ...signerFacingRequest, type: 'forwardToSigner', uniqueRequestIdentifier: confirmation.data.uniqueRequestIdentifier })
		if (requestWasForwarded) return true
		await updatePendingTransactionOrMessage(confirmation.data.uniqueRequestIdentifier, async (transaction) => modifyObject(transaction, {
			approvalStatus: {
				status: 'SignerError',
				code: METAMASK_ERROR_BLANKET_ERROR,
				message: 'The website connection was interrupted before the request reached your wallet. Reload the website and try again.',
			}
		}))
		await updateConfirmTransactionView(ethereum, tokenPriceService)
		return false
	}
	// Only a signer reply gets here for a request that is not simulated: an accept returned early, a reject or close was declined.
	if (pendingTransactionOrMessage.transactionOrMessageCreationStatus !== 'Simulated') return await withResolutionClaim(confirmation.data.uniqueRequestIdentifier, resolutionContext, async () => await reply(formRejectMessage(METAMASK_ERROR_BLANKET_ERROR, 'The Interceptor failed to process the transaction')))
	if (!pendingTransactionOrMessage.simulationMode) {
		if (confirmation.data.action === 'signerIncluded') {
			const safeReply = await resolveSafeSignerReply(ethereum, tokenPriceService, pendingTransactionOrMessage, confirmation.data.signerReply)
			if (safeReply.status === 'error') {
				await updatePendingTransactionOrMessage(confirmation.data.uniqueRequestIdentifier, async (pending) => modifyObject(pending, {
					approvalStatus: safeReply.approvalStatus,
				}))
				await updateConfirmTransactionView(ethereum, tokenPriceService)
				return false
			}
			if (safeReply.status === 'success') return reply({ type: 'result', result: safeReply.result })
			return reply({ type: 'result', result: confirmation.data.signerReply })
		}
		await removePendingRequestAndUpdateView()
		return await replyToInterceptedRequestAfterManifestV2Reconnect(websiteTabConnections, { ...signerFacingRequest, type: 'forwardToSigner', uniqueRequestIdentifier: confirmation.data.uniqueRequestIdentifier })
	}
	if (confirmation.data.action === 'signerIncluded') throw new Error('Signer included transaction that was in simulation')

	// Accepting stacks the request and replies only if it wins the request's resolution (withResolutionClaim).
	const simulatedPending = pendingTransactionOrMessage
	return await withResolutionClaim(confirmation.data.uniqueRequestIdentifier, resolutionContext, async () => {
		switch (simulatedPending.type) {
			case 'SignableMessage': {
				// A message an earlier accept already stacked before stopping is not stacked again.
				await updateInterceptorTransactionStack((prevStack: InterceptorTransactionStack) => prevStack.operations.some((operation) => operation.type === 'Message' && operation.signedMessageTransaction.messageIdentifier === simulatedPending.signedMessageTransaction.messageIdentifier)
					? prevStack
					: { operations: [...prevStack.operations, { type: 'Message' as const, signedMessageTransaction: simulatedPending.signedMessageTransaction }] })
				await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService)
				return reply({ type: 'result', result: (await simulatePersonalSign(simulatedPending.originalRequestParameters, simulatedPending.signedMessageTransaction.fakeSignedFor)).signature })
			}
			case 'Transaction': {
				// Stacked under the hash its preview showed, which the page gets; reserving it kept every other append off it. A request pending from before reservations reserves one now, stored first, so a repeated accept stacks the same hash.
				const pendingTransaction = simulatedPending
				const acceptance = await withSimulationHashLock(async () => {
					const current = (await getPendingTransactionsAndMessages()).find((request) => doesUniqueRequestIdentifiersMatch(request.uniqueRequestIdentifier, pendingTransaction.uniqueRequestIdentifier))
					if (current?.type !== 'Transaction') return { kind: 'resolved' } satisfies AcceptedTransactionStacking
					const allocatedReservation = current.simulationHashReservation === undefined && stacksTransactionOnAccept(current) ? await allocateSimulationHashReservation(pendingTransaction.transactionToSimulate, pendingTransaction.uniqueRequestIdentifier) : undefined
					if (allocatedReservation !== undefined) await updatePendingTransactionOrMessage(pendingTransaction.uniqueRequestIdentifier, async (request) => request.type === 'Transaction' ? { ...request, simulationHashReservation: allocatedReservation } : request)
					const transactionToStack = toPreSimulationTransaction(pendingTransaction.transactionToSimulate, current.simulationHashReservation ?? allocatedReservation)
					return await updateInterceptorTransactionStackWithResult<AcceptedTransactionStacking>((prevStack: InterceptorTransactionStack) => {
						// An accept repeated while the first one replies, or retried after it stacked the transaction, replies with the stacked hash again.
						const alreadyStacked = prevStack.operations.find((operation) => operation.type === 'Transaction' && operation.preSimulationTransaction.transactionIdentifier === pendingTransaction.transactionIdentifier)
						if (alreadyStacked?.type === 'Transaction') return { stack: prevStack, result: { kind: 'stacked', transaction: alreadyStacked.preSimulationTransaction } }
						const stack = appendAcceptedTransactionToStack(prevStack, transactionToStack)
						return stack === undefined ? { stack: prevStack, result: { kind: 'hash-taken' } } : { stack, result: { kind: 'stacked', transaction: transactionToStack } }
					})
				})
				// Another accept, reject or close resolved the request while this one waited.
				if (acceptance.kind === 'resolved') return false
				if (acceptance.kind === 'hash-taken') {
					await updatePendingTransactionOrMessage(confirmation.data.uniqueRequestIdentifier, async (pending) => modifyObject(pending, {
						approvalStatus: { status: 'SignerError', code: METAMASK_ERROR_BLANKET_ERROR, message: 'A transaction on the simulation stack already uses this transaction\'s hash. Reject this request and send the transaction again.' },
					}))
					await updateConfirmTransactionView(ethereum, tokenPriceService)
					return false
				}
				const { transaction } = acceptance
				await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService)
				markPerformance(POPUP_PERFORMANCE_MARKS.backgroundTransactionStackAppended)
				return reply({ type: 'result', result: EthereumBytes32.serialize(transaction.signedTransaction.hash) })
			}
			default: assertNever(simulatedPending)
		}
	})
}

export const onCloseWindowOrTab = async (popupOrTabs: PopupOrTabId, ethereum: EthereumClientService, tokenPriceService: TokenPriceService, websiteTabConnections: WebsiteTabConnections) => { // check if user has closed the window on their own, if so, reject all signatures
	// The close event comes once, so reading the requests it rejects is retried rather than dropped.
	await runWithBoundedRetry(async (context) => {
		// Only the closed window's own requests are declined, as the user closing that window.
		const closedWindowRequests = (await getPendingTransactionsAndMessages()).filter((pending) => pending.popupOrTabId.type === popupOrTabs.type && pending.popupOrTabId.id === popupOrTabs.id)
		for (const pending of closedWindowRequests) resetRequestRetryBudget(pending.uniqueRequestIdentifier)
		await resolveAllPendingTransactionsAndMessageAsNoResponse(closedWindowRequests, context)
	}, { ethereum, tokenPriceService, websiteTabConnections }, { code: 'window_close_resolution', description: 'the rejection of requests whose confirmation window closed' }, 0)
}

export async function resolvePendingRequestsForMissingConfirmationWindows(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, websiteTabConnections: WebsiteTabConnections) {
	const pendingTransactions = await getPendingTransactionsAndMessages()
	const missingConfirmationWindows = new Map<string, boolean>()
	const orphanedTransactions: PendingTransactionOrSignableMessage[] = []
	for (const transaction of pendingTransactions) {
		const windowIdentifier = `${ transaction.popupOrTabId.type }:${ transaction.popupOrTabId.id }`
		let confirmationWindowIsMissing = missingConfirmationWindows.get(windowIdentifier)
		if (confirmationWindowIsMissing === undefined) {
			confirmationWindowIsMissing = await getPopupOrTabById(transaction.popupOrTabId) === undefined
			missingConfirmationWindows.set(windowIdentifier, confirmationWindowIsMissing)
		}
		if (confirmationWindowIsMissing) orphanedTransactions.push(transaction)
	}
	for (const orphan of orphanedTransactions) resetRequestRetryBudgetAtStartup(orphan.uniqueRequestIdentifier)
	await resolveAllPendingTransactionsAndMessageAsNoResponse(orphanedTransactions, { ethereum, tokenPriceService, websiteTabConnections, automatic: true })
}

const resolveAllPendingTransactionsAndMessageAsNoResponse = async (transactions: readonly PendingTransactionOrSignableMessage[], context: ResolutionContext) => {
	for (const transaction of transactions) await declineRequest(transaction.uniqueRequestIdentifier, 'close', context)
}

const formRejectMessage = (code: number, errorString: string) => {
	return {
		type: 'result' as const,
		error: { code, message: errorString }
	}
}

const resolveInsufficientBalanceMessageForTransaction = async (
	ethereumClientService: EthereumClientService,
	requestAbortController: AbortController | undefined,
	simulationState: Awaited<ReturnType<typeof getUpdatedSimulationState>>,
	transaction: {
		from: bigint
		to: bigint | null
		value: bigint
		input: Uint8Array
	},
	nativeBalancePromise: Promise<bigint>,
) => {
	try {
		const nativeBalance = await nativeBalancePromise
		return await resolveInsufficientBalanceMessage(
			transaction,
			{ balance: nativeBalance, symbol: ethereumClientService.getRpcEntry().currencyTicker, decimals: 18n },
			async (token, owner) => {
				const tokenEntry = await identifyAddress(ethereumClientService, requestAbortController, token)
				if (tokenEntry.type !== 'ERC20') return undefined
				const tokenBalance = await getSimulatedErc20Balance(ethereumClientService, requestAbortController, simulationState, token, owner)
				if (tokenBalance === undefined) return undefined
				return { token, balance: tokenBalance, symbol: tokenEntry.symbol, decimals: tokenEntry.decimals }
			},
		)
	} catch(error: unknown) {
		if (isNewBlockAbort(error)) throw error
		await reportLocalRecovery(error, {
			code: 'insufficient_balance_diagnosis_failed',
			message: 'Keeping the original gas-estimation error because optional balance diagnosis failed.',
		})
		return undefined
	}
}

export const formSendRawTransaction = async(_ethereumClientService: EthereumClientService, sendRawTransactionParams: SendRawTransactionParams, website: Website, created: Date, transactionIdentifier: EthereumQuantity): Promise<WebsiteCreatedEthereumTransaction> => {
	const parsedTransaction = await parseSendRawTransaction(sendRawTransactionParams.params[0])
	return {
		transaction: parsedTransaction.transaction,
		signedTransaction: parsedTransaction.signedTransaction,
		website,
		created,
		originalRequestParameters: sendRawTransactionParams,
		transactionIdentifier,
		success: true,
	}
}

export const formEthSendTransaction = async(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, activeAddress: bigint | undefined, website: Website, sendTransactionParams: SendTransactionParams, created: Date, transactionIdentifier: EthereumQuantity, simulationMode = true, gasPayment: TransactionGasPayment = 'transaction-sender'): Promise<WebsiteCreatedEthereumTransactionOrFailed> => {
	const paidByExecutor = gasPayment !== 'transaction-sender'
	const simulationState = simulationMode || paidByExecutor
		? await getUpdatedSimulationState(ethereumClientService, await captureSimulationSnapshot())
		: PASSTHROUGH_STATE
	const transactionDetails = sendTransactionParams.params[0]
	if (activeAddress === undefined) throw new Error('Access to active address is denied')
	const from = simulationMode && transactionDetails.from !== undefined ? transactionDetails.from : activeAddress
	// Defined by the Safe layer for a transaction the simulation runs as an executor's call (a Gnosis Safe's own call), so this function picks no Safe-specific option or nonce source itself.
	const executedCallFormation = getExecutedCallFormation(ethereumClientService, gasPayment)
	const transactionCountPromise = silenceChromeUnCaughtPromise(executedCallFormation === undefined
		? getSimulatedTransactionCount(ethereumClientService, requestAbortController, simulationState, from)
		: executedCallFormation.getNonce(requestAbortController, simulationState, from))
	const parentBlockPromise = !paidByExecutor
		? silenceChromeUnCaughtPromise(ethereumClientService.getBlock(requestAbortController)) // the latest real block is the parent of the transaction being prepared
		: undefined
	const balancePromise = !paidByExecutor
		? silenceChromeUnCaughtPromise(getSimulatedBalance(ethereumClientService, requestAbortController, simulationState, from))
		: undefined
	const parentBlock = parentBlockPromise === undefined ? undefined : await parentBlockPromise
	if (parentBlock === null) throw new Error('The latest block is null')
	if (parentBlock !== undefined && parentBlock.baseFeePerGas === undefined) throw new Error(CANNOT_SIMULATE_OFF_LEGACY_BLOCK)
	const parentBaseFeePerGas = parentBlock?.baseFeePerGas
	const requestedMaxPriorityFeePerGas = transactionDetails.maxPriorityFeePerGas !== undefined && transactionDetails.maxPriorityFeePerGas !== null ? transactionDetails.maxPriorityFeePerGas : 10n**8n // 0.1 nanoeth/gas
	const maxPriorityFeePerGas = paidByExecutor ? 0n : requestedMaxPriorityFeePerGas
	const value = transactionDetails.value !== undefined  ? transactionDetails.value : 0n
	const getFeePerGas = async (gasLimit: bigint) => {
		if (paidByExecutor) return { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }
		if (parentBaseFeePerGas === undefined || balancePromise === undefined) throw new Error('Transaction fee context is unavailable')
		return getTransactionFeesForBaseFee(parentBaseFeePerGas, maxPriorityFeePerGas, transactionDetails.maxFeePerGas, await balancePromise, value, gasLimit)
	}
	const getInitialMaxFeePerGas = () => {
		if (paidByExecutor) return 0n
		if (hasExplicitMaxFeePerGas(transactionDetails.maxFeePerGas)) return transactionDetails.maxFeePerGas
		if (parentBaseFeePerGas === undefined) throw new Error('Transaction fee context is unavailable')
		return getDesiredMaxFeePerGasForBaseFee(parentBaseFeePerGas, maxPriorityFeePerGas)
	}
	const transactionWithoutGasBase = {
		from,
		chainId: ethereumClientService.getChainId(),
		nonce: await transactionCountPromise,
		maxFeePerGas: getInitialMaxFeePerGas(),
		maxPriorityFeePerGas,
		to: transactionDetails.to === undefined ? null : transactionDetails.to,
		value,
		input: getInputFieldFromDataOrInput(transactionDetails),
		accessList: transactionDetails.accessList ?? [],
	}
	const transactionWithoutGas = await createEip1559Or7702Transaction(transactionWithoutGasBase, transactionDetails)
	const extraParams = {
		website,
		created,
		originalRequestParameters: sendTransactionParams,
		transactionIdentifier,
		error: undefined,
	}
	// Carried to the confirmation simulation and the simulation stack, which run the Safe's call through its execTransaction.
	const simulationOptionsField: { readonly simulationOptions?: TransactionSimulationOptions } = executedCallFormation === undefined ? {} : { simulationOptions: executedCallFormation.simulationOptions }
	if (transactionDetails.gas === undefined) {
		try {
			if (paidByExecutor && simulationState.kind === 'passthrough') {
				throw new Error('Gnosis Safe transaction gas estimation requires the Interceptor simulator.')
			}
			const estimateGas = executedCallFormation === undefined
				? await simulateEstimateGas(ethereumClientService, requestAbortController, simulationState, transactionWithoutGas)
				: await executedCallFormation.estimateGas(requestAbortController, simulationState, transactionWithoutGas, { website, created, originalRequestParameters: sendTransactionParams, transactionIdentifier })
			if ('error' in estimateGas) {
				const insufficientBalanceMessage = balancePromise === undefined
					? undefined
					: await resolveInsufficientBalanceMessageForTransaction(ethereumClientService, requestAbortController, simulationState, transactionWithoutGas, balancePromise)
				return {
					...extraParams,
					error: insufficientBalanceMessage === undefined ? estimateGas.error : { ...estimateGas.error, message: insufficientBalanceMessage },
					success: false,
				}
			}
			return { transaction: { ...transactionWithoutGas, ...await getFeePerGas(estimateGas.gas), gas: estimateGas.gas }, ...extraParams, ...simulationOptionsField, success: true }
		} catch(error: unknown) {
			if (isNewBlockAbort(error)) throw error
			if (error instanceof JsonRpcResponseError) return { ...extraParams, error: { code: error.code, message: error.message, data: typeof error.data === 'string' ? error.data : '0x' }, success: false }
			await reportLocalRecovery(error, { code: 'transaction_gas_estimation_failed', message: 'Returning a typed RPC error to the requesting page.' })
			if (error instanceof Error) return { ...extraParams, error: { code: 123456, message: error.message, data: 'data' in error && typeof error.data === 'string' ? error.data : '0x' }, success: false }
			return { ...extraParams, error: { code: 123456, message: 'Unknown Error', data: '0x' }, success: false }
		}
	}
	return { transaction: { ...transactionWithoutGas, ...await getFeePerGas(transactionDetails.gas), gas: transactionDetails.gas }, ...extraParams, ...simulationOptionsField, success: true }
}

const openConfirmationWindow = async () => await openPopupOrTab({ url: getHtmlFile('confirmTransaction'), type: 'popup', height: 800, width: 600 })
// Called under the pending-confirmation lock. Requests whose window is gone are rejected as for a window the user closed, by resolutions that know the lock is held.
const getPendingTransactionWindow = async (ethereum: EthereumClientService, tokenPriceService: TokenPriceService, websiteTabConnections: WebsiteTabConnections) => {
	// Each request is checked against its own window: requests whose window is gone are rejected, and a live confirmation window of another request is reused.
	let liveWindow: Awaited<ReturnType<typeof getPopupOrTabById>>
	const orphanedRequests: PendingTransactionOrSignableMessage[] = []
	for (const pending of await getPendingTransactionsAndMessages()) {
		const window = await getPopupOrTabById(pending.popupOrTabId)
		if (window === undefined) orphanedRequests.push(pending)
		else liveWindow ??= window
	}
	if (orphanedRequests.length > 0) await resolveAllPendingTransactionsAndMessageAsNoResponse(orphanedRequests, { ethereum, tokenPriceService, websiteTabConnections, holdsPendingConfirmationLock: true })
	return liveWindow ?? await openConfirmationWindow()
}

export async function openConfirmTransactionDialogForMessage(
	ethereumClientService: EthereumClientService,
	tokenPriceService: TokenPriceService,
	request: InterceptedRequest,
	confirmation: MessageConfirmationRequest,
	simulationMode: boolean,
	activeAddress: bigint | undefined,
	website: Website,
	websiteTabConnections: WebsiteTabConnections,
) {
	const transactionParams = confirmation.parameters
	if (activeAddress === undefined) return { type: 'result' as const, ...ERROR_INTERCEPTOR_NO_ACTIVE_ADDRESS }
	const activeAddressEntry = (await getUserAddressBookEntriesForChainIdMorePreciseFirst(ethereumClientService.getChainId()))
		.find((entry) => entry.address === activeAddress)
	const signerTabState = await getTabState(request.uniqueRequestIdentifier.requestSocket.tabId)
	const simulationSignerAddress = activeAddressEntry?.type === 'safe'
		? simulationMode ? activeAddressEntry.safeSimulationSignerAddress : getWalletSelectedAccount(signerTabState)
		: activeAddress
	if (simulationSignerAddress === undefined) {
		return formRejectMessage(SAFE_SIGNER_SELECTION_ERROR_CODE, simulationMode
			? 'Select a Gnosis Safe signer for simulation before signing a message.'
			: 'Select a current Gnosis Safe owner in the signer wallet before signing a message.')
	}
	const uniqueRequestIdentifierString = getUniqueRequestIdentifierString(request.uniqueRequestIdentifier)
	const messageIdentifier = EthereumQuantity.parse(keccak256(stringToBytes(uniqueRequestIdentifierString)))
	const created = new Date()
	const safeMessage = transactionParams.method === 'eth_signTypedData_v4' && confirmation.review !== undefined
		? SafeMessage.parse({ typedData: transactionParams.params[1], review: confirmation.review }) : undefined
	const signedMessageTransaction = {
		website,
		created,
		activeAddress,
		originalRequestParameters: transactionParams,
		fakeSignedFor: simulationSignerAddress,
		simulationMode,
		request,
		messageIdentifier,
		...(safeMessage === undefined ? {} : { safeMessageReview: safeMessage.review }),
	}
	try {
		const visualizedPersonalSignRequest = await craftPersonalSignPopupMessage(ethereumClientService, undefined, signedMessageTransaction, ethereumClientService.getRpcEntry())
		const walletSignerAddress = getWalletSelectedAccount(signerTabState)
		let safeMessageCoSignSnapshot: Awaited<ReturnType<typeof createSafeMessageCoSignSnapshot | typeof createSafeOffChainMessageSnapshot>> | undefined
			let safeMessageValidationError: string | undefined
			let safeMessageValidationDetails: SafeSignerErrorDetails | undefined
		if (!simulationMode && activeAddressEntry?.type === 'safe' && (visualizedPersonalSignRequest.type === 'SafeTx' || isSafeMessageCoSignRequest(transactionParams, activeAddress, ethereumClientService.getChainId(), confirmation.review))) {
				try {
					safeMessageCoSignSnapshot = visualizedPersonalSignRequest.type === 'SafeTx'
						? await createSafeMessageCoSignSnapshot(ethereumClientService, activeAddress, walletSignerAddress, transactionParams, visualizedPersonalSignRequest.message)
						: await createSafeOffChainMessageSnapshot(ethereumClientService, activeAddress, walletSignerAddress, transactionParams, safeMessage?.review)
				} catch (error) {
					if (!isExpectedSafeMessageCoSignSnapshotFailure(error)) throw error
					safeMessageValidationError = getErrorMessage(error) ?? 'The Gnosis Safe transaction could not be validated.'
					safeMessageValidationDetails = isSafeMessageAccountMismatchFailure(error) ? error.safeSignerErrorDetails : undefined
			}
		}
		await pendingConfirmationSemaphore.execute(async () => {
			const openedDialog = await getPendingTransactionWindow(ethereumClientService, tokenPriceService, websiteTabConnections)
			if (openedDialog === undefined) throw new Error('Failed to get pending transaction window!')

			const pendingMessage = {
				type: 'SignableMessage' as const,
				popupOrTabId: openedDialog,
				originalRequestParameters: transactionParams,
				uniqueRequestIdentifier: request.uniqueRequestIdentifier,
				simulationMode,
				activeAddress,
				created,
				transactionOrMessageCreationStatus: 'Crafting' as const,
				website,
				approvalStatus: safeMessageValidationError === undefined
					? { status: 'WaitingForUser' as const }
					: createSafeSignerErrorStatus(safeMessageValidationError, SAFE_SIGNER_SELECTION_ERROR_CODE, safeMessageValidationDetails),
				signedMessageTransaction,
				...(safeMessageCoSignSnapshot === undefined ? {} : { safeMessageCoSignSnapshot }),
			}
			await appendPendingTransactionOrMessage(pendingMessage)
			await updateConfirmTransactionView(ethereumClientService, tokenPriceService)

			await updatePendingTransactionOrMessage(pendingMessage.uniqueRequestIdentifier, async (message) => {
				if (message.type !== 'SignableMessage') return message
				return modifyObject(message, { transactionOrMessageCreationStatus: 'Simulating' as const } )
			})
			await updateConfirmTransactionView(ethereumClientService, tokenPriceService)

			await updatePendingTransactionOrMessage(pendingMessage.uniqueRequestIdentifier, async (message) => {
				if (message.type !== 'SignableMessage') return message
				return { ...message, visualizedPersonalSignRequest, transactionOrMessageCreationStatus: 'Simulated' as const }
			})
			await updateConfirmTransactionView(ethereumClientService, tokenPriceService)

			await tryFocusingTabOrWindow(openedDialog)
			if (visualizedPersonalSignRequest.type === 'SafeTx') {
				await simulateGnosisSafeTransactionOnPass(ethereumClientService, tokenPriceService, visualizedPersonalSignRequest)
			}
		})
	} catch(e) {
		if (isSafeSignerSelectionFailure(e)) {
			return formRejectMessage(SAFE_SIGNER_SELECTION_ERROR_CODE, getErrorMessage(e) ?? 'Select a current Gnosis Safe owner in the signer wallet before co-signing.')
		}
		await reportUnexpectedError(e)
		return formRejectMessage(METAMASK_ERROR_BLANKET_ERROR, 'Failed to process message signing request. See Interceptor for error message')
	}
	const pendingTransactionData = await getPendingTransactionOrMessageByidentifier(request.uniqueRequestIdentifier)
	if (pendingTransactionData === undefined) return formRejectMessage(METAMASK_ERROR_BLANKET_ERROR, 'The Interceptor failed to process the transaction')
	return { type: 'doNotReply' as const }
}

export async function openConfirmTransactionDialogForTransaction(
	ethereumClientService: EthereumClientService,
	tokenPriceService: TokenPriceService,
	request: InterceptedRequest,
	confirmation: TransactionConfirmationRequest,
	simulationMode: boolean,
	activeAddress: bigint | undefined,
	website: Website,
	websiteTabConnections: WebsiteTabConnections,
) {
	const uniqueRequestIdentifierString = getUniqueRequestIdentifierString(request.uniqueRequestIdentifier)
	const transactionIdentifier = EthereumQuantity.parse(keccak256(stringToBytes(uniqueRequestIdentifierString)))
	const created = new Date()
	if (activeAddress === undefined) return { type: 'result' as const, ...ERROR_INTERCEPTOR_NO_ACTIVE_ADDRESS }
	const signerTabState = await getTabState(request.uniqueRequestIdentifier.requestSocket.tabId)
	const walletSignerAddress = getWalletSelectedAccount(signerTabState)
	const safePreparation = await prepareSafeTransactionConfirmation(
		ethereumClientService,
		confirmation,
		simulationMode,
		activeAddress,
		walletSignerAddress,
	)
	if (safePreparation.rejection !== undefined) {
		return formRejectMessage(safePreparation.rejection.code, safePreparation.rejection.message)
	}
	const {
		effectiveTransactionParams,
		transactionExecutor,
		gasPayment,
		preparationMessage: safePreparationMessage,
	} = safePreparation
	const transactionToSimulatePromise = safePreparationMessage !== undefined
		? Promise.resolve({
			website,
			created,
			originalRequestParameters: effectiveTransactionParams,
			transactionIdentifier,
			success: false as const,
			error: {
				code: METAMASK_ERROR_FAILED_TO_PARSE_REQUEST,
				message: safePreparationMessage,
			},
		})
		: effectiveTransactionParams.method === 'eth_sendTransaction'
		? formEthSendTransaction(
			ethereumClientService,
			undefined,
			transactionExecutor,
			website,
			effectiveTransactionParams,
			created,
			transactionIdentifier,
			simulationMode,
			gasPayment,
		)
		: formSendRawTransaction(ethereumClientService, effectiveTransactionParams, website, created, transactionIdentifier)
	silenceChromeUnCaughtPromise(transactionToSimulatePromise)
	const outcome = await pendingConfirmationSemaphore.execute(async () => {
		const finalizedSafePreparation = await safePreparation.finalize(
			await transactionToSimulatePromise,
			request.uniqueRequestIdentifier.requestSocket.tabId,
		)
		try {
			const { transactionToSimulate, safeTransaction, approvalStatus: safeSignerMismatch, pendingSafeFields } = finalizedSafePreparation
			const openedDialog = await getPendingTransactionWindow(ethereumClientService, tokenPriceService, websiteTabConnections)
			if (openedDialog === undefined) return formRejectMessage(METAMASK_ERROR_FAILED_TO_PARSE_REQUEST, 'Failed to get pending transaction window')
			markPerformance(POPUP_PERFORMANCE_MARKS.backgroundTransactionConfirmPopupOpened)

			const pendingTransaction = {
				type: 'Transaction' as const,
				popupOrTabId: openedDialog,
				originalRequestParameters: effectiveTransactionParams,
				uniqueRequestIdentifier: request.uniqueRequestIdentifier,
				simulationMode,
				activeAddress: transactionExecutor,
				created,
				transactionOrMessageCreationStatus: 'Crafting' as const,
				transactionIdentifier,
				website,
				approvalStatus: safeSignerMismatch ?? { status: 'WaitingForUser' as const },
				...(safeTransaction === undefined ? {} : { safeTransaction }),
				...(pendingSafeFields ?? {}),
			}
			// A transaction that accepting stacks reserves its hash once, as the request is stored, so the preview shows it; under the hash lock, so no other reservation or import takes it meanwhile.
			const simulationHashReservation = await withSimulationHashLock(async () => {
				const reservation = stacksTransactionOnAccept(pendingTransaction) && transactionToSimulate.success ? await allocateSimulationHashReservation(transactionToSimulate, request.uniqueRequestIdentifier) : undefined
				await appendPendingTransactionOrMessage(reservation === undefined ? pendingTransaction : { ...pendingTransaction, simulationHashReservation: reservation })
				return reservation
			})
			await updateConfirmTransactionView(ethereumClientService, tokenPriceService)
			markPerformance(POPUP_PERFORMANCE_MARKS.backgroundTransactionSimulationStart)
			const simulationResultsPromise = silenceChromeUnCaughtPromise(refreshConfirmTransactionSimulation(
				ethereumClientService,
				tokenPriceService,
				transactionExecutor,
				simulationMode,
				request.uniqueRequestIdentifier,
				transactionToSimulate,
				{ safeSigningRequest: safeTransaction, simulationHashReservation },
			))
			if (transactionToSimulate.success) {
				await updatePendingTransactionOrMessage(pendingTransaction.uniqueRequestIdentifier, async (transaction) => ({ ...transaction, transactionToSimulate: transactionToSimulate, transactionOrMessageCreationStatus: 'Simulating' as const }))
				await updateConfirmTransactionView(ethereumClientService, tokenPriceService)
			}
			const popupVisualisation = await simulationResultsPromise
			markPerformance(POPUP_PERFORMANCE_MARKS.backgroundTransactionSimulationEnd)
			await updatePendingTransactionOrMessage(pendingTransaction.uniqueRequestIdentifier, async (transaction) => {
				if (transaction.type !== 'Transaction') return transaction
				if (popupVisualisation === undefined) return transaction
				if (transaction.transactionOrMessageCreationStatus === 'Simulated' || transaction.transactionOrMessageCreationStatus === 'FailedToSimulate') {
					if ('popupVisualisation' in transaction && !shouldReplacePopupVisualisation(transaction.popupVisualisation, popupVisualisation)) return transaction
				}
				if (transactionToSimulate.success) return { ...transaction, transactionToSimulate, popupVisualisation, transactionOrMessageCreationStatus: 'Simulated' }
				return { ...transaction, transactionToSimulate, popupVisualisation, transactionOrMessageCreationStatus: 'FailedToSimulate' }
			})
			await updateConfirmTransactionView(ethereumClientService, tokenPriceService)
			await tryFocusingTabOrWindow(openedDialog)
			return { success: true }
		} catch(e: unknown) {
			await reportLocalRecovery(e, { code: 'send_transaction_preparation_failed', message: 'Returning a wallet-compatible rejection to the requesting page.', details: e instanceof Error ? e.stack : undefined })
			return formRejectMessage(METAMASK_ERROR_FAILED_TO_PARSE_REQUEST, 'The Interceptor failed to send transaction')
		}
	})
	if (!('success' in outcome)) return formRejectMessage(outcome.error.code, outcome.error.message)
	const pendingTransactionData = await getPendingTransactionOrMessageByidentifier(request.uniqueRequestIdentifier)

	if (pendingTransactionData === undefined) return formRejectMessage(METAMASK_ERROR_BLANKET_ERROR, 'The Interceptor failed to process the transaction')
	return { type: 'doNotReply' as const }
}
