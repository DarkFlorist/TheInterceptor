import * as funtypes from 'funtypes'
import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import type { InterceptedRequestForward, StoredTerminalReply } from '../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { PopupOrTabId } from '../types/websiteAccessTypes.js'
import { simulatePersonalSign } from '../simulation/services/simulationPersonalSigning.js'
import { METAMASK_ERROR_BLANKET_ERROR, METAMASK_ERROR_USER_REJECTED_REQUEST } from '../utils/constants.js'
import { reportLocalRecovery } from '../utils/errors.js'
import { type UniqueRequestIdentifier, doesTabExist, doesUniqueRequestIdentifiersMatch, getUniqueRequestIdentifierString } from '../utils/requests.js'
import { assertNever } from '../utils/typescript.js'
import { type ConfirmationWindowAccess, updateConfirmationWindowAfterRemoving } from './confirmationWindowLifecycle.js'
import { getPendingTerminalReplies } from './pendingTerminalReplies.js'
import { getInterceptorTransactionStack, getPendingTransactionsAndMessages, removePendingTransactionOrMessage, updatePendingTransactionOrMessage } from './storageVariables.js'
import { attachTerminalReplyWindow, attemptQueuedTerminalReplyDelivery, forgetTerminalReplyWindow, getQueuedTerminalReply, queueTerminalReply, retireTerminalReply } from './terminalReplyDelivery.js'

/**
 * The resolution of pending requests: how a request gets its terminal outcome and is finished, whatever starts it (a user action in the confirmation window, a closed window or tab, a reconnecting page, startup). The module owns all resolution state: claims, deferred resolutions, chosen replies, decline intents and each request's one retry budget.
 * It needs no simulation services: the steps that do, showing the confirmation queue in a window that still has requests and settling a signer's result, come in the context (refreshConfirmationWindow, settleSignerResult), and a failure in them is retried like any other step.
 */

// automatic marks a resolution no user started (a scheduled retry, a reconnect flush, startup, a follow-up on claim release): it only runs while the request's retry budget lasts (withResolutionClaim).
export type ResolutionContext = ConfirmationWindowAccess & { readonly websiteTabConnections: WebsiteTabConnections, readonly settleSignerResult: SignerResultSettlement, readonly automatic?: true }
// Settles a signer's result for a request still pending and uncommitted, run under its claim: it persists what the result stands for and commits the reply (commitAndFinish), or records why the result was refused.
export type SignerResultSettlement = (request: PendingTransactionOrSignableMessage, signerReply: unknown, context: ResolutionContext) => Promise<boolean | undefined>
// The context for a retry that runs later: without the caller's locks, and automatic.
const withoutHeldLocks = ({ refreshConfirmationWindow, websiteTabConnections, settleSignerResult }: ResolutionContext): ResolutionContext => ({ refreshConfirmationWindow, websiteTabConnections, settleSignerResult, automatic: true })

const getPendingRequest = async (uniqueRequestIdentifier: UniqueRequestIdentifier) => (await getPendingTransactionsAndMessages()).find((pending) => doesUniqueRequestIdentifiersMatch(pending.uniqueRequestIdentifier, uniqueRequestIdentifier))

export const formRejectMessage = (code: number, errorString: string) => ({ type: 'result' as const, error: { code, message: errorString } })

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
export const resetRequestRetryBudget = (uniqueRequestIdentifier: UniqueRequestIdentifier) => clearRequestRetry(getUniqueRequestIdentifierString(uniqueRequestIdentifier))
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
// The signer results that arrived for each request and are not processed yet, an external one-time input kept until its request's claim processes it (submitSignerResult). Kept in memory only: a restart loses the signer connection that produced the result, and the request stays waiting for its signer, for the user to reject.
const keptSignerResults = new Map<string, { readonly signerReply: unknown, readonly arrival: number }>()
// When each request's decline intent arrived; with the arrivals of kept signer results and of actions taking a claim (withResolutionClaim), from one counter, so that of the inputs and actions the first to arrive wins.
const firstDeclineArrivals = new Map<string, number>()
let nextInputArrival = 0
// The requests whose stored declineRequested this session wrote (declineRequest); a stored decline missing here came from an earlier session.
const declinesPersistedThisSession = new Set<string>()
// Drops the inputs kept for a request that is finished or gone.
const forgetRequestInputs = (claim: string) => {
	declinesPersistedThisSession.delete(claim)
	declineIntents.delete(claim)
	firstDeclineArrivals.delete(claim)
	keptSignerResults.delete(claim)
}

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

