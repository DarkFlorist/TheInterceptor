import { checkAndThrowRuntimeLastError, getHostWithPort, getTabIfExists, isMissingBrowserTargetError } from './requests.js'
import { reportLocalRecoveryBestEffort, reportUnexpectedError } from './errors.js'
import { getManifestV2IsolatedWorldInjections, getPageWorldScriptPaths } from './contentScriptInjectionArtifacts.js'
import type { ContentScriptRegistrationConfiguration } from './contentScriptInjectionConfiguration.js'

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

// A match pattern without a port matches every port of its host, while one with a port compares it with the URL's effective port, so naming the default port too keeps the pattern to that one origin. Chrome rejects a port after the * scheme, so each pattern names its scheme.
function getExactOriginMatchPattern(url: URL) {
	const defaultPort = url.protocol === 'https:' ? '443' : '80'
	return `${ url.protocol }//${ url.hostname }:${ url.port === '' ? defaultPort : url.port }/*`
}

// Website access, including a disabled Interceptor, is stored per getHostWithPort origin and compared as an exact string, as the MV2 injection also does. A disabled site is excluded on exactly the URLs with that origin: excluding its subdomains or other ports too would leave pages that the popup and the access policy treat as enabled without the Interceptor provider (#1701).
function getManifestV3ExcludeMatchesForOrigin(origin: string) {
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

export function getManifestV3ExcludeMatches(origins: readonly string[]) {
	const patterns = new Set<string>()
	for (const origin of origins) {
		for (const pattern of getManifestV3ExcludeMatchesForOrigin(origin)) patterns.add(pattern)
	}
	return [...patterns]
}

export const updateContentScriptInjectionStrategyManifestV3 = async ({ injectionSites: { interceptorDisabledSites }, pageWorldProvider: { metamaskCompatibilityMode } }: ContentScriptRegistrationConfiguration) => {
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
				// A failed rollback is a second failure that the rethrown registration error does not carry, so only it is reported here.
				await reportUnexpectedError(rollbackError, { code: 'content_script_registration_rollback_failed' })
			}
		}
		// The caller reports the registration failure with the code of its own context, so it is only rethrown here.
		throw error
	}
}

type GetContentScriptInjectionConfiguration = () => Promise<ContentScriptRegistrationConfiguration>

const createInjectLogic = (getContentScriptInjectionConfiguration: GetContentScriptInjectionConfiguration) => async (content: browser.webNavigation._OnCommittedDetails) => {
	if (!isInjectableSite(content.url)) return false
	const { injectionSites: { interceptorDisabledSites }, pageWorldProvider: { metamaskCompatibilityMode } } = await getContentScriptInjectionConfiguration()
	// The tab can navigate while settings are loading, including to another extension page where injection is prohibited.
	const thisTab = await getTabIfExists(content.tabId)
	if (thisTab?.url === undefined || !isInjectableSite(thisTab.url)) return false
	const urls = [content.url, thisTab.url]
	const hostnames = urls.map((url) => getHostWithPort(url))
	const noMatches = interceptorDisabledSites.every(excludeMatch => !hostnames.includes(excludeMatch))
	if (!noMatches) return false
	try {
		for (const injection of getManifestV2IsolatedWorldInjections(metamaskCompatibilityMode)) {
			await browser.tabs.executeScript(content.tabId, { file: `/${ injection.file }`, allFrames: false, runAt: 'document_start' })
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
