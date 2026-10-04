import { getWebsiteAccessFromStoredItems } from './settings.js'
import { contentScriptRegistrationSettingsKeys } from '../types/contentScriptSettings.js'
import { getChromeSiteMatchPatterns } from '../utils/chromeMatchPatterns.js'
import { reportUnexpectedError } from '../utils/errors.js'
import { INJECTABLE_SITES_WILDCARD, INPAGE_SCRIPTS, PROVIDER_SCRIPTS } from '../config/injectedScripts.js'
import { getInterceptorDisabledSites } from './websiteAccessPolicy.js'
import { createSafeAppsHostRegistration } from './safeAppsHostRegistration.js'
import type { FixedContentScript } from './contentScriptDefinition.js'

type ContentScriptConfiguration = {
	readonly cacheKey: string
	readonly excludeMatches: string[]
	readonly storedItems: unknown
}

// One storage snapshot owns both the cache identity and the desired registration patterns.
async function getContentScriptConfiguration(): Promise<ContentScriptConfiguration> {
	const storedItems = await browser.storage.local.get(contentScriptRegistrationSettingsKeys)
	const websiteAccess = await getWebsiteAccessFromStoredItems(storedItems)
	return {
		cacheKey: JSON.stringify(storedItems),
		excludeMatches: getChromeSiteMatchPatterns(getInterceptorDisabledSites(websiteAccess)),
		storedItems,
	}
}

function getBaseContentScripts(excludeMatches: string[]): [FixedContentScript, FixedContentScript] {
	return [{
		id: 'inpage2',
		allFrames: true,
		matches: INJECTABLE_SITES_WILDCARD,
		excludeMatches,
		js: ['/vendor/webextension-polyfill/dist/browser-polyfill.js', INPAGE_SCRIPTS.contentListener, INPAGE_SCRIPTS.contentListenerBootstrap],
		runAt: 'document_start',
		world: 'ISOLATED',
		matchOriginAsFallback: true,
	}, {
		id: 'inpage',
		allFrames: true,
		matches: INJECTABLE_SITES_WILDCARD,
		excludeMatches,
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

// A settings-driven update and a workflow waiting before reload share one application of the persisted configuration.
export function createContentScriptRegistrationService() {
	let previousUpdate: Promise<void> = Promise.resolve()
	let appliedSettingsKey: string | undefined
	let appliedBaseKey: string | undefined
	const hostRegistration = createSafeAppsHostRegistration()
	const queueUpdate = (failedAttemptToRetry?: number, forceReconcile = false) => {
		const nextUpdate = previousUpdate.then(async () => {
			// Read inside the queue so subsequent writes cannot leave the last requested update applying stale state.
			const configuration = await getContentScriptConfiguration()
			const settingsKey = configuration.cacheKey
			// Concurrent callers may retry the failure they observed once; a newer queued attempt owns subsequent retries.
			const retryObservedFailure = hostRegistration.shouldRetry(failedAttemptToRetry)
			if (settingsKey === appliedSettingsKey && !retryObservedFailure && !forceReconcile) return hostRegistration.outcome()
			try {
				const baseKey = JSON.stringify(configuration.excludeMatches)
				const baseContentScripts = getBaseContentScripts(configuration.excludeMatches)
				const hostPlan = hostRegistration.plan(configuration.storedItems, configuration.excludeMatches)
				const baseWasReconciled = forceReconcile || baseKey !== appliedBaseKey
				// Only website-access exclusions require a core provider update. Hosting is a separate overlay.
				if (baseWasReconciled) {
					await reconcileBaseContentScripts(baseContentScripts, hostPlan.hostScript)
					appliedBaseKey = baseKey
				}
				const outcome = hostRegistration.needsUpdate(hostPlan)
					? await hostRegistration.apply(hostPlan, baseContentScripts, baseWasReconciled)
					: hostRegistration.outcome()
				appliedSettingsKey = settingsKey
				return outcome
			} catch (error: unknown) {
				// A failed mutation can leave any script definition unknown, including a previously cached configuration.
				appliedSettingsKey = undefined
				appliedBaseKey = undefined
				hostRegistration.forget()
				throw error
			}
		})
		previousUpdate = nextUpdate.then(() => undefined, () => undefined)
		return nextUpdate
	}
	// Explicit callers receive the outcome and may retry a cached hosting failure; concurrent callers share one retry.
	const update = async () => {
		const failedAttemptToRetry = hostRegistration.observedFailure()
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
		if (!hostRegistration.hasOrigin(origin)) return false
		if (await hostRegistration.hasAppliedRegistrations()) return true
		// Chrome registrations can change without a settings event; repair the cached configuration before reload.
		if (await queueUpdate(undefined, true) !== 'configuration-applied') return false
		return hostRegistration.hasOrigin(origin) && await hostRegistration.hasAppliedRegistrations()
	}
	return { update, start, stop, ensureSafeAppsHostRegistered }
}

// One service per background runtime; the reload workflow awaits the same queue as the storage observer.
export const contentScriptRegistration = createContentScriptRegistrationService()
