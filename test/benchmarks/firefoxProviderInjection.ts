import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { launchFirefoxSession } from './firefoxHarness.js'

// Checks the Firefox MV2 provider injection in a real browser. The page's first script records whether the provider existed when it ran, each script element the extension adds with whether the provider existed when the page observed it, and any CSP violation.
const firstPageScript = [
	'window.injectionObservations = { providerAtFirstPageScript: window.ethereum?.isInterceptor === true, addedScripts: [], cspViolations: 0 }',
	'new MutationObserver((mutations) => { for (const mutation of mutations) for (const node of mutation.addedNodes) if (node instanceof HTMLScriptElement && node !== document.currentScript) window.injectionObservations.addedScripts.push({ external: node.src !== "", providerDefined: window.ethereum?.isInterceptor === true }) }).observe(document, { childList: true, subtree: true })',
	'addEventListener("securitypolicyviolation", () => { window.injectionObservations.cspViolations += 1 })',
].join('\n')
const firstPageScriptHash = createHash('sha256').update(firstPageScript).digest('base64')
const pageHtml = `<!doctype html><html><head><script>${ firstPageScript }</script></head><body>Interceptor Firefox provider injection check</body></html>`

// The strict policy allows only the page's own first script, so the injected inline provider is blocked and the extension URL fallback has to load it.
const strictCspPath = '/strict-csp'
const pagePaths = ['/no-csp', strictCspPath]
const strictContentSecurityPolicy = `script-src 'self' 'sha256-${ firstPageScriptHash }'`
const pageLoadsPerPath = 5

// Polls for the provider so a page where it arrives late, or never, is told apart from one where it arrived in time.
const waitForInterceptorProvider = 'new Promise((resolve) => { const startedAt = Date.now(); const poll = () => { if (window.ethereum?.isInterceptor === true) resolve(true); else if (Date.now() - startedAt > 10000) resolve(false); else setTimeout(poll, 50) }; poll() })'

type AddedScript = { readonly external: boolean, readonly providerDefined: boolean }
type InjectionObservations = { readonly providerAtFirstPageScript: boolean, readonly addedScripts: readonly AddedScript[], readonly cspViolations: number }
type PageResult = { readonly path: string, readonly load: number, readonly providerArrived: boolean | undefined, readonly observations: InjectionObservations | undefined }

function getFailure({ path, providerArrived, observations }: PageResult) {
	if (providerArrived !== true) return 'the provider never arrived'
	if (observations === undefined) return 'the page did not record its observations'
	// The MV2 injection starts after a background round trip, so on a page that loads this fast it may land before or after the page's first script; either order is valid, but it must be the expected one of the two.
	if (observations.providerAtFirstPageScript) return undefined
	const [firstAddedScript, secondAddedScript] = observations.addedScripts
	if (firstAddedScript === undefined || firstAddedScript.external) return 'the page did not see the inline provider script being added'
	if (path !== strictCspPath) {
		if (!firstAddedScript.providerDefined) return 'the inline provider was not defined synchronously when its script element was added'
		if (observations.addedScripts.length !== 1) return 'the extension URL fallback ran although the inline provider was allowed'
		return undefined
	}
	if (observations.cspViolations === 0) return 'the strict CSP did not block the inline provider script'
	if (secondAddedScript?.external !== true) return 'the extension URL fallback did not run after the CSP blocked the inline provider'
	return undefined
}

async function startPageServer() {
	const server = createServer((request, response) => {
		const path = request.url?.split('?')[0] ?? ''
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
	if (address === null || typeof address === 'string') throw new Error('Could not start the Firefox provider injection page server')
	return {
		baseUrl: `http://127.0.0.1:${ address.port }`,
		close: async () => await new Promise<void>((resolve) => server.close(() => resolve())),
	}
}

async function main() {
	const pageServer = await startPageServer()
	const session = await launchFirefoxSession()
	const results: PageResult[] = []
	try {
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
	} finally {
		await session.close()
		await pageServer.close()
	}
	const failures = results.flatMap((result) => {
		const failure = getFailure(result)
		return failure === undefined ? [] : [`${ result.path } load ${ result.load }: ${ failure }`]
	})
	console.warn(JSON.stringify({ ok: failures.length === 0, browserVersion: session.browserVersion, failures, results }, undefined, 2))
	if (failures.length > 0) throw new Error(`The Firefox provider injection check failed on ${ failures.length } of ${ results.length } page loads.`)
	console.warn('Interceptor Firefox provider injection check passed.')
}

main().catch((error: unknown) => {
	console.error(error)
	process.exit(1)
})
