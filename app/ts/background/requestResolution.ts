import { getDeclinedRequestReply } from './terminalReplyShaping.js'
import { recordResolutionInput, forgetRecordedResolutionInputs, writeInputsRecordedSoFar, type PendingResolutionIdentity } from './requestResolutionInputs.js'
import type { PendingTransactionOrSignableMessage, ResolutionInput } from '../types/accessRequest.js'
import type { InterceptedRequestForward, StoredTerminalReply } from '../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { reportLocalRecovery } from '../utils/errors.js'
import { type UniqueRequestIdentifier, doesTabExist, doesUniqueRequestIdentifiersMatch, getUniqueRequestIdentifierString } from '../utils/requests.js'
import { assertNever } from '../utils/typescript.js'
import { type ConfirmationWindowAccess, updateConfirmationWindowAfterRemoving } from './confirmationWindowLifecycle.js'
import { resolutionState } from './requestResolutionState.js'
import { getPendingTransactionsAndMessages, removePendingTransactionOrMessage, updateOwnedPendingRequestField } from './storageVariables.js'
import { attachTerminalReplyWindow, attemptQueuedTerminalReplyDelivery, forgetTerminalReplyWindow, getQueuedTerminalReply, queueTerminalReply, retireTerminalReply } from './terminalReplyDelivery.js'

/**
 * The resolution of pending requests: how a request gets its terminal outcome and is finished, whatever starts it (a user action in the confirmation window, a closed window or tab, a reconnecting page, a signer's answer, startup). The inputs that decide it, declines and signer results, are stored on the pending request in arrival order (resolutionInputs), so their order survives a restart; the in-memory state (claims, deferred resolutions, chosen replies, each request's one retry budget) is in requestResolutionState.ts. requestResolutionInputs owns input persistence, terminalReplyShaping owns reply policy, and requestResolutionLifecycle owns startup and close events.
 * It needs no simulation services: the steps that do, showing the confirmation queue in a window that still has requests and settling a signer's result, come in the context (refreshConfirmationWindow, settleSignerResult), and a failure in them is retried like any other step.
 */

// What a resolution can do, the same for every call of it.
export type ResolutionContext = ConfirmationWindowAccess & { readonly websiteTabConnections: WebsiteTabConnections, readonly settleSignerResult: SignerResultSettlement }
// Settles a signer's result for a request still pending and uncommitted, run under its claim: it persists what the result stands for and commits the reply (commitAndFinish), or records why the result was refused.
type SignerResultSettlement = (request: PendingTransactionOrSignableMessage, signerReply: string, context: ResolutionContext) => Promise<boolean | undefined>
// What holds for one call of a resolution: automatic marks a resolution no user started (a scheduled retry, a reconnect flush, startup, a follow-up on claim release): it only runs while the request's retry budget lasts (withResolutionClaim).
export type ResolutionScope = { readonly automatic?: true }
// The scope of what is launched to run later or on its own (a scheduled retry, startup): automatic.
const LATER_AUTOMATIC_SCOPE: ResolutionScope = { automatic: true }
const getPendingRequest = async (uniqueRequestIdentifier: UniqueRequestIdentifier) => (await getPendingTransactionsAndMessages()).find((pending) => doesUniqueRequestIdentifiersMatch(pending.uniqueRequestIdentifier, uniqueRequestIdentifier))

const clearRequestRetry = resolutionState.requestRetries.reset
const retryBudgetLasts = resolutionState.requestRetries.budgetLasts
export const resetRequestRetryBudget = (uniqueRequestIdentifier: UniqueRequestIdentifier) => clearRequestRetry(getUniqueRequestIdentifierString(uniqueRequestIdentifier))
// Schedules the request's one retry for a failed resolution step, unless its budget is exhausted, then reports the failure. The retry finishes the request, arbitrating its stored inputs.
async function scheduleRequestRetry(uniqueRequestIdentifier: UniqueRequestIdentifier, context: ResolutionContext, error: unknown) {
	const claim = getUniqueRequestIdentifierString(uniqueRequestIdentifier)
	await resolutionState.requestRetries.retryAfterFailure(claim, (generation) => {
		// While another resolution holds the request, the retry is parked on its claim, counting no attempt, and runs once when the claim is released.
		if (resolutionState.claims.has(claim)) {
			const parked = resolutionState.deferredResolutions.get(claim)
			resolutionState.deferredResolutions.set(claim, { ...(parked ?? { automaticOnly: true, followUp: false }), parkedRetryGeneration: generation })
			return
		}
		void runRequestRetry(uniqueRequestIdentifier, context, LATER_AUTOMATIC_SCOPE)
	}, async (retrying) => await reportLocalRecovery(error, retrying
		? { code: 'request_resolution_retrying', message: 'Retrying the resolution of a request.' }
		: { code: 'request_resolution_gave_up', message: 'Stopped retrying the resolution of a request until the user acts on it or the extension restarts.' }))
}

