import { getInterceptorDisabledSites, getSettings } from '../background/settings.js'
import { checkAndThrowRuntimeLastError, getHostnameFromOriginLike, getMatchingWebsiteAccessOrigin, isSchemefulWebsiteOrigin, parseUrlOrUndefined } from './requests.js'

const injectableSitesWildcard = ['file://*/*', 'http://*/*', 'https://*/*']
const injectableSitesRegexp = [/^file:\/\/.*/, /^http:\/\/.*/, /^https:\/\/.*/]

const getHttpOriginMatchParts = (originLike: string): { scheme: 'http' | 'https', hostname: string } | undefined => {
	if (!isSchemefulWebsiteOrigin(originLike)) return undefined
	const url = parseUrlOrUndefined(originLike)
	if (url?.protocol === 'http:') return { scheme: 'http', hostname: url.hostname }
	if (url?.protocol === 'https:') return { scheme: 'https', hostname: url.hostname }
	return undefined
}

export const getInterceptorDisabledSiteExcludeMatches = (originLike: string): readonly string[] => {
	if (originLike === 'file://') return ['file://*/*']
	const httpOriginParts = getHttpOriginMatchParts(originLike)
	if (httpOriginParts !== undefined) return [`${ httpOriginParts.scheme }://${ httpOriginParts.hostname }/*`]
	const host = getHostnameFromOriginLike(originLike)
	if (host.length === 0) return []
	return [`*://${ host }/*`, `*://*.${ host }/*`]
}

export const isUrlExcludedByInterceptorDisabledSite = (disabledSites: readonly string[], urlString: string): boolean => {
	const url = parseUrlOrUndefined(urlString)
	if (url === undefined) return false
	const websiteOrigin = url.protocol === 'file:' ? 'file://' : url.origin === 'null' ? (url.port ? `${ url.hostname }:${ url.port }` : url.hostname) : url.origin
	return getMatchingWebsiteAccessOrigin(disabledSites, websiteOrigin) !== undefined
}

export const updateContentScriptInjectionStrategyManifestV3 = async () => {
	const excludeMatches = getInterceptorDisabledSites(await getSettings()).flatMap((origin) => getInterceptorDisabledSiteExcludeMatches(origin))
	try {
		type RegisteredContentScript = Parameters<typeof browser.scripting.registerContentScripts>[0][0]
		// 'MAIN'` is not supported in `browser.` but its in `chrome.`. This code is only going to be run in manifest v3 environment (chrome) so this should be fine, just ugly
		type FixedRegisterContentScripts = (scripts: (RegisteredContentScript & { world?: 'MAIN' | 'ISOLATED', matchOriginAsFallback: boolean })[]) => Promise<void>
		const fixedRegisterContentScripts = ((browser.scripting.registerContentScripts as unknown) as FixedRegisterContentScripts)
		await browser.scripting.unregisterContentScripts()
		await fixedRegisterContentScripts([{
			id: 'inpage2',
			allFrames: true,
			matches: injectableSitesWildcard,
			excludeMatches,
			js: ['/vendor/webextension-polyfill/dist/browser-polyfill.js', '/inpage/js/listenContentScript.js'],
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
		}])
	} catch (err) {
		console.warn(err)
	}
}

const injectLogic = async (content: browser.webNavigation._OnCommittedDetails) => {
	if (!injectableSitesRegexp.some(regexpPattern => regexpPattern.test(content.url))) return false
	const allTabs = await browser.tabs.query({})
	const thisTab = allTabs.find((tab) => tab.id === content.tabId)
	const urls = [content.url, ...thisTab?.url === undefined ? [] : [thisTab.url]]
	const disabledSites = getInterceptorDisabledSites(await getSettings())
	const noMatches = urls.every((url) => !isUrlExcludedByInterceptorDisabledSite(disabledSites, url))
	if (!noMatches) return false
	try {
		await browser.tabs.executeScript(content.tabId, { file: '/vendor/webextension-polyfill/dist/browser-polyfill.js', allFrames: false, runAt: 'document_start' })
		await browser.tabs.executeScript(content.tabId, { file: '/inpage/js/document_start.js', allFrames: false, runAt: 'document_start' })
		checkAndThrowRuntimeLastError()
	} catch(error) {
		if (error instanceof Error && error.message.startsWith('No tab with id')) return false
		console.error(error)
	}
	return false
}

export const updateContentScriptInjectionStrategyManifestV2 = async () => {
	browser.webNavigation.onCommitted.removeListener(injectLogic)
	browser.webNavigation.onCommitted.addListener(injectLogic, { url: injectableSitesWildcard.map((urlMatches) => ({ urlMatches })) })
}
