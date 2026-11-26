import type { BrowserSession } from './browserTypes.js'

type Value<Result> = { readonly kind: 'value', readonly value: Result }
type NavigationPolicy = { readonly kind: 'navigation' }
type PageClosePolicy = { readonly kind: 'page-close', readonly session: Pick<BrowserSession, 'pages'>, readonly pageId: string }

// Only protocol-specific context loss is retryable. An arbitrary application failure mentioning a frame or a closed resource is still a failure.
function evaluationFailureKind(error: unknown) {
	if (!(error instanceof Error)) return undefined
	if (/^(?:Firefox BiDi script\.evaluate: )?(?:Execution context was destroyed\b|Cannot find (?:default execution )?context\b|no such frame\b|Browsing context (?:.* )?has been discarded\b)/i.test(error.message)
		|| /^Firefox BiDi script\.evaluate: Evaluation was abandoned\b/i.test(error.message)) return 'navigation'
	if (/^CDP websocket closed for ws(?:s)?:\/\//.test(error.message) || /^(?:Target|Session) closed\.?$/i.test(error.message)
		|| /^Firefox BiDi script\.evaluate: Browsing Context with id [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} not found$/i.test(error.message)) return 'target-closed'
	return undefined
}

export function evaluateBrowserTask<Result>(evaluate: () => Promise<Result>, policy: NavigationPolicy): Promise<Value<Result> | { readonly kind: 'retry-navigation' }>
export function evaluateBrowserTask<Result>(evaluate: () => Promise<Result>, policy: PageClosePolicy): Promise<Value<Result> | { readonly kind: 'closed' }>
export async function evaluateBrowserTask<Result>(evaluate: () => Promise<Result>, policy: NavigationPolicy | PageClosePolicy): Promise<Value<Result> | { readonly kind: 'retry-navigation' } | { readonly kind: 'closed' }> {
	try { return { kind: 'value', value: await evaluate() } } catch (error: unknown) {
		const failure = evaluationFailureKind(error)
		if (failure === undefined) throw error
		if (policy.kind === 'navigation') {
			if (failure === 'navigation') return { kind: 'retry-navigation' }
			throw error
		}
		// A click may have been delivered before its reply was lost. Never retry it while the page is still present, or infer closure from the error text alone.
		if ((await policy.session.pages()).some(({ id }) => id === policy.pageId)) throw error
		return { kind: 'closed' }
	}
}