// A retry of the request, automatic so it passes the budget gate: it declines the request if a decline was asked for, else finishes it; either way, under the claim, the kept inputs are arbitrated (resolveKeptInputs).
async function runRequestRetry(uniqueRequestIdentifier: UniqueRequestIdentifier, retryContext: ResolutionContext) {
	const claim = getUniqueRequestIdentifierString(uniqueRequestIdentifier)
	const decline = declineIntents.get(claim)
	return decline === undefined ? await resumeRequest(uniqueRequestIdentifier, retryContext) : await declineRequest(uniqueRequestIdentifier, decline, retryContext)
}

// Delivers a committed reply unless it was delivered; a delivery that throws is returned as its error, for finishing to throw once the request is removed and its window updated.
async function attemptCommittedReplyDelivery(websiteTabConnections: WebsiteTabConnections, committedReply: StoredTerminalReply): Promise<{ readonly delivered: boolean | undefined } | { readonly delivered: false, readonly error: unknown }> {
	if (committedReply.delivered === true) return { delivered: true }
	try {
		return { delivered: await attemptQueuedTerminalReplyDelivery(websiteTabConnections, committedReply) }
	} catch (error) {
		return { delivered: false, error }
	}
}

type FinishingOutcome =
	| { readonly kind: 'uncommitted', readonly request: PendingTransactionOrSignableMessage }
	| { readonly kind: 'absent' }
	| { readonly kind: 'finished', readonly delivered: boolean | undefined }
	| { readonly kind: 'retrying', readonly delivered: boolean | undefined }

/**
 * Finishes a request committed to its terminal reply, under its claim, in resumable steps that each check the stored state: commit a chosen reply whose commitment write failed; deliver the reply unless it was delivered (a disconnected page gets it from the queue when it reconnects); store the request's confirmation window with the reply and remove the pending request; update that window, then forget it; and delete the delivered reply last, the only deletion of a reply (retireTerminalReply). An uncommitted pending request is left to be resolved.
 * Every step, lookups included, is guarded: a failure is reported and the request retried by its one retry owner (scheduleRequestRetry), up to its budget, after which a later user action or restart resumes it.
 */
async function finishCommittedRequest(uniqueRequestIdentifier: UniqueRequestIdentifier, context: ResolutionContext): Promise<FinishingOutcome> {
	const claim = getUniqueRequestIdentifierString(uniqueRequestIdentifier)
	// The delivery result reaches the resolution's caller even when a later step fails and is retried.
	let delivered: boolean | undefined
	try {
		const chosen = chosenUncommittedReplies.get(claim)
		if (chosen !== undefined) {
			await queueTerminalReply(chosen.reply, chosen.confirmationWindow)
			chosenUncommittedReplies.delete(claim)
		}
		const committedReply = await getQueuedTerminalReply(uniqueRequestIdentifier)
		const pending = await getPendingRequest(uniqueRequestIdentifier)
		if (committedReply === undefined) {
			if (pending !== undefined) return { kind: 'uncommitted', request: pending }
			clearRequestRetry(claim)
			forgetRequestInputs(claim)
			return { kind: 'absent' }
		}
		// A delivery that throws does not hold back removing the request and updating its window (#1650); its error is thrown after them, for the retry to deliver the reply again.
		const delivery = await attemptCommittedReplyDelivery(context.websiteTabConnections, committedReply)
		delivered = delivery.delivered
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
		if ('error' in delivery && !requestingTabGone) throw delivery.error
		clearRequestRetry(claim)
		forgetRequestInputs(claim)
		return { kind: 'finished', delivered }
	} catch (error) {
		await scheduleRequestRetry(uniqueRequestIdentifier, context, error)
		return { kind: 'retrying', delivered }
	}
}

// Commits the request to the reply a resolution chose and finishes it. A failed commitment write is retried by finishing, with the same reply.
export async function commitAndFinish(request: PendingTransactionOrSignableMessage, reply: InterceptedRequestForward, context: ResolutionContext) {
	chosenUncommittedReplies.set(getUniqueRequestIdentifierString(request.uniqueRequestIdentifier), { reply, confirmationWindow: request.popupOrTabId })
	const outcome = await finishCommittedRequest(request.uniqueRequestIdentifier, context)
	return outcome.kind === 'finished' || outcome.kind === 'retrying' ? outcome.delivered : undefined
}

