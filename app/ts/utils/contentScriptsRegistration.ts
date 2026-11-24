import { Semaphore } from './semaphore.js'

export type ContentScriptRegistrationDependencies = {
	readonly readDisabledSites: () => Promise<readonly string[]>
	readonly reportError: (error: unknown, context: { readonly code: 'content_script_registration_failed' | 'content_script_unregistration_failed' }) => Promise<void>
}

const injectableSitesWildcard = ['file://*/*', 'http://*/*', 'https://*/*']
// A disabled site's origin as a URL, or 'file' for local files, or undefined for a stored origin that is not a plain http(s) or file origin.
function parseDisabledSiteOrigin(origin: string): { readonly url: URL, readonly hasExplicitScheme: boolean } | 'file' | undefined {
	if (origin === '') return 'file'
	try {
		const hasExplicitScheme = origin.includes('://')
		const url = new URL(hasExplicitScheme ? origin : `http://${ origin }`)
		if (url.protocol === 'file:') return url.hostname === '' ? 'file' : undefined
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
		if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') return undefined
		// URL parsing allows wildcard hosts, but registration patterns must treat each stored host literally. Bracketed hosts have already passed the URL parser's IPv6 validation.
		if (url.hostname === '' || (!url.hostname.startsWith('[') && !/^[a-z0-9._-]+$/i.test(url.hostname))) return undefined
		return { url, hasExplicitScheme }
	} catch (error: unknown) {
		if (error instanceof TypeError) return undefined
		throw error
	}
}

// MV3 excludes a disabled site's subdomains too (#1701), and a pattern without a port covers every port of its host.
function getManifestV3ExcludeMatchesForOrigin(origin: string) {
	const parsed = parseDisabledSiteOrigin(origin)
	if (parsed === undefined) return []
	if (parsed === 'file') return ['file:///*']
	const { url, hasExplicitScheme } = parsed
	const hostname = url.hostname
	const isIpAddressOrLocalhost = hostname === 'localhost' || hostname.startsWith('[') || /^\d+(?:\.\d+){3}$/.test(hostname)
	const hostPattern = isIpAddressOrLocalhost ? url.host : `*.${ url.host }`
	if (hasExplicitScheme) return [`${ url.protocol.slice(0, -1) }://${ hostPattern }/*`]
	if (url.port === '') return [`*://${ hostPattern }/*`]
	return [`http://${ hostPattern }/*`, `https://${ hostPattern }/*`]
}

// Before it moved to a registration, MV2 compared a navigation's exact host and port with the disabled sites. Match patterns cannot keep that scope, since a pattern without a port matches every port of its host, so MV2 excludes each disabled site with globs on the URL text, where a default port is absent and any other port follows the host.
function getManifestV2ExcludeGlobsForOrigin(origin: string) {
	const parsed = parseDisabledSiteOrigin(origin)
	if (parsed === undefined) return []
	if (parsed === 'file') return ['file:///*']
	if (parsed.hasExplicitScheme) return [`${ parsed.url.protocol.slice(0, -1) }://${ parsed.url.host }/*`]
	// A URL never shows its scheme's default port, so a stored host with port 80 comes from an https URL and one with port 443 from an http URL.
	const hasPort = /:\d+$/.test(origin)
	return ['http', 'https'].flatMap((scheme) => {
		const url = new URL(`${ scheme }://${ origin }`)
		return hasPort && url.port === '' ? [] : [`${ scheme }://${ url.host }/*`]
	})
}

export const getManifestV3ExcludeMatches = (origins: readonly string[]) => [...new Set(origins.flatMap(getManifestV3ExcludeMatchesForOrigin))]
const getManifestV2ExcludeGlobs = (origins: readonly string[]) => [...new Set(origins.flatMap(getManifestV2ExcludeGlobsForOrigin))]

export const updateManifestV3ContentScripts = async (dependencies: ContentScriptRegistrationDependencies) => {
	const excludeMatches = getManifestV3ExcludeMatches(await dependencies.readDisabledSites())
	try {
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
		await dependencies.reportError(error, { code: 'content_script_registration_failed' })
	}
}

// Firefox keeps a contentScripts.register registration only while the background page runs, and only the returned object can remove it, so the current one is kept here. Registered scripts run at document_start, before any page script, the way MV3's registered scripts do.
let manifestV2Registration: browser.contentScripts.RegisteredContentScript | undefined
// Registrations a newer one replaced, kept until removing them succeeds. Every update tries again, so a registration with outdated exclusions cannot stay behind and keep injecting into a site disabled since.
let supersededManifestV2Registrations: readonly browser.contentScripts.RegisteredContentScript[] = []
const manifestV2RegistrationSemaphore = new Semaphore(1)

async function removeSupersededManifestV2Registrations(dependencies: ContentScriptRegistrationDependencies) {
	const stillRegistered: browser.contentScripts.RegisteredContentScript[] = []
	for (const registration of supersededManifestV2Registrations) {
		try {
			await registration.unregister()
		} catch (error: unknown) {
			stillRegistered.push(registration)
			await dependencies.reportError(error, { code: 'content_script_unregistration_failed' })
		}
	}
	supersededManifestV2Registrations = stillRegistered
}

// The new registration is added before the previous one is removed, so no navigation in between goes without the provider. A page that loads while both exist runs document_start.js twice in the same content-script world, and its interceptorInjected guard lets only the first run inject.
async function replaceManifestV2ContentScripts(dependencies: ContentScriptRegistrationDependencies) {
	try {
		const excludeGlobs = getManifestV2ExcludeGlobs(await dependencies.readDisabledSites())
		const registration = await browser.contentScripts.register({
			matches: injectableSitesWildcard,
			excludeGlobs,
			js: [
				{ file: '/vendor/webextension-polyfill/dist/browser-polyfill.js' },
				{ file: '/inpage/js/listenContentScript.js' },
				{ file: '/inpage/js/document_start.js' },
			],
			runAt: 'document_start',
			allFrames: false,
		})
		if (manifestV2Registration !== undefined) supersededManifestV2Registrations = [...supersededManifestV2Registrations, manifestV2Registration]
		manifestV2Registration = registration
	} catch (error: unknown) {
		await dependencies.reportError(error, { code: 'content_script_registration_failed' })
	}
	await removeSupersededManifestV2Registrations(dependencies)
}

// Updates run one at a time, so a slower earlier update cannot replace the registration of a newer disabled-site list.
export const updateManifestV2ContentScripts = async (dependencies: ContentScriptRegistrationDependencies) => await manifestV2RegistrationSemaphore.execute(async () => await replaceManifestV2ContentScripts(dependencies))

export const updateContentScriptRegistrations = async (dependencies: ContentScriptRegistrationDependencies) => {
	if (browser.runtime.getManifest().manifest_version === 3) await updateManifestV3ContentScripts(dependencies)
	else await updateManifestV2ContentScripts(dependencies)
}
