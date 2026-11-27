import { getProviderInjectionFailure, type ProviderInjectionResult } from './providerInjectionAssertions.js'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { launchBrowserSession, selectedBrowser, waitForBrowserCondition } from './browserHarness.js'

// Checks provider injection in either browser with the same page observations. The page's first script records whether the provider existed when it ran, each script element the extension adds with whether the provider existed when the page observed it, and any CSP violation.
const firstPageScript = [
	'window.injectionObservations = { providerAtFirstPageScript: window.ethereum?.isInterceptor === true, addedScripts: [], cspViolations: 0 }',
	'new MutationObserver((mutations) => { for (const mutation of mutations) for (const node of mutation.addedNodes) if (node instanceof HTMLScriptElement && node !== document.currentScript) window.injectionObservations.addedScripts.push({ external: node.src !== "", src: node.src, providerDefined: window.ethereum?.isInterceptor === true }) }).observe(document, { childList: true, subtree: true })',
	'addEventListener("securitypolicyviolation", () => { window.injectionObservations.cspViolations += 1 })',
].join('\n')
const firstPageScriptHash = createHash('sha256').update(firstPageScript).digest('base64')
const pageHtml = `<!doctype html><html><head><script>${ firstPageScript }</script></head><body>Interceptor provider injection check</body></html>`
// Different sites force Chrome to exercise its cross-process child-frame injection path.
const framePageHtml = `<!doctype html><script>
const preloadAtFirstScript = globalThis.browserFixturePreloadedBeforeFrameScript === true;
const start = () => {
	if (!window.ethereum?.isInterceptor) { setTimeout(start, 10); return; }
	Promise.all([ethereum.request({method:'eth_chainId'}), ethereum.request({method:'eth_accounts'})]).then(
		([chainId, accounts]) => parent.postMessage({type:'frame-rpc-result',chainId,accounts,preloadAtFirstScript}, '*'),
		error => parent.postMessage({type:'frame-rpc-result',error:String(error),preloadAtFirstScript}, '*')
	);
}; start();
</script>`

// The strict policy allows only the page's own first script, so the injected inline provider is blocked and the extension URL fallback has to load it.
const strictCspPath = '/strict-csp'
const pagePaths = ['/no-csp', strictCspPath]
const strictContentSecurityPolicy = `script-src 'self' 'sha256-${ firstPageScriptHash }'`
const pageLoadsPerPath = 5

// Polls for the provider so a page where it arrives late, or never, is told apart from one where it arrived in time.
const waitForInterceptorProvider = 'new Promise((resolve) => { const startedAt = Date.now(); const poll = () => { if (window.ethereum?.isInterceptor === true) resolve(true); else if (Date.now() - startedAt > 10000) resolve(false); else setTimeout(poll, 50) }; poll() })'

type PageResult = ProviderInjectionResult & { readonly path: string, readonly load: number }

async function startPageServer() {
	const server = createServer((request, response) => {
		const path = request.url?.split('?')[0] ?? ''
		if (path === '/frame-rpc' || path === '/frame-parent') {
			response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
			response.end(path === '/frame-rpc' ? framePageHtml : `<!doctype html><script>
addEventListener('message', event => {
	const child = document.querySelector('iframe');
	if (child && event.source === child.contentWindow && event.origin === new URL(child.src).origin && event.data?.type === 'frame-rpc-result') window.frameRpcResult = event.data;
});
</script>`)
			return
		}
		if (!pagePaths.includes(path)) {
			response.writeHead(404, { 'Cache-Control': 'no-store' })
			response.end()
			return
		}
		response.writeHead(200, {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': 'no-store',
			...path === strictCspPath ? { 'Content-Security-Policy': strictContentSecurityPolicy } : {},
		})
		response.end(pageHtml)
	})
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		server.listen(0, '127.0.0.1', () => resolve())
	})
	const address = server.address()
	if (address === null || typeof address === 'string') throw new Error('Could not start the provider injection page server')
	return {
		baseUrl: `http://127.0.0.1:${ address.port }`,
		close: async () => await new Promise<void>((resolve) => server.close(() => resolve())),
	}
}

