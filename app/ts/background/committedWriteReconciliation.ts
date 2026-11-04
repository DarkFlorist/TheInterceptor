import { reportUnexpectedError } from '../utils/errors.js'
import { runEachIndependently } from './terminalStateRecovery.js'

// Every failure is surfaced: the first is thrown and every other one is reported. Callers pass at least one failure.
export async function throwFirstAndReportRest(failures: readonly unknown[]): Promise<never> {
	const [firstFailure, ...otherFailures] = failures
	for (const failure of otherFailures) await reportUnexpectedError(failure)
	throw firstFailure
}

// One failure collector per committed access-affecting write. Work between the write and its reconciliation (a reply, content-script registration, a settings read-back, provider installation) must never skip that reconciliation: each preceding step runs independently and `reconcile` always runs after them, returning the failures its own nested steps collected (see the *CollectingFailures reconciliation variants). Every failure, in the order it occurred, is then surfaced: the first is thrown and every other one is reported.
export async function reconcileAfterIndependentSteps(precedingSteps: readonly (() => Promise<unknown>)[], reconcile: () => Promise<readonly unknown[]>): Promise<void> {
	const failures = await runEachIndependently(precedingSteps, async (step) => await step())
	try {
		failures.push(...await reconcile())
	} catch (reconcileFailure: unknown) {
		failures.push(reconcileFailure)
	}
	if (failures.length > 0) await throwFirstAndReportRest(failures)
}