// A retry of the request, automatic so it passes the budget gate: it finishes the request, and under the claim the stored inputs are arbitrated (resolveKeptInputs).
const runRequestRetry = async (uniqueRequestIdentifier: UniqueRequestIdentifier, context: ResolutionContext, scope: ResolutionScope) => await resumeRequest(uniqueRequestIdentifier, context, scope)

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
		const chosen = resolutionState.chosenReplies.get(claim)
		if (chosen !== undefined) {
			await queueTerminalReply(chosen.reply, chosen.confirmationWindow)
			resolutionState.chosenReplies.delete(claim)
		}
		const committedReply = await getQueuedTerminalReply(uniqueRequestIdentifier)
		const pending = await getPendingRequest(uniqueRequestIdentifier)
		if (committedReply === undefined) {
			if (pending !== undefined) return { kind: 'uncommitted', request: pending }
			clearRequestRetry(claim)
			forgetRecordedResolutionInputs(claim)
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
		forgetRecordedResolutionInputs(claim)
		return { kind: 'finished', delivered }
	} catch (error) {
		await scheduleRequestRetry(uniqueRequestIdentifier, context, error)
		return { kind: 'retrying', delivered }
	}
}

// Commits the request to the reply a resolution chose and finishes it. A failed commitment write is retried by finishing, with the same reply.
export async function commitAndFinish(request: PendingTransactionOrSignableMessage, reply: InterceptedRequestForward, context: ResolutionContext) {
	resolutionState.chosenReplies.set(getUniqueRequestIdentifierString(request.uniqueRequestIdentifier), { reply, confirmationWindow: request.popupOrTabId })
	const outcome = await finishCommittedRequest(request.uniqueRequestIdentifier, context)
	return outcome.kind === 'finished' || outcome.kind === 'retrying' ? outcome.delivered : undefined
}

// Finishes a committed request under its claim, and arbitrates the stored inputs of one still pending and uncommitted (resolveKeptInputs). It never throws, so a scheduled retry, a reconnect flush or startup can run it unattended: a failure goes to the request's retry, and the inputs stay stored.
export async function resumeRequest(uniqueRequestIdentifier: UniqueRequestIdentifier, context: ResolutionContext, scope: ResolutionScope = {}): Promise<boolean | undefined> {
	try {
		// The claim arbitrates the stored inputs (resolveKeptInputs) before this resolution, which has nothing more to do.
		return await withResolutionClaim(uniqueRequestIdentifier, context, async () => false, { whenClaimed: 'finish-again', arbitratesEveryInput: true }, scope)
	} catch (error) {
		await scheduleRequestRetry(uniqueRequestIdentifier, context, error)
		return undefined
	}
}

// Whether the first input of the stored log matches the given one.
const isSameInput = (logged: ResolutionInput | undefined, input: ResolutionInput) => logged !== undefined && (logged.kind === 'decline' ? input.kind === 'decline' && input.reason === logged.reason : input.kind === 'signerResult' && input.signerReply === logged.signerReply)

/**
 * The one arbitration of a request's stored inputs (resolutionInputs: declines and signer results, in arrival order, across restarts), run by withResolutionClaim under the request's claim for a request still pending and uncommitted, before any resolution of it. It processes the inputs that arrived before the resolution (the first inputsBefore of the log) in order: a decline rejects the request (rejectUnlessStacked); a signer result is settled, and if that commits a reply the arbitration ends, while a refused one is removed from the log with one atomic update and the next input follows. The first committed outcome wins; the inputs after it go with the request when it is finished.
 * A settlement that throws leaves the log as it is, for the request's retry.
 */
