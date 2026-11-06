import { getSettings } from '../background/settings.js'
import type { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { reportUnexpectedError } from './errors.js'
import { Semaphore } from './semaphore.js'
import { getHostWithPort } from './requests.js'

const injectableSitesWildcard = ['file://*/*', 'http://*/*', 'https://*/*']
export const getInterceptorDisabledSites = (websiteAccess: WebsiteAccessArray) => websiteAccess.filter((entry) => entry.interceptorDisabled === true).map((entry) => entry.website.websiteOrigin)

// A match pattern without a port matches every port of its host, while one with a port compares it with the URL's effective port, so naming the default port too keeps the pattern to that one origin. Chrome rejects a port after the * scheme, so each pattern names its scheme.
function getExactOriginMatchPattern(url: URL) {
	const defaultPort = url.protocol === 'https:' ? '443' : '80'
	return `${ url.protocol }//${ url.hostname }:${ url.port === '' ? defaultPort : url.port }/*`
}

// Website access, including a disabled Interceptor, is stored per getHostWithPort origin and compared as an exact string, as the MV2 injection also does. A disabled site is excluded on exactly the URLs with that origin: excluding its subdomains or other ports too would leave pages that the popup and the access policy treat as enabled without the Interceptor provider (#1701).
function getContentScriptExclusionMatchPatternsForOrigin(origin: string) {
	if (origin === '') return ['file:///*']
	try {
		const hasExplicitScheme = origin.includes('://')
		const url = new URL(hasExplicitScheme ? origin : `http://${ origin }`)
		if (url.protocol === 'file:') return url.hostname === '' ? ['file:///*'] : []
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return []
		if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') return []
		if (url.hostname === '') return []
		// URL parsing keeps a * in a hostname, also one decoded from %2A, but a match pattern reads a leading *. as every subdomain and rejects a * anywhere else, which fails the whole registration, so no pattern can name such a host exactly.
		if (url.hostname.includes('*')) return []
		if (hasExplicitScheme) return [getExactOriginMatchPattern(url)]
		// Keep each scheme whose URLs getHostWithPort maps back to this origin. It leaves out a scheme's default port, so for example a stored port 80 only comes from an https URL.
		return ['http:', 'https:']
			.map((scheme) => new URL(`${ scheme }//${ origin }/`))
			.filter((schemeUrl) => getHostWithPort(schemeUrl.href) === origin)
			.map(getExactOriginMatchPattern)
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

// Firefox globs match the serialized URL, which omits default ports. Keep the same exact hosts and origins as the Chrome match patterns, but normalize default ports before constructing globs.
export function getFirefoxContentScriptExclusionGlobs(origins: readonly string[]) {
	return getContentScriptExclusionMatchPatterns(origins).map((pattern) => {
		const url = new URL(pattern)
		return `${ url.protocol }//${ url.host }/*`
	})
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