// Finishes a committed request under its claim, and resolves the inputs kept for one still pending and uncommitted (resolveKeptInputs). It never throws, so a scheduled retry, a reconnect flush or startup can run it unattended: a failure goes to the request's retry, which keeps the signer result.
export async function resumeRequest(uniqueRequestIdentifier: UniqueRequestIdentifier, context: ResolutionContext): Promise<boolean | undefined> {
	try {
		// The claim arbitrates the kept inputs (resolveKeptInputs) before this resolution, which has nothing more to do.
		return await withResolutionClaim(uniqueRequestIdentifier, context, async () => false, { whenClaimed: 'finish-again', arbitratesEveryInput: true })
	} catch (error) {
		await scheduleRequestRetry(uniqueRequestIdentifier, context, error)
		return undefined
	}
}

// The kept inputs that arrived before a claimed resolution, whose arrival is before; a decline stored by an earlier session always did. Inputs that arrived later are left to the claim's release, where the resolution's commitment wins over them.
const getEarlierInputs = (request: PendingTransactionOrSignableMessage, before: number) => {
	const claim = getUniqueRequestIdentifierString(request.uniqueRequestIdentifier)
	// A decline stored on the request that this session did not write came from an earlier session, so it arrived before every input of this session, whatever this session's own decline intents record; one this session wrote keeps its in-memory order.
	const earlierSessionDecline = declinesPersistedThisSession.has(claim) ? undefined : request.declineRequested
	const signerResult = keptSignerResults.get(claim)
	const declineArrival = firstDeclineArrivals.get(claim)
	const decline = declineArrival !== undefined && declineArrival < before ? declineIntents.get(claim) : undefined
	return {
		earlierSessionDecline,
		signerResult: signerResult !== undefined && signerResult.arrival < before ? signerResult : undefined,
		decline: decline === undefined || declineArrival === undefined ? undefined : { reason: decline, arrival: declineArrival },
	}
}

// Whether the request has inputs that arrived before a claimed resolution, which the claim arbitrates first (resolveKeptInputs).
const hasEarlierInputs = (request: PendingTransactionOrSignableMessage, before: number) => {
	const { earlierSessionDecline, signerResult, decline } = getEarlierInputs(request, before)
	return earlierSessionDecline !== undefined || signerResult !== undefined || decline !== undefined
}

/**
 * The one arbitration between a request's kept inputs, a signer result (submitSignerResult) and a decline (declineRequest, or the declineRequested a pending request carries from an earlier session), run by withResolutionClaim under the request's claim, for a request still pending and uncommitted, before any resolution of it; it considers the inputs that arrived before the resolution (getEarlierInputs). The first to arrive wins: a signer result that arrived first is settled, and the decline only runs if the request is still pending and uncommitted afterwards (its result was refused); a decline that arrived first rejects the request and the signer result is dropped.
 * A settlement that throws keeps both inputs, in their order, for the request's retry.
 */
async function resolveKeptInputs(current: PendingTransactionOrSignableMessage, context: ResolutionContext, before: number): Promise<boolean | undefined> {
	const claim = getUniqueRequestIdentifierString(current.uniqueRequestIdentifier)
	const { earlierSessionDecline, signerResult, decline } = getEarlierInputs(current, before)
	if (earlierSessionDecline !== undefined) {
		keptSignerResults.delete(claim)
		return await rejectUnlessStacked(current, earlierSessionDecline, context)
	}
	if (signerResult !== undefined && (decline === undefined || signerResult.arrival < decline.arrival)) {
		const settled = await context.settleSignerResult(current, signerResult.signerReply, context)
		keptSignerResults.delete(claim)
		if (decline === undefined) return settled
		const stillPending = await getPendingRequest(current.uniqueRequestIdentifier)
		// A reply the settlement chose, committed or with its commitment write still to retry, wins over the decline.
		if (stillPending === undefined || chosenUncommittedReplies.has(claim) || await getQueuedTerminalReply(current.uniqueRequestIdentifier) !== undefined) return settled
		return await rejectUnlessStacked(stillPending, decline.reason, context)
	}
	// The decline arrived first: the signer result is dropped.
	if (signerResult !== undefined) keptSignerResults.delete(claim)
	return decline === undefined ? false : await rejectUnlessStacked(current, decline.reason, context)
}

// A signer's result for a request: kept until the request's claim processes it, so a busy claim or a failed step defers it rather than dropping it. The signer is no user, so its result gives the request no new retry budget, but a deferral it records is not automatic-only: it runs on release whatever the budget.
export async function submitSignerResult(uniqueRequestIdentifier: UniqueRequestIdentifier, signerReply: unknown, context: ResolutionContext) {
	keptSignerResults.set(getUniqueRequestIdentifierString(uniqueRequestIdentifier), { signerReply, arrival: nextInputArrival++ })
	return await resumeRequest(uniqueRequestIdentifier, context)
}

