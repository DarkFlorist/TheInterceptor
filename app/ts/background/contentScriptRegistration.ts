import { contentScriptRegistrationSettingsKeys, getContentScriptConfiguration, getInterceptorDisabledSites, getSettings } from './settings.js'
import { checkAndThrowRuntimeLastError, getHostWithPort, getTabIfExists, isMissingBrowserTargetError } from '../utils/requests.js'
import type { ContentScriptConfiguration } from '../types/contentScriptSettings.js'
import { getSafeAppsHostMatchPatterns } from '../utils/safeAppsHosting.js'
import { reportLocalRecoveryBestEffort, reportUnexpectedError } from '../utils/errors.js'
import { INPAGE_SCRIPTS, SAFE_APPS_HOST_SCRIPTS } from '../config/injectedScripts.js'

const injectableSitesWildcard = ['file://*/*', 'http://*/*', 'https://*/*']
const injectableSitesRegexp = [/^file:\/\/.*/, /^http:\/\/.*/, /^https:\/\/.*/]
const extensionGallerySitesRegexp = [/^https:\/\/chromewebstore\.google\.com(?:[\/?#]|$)/, /^https:\/\/chrome\.google\.com\/webstore(?:[\/?#]|$)/]
const otherExtensionInjectionTargetErrorMessage = 'Cannot access a chrome-extension:// URL of different extension'
const extensionGalleryInjectionTargetErrorMessage = 'The extensions gallery cannot be scripted.'
const isInjectableSite = (url: string) => injectableSitesRegexp.some((regexpPattern) => regexpPattern.test(url)) && !extensionGallerySitesRegexp.some((regexpPattern) => regexpPattern.test(url))
const isExpectedManifestV2InjectionTargetError = (error: unknown) => error instanceof Error && (error.message === otherExtensionInjectionTargetErrorMessage || error.message === extensionGalleryInjectionTargetErrorMessage)

type ContentScriptRegistrationOutcome = 'configuration-applied' | 'hosting-failed'

type RegisteredContentScript = Parameters<typeof browser.scripting.registerContentScripts>[0][0]
// The browser polyfill types do not expose Chrome's MAIN world or matchOriginAsFallback options.
type FixedContentScript = RegisteredContentScript & { world?: 'MAIN' | 'ISOLATED', matchOriginAsFallback: boolean }

function getBaseContentScripts(excludeMatches: string[], hostMatches: string[] = []): [FixedContentScript, FixedContentScript] {
	return [{
		id: 'inpage2',
		allFrames: true,
		matches: injectableSitesWildcard,
		excludeMatches,
		js: ['/vendor/webextension-polyfill/dist/browser-polyfill.js', INPAGE_SCRIPTS.contentListener, INPAGE_SCRIPTS.contentListenerBootstrap],
		runAt: 'document_start',
		matchOriginAsFallback: true,
	}, {
		id: 'inpage',
		allFrames: true,
		matches: injectableSitesWildcard,
		excludeMatches: [...excludeMatches, ...hostMatches],
		js: [INPAGE_SCRIPTS.provider],
		runAt: 'document_start',
		world: 'MAIN',
		matchOriginAsFallback: true,
	}]
}

async function reconcileBaseContentScripts(contentScripts: FixedContentScript[]) {
	const registeredContentScripts = await browser.scripting.getRegisteredContentScripts()
	const registeredContentScriptIds = new Set(registeredContentScripts.map(({ id }) => id))
	const desiredContentScriptIds = new Set(contentScripts.map(({ id }) => id))
	const missingContentScripts = contentScripts.filter(({ id }) => !registeredContentScriptIds.has(id))
	const existingContentScripts = contentScripts.filter(({ id }) => registeredContentScriptIds.has(id))
	const obsoleteContentScriptIds = registeredContentScripts.map(({ id }) => id).filter((id) => id !== 'safe-apps-host' && !desiredContentScriptIds.has(id))
	if (missingContentScripts.length > 0) await browser.scripting.registerContentScripts(missingContentScripts)
	if (existingContentScripts.length > 0) await browser.scripting.updateContentScripts(existingContentScripts)
	if (obsoleteContentScriptIds.length > 0) await browser.scripting.unregisterContentScripts({ ids: obsoleteContentScriptIds })
}

async function removeSafeAppsHostScript() {
	const scripts = await browser.scripting.getRegisteredContentScripts()
	if (scripts.some(({ id }) => id === 'safe-apps-host')) await browser.scripting.unregisterContentScripts({ ids: ['safe-apps-host'] })
}

async function reconcileSafeAppsHost(configuration: ContentScriptConfiguration, baseInpageScript: FixedContentScript, baseWasReconciled: boolean) {
	if ('error' in configuration.hosting) throw configuration.hosting.error
	const safeAppsHostMatches = configuration.hosting.matches
	if (safeAppsHostMatches.length === 0) {
		await removeSafeAppsHostScript()
		if (!baseWasReconciled) await browser.scripting.updateContentScripts([baseInpageScript])
		return
	}
	const hostScript: FixedContentScript = {
		id: 'safe-apps-host',
		allFrames: true,
		matches: safeAppsHostMatches,
		excludeMatches: configuration.excludeMatches,
		// Keep provider injection in embedded app frames, but the host itself only changes top-level pages.
		js: [...SAFE_APPS_HOST_SCRIPTS],
		runAt: 'document_start',
		world: 'MAIN',
		matchOriginAsFallback: true,
	}
	const scripts = await browser.scripting.getRegisteredContentScripts()
	if (scripts.some(({ id }) => id === hostScript.id)) await browser.scripting.updateContentScripts([hostScript])
	else await browser.scripting.registerContentScripts([hostScript])
	const hostedInpageScript = getBaseContentScripts(configuration.excludeMatches, safeAppsHostMatches)[1]
	await browser.scripting.updateContentScripts([hostedInpageScript])
}

const applySafeAppsHostOverlay = async (configuration: ContentScriptConfiguration, baseInpageScript: FixedContentScript, baseWasReconciled: boolean): Promise<ContentScriptRegistrationOutcome> => {
	try {
		await reconcileSafeAppsHost(configuration, baseInpageScript, baseWasReconciled)
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
	let appliedAttempt = 0
	const queueUpdate = (failedAttemptToRetry?: number) => {
		const nextUpdate = previousUpdate.then(async () => {
			// Read inside the queue so subsequent writes cannot leave the last requested update applying stale state.
			const configuration = await getContentScriptConfiguration()
			const settingsKey = configuration.cacheKey
			// Concurrent callers may retry the failure they observed once; a newer queued attempt owns subsequent retries.
			const retryObservedFailure = appliedOutcome === 'hosting-failed' && failedAttemptToRetry === appliedAttempt
			if (settingsKey === appliedSettingsKey && !retryObservedFailure) return appliedOutcome
			try {
				const baseKey = JSON.stringify(configuration.excludeMatches)
				const baseContentScripts = getBaseContentScripts(configuration.excludeMatches)
				const baseWasReconciled = baseKey !== appliedBaseKey
				// Only website-access exclusions require a core provider update. Hosting is a separate overlay.
				if (baseWasReconciled) {
					await reconcileBaseContentScripts(baseContentScripts)
					appliedBaseKey = baseKey
				}
				const outcome = await applySafeAppsHostOverlay(configuration, baseContentScripts[1], baseWasReconciled)
				appliedAttempt += 1
				appliedSettingsKey = settingsKey
				appliedOutcome = outcome
				return outcome
			} catch (error: unknown) {
				// A failed mutation can leave any script definition unknown, including a previously cached configuration.
				appliedSettingsKey = undefined
				appliedBaseKey = undefined
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
		const matches = getSafeAppsHostMatchPatterns([origin])
		const scripts = await browser.scripting.getRegisteredContentScripts()
		return scripts.some((script) => script.id === 'safe-apps-host' && matches.every((pattern) => script.matches?.includes(pattern) === true))
	}
	return { update, start, stop, ensureSafeAppsHostRegistered }
}

// One service per background runtime; the reload workflow awaits the same queue as the storage observer.
export const contentScriptRegistration = createContentScriptRegistrationService()

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
