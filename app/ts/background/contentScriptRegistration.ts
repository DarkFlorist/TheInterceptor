import { getChromeSiteMatchPatterns } from '../utils/chromeMatchPatterns.js'
import { reportUnexpectedError } from '../utils/errors.js'
import { INJECTABLE_SITES_WILDCARD, INPAGE_SCRIPTS } from '../config/injectedScripts.js'
import { asExtensionRootPaths, getPageWorldScriptPaths } from '../utils/contentScriptInjectionArtifacts.js'
import type { ContentScriptRegistrationConfiguration } from '../utils/contentScriptInjectionConfiguration.js'
import { getContentScriptInjectionConfiguration } from './contentScriptInjectionConfigurationLoader.js'
import { haveSameScriptFiles, sameContentScript, type FixedContentScript, type RegisteredContentScript } from './contentScriptDefinition.js'

type RegistrationOutcome = 'configuration-applied'
type BaseContentScripts = readonly [FixedContentScript, FixedContentScript]

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

// Native Gnosis Safe Apps run in an extension page. Website injection always installs only the ordinary provider.
async function applyContentScriptRegistration(injection: ContentScriptRegistrationConfiguration): Promise<RegistrationOutcome> {
	if (browser.runtime.getManifest().manifest_version === 3) await reconcileRegisteredContentScripts(getBaseContentScripts(injection))
	return 'configuration-applied'
}

// Settings-driven updates and configuration workflows run one at a time, each applying the configuration it reads.
export function createContentScriptRegistrationService() {
	let previousUpdate: Promise<unknown> = Promise.resolve()
	const queueApplication = (injection: ContentScriptRegistrationConfiguration | undefined) => {
		const nextUpdate = previousUpdate.then(async () => await applyContentScriptRegistration(injection ?? await getContentScriptInjectionConfiguration()))
		previousUpdate = nextUpdate.catch(() => undefined)
		return nextUpdate
	}
	const update = async () => await queueApplication(undefined)
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
		if (area !== 'local' || !('websiteAccess' in changes)) return
		void updateAndReport()
	}
	let started = false
	// Website access controls disabled-site injection. Configuration workflows also await reconcile() before reloading; the shared queue preserves their order.
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
	return { update, reconcile, start, stop }
}

// One service per background runtime; settings workflows await the same queue as the storage observer.
export const contentScriptRegistration = createContentScriptRegistrationService()
