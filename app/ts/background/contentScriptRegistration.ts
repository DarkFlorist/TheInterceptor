import { contentScriptRegistrationSettingsKeys, getEnabledSafeAppsHostOrigins, getInterceptorDisabledSites, getSettings } from './settings.js'
import { checkAndThrowRuntimeLastError, getHostWithPort, getTabIfExists, isMissingBrowserTargetError } from '../utils/requests.js'
import { getChromeMatchPatterns } from '../utils/chromeMatchPatterns.js'
import { getSafeAppsHostMatchPatterns } from '../utils/safeAppsHosting.js'
import { reportLocalRecoveryBestEffort, reportUnexpectedError } from '../utils/errors.js'

const injectableSitesWildcard = ['file://*/*', 'http://*/*', 'https://*/*']
const injectableSitesRegexp = [/^file:\/\/.*/, /^http:\/\/.*/, /^https:\/\/.*/]
const extensionGallerySitesRegexp = [/^https:\/\/chromewebstore\.google\.com(?:[\/?#]|$)/, /^https:\/\/chrome\.google\.com\/webstore(?:[\/?#]|$)/]
const otherExtensionInjectionTargetErrorMessage = 'Cannot access a chrome-extension:// URL of different extension'
const extensionGalleryInjectionTargetErrorMessage = 'The extensions gallery cannot be scripted.'
const isInjectableSite = (url: string) => injectableSitesRegexp.some((regexpPattern) => regexpPattern.test(url)) && !extensionGallerySitesRegexp.some((regexpPattern) => regexpPattern.test(url))
const isExpectedManifestV2InjectionTargetError = (error: unknown) => error instanceof Error && (error.message === otherExtensionInjectionTargetErrorMessage || error.message === extensionGalleryInjectionTargetErrorMessage)

export function getManifestV3ExcludeMatches(origins: readonly string[]) {
	const patterns = new Set<string>()
	for (const origin of origins) {
		for (const pattern of getChromeMatchPatterns(origin, 'site-with-subdomains')) patterns.add(pattern)
	}
	return [...patterns]
}

type ContentScriptRegistrationOutcome = 'applied' | 'base-provider-recovered'

type RegisteredContentScript = Parameters<typeof browser.scripting.registerContentScripts>[0][0]
// The browser polyfill types do not expose Chrome's MAIN world or matchOriginAsFallback options.
type FixedContentScript = RegisteredContentScript & { world?: 'MAIN' | 'ISOLATED', matchOriginAsFallback: boolean }

function getBaseContentScripts(excludeMatches: string[], hostMatches: string[] = []): FixedContentScript[] {
	return [{
		id: 'inpage2',
		allFrames: true,
		matches: injectableSitesWildcard,
		excludeMatches,
		js: ['/vendor/webextension-polyfill/dist/browser-polyfill.js', '/inpage/js/listenContentScript.js', '/inpage/js/listenContentScriptBootstrap.js'],
		runAt: 'document_start',
		matchOriginAsFallback: true,
	}, {
		id: 'inpage',
		allFrames: true,
		matches: injectableSitesWildcard,
		excludeMatches: [...excludeMatches, ...hostMatches],
		js: ['/inpage/js/inpage.js'],
		runAt: 'document_start',
		world: 'MAIN',
		matchOriginAsFallback: true,
	}]
}

async function reconcileContentScripts(contentScripts: FixedContentScript[]) {
	const registeredContentScripts = await browser.scripting.getRegisteredContentScripts()
	const registeredContentScriptIds = new Set(registeredContentScripts.map(({ id }) => id))
	const desiredContentScriptIds = new Set(contentScripts.map(({ id }) => id))
	const missingContentScripts = contentScripts.filter(({ id }) => !registeredContentScriptIds.has(id))
	const existingContentScripts = contentScripts.filter(({ id }) => registeredContentScriptIds.has(id))
	const obsoleteContentScriptIds = registeredContentScripts.map(({ id }) => id).filter((id) => !desiredContentScriptIds.has(id))
	if (missingContentScripts.length > 0) await browser.scripting.registerContentScripts(missingContentScripts)
	if (existingContentScripts.length > 0) await browser.scripting.updateContentScripts(existingContentScripts)
	if (obsoleteContentScriptIds.length > 0) await browser.scripting.unregisterContentScripts({ ids: obsoleteContentScriptIds })
}

const applyContentScriptInjectionStrategyManifestV3 = async (): Promise<ContentScriptRegistrationOutcome> => {
	const excludeMatches = getManifestV3ExcludeMatches(getInterceptorDisabledSites(await getSettings()))
	const baseContentScripts = getBaseContentScripts(excludeMatches)
	try {
		const safeAppsHostMatches = getSafeAppsHostMatchPatterns(await getEnabledSafeAppsHostOrigins())
		const contentScripts = getBaseContentScripts(excludeMatches, safeAppsHostMatches)
		if (safeAppsHostMatches.length > 0) contentScripts.push({
			id: 'safe-apps-host',
			allFrames: true,
			matches: safeAppsHostMatches,
			excludeMatches,
			// Keep provider injection in embedded app frames, but the host itself only changes top-level pages.
			js: ['/inpage/js/safeAppsHostBootstrap.js', '/inpage/js/inpage.js'],
			runAt: 'document_start',
			world: 'MAIN',
			matchOriginAsFallback: true,
		})
		await reconcileContentScripts(contentScripts)
		return 'applied'
	} catch (error: unknown) {
		// Restore ordinary injection and remove stale hosts/exclusions even after a partially applied update.
		try {
			await reconcileContentScripts(baseContentScripts)
		} catch (recoveryError: unknown) {
			throw new AggregateError([error, recoveryError], 'Content script registration and base-provider recovery failed.')
		}
		// Hosting failed, but base injection is ready. Report durably without aborting enable/disable and its required tab reload.
		await reportUnexpectedError(error, { code: 'content_script_registration_failed' })
		return 'base-provider-recovered'
	}
}

// A settings-driven update and a workflow waiting before reload share one application of the persisted configuration.
export function createContentScriptRegistrationService() {
	let previousUpdate: Promise<void> = Promise.resolve()
	let appliedSettingsKey: string | undefined
	let appliedOutcome: ContentScriptRegistrationOutcome = 'applied'
	let appliedAttempt = 0
	const queueUpdate = (retryRecoveredAttempt?: number) => {
		const nextUpdate = previousUpdate.then(async () => {
			// Read inside the queue so subsequent writes cannot leave the last requested update applying stale state.
			const settingsKey = JSON.stringify(await browser.storage.local.get([...contentScriptRegistrationSettingsKeys]))
			// An explicit retry can reapply the failure it observed, but must not repeat a newer queued attempt.
			const retryObservedFailure = appliedOutcome === 'base-provider-recovered' && retryRecoveredAttempt === appliedAttempt
			if (settingsKey === appliedSettingsKey && !retryObservedFailure) return appliedOutcome
			const outcome = await applyContentScriptInjectionStrategyManifestV3()
			appliedAttempt += 1
			appliedSettingsKey = settingsKey
			appliedOutcome = outcome
			return outcome
		})
		previousUpdate = nextUpdate.then(() => undefined, () => undefined)
		return nextUpdate
	}
	const update = () => queueUpdate()
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
		const retryRecoveredAttempt = appliedOutcome === 'base-provider-recovered' ? appliedAttempt : undefined
		if (await queueUpdate(retryRecoveredAttempt) !== 'applied') return false
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
