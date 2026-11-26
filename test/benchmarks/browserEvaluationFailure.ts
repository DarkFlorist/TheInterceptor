export type BrowserEvaluationFailureKind = 'navigation' | 'target-closed'

const failures = new WeakMap<Error, BrowserEvaluationFailureKind>()

// Only engine adapters mark protocol failures; page-thrown errors keep their ordinary failure semantics.
export function markBrowserEvaluationFailure(error: Error, kind: BrowserEvaluationFailureKind) {
	failures.set(error, kind)
	return error
}

export const browserEvaluationFailureKind = (error: unknown) => error instanceof Error ? failures.get(error) : undefined
