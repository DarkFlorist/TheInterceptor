import { getSettings } from '../background/settings.js'
import type { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { reportUnexpectedError } from './errors.js'
import { Semaphore } from './semaphore.js'

const injectableSitesWildcard = ['file://*/*', 'http://*/*', 'https://*/*']
export const getInterceptorDisabledSites = (websiteAccess: WebsiteAccessArray) => websiteAccess.filter((entry) => entry.interceptorDisabled === true).map((entry) => entry.website.websiteOrigin)

function getContentScriptExclusionMatchPatternsForOrigin(origin: string) {
	if (origin === '') return ['file:///*']
	try {
		const hasExplicitScheme = origin.includes('://')
		const url = new URL(hasExplicitScheme ? origin : `http://${ origin }`)
		if (url.protocol === 'file:') return url.hostname === '' ? ['file:///*'] : []
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return []
		if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') return []
		const hostname = url.hostname
		if (hostname === '') return []
		const isIpAddressOrLocalhost = hostname === 'localhost' || hostname.startsWith('[') || /^\d+(?:\.\d+){3}$/.test(hostname)
		const hostPattern = isIpAddressOrLocalhost ? url.host : `*.${ url.host }`
		if (hasExplicitScheme) return [`${ url.protocol.slice(0, -1) }://${ hostPattern }/*`]
		if (url.port === '') return [`*://${ hostPattern }/*`]
		return [`http://${ hostPattern }/*`, `https://${ hostPattern }/*`]
	} catch {
		return []
	}
}

export function getContentScriptExclusionMatchPatterns(origins: readonly string[]) {
	const patterns = new Set<string>()
	for (const origin of origins) {
		for (const pattern of getContentScriptExclusionMatchPatternsForOrigin(origin)) patterns.add(pattern)
	}
	return [...patterns]
}

// Firefox globs require separate root-host and subdomain patterns; their port semantics differ from match patterns.
export function getFirefoxContentScriptExclusionGlobs(origins: readonly string[]) {
	return getContentScriptExclusionMatchPatterns(origins).flatMap((pattern) => pattern.includes('://*.') ? [pattern.replace('://*.', '://'), pattern] : [pattern])
}

export const updateContentScriptInjectionStrategyManifestV3 = async () => {
	try {
		const excludeMatches = getContentScriptExclusionMatchPatterns(getInterceptorDisabledSites((await getSettings()).websiteAccess))
		type RegisteredContentScript = Parameters<typeof browser.scripting.registerContentScripts>[0][0]
		// The browser polyfill types do not expose Chrome's MAIN world or matchOriginAsFallback options.
		type FixedContentScript = RegisteredContentScript & { world?: 'MAIN' | 'ISOLATED', matchOriginAsFallback: boolean }
		const contentScripts: FixedContentScript[] = [{
			id: 'inpage2',
			allFrames: true,
			matches: injectableSitesWildcard,
			excludeMatches,
			js: ['/vendor/webextension-polyfill/dist/browser-polyfill.js', '/inpage/js/listenContentScript.js', '/inpage/js/listenContentScriptBootstrap.js'],
			runAt: 'document_start',
			matchOriginAsFallback: true
		}, {
			id: 'inpage',
			allFrames: true,
			matches: injectableSitesWildcard,
			excludeMatches,
			js: ['/inpage/js/inpage.js'],
			runAt: 'document_start',
			world: 'MAIN',
			matchOriginAsFallback: true
		}]
		const registeredContentScripts = await browser.scripting.getRegisteredContentScripts()
		const registeredContentScriptIds = new Set(registeredContentScripts.map(({ id }) => id))
		const desiredContentScriptIds = new Set(contentScripts.map(({ id }) => id))
		const missingContentScripts = contentScripts.filter(({ id }) => !registeredContentScriptIds.has(id))
		const existingContentScripts = contentScripts.filter(({ id }) => registeredContentScriptIds.has(id))
		const obsoleteContentScriptIds = registeredContentScripts.map(({ id }) => id).filter((id) => !desiredContentScriptIds.has(id))
		if (missingContentScripts.length > 0) await browser.scripting.registerContentScripts(missingContentScripts)
		if (existingContentScripts.length > 0) await browser.scripting.updateContentScripts(existingContentScripts)
		if (obsoleteContentScriptIds.length > 0) await browser.scripting.unregisterContentScripts({ ids: obsoleteContentScriptIds })
	} catch (error: unknown) {
		await reportUnexpectedError(error, { code: 'content_script_registration_failed' })
	}
}

const firefoxRegistrationGate = new Semaphore(1)
let firefoxRegistration: browser.contentScripts.RegisteredContentScript | undefined

export const updateContentScriptInjectionStrategyManifestV2 = async () => {
	try {
		await firefoxRegistrationGate.execute(async () => {
			const disabledSites = getInterceptorDisabledSites((await getSettings()).websiteAccess)
			// Register ahead of navigation: onCommitted plus asynchronous executeScript can run after hostile page scripts. Globs preserve port-specific exclusions, which Firefox match patterns cannot express.
			const nextRegistration = await browser.contentScripts.register({
				matches: injectableSitesWildcard,
				excludeGlobs: getFirefoxContentScriptExclusionGlobs(disabledSites),
				allFrames: true,
				matchAboutBlank: true,
				runAt: 'document_start',
				js: [
					{ file: '/vendor/webextension-polyfill/dist/browser-polyfill.js' },
					{ file: '/inpage/js/listenContentScript.js' },
					{ file: '/inpage/js/document_start.js' },
				],
			})
			const previousRegistration = firefoxRegistration
			firefoxRegistration = nextRegistration
			await previousRegistration?.unregister()
		})
	} catch (error: unknown) {
		await reportUnexpectedError(error, { code: 'content_script_registration_failed' })
	}
}

export const updateContentScriptInjectionStrategy = async () => {
	if (browser.runtime.getManifest().manifest_version === 3) await updateContentScriptInjectionStrategyManifestV3()
	else await updateContentScriptInjectionStrategyManifestV2()
}
