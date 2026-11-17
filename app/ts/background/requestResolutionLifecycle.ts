import { getPendingResolutionIdentity } from './requestResolutionInputs.js'
import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import type { PopupOrTabId } from '../types/websiteAccessTypes.js'
import { reportLocalRecovery } from '../utils/errors.js'
import { type UniqueRequestIdentifier, getUniqueRequestIdentifierString } from '../utils/requests.js'
import { createBoundedRetries } from '../utils/boundedRetry.js'
import { getPendingTerminalReplies } from './pendingTerminalReplies.js'
import { getPendingTransactionsAndMessages } from './storageVariables.js'
import { declineRequest, resetRequestRetryBudget, resumeRequest, type ResolutionContext, type ResolutionScope } from './requestResolution.js'

const LATER_AUTOMATIC_SCOPE: ResolutionScope = { automatic: true }
const requestsResetByStartup = new Set<string>()
const boundedWorkRetries = createBoundedRetries<symbol>({ baseDelayMs: 50, attemptLimit: 6 })
export const resetResolutionLifecycle = () => {
	requestsResetByStartup.clear()
	boundedWorkRetries.resetAll()
}
export const getResolutionLifecycleActivitySize = () => boundedWorkRetries.getScheduledRetryCount()
export const getResolutionLifecycleBookkeepingSize = () => boundedWorkRetries.getTrackedKeyCount() + requestsResetByStartup.size

export const beginStartupRecovery = () => requestsResetByStartup.clear()
const resetRequestRetryBudgetAtStartup = (uniqueRequestIdentifier: UniqueRequestIdentifier) => {
	const claim = getUniqueRequestIdentifierString(uniqueRequestIdentifier)
	if (requestsResetByStartup.has(claim)) return
	requestsResetByStartup.add(claim)
	resetRequestRetryBudget(uniqueRequestIdentifier)
}
// Runs work whose effect recovery depends on, so its intent is never dropped before the work succeeded: a failure is reported and the work retried with the finishing's backoff and limit. The first attempt runs as a user's; retries run later, automatic.
async function runWithBoundedRetry(work: (scope: ResolutionScope) => Promise<void>, failure: { readonly code: string, readonly description: string }): Promise<void> {
	const run = Symbol(failure.code)
	const attempt = async (scope: ResolutionScope): Promise<void> => {
		try {
			await work(scope)
			boundedWorkRetries.reset(run)
		} catch (error) {
			await boundedWorkRetries.retryAfterFailure(run, () => { void attempt(LATER_AUTOMATIC_SCOPE) }, async (retrying) => {
				if (!retrying) boundedWorkRetries.reset(run)
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

// Declines requests as for a closed confirmation window.
export async function declinePendingRequests(requests: readonly PendingTransactionOrSignableMessage[], context: ResolutionContext, scope: ResolutionScope = {}) {
	for (const request of requests) await declineRequest(request.uniqueRequestIdentifier, 'close', context, scope, getPendingResolutionIdentity(request))
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
