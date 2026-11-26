import { launchFirefoxSession } from './firefoxHarness.js'
import { launchChromeBrowserSession } from './chromeHarness.js'
import { waitForBrowserCondition } from './browserHarnessUtils.js'
import { evaluateBrowserTask } from './browserEvaluationTask.js'

export { waitForBrowserCondition } from './browserHarnessUtils.js'
export type { BrowserEngine, BrowserPage, BrowserSession, DocumentRoute } from './browserTypes.js'
import type { BrowserEngine, BrowserPage, BrowserSession } from './browserTypes.js'

export function selectedBrowser() {
	const value = process.argv.find((arg) => arg.startsWith('--browser='))?.slice('--browser='.length)
	if (value !== 'chrome' && value !== 'firefox') throw new Error('Select --browser=chrome or --browser=firefox; test:browsers runs every shared scenario against both.')
	return value
}

export async function launchBrowserSession(browser: BrowserEngine, extensionDirectory?: string): Promise<BrowserSession> {
	return browser === 'firefox' ? await launchFirefoxSession(extensionDirectory) : await launchChromeBrowserSession(extensionDirectory)
}

export async function waitForExtensionPage(session: BrowserSession, name: string) {
	let page: BrowserPage | undefined
	await waitForBrowserCondition(async () => {
		page = (await session.pages()).find((entry) => entry.url.includes(name))
		return page !== undefined
	}, `extension page ${ name }`)
	if (page === undefined) throw new Error(`Missing extension page ${ name }`)
	return page
}

export async function approveBrowserRequest(session: Pick<BrowserSession, 'pages'>, page: Pick<BrowserPage, 'id' | 'evaluate'>, selector: string) {
	await waitForBrowserCondition(async () => {
		// Popup metadata updates can disable the button between driver calls. Check and click in one page task so a disabled click cannot be mistaken for approval.
		const result = await evaluateBrowserTask(() => page.evaluate<boolean>(`(() => {
			const button = document.querySelector(${ JSON.stringify(selector) });
			if (button?.disabled !== false) return false;
			button.click();
			return true;
		})()`), { kind: 'page-close', session, pageId: page.id })
		return result.kind === 'closed' || result.value
	}, 'approval button', undefined, { retryNavigationErrors: false })
}
