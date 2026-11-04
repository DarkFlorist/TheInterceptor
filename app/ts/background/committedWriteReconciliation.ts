import { reportUnexpectedError } from '../utils/errors.js'
import { runEachIndependently } from './terminalStateRecovery.js'

// Every failure is surfaced: the first is thrown and every other one is reported. Callers pass at least one failure.
export async function throwFirstAndReportRest(failures: readonly unknown[]): Promise<never> {
	const [firstFailure, ...otherFailures] = failures
	for (const failure of otherFailures) await reportUnexpectedError(failure)
	throw firstFailure
}

// Work between a committed access-affecting write and its reconciliation (a reply, content-script registration, a settings read-back, provider installation) must never skip that reconciliation. Each preceding step runs independently and `reconcile` always runs after them; then every failure, in order, is surfaced: the first is thrown and every other one is reported.
export async function reconcileAfterIndependentSteps<Result>(precedingSteps: readonly (() => Promise<unknown>)[], reconcile: () => Promise<Result>): Promise<Result> {
	const precedingFailures = await runEachIndependently(precedingSteps, async (step) => await step())
	let result: Result
	try {
		result = await reconcile()
	} catch (reconcileFailure: unknown) {
		return await throwFirstAndReportRest([...precedingFailures, reconcileFailure])
	}
	if (precedingFailures.length > 0) return await throwFirstAndReportRest(precedingFailures)
	return result
}
