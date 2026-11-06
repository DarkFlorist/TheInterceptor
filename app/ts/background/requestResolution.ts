import * as funtypes from 'funtypes'
import type { PendingTransactionOrSignableMessage, ResolutionInput } from '../types/accessRequest.js'
import type { InterceptedRequestForward, StoredTerminalReply } from '../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { InterceptorStackOperation } from '../types/visualizer-types.js'
import { EthereumBytes32 } from '../types/wire-types.js'
import type { PopupOrTabId } from '../types/websiteAccessTypes.js'
import { simulatePersonalSign } from '../simulation/services/simulationPersonalSigning.js'
import { METAMASK_ERROR_BLANKET_ERROR, METAMASK_ERROR_USER_REJECTED_REQUEST } from '../utils/constants.js'
import { reportLocalRecovery } from '../utils/errors.js'
import { type UniqueRequestIdentifier, doesTabExist, doesUniqueRequestIdentifiersMatch, getUniqueRequestIdentifierString } from '../utils/requests.js'
import { Semaphore } from '../utils/semaphore.js'
import { assertNever } from '../utils/typescript.js'
import { type ConfirmationWindowAccess, type LockScope, updateConfirmationWindowAfterRemoving } from './confirmationWindowLifecycle.js'
import { getPendingTerminalReplies } from './pendingTerminalReplies.js'
import { resolutionState } from './requestResolutionState.js'
import { findStackOperation, getRequestStackIdentifier } from './simulationStackHashes.js'
import { getInterceptorTransactionStack, getPendingTransactionsAndMessages, removePendingTransactionOrMessage, updateOwnedPendingRequestField } from './storageVariables.js'
import { attachTerminalReplyWindow, attemptQueuedTerminalReplyDelivery, forgetTerminalReplyWindow, getQueuedTerminalReply, queueTerminalReply, retireTerminalReply } from './terminalReplyDelivery.js'

/**
 * The resolution of pending requests: how a request gets its terminal outcome and is finished, whatever starts it (a user action in the confirmation window, a closed window or tab, a reconnecting page, a signer's answer, startup). The inputs that decide it, declines and signer results, are stored on the pending request in arrival order (resolutionInputs), so their order survives a restart; the in-memory state (claims, deferred resolutions, chosen replies, inputs still to be written and each request's one retry budget) is in requestResolutionState.ts.
 * It needs no simulation services: the steps that do, showing the confirmation queue in a window that still has requests and settling a signer's result, come in the context (refreshConfirmationWindow, settleSignerResult), and a failure in them is retried like any other step.
 */

// What a resolution can do, the same for every call of it.
export type ResolutionContext = ConfirmationWindowAccess & { readonly websiteTabConnections: WebsiteTabConnections, readonly settleSignerResult: SignerResultSettlement }
// Settles a signer's result for a request still pending and uncommitted, run under its claim: it persists what the result stands for and commits the reply (commitAndFinish), or records why the result was refused.
type SignerResultSettlement = (request: PendingTransactionOrSignableMessage, signerReply: string, context: ResolutionContext, scope: ResolutionScope) => Promise<boolean | undefined>
// What holds for one call of a resolution: the lock it runs under (LockScope), and automatic, which marks a resolution no user started (a scheduled retry, a reconnect flush, startup, a follow-up on claim release): it only runs while the request's retry budget lasts (withResolutionClaim).
export type ResolutionScope = LockScope & { readonly automatic?: true }
// The scope of what is launched to run later or on its own (a scheduled retry, startup): no caller's lock reaches it, so it holds none, and it is automatic.
const LATER_AUTOMATIC_SCOPE: ResolutionScope = { automatic: true }
// The lock part of a scope, for a follow-up run on a claim's release. That follow-up runs awaited inside the resolution's own call, whose caller keeps holding its lock and waits for it, so it keeps the lock: taking it again would deadlock.
const releaseLockScope = ({ pendingConfirmationLock }: ResolutionScope): ResolutionScope => pendingConfirmationLock === undefined ? {} : { pendingConfirmationLock }
const releaseAutomaticScope = (scope: ResolutionScope): ResolutionScope => ({ ...releaseLockScope(scope), automatic: true })

