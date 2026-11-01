import { getSettings } from '../background/settings.js'
import type { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { checkAndThrowRuntimeLastError, getTabIfExists, isMissingBrowserTargetError } from './requests.js'
import { reportLocalRecoveryBestEffort, reportUnexpectedError } from './errors.js'
import { getWebsiteOrigin, isLegacyWebsiteOriginForCanonicalOrigin, isCanonicalWebsiteOrigin, normalizeStoredWebsiteOrigin } from './websiteOrigin.js'

const injectableSitesWildcard = ['file://*/*', 'http://*/*', 'https://*/*']
const injectableSitesRegexp = [/^file:\/\/.*/, /^http:\/\/.*/, /^https:\/\/.*/]
const extensionGallerySitesRegexp = [/^https:\/\/chromewebstore\.google\.com(?:[\/?#]|$)/, /^https:\/\/chrome\.google\.com\/webstore(?:[\/?#]|$)/]
const otherExtensionInjectionTargetErrorMessage = 'Cannot access a chrome-extension:// URL of different extension'
const extensionGalleryInjectionTargetErrorMessage = 'The extensions gallery cannot be scripted.'
const isInjectableSite = (url: string) => injectableSitesRegexp.some((regexpPattern) => regexpPattern.test(url)) && !extensionGallerySitesRegexp.some((regexpPattern) => regexpPattern.test(url))
const isExpectedManifestV2InjectionTargetError = (error: unknown) => error instanceof Error && (error.message === otherExtensionInjectionTargetErrorMessage || error.message === extensionGalleryInjectionTargetErrorMessage)
export const getInterceptorDisabledSites = (websiteAccess: WebsiteAccessArray) => websiteAccess.filter((entry) => entry.interceptorDisabled === true).map((entry) => entry.website.websiteOrigin)

// A match pattern without a port matches every port of its host, while one with a port compares it with the URL's effective port, so naming the default port too keeps the pattern to that one origin. Chrome rejects a port after the * scheme, so each pattern names its scheme.
function getExactOriginMatchPattern(url: URL) {
	const defaultPort = url.protocol === 'https:' ? '443' : '80'
	return `${ url.protocol }//${ url.hostname }:${ url.port === '' ? defaultPort : url.port }/*`
}

// URL parsing keeps a * in a hostname, also one decoded from %2A, but a match pattern reads a leading *. as every subdomain and rejects a * anywhere else, which fails the whole registration, so no pattern can name such a host exactly.
const hasMatchPatternWildcardHost = (url: URL) => url.hostname.includes('*')

// A disabled site is excluded on exactly the origins that the MV2 injection and the access policy treat as disabled: excluding its subdomains or other ports too would leave pages that the popup treats as enabled without the Interceptor provider (#1701).
function getManifestV3ExcludeMatchesForOrigin(origin: string) {
	if (/^https?:\/\//iu.test(origin)) {
		try {
			const url = new URL(origin)
			if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return []
		} catch {
			return []
		}
	}
	const normalizedOrigin = normalizeStoredWebsiteOrigin(origin)
	if (normalizedOrigin === undefined) return []
	if (normalizedOrigin === '') return ['file:///*']
	if (!isCanonicalWebsiteOrigin(normalizedOrigin)) {
		// A legacy origin has no scheme, so keep each scheme whose origin the MV2 injection matches with it. A URL leaves out its scheme's default port, so for example a stored port 443 matches both an explicit-port http URL and a default-port https URL.
		return ['http:', 'https:']
			.map((scheme) => new URL(`${ scheme }//${ normalizedOrigin }/`))
			.filter((url) => !hasMatchPatternWildcardHost(url) && isLegacyWebsiteOriginForCanonicalOrigin(normalizedOrigin, url.origin))
			.map(getExactOriginMatchPattern)
	}
	const url = new URL(normalizedOrigin)
	// Match patterns include the query string, while file identity uses only the path.
	if (url.protocol === 'file:') return [normalizedOrigin, `${ normalizedOrigin }?*`]
	if (hasMatchPatternWildcardHost(url)) return []
	return [getExactOriginMatchPattern(url)]
}

export function getManifestV3ExcludeMatches(origins: readonly string[]) {
	const patterns = new Set<string>()
	for (const origin of origins) {
		for (const pattern of getManifestV3ExcludeMatchesForOrigin(origin)) patterns.add(pattern)
	}
	return [...patterns]
}

export const updateContentScriptInjectionStrategyManifestV3 = async () => {
	const excludeMatches = getManifestV3ExcludeMatches(getInterceptorDisabledSites((await getSettings()).websiteAccess))
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
		await reportUnexpectedError(error, { code: 'content_script_registration_failed' })
	}
}

const injectLogic = async (content: browser.webNavigation._OnCommittedDetails) => {
	if (!isInjectableSite(content.url)) return false
	const disabledSites = getInterceptorDisabledSites((await getSettings()).websiteAccess)
	// The tab can navigate while settings are loading, including to another extension page where injection is prohibited.
	const thisTab = await getTabIfExists(content.tabId)
	if (thisTab?.url === undefined || !isInjectableSite(thisTab.url)) return false
	const urls = [content.url, thisTab.url]
	const origins = urls.map((url) => getWebsiteOrigin(url))
	const noMatches = disabledSites.every((disabledSite) => origins.every((origin) => {
		if (disabledSite === origin) return false
		return !isLegacyWebsiteOriginForCanonicalOrigin(disabledSite, origin)
	}))
	if (!noMatches) return false
	try {
		await browser.tabs.executeScript(content.tabId, { file: '/vendor/webextension-polyfill/dist/browser-polyfill.js', allFrames: false, runAt: 'document_start' })
		await browser.tabs.executeScript(content.tabId, { file: '/inpage/js/listenContentScript.js', allFrames: false, runAt: 'document_start' })
		await browser.tabs.executeScript(content.tabId, { file: '/inpage/js/document_start.js', allFrames: false, runAt: 'document_start' })
		checkAndThrowRuntimeLastError()
	} catch(error) {
		if (isMissingBrowserTargetError(error) || isExpectedManifestV2InjectionTargetError(error)) return false
		reportLocalRecoveryBestEffort(error, { code: 'manifest_v2_content_script_injection_failed', message: 'Leaving this navigation without early injection.' })
	}
	return false
}

export const updateContentScriptInjectionStrategyManifestV2 = async () => {
	browser.webNavigation.onCommitted.removeListener(injectLogic)
	browser.webNavigation.onCommitted.addListener(injectLogic, { url: injectableSitesWildcard.map((urlMatches) => ({ urlMatches })) })
}

export const updateContentScriptInjectionStrategy = async () => {
	if (browser.runtime.getManifest().manifest_version === 3) await updateContentScriptInjectionStrategyManifestV3()
	else await updateContentScriptInjectionStrategyManifestV2()
}