async function resolveKeptInputs(current: PendingTransactionOrSignableMessage, context: ResolutionContext, inputsBefore: number): Promise<boolean | undefined> {
	const claim = getUniqueRequestIdentifierString(current.uniqueRequestIdentifier)
	let request = current
	let remainingEarlierInputs = inputsBefore
	let settled: boolean | undefined = false
	while (remainingEarlierInputs > 0) {
		const [input] = request.resolutionInputs ?? []
		if (input === undefined) return settled
		if (input.kind === 'decline') return await commitAndFinish(request, await getDeclinedRequestReply(request, input.reason), context)
		settled = await context.settleSignerResult(request, input.signerReply, context)
		const stillPending = await getPendingRequest(current.uniqueRequestIdentifier)
		// A reply the settlement chose, committed or with its commitment write still to retry, ends the arbitration.
		if (stillPending === undefined || resolutionState.chosenReplies.has(claim) || await getQueuedTerminalReply(current.uniqueRequestIdentifier) !== undefined) return settled
		await updateOwnedPendingRequestField(current.uniqueRequestIdentifier, 'resolutionInputs', async (pending) => isSameInput(pending.resolutionInputs?.[0], input) ? { ...pending, resolutionInputs: (pending.resolutionInputs ?? []).slice(1) } : pending)
		remainingEarlierInputs -= 1
		const afterRemoval = await getPendingRequest(current.uniqueRequestIdentifier)
		if (afterRemoval === undefined) return settled
		request = afterRemoval
	}
	return settled
}

// Records an input for a request and resolves it: the claim writes the recorded input to the stored log before anything else and arbitrates it. A claim held elsewhere, or an automatic resolution out of retries, does not take the claim now, so the input is written right away, detached, so a restart before the next claim still finds it; a failed write goes to the request's retry.
async function recordInputAndResolve(uniqueRequestIdentifier: UniqueRequestIdentifier, input: ResolutionInput, context: ResolutionContext, scope: ResolutionScope, expectedIdentity?: PendingResolutionIdentity) {
	const claim = getUniqueRequestIdentifierString(uniqueRequestIdentifier)
	recordResolutionInput(claim, input, expectedIdentity)
	if (resolutionState.claims.has(claim) || (scope.automatic === true && !retryBudgetLasts(claim))) void (async () => {
		try {
			await writeInputsRecordedSoFar(uniqueRequestIdentifier, async () => undefined)
		} catch (error) {
			await scheduleRequestRetry(uniqueRequestIdentifier, context, error)
		}
	})()
	return await resumeRequest(uniqueRequestIdentifier, context, scope)
}

// A signer's result for a request (an ordinary signer's result or a Gnosis Safe owner signature): stored until the request's claim processes it, so a busy claim, a failed step or a restart defers it rather than dropping it. The signer is no user, so its result gives the request no new retry budget, but a deferral it records is not automatic-only: it runs on release whatever the budget.
export const submitSignerResult = async (uniqueRequestIdentifier: UniqueRequestIdentifier, signerReply: string, context: ResolutionContext) => await recordInputAndResolve(uniqueRequestIdentifier, { kind: 'signerResult', signerReply }, context, {})