const getPendingRequest = async (uniqueRequestIdentifier: UniqueRequestIdentifier) => (await getPendingTransactionsAndMessages()).find((pending) => doesUniqueRequestIdentifiersMatch(pending.uniqueRequestIdentifier, uniqueRequestIdentifier))

export const formRejectMessage = (code: number, errorString: string) => ({ type: 'result' as const, error: { code, message: errorString } })

const clearRequestRetry = resolutionState.requestRetries.reset
const retryBudgetLasts = resolutionState.requestRetries.budgetLasts
export const resetRequestRetryBudget = (uniqueRequestIdentifier: UniqueRequestIdentifier) => clearRequestRetry(getUniqueRequestIdentifierString(uniqueRequestIdentifier))
export const beginStartupRecovery = () => resolutionState.requestsResetByStartup.clear()
const resetRequestRetryBudgetAtStartup = (uniqueRequestIdentifier: UniqueRequestIdentifier) => {
	const claim = getUniqueRequestIdentifierString(uniqueRequestIdentifier)
	if (resolutionState.requestsResetByStartup.has(claim)) return
	resolutionState.requestsResetByStartup.add(claim)
	clearRequestRetry(claim)
}
const recordInput = (claim: string, input: ResolutionInput) => {
	const recorded = resolutionState.recordedInputs.get(claim) ?? { unwritten: [], writtenCount: 0 }
	resolutionState.recordedInputs.set(claim, { ...recorded, unwritten: [...recorded.unwritten, input] })
}
const forgetRecordedInputs = (claim: string) => resolutionState.recordedInputs.delete(claim)
// Logs an input on the stored request, unless it is already there unprocessed: a signer's same answer again, or a second decline (the first decline decides).
function withInputLogged(request: PendingTransactionOrSignableMessage, input: ResolutionInput): PendingTransactionOrSignableMessage {
	const logged = request.resolutionInputs ?? []
	if (input.kind === 'signerResult' && logged.some((entry) => entry.kind === 'signerResult' && entry.signerReply === input.signerReply)) return request
	if (input.kind === 'decline' && logged.some((entry) => entry.kind === 'decline')) return request
	return { ...request, resolutionInputs: [...logged, input] }
}
// Writes the request's recorded inputs, in order, up to the first targetCount recorded, each with one atomic update of the stored request.
async function writeRecordedInputs(uniqueRequestIdentifier: UniqueRequestIdentifier, targetCount: number) {
	const claim = getUniqueRequestIdentifierString(uniqueRequestIdentifier)
	for (;;) {
		const recorded = resolutionState.recordedInputs.get(claim)
		const [next] = recorded?.unwritten ?? []
		if (recorded === undefined || next === undefined || recorded.writtenCount >= targetCount) return
		await updateOwnedPendingRequestField(uniqueRequestIdentifier, 'resolutionInputs', async (request) => withInputLogged(request, next))
		const afterWrite = resolutionState.recordedInputs.get(claim)
		if (afterWrite === undefined) return
		resolutionState.recordedInputs.set(claim, { unwritten: afterWrite.unwritten.slice(1), writtenCount: afterWrite.writtenCount + 1 })
	}
}
// Serializes the writes of recorded inputs with reading a stored log for an action's arrival (withResolutionClaim). Its place in the lock order is defined in confirmationWindowLifecycle.ts.
const inputLogSemaphore = new Semaphore(1)
// Writes the inputs recorded so far, then runs then, in one turn of the input-log lock whose place is taken synchronously: inputs recorded after this call are written after then ran.
function writeInputsRecordedSoFar<Result>(uniqueRequestIdentifier: UniqueRequestIdentifier, then: () => Promise<Result>) {
	const recorded = resolutionState.recordedInputs.get(getUniqueRequestIdentifierString(uniqueRequestIdentifier))
	const targetCount = recorded === undefined ? 0 : recorded.writtenCount + recorded.unwritten.length
	return inputLogSemaphore.execute(async () => {
		await writeRecordedInputs(uniqueRequestIdentifier, targetCount)
		return await then()
	})
}

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
async function finishCommittedRequest(uniqueRequestIdentifier: UniqueRequestIdentifier, context: ResolutionContext, scope: ResolutionScope): Promise<FinishingOutcome> {
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
			forgetRecordedInputs(claim)
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
			await updateConfirmationWindowAfterRemoving(confirmationWindow, uniqueRequestIdentifier.requestSocket.tabId, context, scope)
			await forgetTerminalReplyWindow(uniqueRequestIdentifier)
		}
		await retireTerminalReply(uniqueRequestIdentifier, requestingTabGone)
		if ('error' in delivery && !requestingTabGone) throw delivery.error
		clearRequestRetry(claim)
		forgetRecordedInputs(claim)
		return { kind: 'finished', delivered }
	} catch (error) {
		await scheduleRequestRetry(uniqueRequestIdentifier, context, error)
		return { kind: 'retrying', delivered }
	}
}

