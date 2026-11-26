import { markBrowserEvaluationFailure } from './browserEvaluationFailure.js'

export function firefoxEvaluationFailure(error: Error) {
	if (/^Firefox BiDi script\.evaluate: (?:Execution context was destroyed\b|Cannot find (?:default execution )?context\b|no such frame\b|Browsing context (?:.* )?has been discarded\b|Evaluation was abandoned\b)/i.test(error.message)) return markBrowserEvaluationFailure(error, 'navigation')
	if (/^Firefox BiDi script\.evaluate: Browsing Context with id [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} not found$/i.test(error.message)) return markBrowserEvaluationFailure(error, 'target-closed')
	return error
}
