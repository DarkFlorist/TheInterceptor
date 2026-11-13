import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { type FirefoxPage, type FirefoxSession, launchFirefoxSession } from './firefoxHarness.js'

// Checks the Firefox provider injection in a real browser: a dapp's first script must already see the provider, with and without a strict CSP, and MetaMask compatibility, disabled sites, access approval and revocation, and an extension update must keep working.
const firstPageScript = [
	'const observations = { providerAtFirstPageScript: window.ethereum?.isInterceptor === true, firstPageScriptAt: performance.now(), bridgePortMessages: 0, accountsChangedEvents: [] }',
	'window.injectionObservations = observations',
	'addEventListener("message", (event) => { if (event.source === window && event.data?.type === "interceptor_bridge_port") observations.bridgePortMessages += 1 })',
	'addEventListener("DOMContentLoaded", () => { observations.domContentLoadedAt = performance.now() })',
	'addEventListener("load", () => { observations.loadAt = performance.now() })',
	'const poll = new MessageChannel()',
	'poll.port1.onmessage = () => { if (window.ethereum?.isInterceptor === true) { observations.providerSeenAt = performance.now(); window.ethereum.on("accountsChanged", (accounts) => observations.accountsChangedEvents.push(accounts)); return } if (performance.now() < 10000) poll.port2.postMessage(undefined) }',
	'poll.port2.postMessage(undefined)',
].join('\n')
const firstPageScriptHash = createHash('sha256').update(firstPageScript).digest('base64')
const pageHtml = `<!doctype html><html><head><script>${ firstPageScript }</script></head><body>Interceptor Firefox provider injection check</body></html>`

// The strict policy allows only the page's own first script, so nothing the extension adds to the page as an inline or page-origin script could run.
const strictCspPath = '/strict-csp'
const noCspPath = '/no-csp'
const strictContentSecurityPolicy = `script-src 'sha256-${ firstPageScriptHash }'`
const pageLoadsPerPath = 5
const transitionCycles = 6
const accessApproveButtonSelector = 'nav.popup-button-row button.is-primary:not(.is-danger)'

type InjectionObservations = {
	readonly providerAtFirstPageScript: boolean
	readonly firstPageScriptAt: number
	readonly domContentLoadedAt?: number
	readonly loadAt?: number
	readonly providerSeenAt?: number
	readonly bridgePortMessages: number
	readonly accountsChangedEvents: readonly (readonly string[])[]
}

type PageServer = { readonly origin: string, readonly baseUrl: string, readonly close: () => Promise<void> }