// The size of the in-memory resolution activity: claims held, follow-ups deferred and retries scheduled (of requests and of bounded work), which is empty whenever no resolution is in flight or awaiting a retry. Intent kept for a later user action or startup (chosen replies, decline intents, kept signer results, exhausted budgets) is not activity.
export const getResolutionBookkeepingSize = () => resolutionClaims.size + deferredResolutions.size + [...requestRetries.values()].filter((retry) => retry.timer !== undefined).length + boundedRetryTimers.size

// The scheduled retries of runWithBoundedRetry.
const boundedRetryTimers = new Set<ReturnType<typeof setTimeout>>()
// Runs work whose effect recovery depends on, so its intent is never dropped before the work succeeded: a failure is reported and the work retried with the finishing's backoff and limit. The first attempt runs in the caller's context; retries run later, without the caller's locks.
async function runWithBoundedRetry(work: (context: ResolutionContext) => Promise<void>, context: ResolutionContext, failure: { readonly code: string, readonly description: string }, failedAttempts: number): Promise<void> {
	try {
		await work(context)
	} catch (error) {
		const retrying = failedAttempts + 1 < FINISHING_RETRY_LIMIT
		// Scheduled before the report is awaited.
		if (retrying) {
			const timer = setTimeout(() => {
				boundedRetryTimers.delete(timer)
				void runWithBoundedRetry(work, withoutHeldLocks(context), failure, failedAttempts + 1)
			}, FINISHING_RETRY_BASE_DELAY_MS * 2 ** failedAttempts)
			boundedRetryTimers.add(timer)
		}
		await reportLocalRecovery(error, retrying
			? { code: `${ failure.code }_retrying`, message: `Retrying ${ failure.description }.` }
			: { code: `${ failure.code }_gave_up`, message: `Stopped retrying ${ failure.description }; startup recovery handles it.` })
	}
}

// Lists the closed tab's committed replies and finishes each request.
export async function finishCommittedRequestsOfClosedTab(tabId: number, context: ResolutionContext) {
	await runWithBoundedRetry(async (attemptContext) => {
		for (const committedReply of await getPendingTerminalReplies()) {
			if (committedReply.uniqueRequestIdentifier.requestSocket.tabId !== tabId) continue
			resetRequestRetryBudget(committedReply.uniqueRequestIdentifier)
			await resumeRequest(committedReply.uniqueRequestIdentifier, attemptContext)
		}
	}, context, { code: 'closed_tab_resolution', description: 'the cleanup of a closed tab\'s committed requests' }, 0)
}