type WhenClaimed = 'finish-again' | 'nothing'
// arbitratesEveryInput: the claim is taken to arbitrate the stored inputs themselves (resumeRequest), so every stored input counts; any other claim carries an action, which arrives when it takes the claim, and only the inputs stored before it count.
type ClaimOptions = { readonly whenClaimed?: WhenClaimed, readonly arbitratesEveryInput?: true }
export async function withResolutionClaim<Result>(uniqueRequestIdentifier: UniqueRequestIdentifier, context: ResolutionContext, resolve: (pending: PendingTransactionOrSignableMessage) => Promise<Result>, options: ClaimOptions = {}, scope: ResolutionScope = {}) {
	const whenClaimed = options.whenClaimed ?? 'nothing'
	const claim = getUniqueRequestIdentifierString(uniqueRequestIdentifier)
	// The one gate of automatic attempts: none runs once the request's retry budget is spent; only a user action or the first startup pass renews it.
	if (scope.automatic === true && !retryBudgetLasts(claim)) return false
	if (resolutionState.claims.has(claim)) {
		if (whenClaimed !== 'nothing') {
			const previous = resolutionState.deferredResolutions.get(claim)
			const automaticOnly = (previous?.automaticOnly ?? true) && scope.automatic === true
			resolutionState.deferredResolutions.set(claim, {
				automaticOnly,
				followUp: true,
				...(previous?.parkedRetryGeneration === undefined ? {} : { parkedRetryGeneration: previous.parkedRetryGeneration }),
			})
		}
		return false
	}
	resolutionState.claims.add(claim)
	// Asked for synchronously with the claim, before any lookup that can fail: the inputs recorded before the claim are written to the stored log first, and an action's arrival is the log's length then (the inputs at lower indices arrived before it), so an input that arrives while the claim is held is later than the action.
	const storedInputsBefore = writeInputsRecordedSoFar(uniqueRequestIdentifier, async () => options.arbitratesEveryInput === true ? Number.POSITIVE_INFINITY : ((await getPendingRequest(uniqueRequestIdentifier))?.resolutionInputs ?? []).length)
	try {
		let inputsBefore: number
		try {
			inputsBefore = await storedInputsBefore
		} catch (error) {
			// The inputs stay recorded, in order, for the request's retry, which writes them first; the resolution does not run.
			await scheduleRequestRetry(uniqueRequestIdentifier, context, error)
			return undefined
		}
		const outcome = await finishCommittedRequest(uniqueRequestIdentifier, context)
		switch (outcome.kind) {
			case 'uncommitted': {
				// The one gate of every claimed outcome: the stored inputs that arrived before this resolution (declines and signer results) are arbitrated first, and the resolution runs only for a request they leave pending and uncommitted.
				if (Math.min(inputsBefore, (outcome.request.resolutionInputs ?? []).length) === 0) return await resolve(outcome.request)
				let requestLeftPending: PendingTransactionOrSignableMessage
				try {
					const arbitrated = await resolveKeptInputs(outcome.request, context, inputsBefore)
					const afterArbitration = await getPendingRequest(uniqueRequestIdentifier)
					if (afterArbitration === undefined || resolutionState.chosenReplies.has(claim) || await getQueuedTerminalReply(uniqueRequestIdentifier) !== undefined) return arbitrated
					requestLeftPending = afterArbitration
				} catch (error) {
					// An arbitration that throws leaves the stored inputs for the request's retry; the resolution does not run.
					await scheduleRequestRetry(uniqueRequestIdentifier, context, error)
					return undefined
				}
				// Outside the arbitration's failure handling: a retry only re-arbitrates, so a failing resolution reaches its caller, as it does for a request with no stored inputs.
				return await resolve(requestLeftPending)
			}
			case 'absent': return false
			case 'finished': return outcome.delivered
			case 'retrying': return undefined
			default: return assertNever(outcome)
		}
	} finally {
		resolutionState.claims.delete(claim)
		const deferred = resolutionState.deferredResolutions.get(claim)
		resolutionState.deferredResolutions.delete(claim)
		const parkedRetryIsCurrent = deferred?.parkedRetryGeneration !== undefined && resolutionState.requestRetries.isCurrent(claim, deferred.parkedRetryGeneration)
		if (deferred?.followUp === true) {
			// Follow-ups only automatic resolutions recorded are automatic, and pass the budget gate; one a user action recorded runs regardless. A parked retry joins them.
			await resumeRequest(uniqueRequestIdentifier, context, deferred.automaticOnly ? LATER_AUTOMATIC_SCOPE : {})
		} else if (parkedRetryIsCurrent) {
			await runRequestRetry(uniqueRequestIdentifier, context, LATER_AUTOMATIC_SCOPE)
		}
	}
}

// Why a request is declined: the user rejected it, or its confirmation window closed. Both answer it with the user's rejection, except a reject of a request that never finished simulating, answered as unprocessable.
type DeclineReason = Extract<ResolutionInput, { readonly kind: 'decline' }>['reason']

// The one entry point of a decline, an explicit reject or a closed confirmation window: an input stored on the request in arrival order and arbitrated under its claim (resolveKeptInputs), which only rejects a request still pending and uncommitted, so a commitment always wins, and a signer result that arrived first is settled first. Never throws; any failure goes to the request's one retry owner (scheduleRequestRetry). An accept is never retried this way; it stays the user's to repeat.
export const declineRequest = async (uniqueRequestIdentifier: UniqueRequestIdentifier, reason: DeclineReason, context: ResolutionContext, scope: ResolutionScope = {}, expectedIdentity?: PendingResolutionIdentity) => await recordInputAndResolve(uniqueRequestIdentifier, { kind: 'decline', reason }, context, scope, expectedIdentity)
