import type { BrowserPage, BrowserSession } from './browserTypes.js'

// Engine-private primitives may have wider effects than one page (Firefox uses its user context). Expose only the session-wide operation to scenarios.
export type ViewportDriverPage = BrowserPage & { setViewport: (width: number, height: number) => Promise<void> }
// Driver factories must prepare the new about:blank page before navigating it, so startup scripts observe the session viewport.
export type ViewportDriverSession = Omit<BrowserSession, 'setViewport' | 'openPage' | 'openExtensionPage' | 'pages'> & {
	openPage: (url: string, wait: 'complete' | 'interactive' | undefined, prepare: (page: ViewportDriverPage) => Promise<void>) => Promise<ViewportDriverPage>
	openExtensionPage: (path: string, prepare: (page: ViewportDriverPage) => Promise<void>) => Promise<ViewportDriverPage>
	pages: () => Promise<ViewportDriverPage[]>
}

export function withSessionViewport(driver: ViewportDriverSession, beforeResize: () => Promise<void> = async () => undefined): BrowserSession {
	let viewport: { width: number, height: number } | undefined
	const applied = new Map<string, typeof viewport>()
	const applyViewport = async (page: ViewportDriverPage) => {
		const requested = viewport
		if (requested !== undefined && applied.get(page.id) !== requested) {
			await beforeResize()
			await page.setViewport(requested.width, requested.height)
			applied.set(page.id, requested)
		}
	}
	const exposePage = (page: ViewportDriverPage): BrowserPage => {
		return {
			// List the complete public contract so a new page operation requires an explicit viewport policy.
			id: page.id,
			get url() { return page.url },
			evaluate: async <T = unknown>(expression: string, timeoutMs?: number) => { await applyViewport(page); return await page.evaluate<T>(expression, timeoutMs) },
			navigate: async (url, wait) => { await applyViewport(page); await page.navigate(url, wait) },
			reload: async () => { await applyViewport(page); await page.reload() },
			captureScreenshot: async () => { await applyViewport(page); return await page.captureScreenshot() },
			close: async () => { await page.close() },
		}
	}
	return {
		...driver,
		openPage: async (url, wait) => { const page = await driver.openPage(url, wait, applyViewport); return exposePage(page) },
		openExtensionPage: async (path) => { const page = await driver.openExtensionPage(path, applyViewport); return exposePage(page) },
		pages: async () => {
			const pages = await driver.pages()
			const current = new Set(pages.map(({ id }) => id))
			for (const id of applied.keys()) if (!current.has(id)) applied.delete(id)
			return pages.map(exposePage)
		},
		setViewport: async (width, height) => {
			if (![width, height].every((value) => Number.isSafeInteger(value) && value > 0)) throw new Error('Viewport dimensions must be positive safe integers')
			viewport = { width, height }
			for (const page of await driver.pages()) await applyViewport(page)
		},
	}
}
