import { withSessionViewport, type ViewportDriverSession } from './browserViewport.js'
import type { BrowserPage, BrowserSession } from './browserTypes.js'

const isWebsiteDocument = (url: string) => url !== 'about:blank' && !/^(?:chrome|moz)-extension:/.test(url)

// Own session configuration together: enumeration is pure, while page use and any explicit or implicit viewport change finalize fixture setup for affected website documents.
export function withBrowserFixtureSetup(driver: ViewportDriverSession): BrowserSession {
	let websitePagesInUse = false
	const pageUrls = new Map<string, string>()
	const useDocument = (url: string) => { if (isWebsiteDocument(url)) websitePagesInUse = true }
	const session = withSessionViewport(driver, async () => {
		for (const page of await driver.pages()) useDocument(page.url)
	})
	const requireSetup = () => {
		if (websitePagesInUse) throw new Error('Configure browser fixture preloads and routes before using website documents; use a new session to change fixtures.')
	}
	const wrapPage = (page: BrowserPage): BrowserPage => {
		pageUrls.set(page.id, page.url)
		const currentUrl = () => pageUrls.get(page.id) ?? page.url
		return {
			// List the complete public contract so a new page operation requires an explicit fixture-use policy.
			id: page.id,
			get url() { return currentUrl() },
			navigate: async (url, wait) => {
				useDocument(currentUrl()); useDocument(url)
				await page.navigate(url, wait)
				pageUrls.set(page.id, url)
			},
			evaluate: async <T = unknown>(expression: string, timeoutMs?: number) => { useDocument(currentUrl()); return await page.evaluate<T>(expression, timeoutMs) },
			reload: async () => { useDocument(currentUrl()); await page.reload() },
			captureScreenshot: async () => { useDocument(currentUrl()); return await page.captureScreenshot() },
			close: async () => { await page.close(); pageUrls.delete(page.id) },
		}
	}
	return {
		...session,
		setViewport: async (width, height) => {
			for (const page of await session.pages()) useDocument(page.url)
			await session.setViewport(width, height)
		},
		openPage: async (url, wait) => { useDocument(url); return wrapPage(await session.openPage(url, wait)) },
		openExtensionPage: async (path) => wrapPage(await session.openExtensionPage(path)),
		pages: async () => (await session.pages()).map(wrapPage),
		addPreloadScript: async (source) => { requireSetup(); await session.addPreloadScript(source) },
		routeResponses: async (routes) => { requireSetup(); await session.routeResponses(routes) },
	}
}
