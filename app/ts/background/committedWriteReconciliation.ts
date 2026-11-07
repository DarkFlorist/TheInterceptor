import { reportAsUnexpectedError, surfaceFailures } from '../utils/errors.js'
import { runEachIndependently } from '../utils/array.js'

// Runs follow-up work for a failure (for example publishing an unreadable status) and then throws that failure; a failure of the follow-up is reported after it, never in its place.
export async function throwAfterFollowUp(failure: unknown, followUp: () => Promise<unknown>): Promise<never> {
	return await surfaceFailures([failure, ...await runEachIndependently([followUp], async (step) => await step())], reportAsUnexpectedError)
}

// One failure collector per committed access-affecting write, guaranteeing: (a) the committed revocation is always applied, because `reconcile` runs after every preceding step (a reply, content-script registration, a settings read-back, provider installation) whether or not it failed; (b) no failure is silently lost, each is either thrown or reported; (c) the failures of the steps it runs, including those `reconcile` returns from its nested steps (see the *CollectingFailures variants), keep their order: the first is thrown and the rest are reported. Popup-message publication goes through sendPopupMessageToOpenWindows, which reports its own delivery failures, and report-and-resolve reconciliation (finalizeWebsiteAccessChange) reports notification-only failures after its revocation is applied; both are reported rather than thrown here.
export async function reconcileAfterIndependentSteps(precedingSteps: readonly (() => Promise<unknown>)[], reconcile: () => Promise<readonly unknown[]>): Promise<void> {
	const failures = await runEachIndependently(precedingSteps, async (step) => await step())
	try {
		failures.push(...await reconcile())
	} catch (reconcileFailure: unknown) {
		failures.push(reconcileFailure)
	}
	await surfaceFailures(failures, reportAsUnexpectedError)
}
