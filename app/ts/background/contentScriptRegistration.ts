import { getMetamaskCompatibilityMode } from './settings.js'
import { getPageWorldScriptPaths, getManifestV2IsolatedWorldInjections } from '../utils/contentScriptInjectionArtifacts.js'
import { getWebsiteAccess } from './settings.js'
import { getInterceptorDisabledSites, getManifestV2ExcludeGlobs, getManifestV2ExcludeMatches, getManifestV3ExcludeMatches } from '../utils/contentScriptExclusions.js'
import { Semaphore } from '../utils/semaphore.js'

const injectableSitesWildcard = ['file://*/*', 'http://*/*', 'https://*/*']

// This is the sole serialization boundary for reading desired settings, replacing registrations and retrying failed cleanup.
const registrationUpdates = new Semaphore(1)
let registrationNeedsRetry = false

// Explicit exclusion workflows await reconciliation before reload/success. Storage-only metadata and access edits never retry browser infrastructure work.
export async function reconcileContentScriptRegistration({ exclusionsChanged = true } = {}) {
	return await registrationUpdates.execute(async () => {
		if (!exclusionsChanged && !registrationNeedsRetry) return false
		// Failed reconciliation stays pending here; storage-only updates never invoke this coordinator.
		registrationNeedsRetry = true
		const disabledOrigins = getInterceptorDisabledSites(await getWebsiteAccess())
		// Always read the persisted desired state; repeating a failed toggle/import/removal is sufficient to retry.
		if (browser.runtime.getManifest().manifest_version === 3) await updateContentScriptInjectionStrategyManifestV3(disabledOrigins)
		else await updateContentScriptInjectionStrategyManifestV2(disabledOrigins)
		registrationNeedsRetry = false
		return true
	})
}

const updateContentScriptInjectionStrategyManifestV3 = async (disabledOrigins: readonly string[]) => {
	const excludeMatches = getManifestV3ExcludeMatches(disabledOrigins)
	type RegisteredContentScript = Parameters<typeof browser.scripting.registerContentScripts>[0][0]
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
		js: getPageWorldScriptPaths(await getMetamaskCompatibilityMode()).map((path) => `/${ path }`),
		runAt: 'document_start',
		world: 'MAIN',
		matchOriginAsFallback: true
	}]
	const registeredContentScripts = await browser.scripting.getRegisteredContentScripts()
	const registeredContentScriptIds = new Set(registeredContentScripts.map(({ id }) => id))
	const replacements = new Set(contentScripts.filter((desired) => {
		const registered = registeredContentScripts.find(({ id }) => id === desired.id)
		return registered !== undefined && (registered.js?.length !== desired.js?.length || registered.js?.some((file, index) => file !== desired.js?.[index]))
	}).map(({ id }) => id))
	const desiredContentScriptIds = new Set(contentScripts.map(({ id }) => id))
	const missingContentScripts = contentScripts.filter(({ id }) => !registeredContentScriptIds.has(id) || replacements.has(id))
	const existingContentScripts = contentScripts.filter(({ id }) => registeredContentScriptIds.has(id) && !replacements.has(id))
	const obsoleteContentScriptIds = registeredContentScripts.map(({ id }) => id).filter((id) => !desiredContentScriptIds.has(id))
	// Chrome requires unregister/register when a bootstrap script file changes.
	if (replacements.size > 0) await browser.scripting.unregisterContentScripts({ ids: [...replacements] })
	if (missingContentScripts.length > 0) await browser.scripting.registerContentScripts(missingContentScripts)
	if (existingContentScripts.length > 0) await browser.scripting.updateContentScripts(existingContentScripts)
	if (obsoleteContentScriptIds.length > 0) await browser.scripting.unregisterContentScripts({ ids: obsoleteContentScriptIds })
}

let registeredManifestV2Scripts: browser.contentScripts.RegisteredContentScript | undefined
const manifestV2RegistrationsPendingRemoval = new Set<browser.contentScripts.RegisteredContentScript>()

async function removeSupersededManifestV2Registrations() {
	for (const registration of manifestV2RegistrationsPendingRemoval) {
		await registration.unregister()
		manifestV2RegistrationsPendingRemoval.delete(registration)
	}
}

const updateContentScriptInjectionStrategyManifestV2 = async (disabledOrigins: readonly string[]) => {
	// Keep failed removals reachable and finish cleanup before creating another registration.
	await removeSupersededManifestV2Registrations()
	const excludeMatches = getManifestV2ExcludeMatches(disabledOrigins)
	const excludeGlobs = getManifestV2ExcludeGlobs(disabledOrigins)
	// A late onCommitted/executeScript injection lets page listeners run before the private bridge capture listener.
	const registered = await browser.contentScripts.register({
		matches: injectableSitesWildcard,
		// Firefox rejects empty exclusion lists.
		...(excludeMatches.length === 0 ? {} : { excludeMatches }),
		...(excludeGlobs.length === 0 ? {} : { excludeGlobs }),
		allFrames: true,
		runAt: 'document_start',
		js: getManifestV2IsolatedWorldInjections(await getMetamaskCompatibilityMode()).map(({ file }) => ({ file: `/${ file }` })),
	})
	const previous = registeredManifestV2Scripts
	registeredManifestV2Scripts = registered
	if (previous !== undefined) manifestV2RegistrationsPendingRemoval.add(previous)
	await removeSupersededManifestV2Registrations()
}