async function main() {
	const pageServer = await startPageServer()
	const results: PageResult[] = []
	let browserVersion: string | undefined
	try {
		const session = await launchBrowserSession(selectedBrowser())
		browserVersion = `${ session.browser }: ${ session.browserVersion }`
		try {
			await session.addPreloadScript('globalThis.browserFixturePreloadedBeforeFrameScript = true')
			const settings = await session.openExtensionPage('html/settingsView.html')
			try {
				for (const enabled of [true, false]) {
					await settings.evaluate(`browser.runtime.sendMessage({method:'popup_ChangeSettings',data:{safeAppsCompatibilityMode:${ enabled }}})`)
					const persisted = await settings.evaluate(`(async()=> (await browser.storage.local.get('safeAppsCompatibilityMode')).safeAppsCompatibilityMode)()`)
					if (persisted !== enabled) throw new Error(`${ session.browser } rejected a genuine extension-page settings message`)
				}
				const childUrl = `${ pageServer.baseUrl.replace('127.0.0.1', 'localhost') }/frame-rpc`
				const account = '0x0000000000000000000000000000000000001234'
				await settings.evaluate(`browser.storage.local.set({simulationMode:true,useSignersAddressAsActiveAddress:false,independentActiveSimulationAddress:'${ account }',websiteAccess:[{website:{websiteOrigin:'${ new URL(childUrl).host }'},access:true,addressAccess:[{address:'${ account }',access:true}]}]})`)
				const frameParent = await session.openPage(`${ pageServer.baseUrl }/frame-parent`)
				try {
					await frameParent.evaluate(`(() => {const frame=document.createElement('iframe');frame.src=${ JSON.stringify(childUrl) };document.documentElement.append(frame)})()`)
					await waitForBrowserCondition(async () => await frameParent.evaluate('window.frameRpcResult !== undefined'), 'cross-site iframe provider RPC')
					const result = await frameParent.evaluate<{ chainId?: string, accounts?: string[], error?: string, preloadAtFirstScript?: boolean }>('window.frameRpcResult')
					if (result.error !== undefined || result.chainId !== '0x1' || result.accounts?.[0]?.toLowerCase() !== account || result.preloadAtFirstScript !== true) throw new Error(`Cross-site iframe RPC failed: ${ JSON.stringify(result) }`)
					console.warn(`${ session.browser } cross-site iframe preload, account and chain reads passed`)
				} finally { await frameParent.close() }
			} finally { await settings.close() }
			// The MV2 background registers its webNavigation injector during startup, so wait until a page is injected at all before measuring.
			const warmupPage = await session.openPage(`${ pageServer.baseUrl }/no-csp?warmup`)
			const warmupInjected = await warmupPage.evaluate<boolean>(waitForInterceptorProvider)
			await warmupPage.close()
			if (warmupInjected !== true) throw new Error('The Interceptor never injected its provider into a test page.')
			for (const path of pagePaths) {
				for (let load = 0; load < pageLoadsPerPath; load += 1) {
					const page = await session.openPage(`${ pageServer.baseUrl }${ path }?load=${ load }`)
					const providerArrived = await page.evaluate<boolean>(waitForInterceptorProvider)
					const observations = await page.evaluate<string>('JSON.stringify(window.injectionObservations)')
					results.push({ path, load, providerArrived, observations: observations === undefined ? undefined : JSON.parse(observations) })
					await page.close()
				}
			}
		} finally { await session.close() }
	} finally { await pageServer.close() }
	const failures = results.flatMap((result) => {
		const failure = getProviderInjectionFailure(result, result.path === strictCspPath)
		return failure === undefined ? [] : [`${ result.path } load ${ result.load }: ${ failure }`]
	})
	console.warn(JSON.stringify({ ok: failures.length === 0, browserVersion, failures, results }, undefined, 2))
	if (failures.length > 0) throw new Error(`The provider injection check failed on ${ failures.length } of ${ results.length } page loads.`)
	console.warn('Interceptor shared provider injection check passed.')
}

main().catch((error: unknown) => {
	console.error(error)
	process.exit(1)
})
