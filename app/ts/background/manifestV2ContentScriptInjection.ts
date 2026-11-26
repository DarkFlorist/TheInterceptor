import { checkAndThrowRuntimeLastError, getHostWithPort, getTabIfExists, isMissingBrowserTargetError } from '../utils/requests.js'
import { reportLocalRecoveryBestEffort } from '../utils/errors.js'
import { INJECTABLE_SITES_WILDCARD } from '../config/injectedScripts.js'
import { getManifestV2IsolatedWorldInjections } from '../utils/contentScriptInjectionArtifacts.js'
import type { ContentScriptRegistrationConfiguration } from '../utils/contentScriptInjectionConfiguration.js'

const injectableSitesRegexp = [/^file:\/\/.*/, /^http:\/\/.*/, /^https:\/\/.*/]
const extensionGallerySitesRegexp = [/^https:\/\/chromewebstore\.google\.com(?:[\/?#]|$)/, /^https:\/\/chrome\.google\.com\/webstore(?:[\/?#]|$)/]
const otherExtensionInjectionTargetErrorMessage = 'Cannot access a chrome-extension:// URL of different extension'
const extensionGalleryInjectionTargetErrorMessage = 'The extensions gallery cannot be scripted.'
const isInjectableSite = (url: string) => injectableSitesRegexp.some((regexpPattern) => regexpPattern.test(url)) && !extensionGallerySitesRegexp.some((regexpPattern) => regexpPattern.test(url))
const isExpectedInjectionTargetError = (error: unknown) => error instanceof Error && (error.message === otherExtensionInjectionTargetErrorMessage || error.message === extensionGalleryInjectionTargetErrorMessage)

type GetContentScriptInjectionConfiguration = () => Promise<ContentScriptRegistrationConfiguration>

const createInjectLogic = (getContentScriptInjectionConfiguration: GetContentScriptInjectionConfiguration) => async (content: browser.webNavigation._OnCommittedDetails) => {
	if (!isInjectableSite(content.url)) return false
	const { injectionSites: { interceptorDisabledSites }, pageWorldProvider: { metamaskCompatibilityMode } } = await getContentScriptInjectionConfiguration()
	// The tab can navigate while settings are loading, including to another extension page where injection is prohibited.
	const thisTab = await getTabIfExists(content.tabId)
	if (thisTab?.url === undefined) return false
	// Any extension-owned page may embed a website. Inject its ordinary provider without interpreting feature launch parameters; access approval and feature admission still run in the background.
	const extensionPageChild = content.frameId > 0 && thisTab.url.startsWith(browser.runtime.getURL(''))
	if (!isInjectableSite(thisTab.url) && !extensionPageChild) return false
	const urls = extensionPageChild ? [content.url] : [content.url, thisTab.url]
	const hostnames = urls.map((url) => getHostWithPort(url))
	const noMatches = interceptorDisabledSites.every(excludeMatch => !hostnames.includes(excludeMatch))
	if (!noMatches) return false
	try {
		for (const injection of getManifestV2IsolatedWorldInjections(metamaskCompatibilityMode)) {
			await browser.tabs.executeScript(content.tabId, { file: `/${ injection.file }`, frameId: content.frameId, allFrames: false, runAt: 'document_start' })
		}
		checkAndThrowRuntimeLastError()
	} catch(error) {
		if (isMissingBrowserTargetError(error) || isExpectedInjectionTargetError(error)) return false
		reportLocalRecoveryBestEffort(error, { code: 'manifest_v2_content_script_injection_failed', message: 'Leaving this navigation without early injection.' })
	}
	return false
}

let registeredManifestV2InjectLogic: ReturnType<typeof createInjectLogic> | undefined

export const updateContentScriptInjectionStrategyManifestV2 = async (getContentScriptInjectionConfiguration: GetContentScriptInjectionConfiguration) => {
	if (registeredManifestV2InjectLogic !== undefined) browser.webNavigation.onCommitted.removeListener(registeredManifestV2InjectLogic)
	registeredManifestV2InjectLogic = createInjectLogic(getContentScriptInjectionConfiguration)
	browser.webNavigation.onCommitted.addListener(registeredManifestV2InjectLogic, { url: INJECTABLE_SITES_WILDCARD.map((urlMatches) => ({ urlMatches })) })
}
