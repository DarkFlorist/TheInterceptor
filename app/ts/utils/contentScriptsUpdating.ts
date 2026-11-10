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

// Firefox matches a pattern's host and ignores the URL's port, so a pattern that names a port matches no URL at all (Firefox bugs 1362809 and 1468162). Firefox therefore excludes each disabled origin's whole host from the registered content scripts, and registers the same scripts again for each such host, behind a first script that leaves out exactly the host's disabled origins.
export function getFirefoxContentScriptExclusions(exactOriginExcludeMatches: readonly string[]) {
	const excludeMatches = new Set<string>()
	const disabledHosts = new Map<string, { readonly matches: Set<string>, readonly disabledOrigins: Set<string> }>()
	for (const pattern of exactOriginExcludeMatches) {
		const url = new URL(pattern.slice(0, -1))
		if (url.protocol === 'file:') {
			excludeMatches.add(pattern)
			continue
		}
		const hostPattern = `${ url.protocol }//${ url.hostname }/*`
		excludeMatches.add(hostPattern)
		const disabledHost = disabledHosts.get(url.hostname) ?? { matches: new Set<string>(), disabledOrigins: new Set<string>() }
		disabledHost.matches.add(hostPattern)
		// A URL's origin leaves out its scheme's default port, as window.origin does.
		disabledHost.disabledOrigins.add(url.origin)
		disabledHosts.set(url.hostname, disabledHost)
	}
	return {
		excludeMatches: [...excludeMatches],
		disabledHosts: [...disabledHosts.values()].map(({ matches, disabledOrigins }) => ({ matches: [...matches], disabledOrigins: [...disabledOrigins] })),
	}
}

// Each content script runs once per document: its first statement claims a marker in its world, which inpage.ts and listenContentScriptBootstrap.ts define under the same keys.
type ContentScriptDefinition = { readonly id: string, readonly js: string[], readonly world: 'MAIN' | 'ISOLATED', readonly documentMarker: { readonly global: 'window' | 'globalThis', readonly key: string } }
const contentScriptDefinitions: readonly ContentScriptDefinition[] = [
	{ id: 'inpage2', js: ['/vendor/webextension-polyfill/dist/browser-polyfill.js', '/inpage/js/listenContentScript.js', '/inpage/js/listenContentScriptBootstrap.js'], world: 'ISOLATED', documentMarker: { global: 'globalThis', key: 'TheInterceptor.contentScriptBridge' } },
	{ id: 'inpage', js: ['/inpage/js/inpage.js'], world: 'MAIN', documentMarker: { global: 'window', key: 'TheInterceptor.pageProvider' } },
]
// The browser polyfill types do not expose the MAIN world or matchOriginAsFallback options, which Chrome and Firefox 128 accept.
const sharedContentScriptOptions: { readonly allFrames: true, readonly runAt: 'document_start', readonly matchOriginAsFallback: true } = { allFrames: true, runAt: 'document_start', matchOriginAsFallback: true }

// Firefox matches URL globs against the URL with its credentials, and a glob's * also matches /, so no glob names exactly one origin. This first script compares the document's origin instead, and claims the script's document marker when the origin is disabled, so the scripts after it do nothing. An opaque origin ("null") counts as disabled, because it cannot be told apart.
export function getDisabledOriginCheckCode(disabledOrigins: readonly string[], documentMarker: ContentScriptDefinition['documentMarker']) {
	return `if (window.origin === 'null' || ${ JSON.stringify(disabledOrigins) }.includes(window.origin)) Reflect.defineProperty(${ documentMarker.global }, Symbol.for(${ JSON.stringify(documentMarker.key) }), { value: true, configurable: true })`
}

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

// Firefox's own contentScripts API takes code and keeps a registration only while the background page that made it is loaded, which for the persistent MV2 background is the whole session. It is used only for disabled hosts, keyed by each host's patterns and disabled origins so an unchanged host keeps its registration.
type DisabledHost = ReturnType<typeof getFirefoxContentScriptExclusions>['disabledHosts'][number]
const firefoxDisabledHostContentScripts = new Map<string, browser.contentScripts.RegisteredContentScript[]>()
const getDisabledHostKey = (disabledHost: DisabledHost) => JSON.stringify(disabledHost)

async function registerFirefoxDisabledHostContentScripts(disabledHost: DisabledHost) {
	type FixedContentScriptOptions = browser.contentScripts.RegisteredContentScriptOptions & { world: 'MAIN' | 'ISOLATED', matchOriginAsFallback: boolean }
	const registeredContentScripts: browser.contentScripts.RegisteredContentScript[] = []
	try {
		for (const { js, world, documentMarker } of contentScriptDefinitions) {
			const contentScript: FixedContentScriptOptions = { js: [{ code: getDisabledOriginCheckCode(disabledHost.disabledOrigins, documentMarker) }, ...js.map((file) => ({ file }))], world, matches: disabledHost.matches, ...sharedContentScriptOptions }
			registeredContentScripts.push(await browser.contentScripts.register(contentScript))
		}
	} catch (error: unknown) {
		// A host is tracked only with both of its scripts, so a host that failed half way is registered again by the next update.
		for (const contentScript of registeredContentScripts) await contentScript.unregister()
		throw error
	}
	firefoxDisabledHostContentScripts.set(getDisabledHostKey(disabledHost), registeredContentScripts)
}

async function unregisterFirefoxDisabledHostContentScripts(key: string) {
	const registeredContentScripts = firefoxDisabledHostContentScripts.get(key) ?? []
	while (registeredContentScripts.length > 0) {
		await registeredContentScripts[0]?.unregister()
		registeredContentScripts.shift()
	}
	firefoxDisabledHostContentScripts.delete(key)
}

// Two registrations that match a page at once are harmless, because each script runs once per document, while a moment with none leaves a page without the provider. So a disabled host's own registration is added before the registered scripts stop matching that host, and removed only after they match it again.
async function updateFirefoxContentScripts(exactOriginExcludeMatches: readonly string[]) {
	const { excludeMatches, disabledHosts } = getFirefoxContentScriptExclusions(exactOriginExcludeMatches)
	const desiredDisabledHostKeys = new Set(disabledHosts.map(getDisabledHostKey))
	const registrationErrors: unknown[] = []
	for (const disabledHost of disabledHosts) {
		if (firefoxDisabledHostContentScripts.has(getDisabledHostKey(disabledHost))) continue
		// A host whose own registration failed is still excluded below, because giving its disabled origin the provider would ignore the user's setting; its other origins go without the provider until the next update registers it again.
		await registerFirefoxDisabledHostContentScripts(disabledHost).catch((error: unknown) => { registrationErrors.push(error) })
	}
	await updateRegisteredContentScripts(excludeMatches)
	for (const key of [...firefoxDisabledHostContentScripts.keys()]) {
		if (!desiredDisabledHostKeys.has(key)) await unregisterFirefoxDisabledHostContentScripts(key)
	}
	if (registrationErrors.length > 0) throw registrationErrors[0]
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
		await updateFirefoxContentScripts(exactOriginExcludeMatches)
	} catch (error: unknown) {
		await reportUnexpectedError(error, { code: 'content_script_registration_failed' })
	}
})