// At startup, finishes every request with a committed reply or an asked-for decline, whatever its confirmation window's state, with a new retry budget.
export async function resumeCommittedRequests(startupContext: ResolutionContext) {
	const context = withoutHeldLocks(startupContext)
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
// afterClaiming runs as soon as the claim is taken, before any lookup that can fail. arbitratesEveryInput: the claim is taken to arbitrate the kept inputs themselves (resumeRequest, declineRequest), so every kept input counts; any other claim carries an action, which arrives when it takes the claim, and only inputs that arrived before it count.
type ClaimOptions = { readonly whenClaimed?: WhenClaimed, readonly retryActionWhenFinishingRetries?: true, readonly afterClaiming?: () => Promise<void>, readonly arbitratesEveryInput?: true }
export async function withResolutionClaim<Result>(uniqueRequestIdentifier: UniqueRequestIdentifier, context: ResolutionContext, resolve: (pending: PendingTransactionOrSignableMessage) => Promise<Result>, options: ClaimOptions = {}) {
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
	// Taken synchronously with the claim, so an input that arrives while the claim is held is later than the action.
	const arrival = options.arbitratesEveryInput === true ? Number.POSITIVE_INFINITY : nextInputArrival++
	try {
		await options.afterClaiming?.()
		const outcome = await finishCommittedRequest(uniqueRequestIdentifier, context)
		switch (outcome.kind) {
			case 'uncommitted': {
				// The one gate of every claimed outcome: the inputs that arrived before this resolution (a kept signer result, a decline intent, a stored decline) are arbitrated first, and the resolution runs only for a request they leave pending and uncommitted.
				if (!hasEarlierInputs(outcome.request, arrival)) return await resolve(outcome.request)
				try {
					const arbitrated = await resolveKeptInputs(outcome.request, context, arrival)
					const afterArbitration = await getPendingRequest(uniqueRequestIdentifier)
					if (afterArbitration === undefined || chosenUncommittedReplies.has(claim) || await getQueuedTerminalReply(uniqueRequestIdentifier) !== undefined) return arbitrated
					return await resolve(afterArbitration)
				} catch (error) {
					// An arbitration that throws keeps its inputs, in their order, for the request's retry; the resolution does not run.
					await scheduleRequestRetry(uniqueRequestIdentifier, context, error)
					return undefined
				}
			}
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
			const followUpContext: ResolutionContext = deferred.automaticOnly ? { ...context, automatic: true } : { refreshConfirmationWindow: context.refreshConfirmationWindow, websiteTabConnections: context.websiteTabConnections, settleSignerResult: context.settleSignerResult, ...(context.holdsPendingConfirmationLock === true ? { holdsPendingConfirmationLock: true } : {}) }
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
export async function declineRequest(uniqueRequestIdentifier: UniqueRequestIdentifier, reason: DeclineReason, context: ResolutionContext): Promise<boolean | undefined> {
	const claim = getUniqueRequestIdentifierString(uniqueRequestIdentifier)
	declineIntents.set(claim, reason)
	if (!firstDeclineArrivals.has(claim)) firstDeclineArrivals.set(claim, nextInputArrival++)
	// Marked as this session's within the write, so no read of the stored decline sees it unmarked; a mark whose write fails is harmless, as only a stored decline is looked up in it.
	const storeIntent = async () => await updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (request) => {
		if (request.declineRequested !== undefined) return request
		declinesPersistedThisSession.add(claim)
		return { ...request, declineRequested: reason }
	})
	// Checked synchronously with the claim attempt below: another resolution (an accept, say) holds the request.
	const claimedElsewhere = resolutionClaims.has(claim)
	try {
		// The decline intent is recorded above, so the claim arbitrates it (resolveKeptInputs), with a signer result that arrived before it; nothing more is left to do here.
		const result = await withResolutionClaim(uniqueRequestIdentifier, context, async () => false, {
			whenClaimed: { decline: reason },
			retryActionWhenFinishingRetries: true,
			arbitratesEveryInput: true,
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


// Declines requests as for a closed confirmation window.
export async function declinePendingRequests(requests: readonly PendingTransactionOrSignableMessage[], context: ResolutionContext) {
	for (const request of requests) await declineRequest(request.uniqueRequestIdentifier, 'close', context)
}

const isSameWindow = (window: PopupOrTabId, other: PopupOrTabId | undefined) => other !== undefined && other.type === window.type && other.id === window.id

// The user closed a confirmation window, a user trigger that gives each request it resolves a new retry budget: the window's pending requests are declined, and the committed requests that still owe it their window update (one whose finishing ran out of retries after removing the request) are finished. The close event comes once, so reading what it resolves is retried rather than dropped, each part on its own.
export async function resolveRequestsOfClosedWindow(closedWindow: PopupOrTabId, context: ResolutionContext) {
	await runWithBoundedRetry(async (attemptContext) => {
		const closedWindowRequests = (await getPendingTransactionsAndMessages()).filter((pending) => isSameWindow(closedWindow, pending.popupOrTabId))
		for (const pending of closedWindowRequests) resetRequestRetryBudget(pending.uniqueRequestIdentifier)
		await declinePendingRequests(closedWindowRequests, attemptContext)
	}, context, { code: 'window_close_resolution', description: 'the rejection of requests whose confirmation window closed' }, 0)
	await runWithBoundedRetry(async (attemptContext) => {
		for (const strandedReply of (await getPendingTerminalReplies()).filter((reply) => isSameWindow(closedWindow, reply.confirmationWindow))) {
			resetRequestRetryBudget(strandedReply.uniqueRequestIdentifier)
			await resumeRequest(strandedReply.uniqueRequestIdentifier, attemptContext)
		}
	}, context, { code: 'window_close_finishing', description: 'the finishing of committed requests whose confirmation window closed' }, 0)
}

// At startup, declines the requests whose confirmation window is gone, with a new retry budget.
export async function declineOrphanedRequestsAtStartup(orphanedRequests: readonly PendingTransactionOrSignableMessage[], context: ResolutionContext) {
	for (const orphan of orphanedRequests) resetRequestRetryBudgetAtStartup(orphan.uniqueRequestIdentifier)
	await declinePendingRequests(orphanedRequests, withoutHeldLocks(context))
}
