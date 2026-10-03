import { getSettings, getWebsiteAccessFromStoredItems } from './settings.js'
import { checkAndThrowRuntimeLastError, getHostWithPort, getTabIfExists, isMissingBrowserTargetError } from '../utils/requests.js'
import { ContentScriptHostingSettings, contentScriptRegistrationSettingsKeys } from '../types/contentScriptSettings.js'
import { getSafeAppsHostMatchPatterns } from '../utils/safeAppsHosting.js'
import { getChromeSiteMatchPatterns } from '../utils/chromeMatchPatterns.js'
import { reportLocalRecoveryBestEffort, reportUnexpectedError } from '../utils/errors.js'
import { INPAGE_SCRIPTS, PROVIDER_SCRIPTS, SAFE_APPS_HOST_SCRIPTS } from '../config/injectedScripts.js'
import { DEFAULT_SAFE_APPS_HOST_ORIGINS } from '../types/safeAppsHosting.js'
import { getInterceptorDisabledSites } from './websiteAccessPolicy.js'

const injectableSitesWildcard = ['file://*/*', 'http://*/*', 'https://*/*']
const injectableSitesRegexp = [/^file:\/\/.*/, /^http:\/\/.*/, /^https:\/\/.*/]
const extensionGallerySitesRegexp = [/^https:\/\/chromewebstore\.google\.com(?:[\/?#]|$)/, /^https:\/\/chrome\.google\.com\/webstore(?:[\/?#]|$)/]
const otherExtensionInjectionTargetErrorMessage = 'Cannot access a chrome-extension:// URL of different extension'
const extensionGalleryInjectionTargetErrorMessage = 'The extensions gallery cannot be scripted.'
const isInjectableSite = (url: string) => injectableSitesRegexp.some((regexpPattern) => regexpPattern.test(url)) && !extensionGallerySitesRegexp.some((regexpPattern) => regexpPattern.test(url))
const isExpectedManifestV2InjectionTargetError = (error: unknown) => error instanceof Error && (error.message === otherExtensionInjectionTargetErrorMessage || error.message === extensionGalleryInjectionTargetErrorMessage)

type ContentScriptRegistrationOutcome = 'configuration-applied' | 'hosting-failed'
type ContentScriptConfiguration = {
	readonly cacheKey: string
	readonly excludeMatches: string[]
	readonly hosting: { readonly matches: string[], readonly origins: readonly string[] } | { readonly error: Error }
}

// One storage snapshot owns both the cache identity and the desired registration patterns.
async function getContentScriptConfiguration(): Promise<ContentScriptConfiguration> {
	const storedItems = await browser.storage.local.get(contentScriptRegistrationSettingsKeys)
	const websiteAccess = await getWebsiteAccessFromStoredItems(storedItems)
	return {
		cacheKey: JSON.stringify(storedItems),
		excludeMatches: getChromeSiteMatchPatterns(getInterceptorDisabledSites(websiteAccess)),
		hosting: getHostingConfiguration(storedItems),
	}
}

function getHostingConfiguration(storedItems: unknown): ContentScriptConfiguration['hosting'] {
	const compatibility = ContentScriptHostingSettings.pick('safeAppsCompatibilityMode').safeParse(storedItems)
	if (!compatibility.success) return { error: new Error(compatibility.message) }
	// Unselected hosting data is inert while compatibility is disabled, just as in the ordinary settings getters.
	if (compatibility.value.safeAppsCompatibilityMode !== true) return { matches: [], origins: DEFAULT_SAFE_APPS_HOST_ORIGINS }
	const hosting = ContentScriptHostingSettings.safeParse(storedItems)
	if (!hosting.success) return { error: new Error(hosting.message) }
	const origins = hosting.value.safeAppsHostOrigins ?? DEFAULT_SAFE_APPS_HOST_ORIGINS
	return { matches: getSafeAppsHostMatchPatterns(origins), origins }
}

type RegisteredContentScript = Parameters<typeof browser.scripting.registerContentScripts>[0][0]
// The browser polyfill types do not expose Chrome's MAIN world or matchOriginAsFallback options.
type FixedContentScript = RegisteredContentScript & { world?: 'MAIN' | 'ISOLATED', matchOriginAsFallback: boolean }
const normalizeMatchPattern = (pattern: string) => pattern === 'file://*/*' ? 'file:///*' : pattern
const sameValues = (left: readonly string[] | undefined, right: readonly string[] | undefined) => (left ?? []).length === (right ?? []).length && (right ?? []).every((value) => left?.some((registered) => normalizeMatchPattern(registered) === normalizeMatchPattern(value)) === true)
function sameScript(registered: RegisteredContentScript, desired: FixedContentScript) {
	if (registered.id !== desired.id || !sameValues(registered.matches, desired.matches) || !sameValues(registered.excludeMatches, desired.excludeMatches)) return false
	// Chrome reports extension-relative file paths without the leading slash used at registration.
	if ((registered.js ?? []).length !== desired.js?.length || desired.js?.some((file, index) => registered.js?.[index]?.replace(/^\//, '') !== file.replace(/^\//, ''))) return false
	if (registered.runAt !== desired.runAt || registered.allFrames !== desired.allFrames) return false
	if ('matchOriginAsFallback' in registered && registered.matchOriginAsFallback !== desired.matchOriginAsFallback) return false
	const registeredWorld = 'world' in registered ? registered.world : 'ISOLATED'
	if (registeredWorld !== desired.world) return false
	return true
}

function getBaseContentScripts(excludeMatches: string[], hostMatches: string[] = []): [FixedContentScript, FixedContentScript] {
	return [{
		id: 'inpage2',
		allFrames: true,
		matches: injectableSitesWildcard,
		excludeMatches,
		js: ['/vendor/webextension-polyfill/dist/browser-polyfill.js', INPAGE_SCRIPTS.contentListener, INPAGE_SCRIPTS.contentListenerBootstrap],
		runAt: 'document_start',
		world: 'ISOLATED',
		matchOriginAsFallback: true,
	}, {
		id: 'inpage',
		allFrames: true,
		matches: injectableSitesWildcard,
		excludeMatches: [...excludeMatches, ...hostMatches],
		js: [...PROVIDER_SCRIPTS],
		runAt: 'document_start',
		world: 'MAIN',
		matchOriginAsFallback: true,
	}]
}

async function reconcileBaseContentScripts(contentScripts: FixedContentScript[], overlayScript?: FixedContentScript) {
	const registeredContentScripts = await browser.scripting.getRegisteredContentScripts()
	const registeredContentScriptIds = new Set(registeredContentScripts.map(({ id }) => id))
	const desiredContentScriptIds = new Set([...contentScripts, ...(overlayScript === undefined ? [] : [overlayScript])].map(({ id }) => id))
	const missingContentScripts = contentScripts.filter(({ id }) => !registeredContentScriptIds.has(id))
	const existingContentScripts = contentScripts.filter(({ id }) => registeredContentScriptIds.has(id))
	const obsoleteContentScriptIds = registeredContentScripts.map(({ id }) => id).filter((id) => !desiredContentScriptIds.has(id))
	if (missingContentScripts.length > 0) await browser.scripting.registerContentScripts(missingContentScripts)
	if (existingContentScripts.length > 0) await browser.scripting.updateContentScripts(existingContentScripts)
	if (obsoleteContentScriptIds.length > 0) await browser.scripting.unregisterContentScripts({ ids: obsoleteContentScriptIds })
}

async function removeSafeAppsHostScript() {
	const scripts = await browser.scripting.getRegisteredContentScripts()
	if (scripts.some(({ id }) => id === 'safe-apps-host')) await browser.scripting.unregisterContentScripts({ ids: ['safe-apps-host'] })
}

function getSafeAppsHostScript(configuration: ContentScriptConfiguration): FixedContentScript | undefined {
	if ('error' in configuration.hosting || configuration.hosting.matches.length === 0) return undefined
	return {
		id: 'safe-apps-host',
		allFrames: true,
		matches: configuration.hosting.matches,
		excludeMatches: configuration.excludeMatches,
		// Keep provider injection in embedded app frames, but the host itself only changes top-level pages.
		js: [...SAFE_APPS_HOST_SCRIPTS],
		runAt: 'document_start',
		world: 'MAIN',
		matchOriginAsFallback: true,
	}
}

async function reconcileSafeAppsHost(configuration: ContentScriptConfiguration, hostScript: FixedContentScript | undefined, baseInpageScript: FixedContentScript, baseWasReconciled: boolean) {
	if ('error' in configuration.hosting) throw configuration.hosting.error
	if (hostScript === undefined) {
		await removeSafeAppsHostScript()
		if (!baseWasReconciled) await browser.scripting.updateContentScripts([baseInpageScript])
		return
	}
	const scripts = await browser.scripting.getRegisteredContentScripts()
	if (scripts.some(({ id }) => id === hostScript.id)) await browser.scripting.updateContentScripts([hostScript])
	else await browser.scripting.registerContentScripts([hostScript])
	const hostedInpageScript = getBaseContentScripts(configuration.excludeMatches, configuration.hosting.matches)[1]
	await browser.scripting.updateContentScripts([hostedInpageScript])
}

const applySafeAppsHostOverlay = async (configuration: ContentScriptConfiguration, hostScript: FixedContentScript | undefined, baseInpageScript: FixedContentScript, baseWasReconciled: boolean): Promise<ContentScriptRegistrationOutcome> => {
	try {
		await reconcileSafeAppsHost(configuration, hostScript, baseInpageScript, baseWasReconciled)
		return 'configuration-applied'
	} catch (error: unknown) {
		// A partially installed host must not leave the ordinary provider excluded on that site.
		try {
			await removeSafeAppsHostScript()
			if (!baseWasReconciled || !('error' in configuration.hosting)) await browser.scripting.updateContentScripts([baseInpageScript])
		} catch (recoveryError: unknown) {
			throw new AggregateError([error, recoveryError], 'Safe Apps host registration and provider rollback failed.')
		}
		await reportUnexpectedError(error, { code: 'safe_apps_host_registration_failed' })
		return 'hosting-failed'
	}
}

// A settings-driven update and a workflow waiting before reload share one application of the persisted configuration.
export function createContentScriptRegistrationService() {
	let previousUpdate: Promise<void> = Promise.resolve()
	let appliedSettingsKey: string | undefined
	let appliedBaseKey: string | undefined
	let appliedOutcome: ContentScriptRegistrationOutcome = 'configuration-applied'
	let appliedHosting: Extract<ContentScriptConfiguration['hosting'], { readonly matches: string[] }> | undefined
	let appliedScripts: readonly FixedContentScript[] | undefined
	let appliedAttempt = 0
	const queueUpdate = (failedAttemptToRetry?: number, forceReconcile = false) => {
		const nextUpdate = previousUpdate.then(async () => {
			// Read inside the queue so subsequent writes cannot leave the last requested update applying stale state.
			const configuration = await getContentScriptConfiguration()
			const settingsKey = configuration.cacheKey
			// Concurrent callers may retry the failure they observed once; a newer queued attempt owns subsequent retries.
			const retryObservedFailure = appliedOutcome === 'hosting-failed' && failedAttemptToRetry === appliedAttempt
			if (settingsKey === appliedSettingsKey && !retryObservedFailure && !forceReconcile) return appliedOutcome
			try {
				const baseKey = JSON.stringify(configuration.excludeMatches)
				const baseContentScripts = getBaseContentScripts(configuration.excludeMatches)
				const hostScript = getSafeAppsHostScript(configuration)
				const baseWasReconciled = forceReconcile || baseKey !== appliedBaseKey
				// Only website-access exclusions require a core provider update. Hosting is a separate overlay.
				if (baseWasReconciled) {
					await reconcileBaseContentScripts(baseContentScripts, hostScript)
					appliedBaseKey = baseKey
				}
				const outcome = await applySafeAppsHostOverlay(configuration, hostScript, baseContentScripts[1], baseWasReconciled)
				appliedAttempt += 1
				appliedSettingsKey = settingsKey
				appliedOutcome = outcome
				appliedHosting = outcome === 'configuration-applied' && 'matches' in configuration.hosting ? configuration.hosting : undefined
				appliedScripts = outcome === 'configuration-applied' && 'matches' in configuration.hosting ? [...getBaseContentScripts(configuration.excludeMatches, configuration.hosting.matches), ...(hostScript === undefined ? [] : [hostScript])] : undefined
				return outcome
			} catch (error: unknown) {
				// A failed mutation can leave any script definition unknown, including a previously cached configuration.
				appliedSettingsKey = undefined
				appliedBaseKey = undefined
				appliedHosting = undefined
				appliedScripts = undefined
				throw error
			}
		})
		previousUpdate = nextUpdate.then(() => undefined, () => undefined)
		return nextUpdate
	}
	// Explicit callers receive the outcome and may retry a cached hosting failure; concurrent callers share one retry.
	const update = async (): Promise<ContentScriptRegistrationOutcome> => {
		const failedAttemptToRetry = appliedOutcome === 'hosting-failed' ? appliedAttempt : undefined
		return await queueUpdate(failedAttemptToRetry)
	}
	const updateAndReport = async () => {
		try {
			await update()
		} catch (error: unknown) {
			await reportUnexpectedError(error, { code: 'content_script_registration_failed' })
		}
	}
	const onStorageChanged = (changes: Record<string, browser.storage.StorageChange>, area: string) => {
		if (area !== 'local' || !contentScriptRegistrationSettingsKeys.some((key) => key in changes)) return
		void updateAndReport()
	}
	let started = false
	// Storage changes are the single MV3 settings trigger, including imports and website-access updates.
	const start = () => {
		if (started) return
		started = true
		browser.storage.onChanged.addListener(onStorageChanged)
		void updateAndReport()
	}
	// Detach observation without cancelling registrations already awaited by a reload workflow.
	const stop = () => {
		if (!started) return
		browser.storage.onChanged.removeListener(onStorageChanged)
		started = false
	}
	const ensureSafeAppsHostRegistered = async (origin: string) => {
		if (await update() !== 'configuration-applied') return false
		const hosting = appliedHosting
		if (hosting === undefined || !hosting.origins.includes(origin)) return false
		const hasAppliedRegistrations = async () => {
			if (appliedScripts === undefined) return false
			const scripts = await browser.scripting.getRegisteredContentScripts()
			return appliedScripts.every((desired) => scripts.some((script) => sameScript(script, desired)))
		}
		if (await hasAppliedRegistrations()) return true
		// Chrome registrations can change without a settings event; repair the cached configuration before reload.
		if (await queueUpdate(undefined, true) !== 'configuration-applied') return false
		return appliedHosting?.origins.includes(origin) === true && await hasAppliedRegistrations()
	}
	return { update, start, stop, ensureSafeAppsHostRegistered }
}

// One service per background runtime; the reload workflow awaits the same queue as the storage observer.
export const contentScriptRegistration = createContentScriptRegistrationService()

const injectLogic = async (content: browser.webNavigation._OnCommittedDetails) => {
	if (!isInjectableSite(content.url)) return false
	const disabledSites = getInterceptorDisabledSites((await getSettings()).websiteAccess)
	// The tab can navigate while settings are loading, including to another extension page where injection is prohibited.
	const thisTab = await getTabIfExists(content.tabId)
	if (thisTab?.url === undefined || !isInjectableSite(thisTab.url)) return false
	const urls = [content.url, thisTab.url]
	const hostnames = urls.map((url) => getHostWithPort(url))
	const noMatches = disabledSites.every(excludeMatch => !hostnames.includes(excludeMatch))
	if (!noMatches) return false
	try {
		await browser.tabs.executeScript(content.tabId, { file: '/vendor/webextension-polyfill/dist/browser-polyfill.js', allFrames: false, runAt: 'document_start' })
		await browser.tabs.executeScript(content.tabId, { file: INPAGE_SCRIPTS.contentListener, allFrames: false, runAt: 'document_start' })
		await browser.tabs.executeScript(content.tabId, { file: INPAGE_SCRIPTS.documentStart, allFrames: false, runAt: 'document_start' })
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
