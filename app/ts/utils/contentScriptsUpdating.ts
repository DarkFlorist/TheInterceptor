import { getInterceptorDisabledSites, getSettings } from '../background/settings.js'
import { checkAndThrowRuntimeLastError, getHostWithPort, getTabIfExists, isMissingBrowserTargetError } from './requests.js'
import { reportLocalRecoveryBestEffort, reportUnexpectedError } from './errors.js'

const injectableSitesWildcard = ['file://*/*', 'http://*/*', 'https://*/*']
const injectableSitesRegexp = [/^file:\/\/.*/, /^http:\/\/.*/, /^https:\/\/.*/]
const extensionGallerySitesRegexp = [/^https:\/\/chromewebstore\.google\.com(?:[\/?#]|$)/, /^https:\/\/chrome\.google\.com\/webstore(?:[\/?#]|$)/]
const otherExtensionInjectionTargetErrorMessage = 'Cannot access a chrome-extension:// URL of different extension'
const extensionGalleryInjectionTargetErrorMessage = 'The extensions gallery cannot be scripted.'
const isInjectableSite = (url: string) => injectableSitesRegexp.some((regexpPattern) => regexpPattern.test(url)) && !extensionGallerySitesRegexp.some((regexpPattern) => regexpPattern.test(url))
const isExpectedManifestV2InjectionTargetError = (error: unknown) => error instanceof Error && (error.message === otherExtensionInjectionTargetErrorMessage || error.message === extensionGalleryInjectionTargetErrorMessage)

function getManifestV3ExcludeMatchesForOrigin(origin: string) {
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

export function getManifestV3ExcludeMatches(origins: readonly string[]) {
	const patterns = new Set<string>()
	for (const origin of origins) {
		for (const pattern of getManifestV3ExcludeMatchesForOrigin(origin)) patterns.add(pattern)
	}
	return [...patterns]
}

export const updateContentScriptInjectionStrategyManifestV3 = async () => {
	const excludeMatches = getManifestV3ExcludeMatches(getInterceptorDisabledSites(await getSettings()))
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
		const missingContentScripts = contentScripts.filter(({ id }) => !registeredContentScriptIds.has(id))
		const existingContentScripts = contentScripts.filter(({ id }) => registeredContentScriptIds.has(id))
		if (missingContentScripts.length > 0) await browser.scripting.registerContentScripts(missingContentScripts)
		if (existingContentScripts.length > 0) await browser.scripting.updateContentScripts(existingContentScripts)
	} catch (error: unknown) {
		await reportUnexpectedError(error, { code: 'content_script_registration_failed' })
	}
}

const injectLogic = async (content: browser.webNavigation._OnCommittedDetails) => {
	if (!isInjectableSite(content.url)) return false
	const disabledSites = getInterceptorDisabledSites(await getSettings())
	// The tab can navigate while settings are loading, including to another extension page where injection is prohibited.
	const thisTab = await getTabIfExists(content.tabId)
	if (thisTab?.url === undefined || !isInjectableSite(thisTab.url)) return false
	const urls = [content.url, thisTab.url]
	const hostnames = urls.map((url) => getHostWithPort(url))
	const noMatches = disabledSites.every(excludeMatch => !hostnames.includes(excludeMatch))
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
