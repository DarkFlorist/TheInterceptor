import type { InterceptedRequestForward } from '../types/interceptor-messages.js'
import type { PopupOrTabId } from '../types/websiteAccessTypes.js'
import { createBoundedRetries } from '../utils/boundedRetry.js'

// What to run for a request once its claim is released, recorded by a resolution that found it claimed, coalesced into one entry. Only data: the claim holder runs it in its own context (without holding the admission lock). The request is finished again, so that pass sees what changed meanwhile (its requesting tab closing, say, or an input that arrived) and arbitrates the stored inputs: a decline then rejects a request still pending and uncommitted, such as one whose claimed accept failed, and does nothing for one that was resolved. Each follow-up runs once per recording, so the passes stop once nothing records more. automaticOnly: every resolution that recorded it was automatic, so it runs only while the budget lasts. followUp: a resolution recorded work to follow; parkedRetryGeneration: a scheduled retry came due meanwhile, which runs on release if it is still the request's current one. Parked retries collapse into one entry.
type DeferredResolution = { readonly automaticOnly: boolean, readonly followUp: boolean, readonly parkedRetryGeneration?: number }
const FINISHING_RETRIES = { baseDelayMs: 50, attemptLimit: 6 }
// All the working state of request resolution (requestResolution.ts), which a restart loses.
export const resolutionState = {
	// The requests whose terminal outcome an accept, reject or close has claimed and is carrying out. A claim is taken synchronously, so of racing resolutions of a request exactly one stacks it or replies; the others return false without either. Under the claim, a committed request is only finished (finishCommittedRequest); only an uncommitted pending request gets an outcome chosen (resolve).
	claims: new Set<string>(),
	deferredResolutions: new Map<string, DeferredResolution>(),
	// A reply a resolution chose for a request whose commitment write failed: finishing the request commits it, so the request keeps that outcome.
	chosenReplies: new Map<string, { readonly reply: InterceptedRequestForward, readonly confirmationWindow: PopupOrTabId }>(),
	// The one retry owner of each request, shared by finishing and declining it: one attempt budget and at most one scheduled retry. A completed resolution drops it; an exhausted budget stays exhausted, so automatic follow-ups (deferrals, finishers) never extend it, and only a user action or startup resets it (resetRequestRetryBudget).
	requestRetries: createBoundedRetries<string>(FINISHING_RETRIES),
}