function sleep(milliseconds: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

async function startPageServer(): Promise<PageServer> {
	const server = createServer((request, response) => {
		const path = request.url?.split('?')[0] ?? ''
		// A path under /no-csp lets a URL carry another origin's host and port in its path.
		if (path !== noCspPath && !path.startsWith(`${ noCspPath }/`) && path !== strictCspPath) {
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
		origin: `127.0.0.1:${ address.port }`,
		baseUrl: `http://127.0.0.1:${ address.port }`,
		close: async () => await new Promise<void>((resolve) => server.close(() => resolve())),
	}
}

async function readObservations(page: FirefoxPage) {
	const serialized = await page.evaluate<string>('JSON.stringify(window.injectionObservations)')
	if (serialized === undefined) throw new Error('The page did not record its observations')
	const observations: InjectionObservations = JSON.parse(serialized)
	return observations
}

// Waits until the page's own poll has seen the provider or given up, so a provider that arrives late, or never, is told apart from one that arrived in time.
async function readObservationsAcrossReload(page: FirefoxPage) {
	for (let attempt = 0; attempt < 5; attempt += 1) {
		try {
			return await waitForProviderObservation(page, 5000)
		} catch {
			await sleep(200)
		}
	}
	return undefined
}

async function waitForProviderObservation(page: FirefoxPage, timeoutMilliseconds: number) {
	const deadline = Date.now() + timeoutMilliseconds
	while (true) {
		const observations = await readObservations(page)
		if (observations.providerSeenAt !== undefined || Date.now() > deadline) return observations
		await sleep(50)
	}
}

// A provider request answered by the background shows that the page, the content script bridge and the background are connected.
async function requestChainId(page: FirefoxPage) {
	return await page.evaluate<string>('window.ethereum === undefined ? "no provider" : Promise.race([window.ethereum.request({ method: "eth_chainId" }).then((chainId) => String(chainId), (error) => `error: ${ error?.message }`), new Promise((resolve) => setTimeout(() => resolve("timeout"), 5000))])')
}

function roundTimings(observations: InjectionObservations) {
	const round = (value: number | undefined) => value === undefined ? undefined : Math.round(value * 10) / 10
	return {
		firstPageScriptAt: round(observations.firstPageScriptAt),
		domContentLoadedAt: round(observations.domContentLoadedAt),
		loadAt: round(observations.loadAt),
		providerSeenAt: round(observations.providerSeenAt),
		providerAfterLoadMs: observations.providerSeenAt === undefined || observations.loadAt === undefined ? undefined : round(observations.providerSeenAt - observations.loadAt),
	}
}

// Firefox refuses WebDriver navigation to moz-extension URLs, so the check asks the extension's own access popup to open an extension tab and drives the extension from that tab.
async function openControlPage(session: FirefoxSession, controlServer: PageServer) {
	const page = await session.openPage(`${ controlServer.baseUrl }${ noCspPath }?control`)
	await waitForProviderObservation(page, 10000)
	await page.evaluate('window.ethereum.request({ method: "eth_requestAccounts" }).catch(() => undefined) && true')
	const accessPopup = await session.waitForPage(`${ session.extensionOrigin }/html/interceptorAccess.html`, 15000)
	await accessPopup.evaluate('browser.tabs.create({ url: browser.runtime.getURL("html/popup.html") }).then(() => true)')
	const controlPage = await session.waitForPage(`${ session.extensionOrigin }/html/popup.html`, 15000)
	await accessPopup.close()
	await page.close()
	return controlPage
}

async function sendPopupMessage(controlPage: FirefoxPage, message: unknown) {
	await controlPage.evaluate(`browser.runtime.sendMessage(${ JSON.stringify(message) }).then(() => true)`)
}

async function readRegisteredContentScripts(controlPage: FirefoxPage) {
	const serialized = await controlPage.evaluate<string>('browser.scripting === undefined ? "unavailable" : browser.scripting.getRegisteredContentScripts().then((scripts) => JSON.stringify(scripts.map(({ id, excludeMatches, world }) => ({ id, excludeMatches, world }))))')
	if (serialized === undefined || serialized === 'unavailable') return 'browser.scripting is unavailable'
	const scripts: readonly { readonly id: string, readonly excludeMatches?: readonly string[], readonly world?: string }[] = JSON.parse(serialized)
	return scripts
}

async function setStorage(controlPage: FirefoxPage, items: Record<string, unknown>) {
	await controlPage.evaluate(`browser.storage.local.set(${ JSON.stringify(items) }).then(() => true)`)
}

async function waitFor(condition: () => Promise<boolean>, timeoutMilliseconds: number) {
	const deadline = Date.now() + timeoutMilliseconds
	while (Date.now() < deadline) {
		if (await condition()) return true
		await sleep(100)
	}
	return false
}

async function main() {
	const pageServer = await startPageServer()
	const otherPortPageServer = await startPageServer()
	const controlServer = await startPageServer()
	const session = await launchFirefoxSession()
	const failures: string[] = []
	const report: Record<string, unknown> = { browserVersion: session.browserVersion }
	const expect = (condition: boolean, failure: string) => {
		if (!condition) failures.push(failure)
	}
	try {
		// The background registers or starts its injector during startup, so wait until a page gets the provider at all before measuring.
		const warmupReady = await waitFor(async () => {
			const warmupPage = await session.openPage(`${ pageServer.baseUrl }${ noCspPath }?warmup`)
			const observations = await waitForProviderObservation(warmupPage, 2000)
			await warmupPage.close()
			return observations.providerSeenAt !== undefined
		}, 30000)
		if (!warmupReady) throw new Error('The Interceptor never injected its provider into a test page.')
		const controlPage = await openControlPage(session, controlServer)
		report.registeredContentScriptsAtStartup = await readRegisteredContentScripts(controlPage)

		const loads = []
		for (const path of [noCspPath, strictCspPath]) {
			for (let load = 0; load < pageLoadsPerPath; load += 1) {
				const page = await session.openPage(`${ pageServer.baseUrl }${ path }?load=${ load }`)
				const observations = await waitForProviderObservation(page, 10000)
				const chainId = observations.providerSeenAt === undefined ? 'no provider' : await requestChainId(page)
				await page.close()
				loads.push({ path, load, providerAtFirstPageScript: observations.providerAtFirstPageScript, bridgePortMessages: observations.bridgePortMessages, chainId, ...roundTimings(observations) })
				expect(observations.providerSeenAt !== undefined, `${ path } load ${ load }: the provider never arrived`)
				expect(observations.providerAtFirstPageScript, `${ path } load ${ load }: the provider was not defined when the page's first script ran`)
				expect(observations.bridgePortMessages === 1, `${ path } load ${ load }: the provider connected to the content script ${ observations.bridgePortMessages } times instead of once`)
				expect(chainId?.startsWith('0x') === true, `${ path } load ${ load }: eth_chainId was not answered (${ chainId })`)
			}
		}
		report.loads = loads

		// MetaMask compatibility is read from the background when the provider connects, so each mode needs a fresh page.
		const compatibility: Record<string, unknown> = {}
		for (const metamaskCompatibilityMode of [true, false]) {
			await setStorage(controlPage, { metamaskCompatibilityMode })
			const page = await session.openPage(`${ pageServer.baseUrl }${ noCspPath }?compatibility=${ metamaskCompatibilityMode }`)
			await waitForProviderObservation(page, 10000)
			const chainId = await requestChainId(page)
			const isMetaMask = await waitFor(async () => await page.evaluate<boolean>('window.ethereum?.isMetaMask === true') === true, metamaskCompatibilityMode ? 5000 : 1000)
			await page.close()
			compatibility[String(metamaskCompatibilityMode)] = { chainId, isMetaMask }
			expect(isMetaMask === metamaskCompatibilityMode, `MetaMask compatibility ${ metamaskCompatibilityMode ? 'on' : 'off' }: window.ethereum.isMetaMask was ${ isMetaMask }`)
		}
		report.compatibility = compatibility

		// Disabling the Interceptor for one origin must keep the provider out of exactly that origin, also when the URL carries credentials, and keep it, before the first script, on the same host's other port, also when that URL names the disabled origin in its path or query. Firefox ignores ports in match patterns, so this is checked in the page rather than in the registered patterns.
		const website = { websiteOrigin: pageServer.origin, icon: undefined, title: undefined }
		const otherPortAuthority = otherPortPageServer.origin
		await sendPopupMessage(controlPage, { method: 'popup_setDisableInterceptor', data: { interceptorDisabled: true, website } })
		const disabledRegistration = await readRegisteredContentScripts(controlPage)
		const disabledOriginPages: Record<string, boolean> = {}
		for (const url of [`${ pageServer.baseUrl }${ noCspPath }?disabled`, `http://user@${ pageServer.origin }${ noCspPath }?credentials`, `http://user:secret@${ pageServer.origin }${ noCspPath }?credentials-and-password`]) {
			const page = await session.openPage(url)
			const observations = await waitForProviderObservation(page, 2000)
			await page.close()
			disabledOriginPages[url] = observations.providerSeenAt !== undefined
			expect(observations.providerSeenAt === undefined, `disabled site: the provider was injected into the disabled origin at ${ url }`)
		}
		const otherOriginPages: Record<string, unknown> = {}
		for (const url of [`${ otherPortPageServer.baseUrl }${ noCspPath }?other-port`, `${ otherPortPageServer.baseUrl }${ noCspPath }/x/@${ pageServer.origin }/`, `${ otherPortPageServer.baseUrl }${ noCspPath }?next=@${ pageServer.origin }/`, `http://user@${ otherPortAuthority }${ noCspPath }?credentials`]) {
			const page = await session.openPage(url)
			const observations = await waitForProviderObservation(page, 10000)
			const chainId = await requestChainId(page)
			await page.close()
			otherOriginPages[url] = { providerAtFirstPageScript: observations.providerAtFirstPageScript, bridgePortMessages: observations.bridgePortMessages, chainId }
			expect(observations.providerAtFirstPageScript, `disabled site: ${ url } did not get the provider before its first script`)
			expect(observations.bridgePortMessages === 1, `disabled site: the provider at ${ url } connected ${ observations.bridgePortMessages } times instead of once`)
			expect(chainId?.startsWith('0x') === true, `disabled site: eth_chainId was not answered at ${ url } (${ chainId })`)
		}
		await sendPopupMessage(controlPage, { method: 'popup_setDisableInterceptor', data: { interceptorDisabled: false, website } })
		const reenabledRegistration = await readRegisteredContentScripts(controlPage)
		const reenabledPage = await session.openPage(`${ pageServer.baseUrl }${ noCspPath }?reenabled`)
		const reenabledObservations = await waitForProviderObservation(reenabledPage, 10000)
		await reenabledPage.close()
		report.disabledSite = {
			disabledOrigin: pageServer.origin,
			otherPortOrigin: otherPortPageServer.origin,
			disabledRegistration,
			reenabledRegistration,
			disabledOriginProviderSeen: disabledOriginPages,
			otherOriginPages,
			reenabledProviderAtFirstPageScript: reenabledObservations.providerAtFirstPageScript,
		}
		expect(Array.isArray(disabledRegistration) && disabledRegistration.length === 2, `disabled site: the content scripts are not registered: ${ JSON.stringify(disabledRegistration) }`)
		// Firefox reports an empty exclusion list as a missing one.
		expect(Array.isArray(reenabledRegistration) && reenabledRegistration.length === 2 && reenabledRegistration.every(({ excludeMatches }) => (excludeMatches ?? []).length === 0), `disabled site: re-enabling did not clear the exclusion: ${ JSON.stringify(reenabledRegistration) }`)
		expect(reenabledObservations.providerAtFirstPageScript, 'disabled site: re-enabling did not restore the provider before the first script')

		// Approving access through the real access popup and then removing it must reach the page.
		const accessPage = await session.openPage(`${ pageServer.baseUrl }${ noCspPath }?access`)
		await waitForProviderObservation(accessPage, 10000)
		await accessPage.evaluate('window.ethereum.request({ method: "eth_requestAccounts" }).then((accounts) => { window.requestedAccounts = accounts }, (error) => { window.requestedAccounts = `error: ${ error?.message }` }) && true')
		const accessPopup = await session.waitForPage(`${ session.extensionOrigin }/html/interceptorAccess.html`, 15000)
		const approveEnabled = await waitFor(async () => await accessPopup.evaluate<boolean>(`document.querySelector(${ JSON.stringify(accessApproveButtonSelector) })?.disabled === false`).catch(() => false) === true, 15000)
		if (approveEnabled) await accessPopup.evaluate(`document.querySelector(${ JSON.stringify(accessApproveButtonSelector) }).click() || true`)
		await waitFor(async () => await accessPage.evaluate<boolean>('window.requestedAccounts !== undefined') === true, 15000)
		const requestedAccounts = await accessPage.evaluate<unknown>('window.requestedAccounts')
		await sendPopupMessage(controlPage, { method: 'popup_removeWebsiteAccess', data: { websiteOrigin: pageServer.origin } })
		const revokedEventSeen = await waitFor(async () => (await readObservations(accessPage)).accountsChangedEvents.some((accounts) => accounts.length === 0), 10000)
		const accountsAfterRevocation = await accessPage.evaluate<unknown>('window.ethereum?.request({ method: "eth_accounts" })')
		await accessPage.close()
		report.access = { approveEnabled, requestedAccounts, revokedEventSeen, accountsAfterRevocation }
		expect(Array.isArray(requestedAccounts) && requestedAccounts.length > 0, `access: approving access did not return accounts: ${ JSON.stringify(requestedAccounts) }`)
		expect(revokedEventSeen, 'access: removing access did not send accountsChanged with no accounts')
		expect(Array.isArray(accountsAfterRevocation) && accountsAfterRevocation.length === 0, `access: eth_accounts after removing access returned ${ JSON.stringify(accountsAfterRevocation) }`)

		// Pages on the same host's other port keep loading while the origin is disabled and enabled again, so some load while the registrations change. Each must still get exactly one provider before its first script. Disabling reloads connected tabs, so a page read during a reload is read again.
		let toggling = true
		const toggle = async () => {
			for (let cycle = 0; cycle < transitionCycles; cycle += 1) {
				await sendPopupMessage(controlPage, { method: 'popup_setDisableInterceptor', data: { interceptorDisabled: true, website } })
				await sendPopupMessage(controlPage, { method: 'popup_removeWebsiteAccess', data: { websiteOrigin: pageServer.origin } })
			}
			toggling = false
		}
		const transitionLoads: { readonly providerAtFirstPageScript: boolean, readonly bridgePortMessages: number }[] = []
		const loadDuringTransitions = async () => {
			while (toggling) {
				const page = await session.openPage(`${ otherPortPageServer.baseUrl }${ noCspPath }?transition=${ transitionLoads.length }`)
				const observations = await readObservationsAcrossReload(page)
				await page.close().catch(() => undefined)
				if (observations !== undefined) transitionLoads.push({ providerAtFirstPageScript: observations.providerAtFirstPageScript, bridgePortMessages: observations.bridgePortMessages })
				// Paced so the page loads do not starve the background that is changing the registrations.
				await sleep(100)
			}
		}
		await Promise.all([toggle(), loadDuringTransitions()])
		report.transitions = { cycles: transitionCycles, pageLoads: transitionLoads.length, withoutProviderAtFirstScript: transitionLoads.filter(({ providerAtFirstPageScript }) => !providerAtFirstPageScript).length, withMoreThanOneProvider: transitionLoads.filter(({ bridgePortMessages }) => bridgePortMessages > 1).length }
		expect(transitionLoads.length > 0, 'transitions: no page loaded while the site was disabled and enabled again')
		expect(transitionLoads.every(({ providerAtFirstPageScript, bridgePortMessages }) => providerAtFirstPageScript && bridgePortMessages === 1), `transitions: a page on the other port did not get exactly one provider before its first script: ${ JSON.stringify(transitionLoads) }`)

		// An update restarts the background; pages loaded afterwards must get exactly one provider before their first script, and the background must not register duplicates.
		const pageBeforeUpdate = await session.openPage(`${ pageServer.baseUrl }${ noCspPath }?before-update`)
		await waitForProviderObservation(pageBeforeUpdate, 10000)
		await session.reinstallExtension()
		const updateReady = await waitFor(async () => {
			const probePage = await session.openPage(`${ pageServer.baseUrl }${ noCspPath }?after-update-probe`)
			const observations = await waitForProviderObservation(probePage, 2000)
			const chainId = observations.providerSeenAt === undefined ? 'no provider' : await requestChainId(probePage)
			await probePage.close()
			return chainId?.startsWith('0x') === true
		}, 30000)
		const pageAfterUpdate = await session.openPage(`${ pageServer.baseUrl }${ strictCspPath }?after-update`)
		const afterUpdateObservations = await waitForProviderObservation(pageAfterUpdate, 10000)
		const afterUpdateChainId = await requestChainId(pageAfterUpdate)
		await pageAfterUpdate.close()
		const pageBeforeUpdateChainId = await requestChainId(pageBeforeUpdate)
		await pageBeforeUpdate.close()
		const controlPageAfterUpdate = await openControlPage(session, controlServer)
		const registrationAfterUpdate = await readRegisteredContentScripts(controlPageAfterUpdate)
		await controlPageAfterUpdate.close()
		report.update = {
			updateReady,
			providerAtFirstPageScript: afterUpdateObservations.providerAtFirstPageScript,
			bridgePortMessages: afterUpdateObservations.bridgePortMessages,
			afterUpdateChainId,
			pageLoadedBeforeUpdateChainId: pageBeforeUpdateChainId,
			registrationAfterUpdate,
		}
		expect(updateReady, 'update: no page got a working provider after the extension update')
		expect(afterUpdateObservations.providerAtFirstPageScript, 'update: the provider was not defined when the first script ran after the update')
		expect(afterUpdateObservations.bridgePortMessages === 1, `update: the provider connected ${ afterUpdateObservations.bridgePortMessages } times instead of once after the update`)
		expect(afterUpdateChainId?.startsWith('0x') === true, `update: eth_chainId was not answered after the update (${ afterUpdateChainId })`)
		expect(Array.isArray(registrationAfterUpdate) && registrationAfterUpdate.map(({ id }) => id).sort().join(',') === 'inpage,inpage2', `update: unexpected registered content scripts after the update: ${ JSON.stringify(registrationAfterUpdate) }`)
	} finally {
		await session.close()
		await pageServer.close()
		await otherPortPageServer.close()
		await controlServer.close()
	}
	console.warn(JSON.stringify({ ok: failures.length === 0, failures, ...report }, undefined, 2))
	if (failures.length > 0) throw new Error(`The Firefox provider injection check failed ${ failures.length } expectations.`)
	console.warn('Interceptor Firefox provider injection check passed.')
}

main().catch((error: unknown) => {
	console.error(error)
	process.exit(1)
})
