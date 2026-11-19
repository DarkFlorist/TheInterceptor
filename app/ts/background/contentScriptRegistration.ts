import { contentScriptHostingSettingsKeys } from '../types/contentScriptSettings.js'
import { getChromeSiteMatchPatterns } from '../utils/chromeMatchPatterns.js'
import { reportUnexpectedError } from '../utils/errors.js'
import { INJECTABLE_SITES_WILDCARD, INPAGE_SCRIPTS } from '../config/injectedScripts.js'
import { asExtensionRootPaths, getPageWorldScriptPaths } from '../utils/contentScriptInjectionArtifacts.js'
import type { ContentScriptRegistrationConfiguration } from '../utils/contentScriptInjectionConfiguration.js'
import { getContentScriptInjectionConfiguration } from './contentScriptInjectionConfigurationLoader.js'
import { createSafeAppsHostRegistration } from './safeAppsHostRegistration.js'
import { haveSameScriptFiles, type FixedContentScript, type RegisteredContentScript } from './contentScriptDefinition.js'

type BaseContentScripts = [FixedContentScript, FixedContentScript]

type ContentScriptConfiguration = {
	readonly cacheKey: string
	readonly baseScripts: BaseContentScripts
	readonly hostingSettings: unknown
}

function getBaseContentScripts({ injectionSites, pageWorldProvider }: ContentScriptRegistrationConfiguration): BaseContentScripts {
	const excludeMatches = getChromeSiteMatchPatterns(injectionSites.interceptorDisabledSites)
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
		js: asExtensionRootPaths(getPageWorldScriptPaths(pageWorldProvider.metamaskCompatibilityMode)),
		runAt: 'document_start',
		world: 'MAIN',
		matchOriginAsFallback: true,
	}]
}

// One configuration snapshot owns both the cache identity and the desired registrations; the hosting settings are read in a single storage read.
async function getContentScriptConfiguration(injection: ContentScriptRegistrationConfiguration): Promise<ContentScriptConfiguration> {
	const hostingSettings = await browser.storage.local.get(contentScriptHostingSettingsKeys)
	return {
		cacheKey: JSON.stringify({ injection, hostingSettings }),
		baseScripts: getBaseContentScripts(injection),
		hostingSettings,
	}
}

async function restoreRegisteredContentScripts(previousRegisteredContentScripts: readonly RegisteredContentScript[]) {
	try {
		const currentRegisteredContentScriptIds = (await browser.scripting.getRegisteredContentScripts()).map(({ id }) => id)
		if (currentRegisteredContentScriptIds.length > 0) await browser.scripting.unregisterContentScripts({ ids: currentRegisteredContentScriptIds })
		if (previousRegisteredContentScripts.length > 0) await browser.scripting.registerContentScripts([...previousRegisteredContentScripts])
	} catch (rollbackError: unknown) {
		// A failed rollback is a second failure that the rethrown registration error does not carry, so only it is reported here.
		await reportUnexpectedError(rollbackError, { code: 'content_script_registration_rollback_failed' })
	}
}

// Registers missing scripts, updates existing ones and prunes obsolete ones, keeping the planned host overlay; a failed mutation restores the previous registrations before the error is rethrown.
async function reconcileBaseContentScripts(contentScripts: readonly FixedContentScript[], overlayScript: FixedContentScript | undefined) {
	let previousRegisteredContentScripts: RegisteredContentScript[] | undefined
	let registrationMutationStarted = false
	try {
		const registeredContentScripts = await browser.scripting.getRegisteredContentScripts()
		previousRegisteredContentScripts = registeredContentScripts
		const registeredContentScriptsById = new Map(registeredContentScripts.map((registration) => [registration.id, registration]))
		const desiredContentScriptIds = new Set([...contentScripts, ...(overlayScript === undefined ? [] : [overlayScript])].map(({ id }) => id))
		// A script whose files change with MetaMask compatibility mode is registered anew instead of updated in place.
		const replacementContentScriptIds = new Set(contentScripts.filter((script) => {
			const registered = registeredContentScriptsById.get(script.id)
			return registered !== undefined && !haveSameScriptFiles(registered, script)
		}).map(({ id }) => id))
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
	} catch (error: unknown) {
		if (registrationMutationStarted && previousRegisteredContentScripts !== undefined) await restoreRegisteredContentScripts(previousRegisteredContentScripts)
		// The caller reports the registration failure with the code of its own context, so it is only rethrown here.
		throw error
	}
}

// A settings-driven update, a configuration workflow and a Safe App preparation waiting before reload share one application of the configuration.
export function createContentScriptRegistrationService() {
	let previousUpdate: Promise<void> = Promise.resolve()
	let appliedSettingsKey: string | undefined
	let appliedBaseKey: string | undefined
	const hostRegistration = createSafeAppsHostRegistration()
	const queueUpdate = ({ failedAttemptToRetry, forceReconcile, injection }: { readonly failedAttemptToRetry: number | undefined, readonly forceReconcile: boolean, readonly injection: ContentScriptRegistrationConfiguration | undefined }) => {
		const nextUpdate = previousUpdate.then(async () => {
			// Read inside the queue so subsequent writes cannot leave the last requested update applying stale state.
			const configuration = await getContentScriptConfiguration(injection ?? await getContentScriptInjectionConfiguration())
			const settingsKey = configuration.cacheKey
			const baseKey = JSON.stringify(configuration.baseScripts)
			// Only website-access exclusions and the compatibility-mode provider require a base provider update. Hosting is a separate overlay.
			const baseNeedsReconcile = forceReconcile || baseKey !== appliedBaseKey
			try {
				const outcome = await hostRegistration.reconcile({
					storedItems: configuration.hostingSettings,
					baseScripts: configuration.baseScripts,
					reconcileBase: baseNeedsReconcile ? async (hostScript) => await reconcileBaseContentScripts(configuration.baseScripts, hostScript) : undefined,
					configurationUnchanged: settingsKey === appliedSettingsKey,
					failedAttemptToRetry,
				})
				appliedBaseKey = baseKey
				appliedSettingsKey = settingsKey
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
	const update = async () => await queueUpdate({ failedAttemptToRetry: hostRegistration.observedFailure(), forceReconcile: false, injection: undefined })
	// Configuration workflows apply the configuration they compared and always rewrite the base registrations.
	const reconcile = async (injection: ContentScriptRegistrationConfiguration) => await queueUpdate({ failedAttemptToRetry: hostRegistration.observedFailure(), forceReconcile: true, injection })
	const updateAndReport = async () => {
		try {
			await update()
		} catch (error: unknown) {
			await reportUnexpectedError(error, { code: 'content_script_registration_failed' })
		}
	}
	const onStorageChanged = (changes: Record<string, browser.storage.StorageChange>, area: string) => {
		if (area !== 'local' || !contentScriptHostingSettingsKeys.some((key) => key in changes)) return
		void updateAndReport()
	}
	let started = false
	// The storage listener applies Safe Apps hosting changes from any writer and reports its own failures. Website access, MetaMask compatibility mode and settings imports change the base registrations through the contentScriptInjectionStrategy.ts workflows, which await reconcile() and own their caller's result.
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
		if (await queueUpdate({ failedAttemptToRetry: undefined, forceReconcile: true, injection: undefined }) !== 'configuration-applied') return false
		return hostRegistration.hasOrigin(origin) && await hostRegistration.hasAppliedRegistrations()
	}
	return { update, reconcile, start, stop, ensureSafeAppsHostRegistered }
}

// One service per background runtime; configuration workflows and Safe App preparation await the same queue as the storage observer.
export const contentScriptRegistration = createContentScriptRegistrationService()
