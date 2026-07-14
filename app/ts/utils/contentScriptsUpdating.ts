import { getInterceptorDisabledSites, getSettings } from '../background/settings.js'
import { checkAndThrowRuntimeLastError, getHostWithPort, getTabIfExists, isMissingBrowserTargetError } from './requests.js'
import { reportLocalRecoveryBestEffort, reportUnexpectedError } from './errors.js'

const injectableSitesWildcard = ['file://*/*', 'http://*/*', 'https://*/*']
const injectableSitesRegexp = [/^file:\/\/.*/, /^http:\/\/.*/, /^https:\/\/.*/]
const otherExtensionInjectionTargetErrorMessage = 'Cannot access a chrome-extension:// URL of different extension'
const isInjectableSite = (url: string) => injectableSitesRegexp.some((regexpPattern) => regexpPattern.test(url))
const isOtherExtensionInjectionTargetError = (error: unknown) => error instanceof Error && error.message === otherExtensionInjectionTargetErrorMessage

export const updateContentScriptInjectionStrategyManifestV3 = async () => {
	const excludeMatches = getInterceptorDisabledSites(await getSettings()).map((origin) => `*://*.${ origin }/*`)
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
		}])
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
		if (isMissingBrowserTargetError(error) || isOtherExtensionInjectionTargetError(error)) return false
		reportLocalRecoveryBestEffort(error, { code: 'manifest_v2_content_script_injection_failed', message: 'Leaving this navigation without early injection.' })
	}
	return false
}

export const updateContentScriptInjectionStrategyManifestV2 = async () => {
	browser.webNavigation.onCommitted.removeListener(injectLogic)
	browser.webNavigation.onCommitted.addListener(injectLogic, { url: injectableSitesWildcard.map((urlMatches) => ({ urlMatches })) })
}