// Commits the request to the reply a resolution chose and finishes it. A failed commitment write is retried by finishing, with the same reply.
export async function commitAndFinish(request: PendingTransactionOrSignableMessage, reply: InterceptedRequestForward, context: ResolutionContext, scope: ResolutionScope) {
	resolutionState.chosenReplies.set(getUniqueRequestIdentifierString(request.uniqueRequestIdentifier), { reply, confirmationWindow: request.popupOrTabId })
	const outcome = await finishCommittedRequest(request.uniqueRequestIdentifier, context, scope)
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
async function resolveKeptInputs(current: PendingTransactionOrSignableMessage, context: ResolutionContext, scope: ResolutionScope, inputsBefore: number): Promise<boolean | undefined> {
	const claim = getUniqueRequestIdentifierString(current.uniqueRequestIdentifier)
	let request = current
	let remainingEarlierInputs = inputsBefore
	let settled: boolean | undefined = false
	while (remainingEarlierInputs > 0) {
		const [input] = request.resolutionInputs ?? []
		if (input === undefined) return settled
		if (input.kind === 'decline') return await rejectUnlessStacked(request, input.reason, context, scope)
		settled = await context.settleSignerResult(request, input.signerReply, context, scope)
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
async function recordInputAndResolve(uniqueRequestIdentifier: UniqueRequestIdentifier, input: ResolutionInput, context: ResolutionContext, scope: ResolutionScope) {
	const claim = getUniqueRequestIdentifierString(uniqueRequestIdentifier)
	recordInput(claim, input)
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

// Runs work whose effect recovery depends on, so its intent is never dropped before the work succeeded: a failure is reported and the work retried with the finishing's backoff and limit. The first attempt runs as a user's; retries run later, automatic.
async function runWithBoundedRetry(work: (scope: ResolutionScope) => Promise<void>, failure: { readonly code: string, readonly description: string }): Promise<void> {
	const run = Symbol(failure.code)
	const attempt = async (scope: ResolutionScope): Promise<void> => {
		try {
			await work(scope)
			resolutionState.boundedWorkRetries.reset(run)
		} catch (error) {
			await resolutionState.boundedWorkRetries.retryAfterFailure(run, () => { void attempt(LATER_AUTOMATIC_SCOPE) }, async (retrying) => {
				if (!retrying) resolutionState.boundedWorkRetries.reset(run)
				await reportLocalRecovery(error, retrying
					? { code: `${ failure.code }_retrying`, message: `Retrying ${ failure.description }.` }
					: { code: `${ failure.code }_gave_up`, message: `Stopped retrying ${ failure.description }; startup recovery handles it.` })
			})
		}
	}
	await attempt({})
}

// Lists the closed tab's committed replies and finishes each request.
export async function finishCommittedRequestsOfClosedTab(tabId: number, context: ResolutionContext) {
	await runWithBoundedRetry(async (scope) => {
		for (const committedReply of await getPendingTerminalReplies()) {
			if (committedReply.uniqueRequestIdentifier.requestSocket.tabId !== tabId) continue
			resetRequestRetryBudget(committedReply.uniqueRequestIdentifier)
			await resumeRequest(committedReply.uniqueRequestIdentifier, context, scope)
		}
	}, { code: 'closed_tab_resolution', description: 'the cleanup of a closed tab\'s committed requests' })
}

// At startup, finishes every request with a committed reply or stored inputs (a decline or a signer result), whatever its confirmation window's state, with a new retry budget.
export async function resumeCommittedRequests(context: ResolutionContext) {
	for (const committedReply of await getPendingTerminalReplies()) {
		resetRequestRetryBudgetAtStartup(committedReply.uniqueRequestIdentifier)
		await resumeRequest(committedReply.uniqueRequestIdentifier, context, LATER_AUTOMATIC_SCOPE)
	}
	// Interrupted inputs are arbitrated whatever the window's state; other requests with live windows are left to the user.
	for (const pending of await getPendingTransactionsAndMessages()) {
		if ((pending.resolutionInputs ?? []).length === 0) continue
		resetRequestRetryBudgetAtStartup(pending.uniqueRequestIdentifier)
		await resumeRequest(pending.uniqueRequestIdentifier, context, LATER_AUTOMATIC_SCOPE)
	}
}

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
		const outcome = await finishCommittedRequest(uniqueRequestIdentifier, context, scope)
		switch (outcome.kind) {
			case 'uncommitted': {
				// The one gate of every claimed outcome: the stored inputs that arrived before this resolution (declines and signer results) are arbitrated first, and the resolution runs only for a request they leave pending and uncommitted.
				if (Math.min(inputsBefore, (outcome.request.resolutionInputs ?? []).length) === 0) return await resolve(outcome.request)
				let requestLeftPending: PendingTransactionOrSignableMessage
				try {
					const arbitrated = await resolveKeptInputs(outcome.request, context, scope, inputsBefore)
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
			await resumeRequest(uniqueRequestIdentifier, context, deferred.automaticOnly ? releaseAutomaticScope(scope) : releaseLockScope(scope))
		} else if (parkedRetryIsCurrent) {
			await runRequestRetry(uniqueRequestIdentifier, context, releaseAutomaticScope(scope))
		}
	}
}

// Why a request is declined: the user rejected it, or its confirmation window closed. Both answer it with the user's rejection, except a reject of a request that never finished simulating, answered as unprocessable.
type DeclineReason = Extract<ResolutionInput, { readonly kind: 'decline' }>['reason']

// The terminal reply that a result or error message gives a request.
export function toTerminalReply(request: PendingTransactionOrSignableMessage, message: { type: 'result', error: { code: number, message: string } } | { type: 'result', result: unknown }): InterceptedRequestForward {
	if ('error' in message) return { ...request.originalRequestParameters, ...message, uniqueRequestIdentifier: request.uniqueRequestIdentifier }
	if (request.originalRequestParameters.method === 'eth_sendRawTransaction' || request.originalRequestParameters.method === 'eth_sendTransaction') return { ...request.originalRequestParameters, ...message, result: EthereumBytes32.parse(message.result), uniqueRequestIdentifier: request.uniqueRequestIdentifier }
	return { ...request.originalRequestParameters, ...message, result: funtypes.String.parse(message.result), uniqueRequestIdentifier: request.uniqueRequestIdentifier }
}

// What a request can leave on the simulation stack.
type StackedRequestOperation = Extract<InterceptorStackOperation, { readonly type: 'Transaction' | 'Message' }>

// The one terminal reply of a request stacked on the simulation stack, whichever resolution commits it (an accept, or a decline of a request stacked before its reply was committed): a transaction's stacked hash, a message's simulated signature.
export async function toStackedTerminalReply(request: PendingTransactionOrSignableMessage, stacked: StackedRequestOperation) {
	switch (stacked.type) {
		case 'Transaction': return toTerminalReply(request, { type: 'result', result: EthereumBytes32.serialize(stacked.preSimulationTransaction.signedTransaction.hash) })
		case 'Message': return toTerminalReply(request, { type: 'result', result: (await simulatePersonalSign(stacked.signedMessageTransaction.originalRequestParameters, stacked.signedMessageTransaction.fakeSignedFor)).signature })
		default: return assertNever(stacked)
	}
}

// Answers a request that is declined: a rejection, unless it is already stacked in simulation mode (an accept stacked it and failed before its reply was committed, or its commitment and queued reply were lost), when it gets what accepting gives it: a transaction's stacked hash, a message's simulated signature. Its identifier is unique to it (createRequestIdentity), so what is found on the stack was stacked by this request, even when a page reused its request id.
async function rejectUnlessStacked(request: PendingTransactionOrSignableMessage, reason: DeclineReason, context: ResolutionContext, scope: ResolutionScope) {
	const rejection = reason === 'reject' && request.transactionOrMessageCreationStatus !== 'Simulated'
		? formRejectMessage(METAMASK_ERROR_BLANKET_ERROR, 'The Interceptor failed to process the transaction')
		: formRejectMessage(METAMASK_ERROR_USER_REJECTED_REQUEST, 'User denied transaction signature')
	const stacked = request.simulationMode ? findStackOperation((await getInterceptorTransactionStack()).operations, getRequestStackIdentifier(request)) : undefined
	return await commitAndFinish(request, stacked === undefined ? toTerminalReply(request, rejection) : await toStackedTerminalReply(request, stacked), context, scope)
}

// The one entry point of a decline, an explicit reject or a closed confirmation window: an input stored on the request in arrival order and arbitrated under its claim (resolveKeptInputs), which only rejects a request still pending and uncommitted, so a commitment always wins, and a signer result that arrived first is settled first. Never throws; any failure goes to the request's one retry owner (scheduleRequestRetry). An accept is never retried this way; it stays the user's to repeat.
export const declineRequest = async (uniqueRequestIdentifier: UniqueRequestIdentifier, reason: DeclineReason, context: ResolutionContext, scope: ResolutionScope = {}) => await recordInputAndResolve(uniqueRequestIdentifier, { kind: 'decline', reason }, context, scope)

// Declines requests as for a closed confirmation window.
export async function declinePendingRequests(requests: readonly PendingTransactionOrSignableMessage[], context: ResolutionContext, scope: ResolutionScope = {}) {
	for (const request of requests) await declineRequest(request.uniqueRequestIdentifier, 'close', context, scope)
}

const isSameWindow = (window: PopupOrTabId, other: PopupOrTabId | undefined) => other !== undefined && other.type === window.type && other.id === window.id

// The user closed a confirmation window, a user trigger that gives each request it resolves a new retry budget: the window's pending requests are declined, and the committed requests that still owe it their window update (one whose finishing ran out of retries after removing the request) are finished. The close event comes once, so reading what it resolves is retried rather than dropped, each part on its own.
export async function resolveRequestsOfClosedWindow(closedWindow: PopupOrTabId, context: ResolutionContext) {
	await runWithBoundedRetry(async (scope) => {
		const closedWindowRequests = (await getPendingTransactionsAndMessages()).filter((pending) => isSameWindow(closedWindow, pending.popupOrTabId))
		for (const pending of closedWindowRequests) resetRequestRetryBudget(pending.uniqueRequestIdentifier)
		await declinePendingRequests(closedWindowRequests, context, scope)
	}, { code: 'window_close_resolution', description: 'the rejection of requests whose confirmation window closed' })
	await runWithBoundedRetry(async (scope) => {
		for (const strandedReply of (await getPendingTerminalReplies()).filter((reply) => isSameWindow(closedWindow, reply.confirmationWindow))) {
			resetRequestRetryBudget(strandedReply.uniqueRequestIdentifier)
			await resumeRequest(strandedReply.uniqueRequestIdentifier, context, scope)
		}
	}, { code: 'window_close_finishing', description: 'the finishing of committed requests whose confirmation window closed' })
}

// At startup, declines the requests whose confirmation window is gone, with a new retry budget.
export async function declineOrphanedRequestsAtStartup(orphanedRequests: readonly PendingTransactionOrSignableMessage[], context: ResolutionContext) {
	for (const orphan of orphanedRequests) resetRequestRetryBudgetAtStartup(orphan.uniqueRequestIdentifier)
	await declinePendingRequests(orphanedRequests, context, LATER_AUTOMATIC_SCOPE)
}
