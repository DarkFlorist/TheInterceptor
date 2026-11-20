import { contentScriptHostingSettingsKeys } from '../types/contentScriptSettings.js'
import { getChromeSiteMatchPatterns } from '../utils/chromeMatchPatterns.js'
import { reportUnexpectedError } from '../utils/errors.js'
import { INJECTABLE_SITES_WILDCARD, INPAGE_SCRIPTS } from '../config/injectedScripts.js'
import { asExtensionRootPaths, getPageWorldScriptPaths } from '../utils/contentScriptInjectionArtifacts.js'
import type { ContentScriptRegistrationConfiguration } from '../utils/contentScriptInjectionConfiguration.js'
import { getContentScriptInjectionConfiguration } from './contentScriptInjectionConfigurationLoader.js'
import { planSafeAppsHosting, type BaseContentScripts } from './safeAppsHostRegistration.js'
import { haveSameScriptFiles, sameContentScript, type FixedContentScript, type RegisteredContentScript } from './contentScriptDefinition.js'

type RegistrationOutcome = 'configuration-applied' | 'hosting-failed'

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

// Makes Chrome's registered scripts exactly the desired ones: registers missing scripts, updates changed ones and prunes the rest. A failed mutation restores the previous registrations before the error is rethrown.
async function reconcileRegisteredContentScripts(contentScripts: readonly FixedContentScript[]) {
	let previousRegisteredContentScripts: RegisteredContentScript[] | undefined
	let registrationMutationStarted = false
	try {
		const registeredContentScripts = await browser.scripting.getRegisteredContentScripts()
		previousRegisteredContentScripts = registeredContentScripts
		const registeredContentScriptsById = new Map(registeredContentScripts.map((registration) => [registration.id, registration]))
		const desiredContentScriptIds = new Set(contentScripts.map(({ id }) => id))
		// A script whose files change with MetaMask compatibility mode is registered anew instead of updated in place.
		const replacementContentScriptIds = new Set(contentScripts.filter((script) => {
			const registered = registeredContentScriptsById.get(script.id)
			return registered !== undefined && !haveSameScriptFiles(registered, script)
		}).map(({ id }) => id))
		const missingContentScripts = contentScripts.filter(({ id }) => !registeredContentScriptsById.has(id) || replacementContentScriptIds.has(id))
		const changedContentScripts = contentScripts.filter((script) => {
			const registered = registeredContentScriptsById.get(script.id)
			return registered !== undefined && !replacementContentScriptIds.has(script.id) && !sameContentScript(registered, script)
		})
		const obsoleteContentScriptIds = registeredContentScripts.map(({ id }) => id).filter((id) => !desiredContentScriptIds.has(id))
		if (replacementContentScriptIds.size > 0) {
			registrationMutationStarted = true
			await browser.scripting.unregisterContentScripts({ ids: [...replacementContentScriptIds] })
		}
		if (missingContentScripts.length > 0) {
			registrationMutationStarted = true
			await browser.scripting.registerContentScripts(missingContentScripts)
		}
		if (changedContentScripts.length > 0) {
			registrationMutationStarted = true
			await browser.scripting.updateContentScripts(changedContentScripts)
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

// Each application reads the stored settings and Chrome's registered scripts afresh, so no applied state is cached between updates. Hosting failures fall back to the base scripts, which keeps ordinary provider injection everywhere.
async function applyContentScriptRegistration(injection: ContentScriptRegistrationConfiguration): Promise<{ readonly outcome: RegistrationOutcome, readonly hostedOrigins: readonly string[] }> {
	const baseScripts = getBaseContentScripts(injection)
	const hosting = planSafeAppsHosting(await browser.storage.local.get(contentScriptHostingSettingsKeys), baseScripts)
	if (hosting === undefined) {
		await reconcileRegisteredContentScripts(baseScripts)
		return { outcome: 'configuration-applied', hostedOrigins: [] }
	}
	if ('error' in hosting) {
		await reconcileRegisteredContentScripts(baseScripts)
		await reportUnexpectedError(hosting.error, { code: 'safe_apps_host_registration_failed' })
		return { outcome: 'hosting-failed', hostedOrigins: [] }
	}
	try {
		await reconcileRegisteredContentScripts(hosting.scripts)
		return { outcome: 'configuration-applied', hostedOrigins: hosting.origins }
	} catch (error: unknown) {
		try {
			await reconcileRegisteredContentScripts(baseScripts)
		} catch (recoveryError: unknown) {
			throw new AggregateError([error, recoveryError], 'Safe Apps host registration and provider rollback failed.')
		}
		await reportUnexpectedError(error, { code: 'safe_apps_host_registration_failed' })
		return { outcome: 'hosting-failed', hostedOrigins: [] }
	}
}

// A settings-driven update, a configuration workflow and a Safe App preparation waiting before reload run one at a time, each applying the configuration it reads.
export function createContentScriptRegistrationService() {
	let previousUpdate: Promise<unknown> = Promise.resolve()
	const queueApplication = (injection: ContentScriptRegistrationConfiguration | undefined) => {
		const nextUpdate = previousUpdate.then(async () => await applyContentScriptRegistration(injection ?? await getContentScriptInjectionConfiguration()))
		previousUpdate = nextUpdate.catch(() => undefined)
		return nextUpdate
	}
	const update = async () => (await queueApplication(undefined)).outcome
	// Configuration workflows apply the configuration they compared rather than rereading it.
	const reconcile = async (injection: ContentScriptRegistrationConfiguration) => {
		await queueApplication(injection)
	}
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
	// Applying the configuration also repairs registrations that changed without a settings event, so a successful application that hosts the origin means it is registered.
	const ensureSafeAppsHostRegistered = async (origin: string) => {
		const { outcome, hostedOrigins } = await queueApplication(undefined)
		return outcome === 'configuration-applied' && hostedOrigins.includes(origin)
	}
	return { update, reconcile, start, stop, ensureSafeAppsHostRegistered }
}

// One service per background runtime; configuration workflows and Safe App preparation await the same queue as the storage observer.
export const contentScriptRegistration = createContentScriptRegistrationService()
