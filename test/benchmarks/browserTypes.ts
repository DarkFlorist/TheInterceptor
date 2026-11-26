export type BrowserEngine = 'chrome' | 'firefox'
export type BrowserPage = {
	id: string
	url: string
	navigate: (url: string, wait?: 'complete' | 'interactive') => Promise<void>
	// Evaluate one JavaScript expression and await its JSON-serializable result (or undefined); use an IIFE for statements. The optional deadline permits long evaluations.
	evaluate: <T = unknown>(expression: string, timeoutMs?: number) => Promise<T | undefined>
	reload: () => Promise<void>
	captureScreenshot: () => Promise<string>
	close: () => Promise<void>
}

export type DocumentRoute = { readonly url: string, readonly body: string, readonly headers?: Readonly<Record<string, string>> }
export type BrowserSession = {
	readonly browser: BrowserEngine
	readonly browserVersion: string
	// Set exact content dimensions for all current pages and the default for future pages. Driver-opened pages have these dimensions before navigation; enumerated pages apply the default before their next driver interaction; independently created popups may run scripts before the harness applies the default.
	setViewport: (width: number, height: number) => Promise<void>
	openPage: (url: string, wait?: 'complete' | 'interactive') => Promise<BrowserPage>
	openExtensionPage: (path: string) => Promise<BrowserPage>
	pages: () => Promise<BrowserPage[]>
	// Configure fixtures before using HTTP(S) or file documents; browser-internal and extension controls and page enumeration remain available during setup.
	addPreloadScript: (source: string) => Promise<void>
	// Replace the document route table during setup; an empty list clears interception.
	routeResponses: (routes: readonly DocumentRoute[]) => Promise<void>
	close: () => Promise<void>
}
