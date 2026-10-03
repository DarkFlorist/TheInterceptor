import { checkAndThrowRuntimeLastError, getHostWithPort, getTabIfExists, isMissingBrowserTargetError } from './requests.js'
import { reportLocalRecoveryBestEffort, reportUnexpectedError } from './errors.js'
import { getManifestV2IsolatedWorldInjections, getPageWorldScriptPaths } from '../config/contentScriptInjectionArtifacts.js'
import type { ContentScriptInjectionConfiguration } from '../config/contentScriptInjectionConfiguration.js'

const injectableSitesWildcard = ['file://*/*', 'http://*/*', 'https://*/*']
const injectableSitesRegexp = [/^file:\/\/.*/, /^http:\/\/.*/, /^https:\/\/.*/]
const extensionGallerySitesRegexp = [/^https:\/\/chromewebstore\.google\.com(?:[\/?#]|$)/, /^https:\/\/chrome\.google\.com\/webstore(?:[\/?#]|$)/]
const otherExtensionInjectionTargetErrorMessage = 'Cannot access a chrome-extension:// URL of different extension'
const extensionGalleryInjectionTargetErrorMessage = 'The extensions gallery cannot be scripted.'
const isInjectableSite = (url: string) => injectableSitesRegexp.some((regexpPattern) => regexpPattern.test(url)) && !extensionGallerySitesRegexp.some((regexpPattern) => regexpPattern.test(url))
const isExpectedManifestV2InjectionTargetError = (error: unknown) => error instanceof Error && (error.message === otherExtensionInjectionTargetErrorMessage || error.message === extensionGalleryInjectionTargetErrorMessage)
const asRootRelativePaths = (paths: readonly string[]) => paths.map((scriptPath) => `/${ scriptPath }`)
const haveSameScriptFiles = (first: readonly string[] | undefined, second: readonly string[] | undefined) => {
	if (first === undefined || second === undefined) return first === second
	return first.length === second.length && first.every((scriptPath, index) => scriptPath === second[index])
}

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

export const updateContentScriptInjectionStrategyManifestV3 = async ({ metamaskCompatibilityMode, interceptorDisabledSites }: ContentScriptInjectionConfiguration) => {
	const excludeMatches = getManifestV3ExcludeMatches(interceptorDisabledSites)
	type RegisteredContentScript = Parameters<typeof browser.scripting.registerContentScripts>[0][0]
	let previousRegisteredContentScripts: RegisteredContentScript[] | undefined
	let registrationMutationStarted = false
	try {
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
			js: asRootRelativePaths(getPageWorldScriptPaths(metamaskCompatibilityMode)),
			runAt: 'document_start',
			world: 'MAIN',
			matchOriginAsFallback: true
		}]
		const registeredContentScripts = await browser.scripting.getRegisteredContentScripts()
		previousRegisteredContentScripts = registeredContentScripts
		const registeredContentScriptsById = new Map(registeredContentScripts.map((registration) => [registration.id, registration]))
		const desiredContentScriptIds = new Set(contentScripts.map(({ id }) => id))
		const replacementContentScripts = contentScripts.filter(({ id, js }) => {
			const registered = registeredContentScriptsById.get(id)
			return registered !== undefined && !haveSameScriptFiles(registered.js, js)
		})
		const replacementContentScriptIds = new Set(replacementContentScripts.map(({ id }) => id))
		const missingContentScripts = contentScripts.filter(({ id }) => !registeredContentScriptsById.has(id) || replacementContentScriptIds.has(id))
		const existingContentScripts = contentScripts.filter(({ id }) => registeredContentScriptsById.has(id) && !replacementContentScriptIds.has(id))
		const obsoleteContentScriptIds = registeredContentScripts.map(({ id }) => id).filter((id) => !desiredContentScriptIds.has(id))
		if (replacementContentScriptIds.size > 0) {
			registrationMutationStarted = true
			await browser.scripting.unregisterContentScripts({ ids: [...replacementContentScriptIds] })
		}
		if (missingContentScripts.length > 0) {
			registrationMutationStarted = true
			await browser.scripting.registerContentScripts(missingContentScripts)
		}
		if (existingContentScripts.length > 0) {
			registrationMutationStarted = true
			await browser.scripting.updateContentScripts(existingContentScripts)
		}
		if (obsoleteContentScriptIds.length > 0) {
			registrationMutationStarted = true
			await browser.scripting.unregisterContentScripts({ ids: obsoleteContentScriptIds })
		}
		return true
	} catch (error: unknown) {
		if (registrationMutationStarted && previousRegisteredContentScripts !== undefined) {
			try {
				const currentRegisteredContentScripts = await browser.scripting.getRegisteredContentScripts()
				const currentRegisteredContentScriptIds = currentRegisteredContentScripts.map(({ id }) => id)
				if (currentRegisteredContentScriptIds.length > 0) await browser.scripting.unregisterContentScripts({ ids: currentRegisteredContentScriptIds })
				if (previousRegisteredContentScripts.length > 0) await browser.scripting.registerContentScripts(previousRegisteredContentScripts)
			} catch (rollbackError) {
				await reportUnexpectedError(rollbackError, { code: 'content_script_registration_rollback_failed' })
			}
		}
		await reportUnexpectedError(error, { code: 'content_script_registration_failed' })
		throw error
	}
}

type GetContentScriptInjectionConfiguration = () => Promise<ContentScriptInjectionConfiguration>

const createInjectLogic = (getContentScriptInjectionConfiguration: GetContentScriptInjectionConfiguration) => async (content: browser.webNavigation._OnCommittedDetails) => {
	if (!isInjectableSite(content.url)) return false
	const { metamaskCompatibilityMode, interceptorDisabledSites } = await getContentScriptInjectionConfiguration()
	// The tab can navigate while settings are loading, including to another extension page where injection is prohibited.
	const thisTab = await getTabIfExists(content.tabId)
	if (thisTab?.url === undefined || !isInjectableSite(thisTab.url)) return false
	const urls = [content.url, thisTab.url]
	const hostnames = urls.map((url) => getHostWithPort(url))
	const noMatches = interceptorDisabledSites.every(excludeMatch => !hostnames.includes(excludeMatch))
	if (!noMatches) return false
	try {
		for (const injection of getManifestV2IsolatedWorldInjections(metamaskCompatibilityMode)) {
			const script = 'file' in injection ? { file: `/${ injection.file }` } : { code: injection.code }
			await browser.tabs.executeScript(content.tabId, { ...script, allFrames: false, runAt: 'document_start' })
		}
		checkAndThrowRuntimeLastError()
	} catch(error) {
		if (isMissingBrowserTargetError(error) || isExpectedManifestV2InjectionTargetError(error)) return false
		reportLocalRecoveryBestEffort(error, { code: 'manifest_v2_content_script_injection_failed', message: 'Leaving this navigation without early injection.' })
	}
	return false
}

let registeredManifestV2InjectLogic: ReturnType<typeof createInjectLogic> | undefined

export const updateContentScriptInjectionStrategyManifestV2 = async (getContentScriptInjectionConfiguration: GetContentScriptInjectionConfiguration) => {
	if (registeredManifestV2InjectLogic !== undefined) browser.webNavigation.onCommitted.removeListener(registeredManifestV2InjectLogic)
	registeredManifestV2InjectLogic = createInjectLogic(getContentScriptInjectionConfiguration)
	browser.webNavigation.onCommitted.addListener(registeredManifestV2InjectLogic, { url: injectableSitesWildcard.map((urlMatches) => ({ urlMatches })) })
}
