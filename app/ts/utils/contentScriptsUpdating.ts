import { getSettings } from '../background/settings.js'
import type { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { getHostWithPort } from './requests.js'
import { reportUnexpectedError } from './errors.js'
import { Semaphore } from './semaphore.js'

const injectableSitesWildcard = ['file://*/*', 'http://*/*', 'https://*/*']
export const getInterceptorDisabledSites = (websiteAccess: WebsiteAccessArray) => websiteAccess.filter((entry) => entry.interceptorDisabled === true).map((entry) => entry.website.websiteOrigin)

// In Chrome a match pattern without a port matches every port of its host, while one with a port compares it with the URL's effective port, so naming the default port too keeps the pattern to that one origin. Chrome rejects a port after the * scheme, so each pattern names its scheme.
function getExactOriginMatchPattern(url: URL) {
	const defaultPort = url.protocol === 'https:' ? '443' : '80'
	return `${ url.protocol }//${ url.hostname }:${ url.port === '' ? defaultPort : url.port }/*`
}

// Website access, including a disabled Interceptor, is stored per getHostWithPort origin and compared as an exact string. A disabled site is excluded on exactly the URLs with that origin: excluding its subdomains or other ports too would leave pages that the popup and the access policy treat as enabled without the Interceptor provider (#1701).
function getContentScriptExcludeMatchesForOrigin(origin: string) {
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

export function getContentScriptExcludeMatches(origins: readonly string[]) {
	const patterns = new Set<string>()
	for (const origin of origins) {
		for (const pattern of getContentScriptExcludeMatchesForOrigin(origin)) patterns.add(pattern)
	}
	return [...patterns]
}

// Firefox matches a pattern's host and ignores the URL's port, so a pattern that names a port matches no URL at all (Firefox bugs 1362809 and 1468162). Firefox therefore excludes each disabled origin's whole host from the registered content scripts, and registers the same scripts again for that host's other origins with URL globs that leave out exactly the disabled origins.
export function getFirefoxContentScriptExclusions(exactOriginExcludeMatches: readonly string[]) {
	const excludeMatches = new Set<string>()
	const otherOriginMatches = new Set<string>()
	const otherOriginExcludeGlobs = new Set<string>()
	for (const pattern of exactOriginExcludeMatches) {
		const url = new URL(pattern.slice(0, -1))
		if (url.protocol === 'file:') {
			excludeMatches.add(pattern)
			continue
		}
		const hostPattern = `${ url.protocol }//${ url.hostname }/*`
		excludeMatches.add(hostPattern)
		otherOriginMatches.add(hostPattern)
		// A URL's origin leaves out its scheme's default port, as the URL itself does, and the glob covers the URLs that also carry credentials.
		otherOriginExcludeGlobs.add(`${ url.origin }/*`)
		otherOriginExcludeGlobs.add(`${ url.protocol }//*@${ url.host }/*`)
	}
	return { excludeMatches: [...excludeMatches], otherOriginMatches: [...otherOriginMatches], otherOriginExcludeGlobs: [...otherOriginExcludeGlobs] }
}

// The browser polyfill types do not expose the MAIN world or matchOriginAsFallback options, which Chrome and Firefox 128 accept.
type ContentScriptDefinition = { readonly id: string, readonly js: string[], readonly world: 'MAIN' | 'ISOLATED' }
const contentScriptDefinitions: readonly ContentScriptDefinition[] = [
	{ id: 'inpage2', js: ['/vendor/webextension-polyfill/dist/browser-polyfill.js', '/inpage/js/listenContentScript.js', '/inpage/js/listenContentScriptBootstrap.js'], world: 'ISOLATED' },
	{ id: 'inpage', js: ['/inpage/js/inpage.js'], world: 'MAIN' },
]
const sharedContentScriptOptions: { readonly allFrames: true, readonly runAt: 'document_start', readonly matchOriginAsFallback: true } = { allFrames: true, runAt: 'document_start', matchOriginAsFallback: true }

async function updateRegisteredContentScripts(excludeMatches: string[]) {
	type RegisteredContentScript = Parameters<typeof browser.scripting.registerContentScripts>[0][0]
	type FixedContentScript = RegisteredContentScript & { world: 'MAIN' | 'ISOLATED', matchOriginAsFallback: boolean }
	const contentScripts: FixedContentScript[] = contentScriptDefinitions.map(({ id, js, world }) => ({ id, js, world, matches: injectableSitesWildcard, excludeMatches, ...sharedContentScriptOptions }))
	const registeredContentScripts = await browser.scripting.getRegisteredContentScripts()
	const registeredContentScriptIds = new Set(registeredContentScripts.map(({ id }) => id))
	const desiredContentScriptIds = new Set(contentScripts.map(({ id }) => id))
	const missingContentScripts = contentScripts.filter(({ id }) => !registeredContentScriptIds.has(id))
	const existingContentScripts = contentScripts.filter(({ id }) => registeredContentScriptIds.has(id))
	const obsoleteContentScriptIds = registeredContentScripts.map(({ id }) => id).filter((id) => !desiredContentScriptIds.has(id))
	if (missingContentScripts.length > 0) await browser.scripting.registerContentScripts(missingContentScripts)
	if (existingContentScripts.length > 0) await browser.scripting.updateContentScripts(existingContentScripts)
	if (obsoleteContentScriptIds.length > 0) await browser.scripting.unregisterContentScripts({ ids: obsoleteContentScriptIds })
}

// Firefox's own contentScripts API accepts URL globs but keeps a registration only while the background page that made it is loaded, which for the persistent MV2 background is the whole session; it is used only for the other origins of disabled hosts.
let firefoxOtherOriginContentScripts: readonly browser.contentScripts.RegisteredContentScript[] = []
async function updateFirefoxOtherOriginContentScripts(matches: string[], excludeGlobs: string[]) {
	// Unregistering before registering leaves a page that loads in between without the provider, rather than with two. A handle is forgotten only once it is unregistered, and kept as soon as it is registered, so a failed call leaves the next update able to unregister it.
	for (const contentScript of firefoxOtherOriginContentScripts) await contentScript.unregister()
	firefoxOtherOriginContentScripts = []
	type FixedContentScriptOptions = browser.contentScripts.RegisteredContentScriptOptions & { world: 'MAIN' | 'ISOLATED', matchOriginAsFallback: boolean }
	const contentScripts: FixedContentScriptOptions[] = matches.length === 0 ? [] : contentScriptDefinitions.map(({ js, world }) => ({ js: js.map((file) => ({ file })), world, matches, excludeGlobs, ...sharedContentScriptOptions }))
	for (const contentScript of contentScripts) firefoxOtherOriginContentScripts = [...firefoxOtherOriginContentScripts, await browser.contentScripts.register(contentScript)]
}

// Settings changes and startup can update the registrations at the same time, and each update reads and replaces the previous registrations.
const contentScriptUpdateSemaphore = new Semaphore(1)

// Chrome (MV3) and Firefox (MV2) both register the content scripts, so the provider runs in the page's MAIN world at document_start, before the page's own scripts and regardless of the page's CSP.
export const updateContentScriptInjectionStrategy = async () => await contentScriptUpdateSemaphore.execute(async () => {
	const exactOriginExcludeMatches = getContentScriptExcludeMatches(getInterceptorDisabledSites((await getSettings()).websiteAccess))
	try {
		if (browser.runtime.getManifest().manifest_version === 3) {
			await updateRegisteredContentScripts(exactOriginExcludeMatches)
			return
		}
		const { excludeMatches, otherOriginMatches, otherOriginExcludeGlobs } = getFirefoxContentScriptExclusions(exactOriginExcludeMatches)
		await updateRegisteredContentScripts(excludeMatches)
		await updateFirefoxOtherOriginContentScripts(otherOriginMatches, otherOriginExcludeGlobs)
	} catch (error: unknown) {
		await reportUnexpectedError(error, { code: 'content_script_registration_failed' })
	}
})
