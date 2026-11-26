import { markBrowserEvaluationFailure } from './browserEvaluationFailure.js'

export function chromeEvaluationFailure(error: Error) {
	if (/^(?:Execution context was destroyed\b|Cannot find (?:default execution )?context\b|no such frame\b)/i.test(error.message)) return markBrowserEvaluationFailure(error, 'navigation')
	if (/^CDP websocket closed for ws(?:s)?:\/\//.test(error.message) || /^(?:Target|Session) closed\.?$/i.test(error.message)) return markBrowserEvaluationFailure(error, 'target-closed')
	return error
}
