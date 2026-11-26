import type { BrowserPage, BrowserSession } from './browserTypes.js'
import { approveBrowserRequest, waitForBrowserCondition } from './browserHarness.js'
import { evaluateBrowserTask } from './browserEvaluationTask.js'

// Transaction clicks can be refused when the reviewed simulation changes. Only that explicit notice permits a fresh UI approval; an open popup alone never permits another click or an SDK replay.
export async function approveBrowserConfirmation(session: Pick<BrowserSession, 'pages'>, page: Pick<BrowserPage, 'id' | 'evaluate'>, selector: string) {
	await approveBrowserRequest(session, page, selector)
	let handledReview: string | undefined
	let reapprovals = 0
	await waitForBrowserCondition(async () => {
		if (!(await session.pages()).some(({ id }) => id === page.id)) return true
		const result = await evaluateBrowserTask(() => page.evaluate<{ review?: string, clicked: boolean }>(`(() => {
				const review = document.querySelector('[data-confirmation-review-changed]')?.getAttribute('data-confirmation-review-changed') ?? undefined;
				if (review === undefined || review === ${ JSON.stringify(handledReview) ?? 'undefined' }) return { review, clicked: false };
				const button = document.querySelector(${ JSON.stringify(selector) });
				if (button?.disabled !== false) return { review, clicked: false };
				button.click();
				return { review, clicked: true };
			})()`), { kind: 'page-close', session, pageId: page.id })
		if (result.kind === 'closed') return true
		const observed = result.value
		if (observed === undefined) throw new Error('Confirmation evaluation returned no observation')
		// Each changed reviewed result can be approved once, even when rendering batches the notice transitions.
		if (observed.clicked) { handledReview = observed.review; reapprovals++ }
		return false
	}, 'transaction confirmation completion', undefined, { retryNavigationErrors: false })
	return reapprovals
}
