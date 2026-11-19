import type { ContentScriptRegistrationConfiguration } from '../utils/contentScriptInjectionConfiguration.js'
import { getContentScriptInjectionConfiguration } from './contentScriptInjectionConfigurationLoader.js'
import { reportUnexpectedError } from '../utils/errors.js'
import { getPageWorldScriptPaths, getManifestV2IsolatedWorldInjections } from '../utils/contentScriptInjectionArtifacts.js'
import { getManifestV2ExcludeGlobs, getManifestV2ExcludeMatches, getManifestV3ExcludeMatches } from '../utils/contentScriptExclusions.js'
import { Semaphore } from '../utils/semaphore.js'

const injectableSitesWildcard = ['file://*/*', 'http://*/*', 'https://*/*']

// This is the sole serialization boundary for reading desired settings, replacing registrations and retrying failed cleanup.
const registrationUpdates = new Semaphore(1)

// Explicit exclusion workflows await reconciliation before reload/success. Storage-only metadata and access edits never retry browser infrastructure work.
export async function reconcileContentScriptRegistration() {
	return await registrationUpdates.execute(async () => {
		const configuration = await getContentScriptInjectionConfiguration()
		return browser.runtime.getManifest().manifest_version === 3
			? await updateContentScriptInjectionStrategyManifestV3(configuration)
			: await updateContentScriptInjectionStrategyManifestV2(configuration)
	})
}

const updateContentScriptInjectionStrategyManifestV3 = async ({ injectionSites: { interceptorDisabledSites: disabledOrigins }, pageWorldProvider: { metamaskCompatibilityMode } }: ContentScriptRegistrationConfiguration) => {
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
		js: getPageWorldScriptPaths(metamaskCompatibilityMode).map((path) => `/${ path }`),
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
	const existingContentScripts = contentScripts.filter((desired) => {
		const registered = registeredContentScripts.find(({ id }) => id === desired.id)
		if (registered === undefined || replacements.has(desired.id)) return false
		return registered.allFrames !== desired.allFrames
			|| registered.runAt !== desired.runAt
			|| JSON.stringify(registered.matches ?? []) !== JSON.stringify(desired.matches)
			|| JSON.stringify(registered.excludeMatches ?? []) !== JSON.stringify(desired.excludeMatches)
			|| ('world' in registered ? registered.world : 'ISOLATED') !== (desired.world ?? 'ISOLATED')
			|| ('matchOriginAsFallback' in registered ? registered.matchOriginAsFallback : false) !== desired.matchOriginAsFallback
	})
	const obsoleteContentScriptIds = registeredContentScripts.map(({ id }) => id).filter((id) => !desiredContentScriptIds.has(id))
	try {
		// Chrome requires unregister/register when a bootstrap script file changes.
		if (replacements.size > 0) await browser.scripting.unregisterContentScripts({ ids: [...replacements] })
		if (missingContentScripts.length > 0) await browser.scripting.registerContentScripts(missingContentScripts)
		if (existingContentScripts.length > 0) await browser.scripting.updateContentScripts(existingContentScripts)
		if (obsoleteContentScriptIds.length > 0) await browser.scripting.unregisterContentScripts({ ids: obsoleteContentScriptIds })
	} catch (error) {
		// Restore the actual pre-update registrations, including browser-only fields, before propagating the failure to the configuration workflow.
		try {
			const current = await browser.scripting.getRegisteredContentScripts()
			if (JSON.stringify(current) !== JSON.stringify(registeredContentScripts)) {
				if (current.length > 0) await browser.scripting.unregisterContentScripts({ ids: current.map(({ id }) => id) })
				if (registeredContentScripts.length > 0) await browser.scripting.registerContentScripts(registeredContentScripts)
			}
		} catch (rollbackError) {
			await reportUnexpectedError(rollbackError, { code: 'content_script_registration_rollback_failed' })
		}
		throw error
	}
	return replacements.size > 0 || missingContentScripts.length > 0 || existingContentScripts.length > 0 || obsoleteContentScriptIds.length > 0
}

type ManifestV2RegistrationState = {
	active?: { readonly handle: browser.contentScripts.RegisteredContentScript, readonly configuration: Parameters<typeof browser.contentScripts.register>[0] }
	readonly pendingRemoval: Set<browser.contentScripts.RegisteredContentScript>
}
const manifestV2Registrations = new WeakMap<typeof browser.contentScripts, ManifestV2RegistrationState>()

async function removeSupersededManifestV2Registrations(state: ManifestV2RegistrationState) {
	for (const registration of state.pendingRemoval) {
		await registration.unregister()
		state.pendingRemoval.delete(registration)
	}
}

const updateContentScriptInjectionStrategyManifestV2 = async ({ injectionSites: { interceptorDisabledSites: disabledOrigins }, pageWorldProvider: { metamaskCompatibilityMode } }: ContentScriptRegistrationConfiguration) => {
	const state: ManifestV2RegistrationState = manifestV2Registrations.get(browser.contentScripts) ?? { pendingRemoval: new Set<browser.contentScripts.RegisteredContentScript>() }
	manifestV2Registrations.set(browser.contentScripts, state)
	const removedSuperseded = state.pendingRemoval.size > 0
	await removeSupersededManifestV2Registrations(state)
	const excludeMatches = getManifestV2ExcludeMatches(disabledOrigins)
	const excludeGlobs = getManifestV2ExcludeGlobs(disabledOrigins)
	const configuration = {
		matches: injectableSitesWildcard,
		// Firefox rejects empty exclusion lists.
		...(excludeMatches.length === 0 ? {} : { excludeMatches }),
		...(excludeGlobs.length === 0 ? {} : { excludeGlobs }),
		allFrames: true,
		runAt: 'document_start',
		js: getManifestV2IsolatedWorldInjections(metamaskCompatibilityMode).map(({ file }) => ({ file: `/${ file }` })),
	} satisfies Parameters<typeof browser.contentScripts.register>[0]
	if (state.active !== undefined && JSON.stringify(state.active.configuration) === JSON.stringify(configuration)) return removedSuperseded
	// A late onCommitted/executeScript injection lets page listeners run before the private bridge capture listener.
	const handle = await browser.contentScripts.register(configuration)
	const previous = state.active
	state.active = { handle, configuration }
	if (previous !== undefined) state.pendingRemoval.add(previous.handle)
	await removeSupersededManifestV2Registrations(state)
	return true
}
