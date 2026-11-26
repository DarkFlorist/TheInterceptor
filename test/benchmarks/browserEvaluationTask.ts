import { browserEvaluationFailureKind } from './browserEvaluationFailure.js'
import type { BrowserSession } from './browserTypes.js'

type Value<Result> = { readonly kind: 'value', readonly value: Result }
type NavigationPolicy = { readonly kind: 'navigation' }
type PageClosePolicy = { readonly kind: 'page-close', readonly session: Pick<BrowserSession, 'pages'>, readonly pageId: string }

export function evaluateBrowserTask<Result>(evaluate: () => Promise<Result>, policy: NavigationPolicy): Promise<Value<Result> | { readonly kind: 'retry-navigation' }>
export function evaluateBrowserTask<Result>(evaluate: () => Promise<Result>, policy: PageClosePolicy): Promise<Value<Result> | { readonly kind: 'closed' }>
export async function evaluateBrowserTask<Result>(evaluate: () => Promise<Result>, policy: NavigationPolicy | PageClosePolicy): Promise<Value<Result> | { readonly kind: 'retry-navigation' } | { readonly kind: 'closed' }> {
	try { return { kind: 'value', value: await evaluate() } } catch (error: unknown) {
		const failure = browserEvaluationFailureKind(error)
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
