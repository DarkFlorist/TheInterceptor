import { getHostWithPort } from './requests.js'
import { reportUnexpectedError } from './errors.js'
import { getPageWorldScriptPaths, isolatedWorldScriptPaths } from './contentScriptInjectionArtifacts.js'
import type { ContentScriptRegistrationConfiguration } from './contentScriptInjectionConfiguration.js'
import { contentScriptDocumentMarkers, type ContentScriptDocumentMarkers, type ContentScriptWorld } from './contentScriptDocumentMarkers.js'

const injectableSitesWildcard = ['file://*/*', 'http://*/*', 'https://*/*']
const asRootRelativePaths = (paths: readonly string[]) => paths.map((scriptPath) => `/${ scriptPath }`)
const haveSameScriptFiles = (first: readonly string[] | undefined, second: readonly string[] | undefined) => {
	if (first === undefined || second === undefined) return first === second
	return first.length === second.length && first.every((scriptPath, index) => scriptPath === second[index])
}

// In Chrome a match pattern without a port matches every port of its host, while one with a port compares it with the URL's effective port, so naming the default port too keeps the pattern to that one origin. Chrome rejects a port after the * scheme, so each pattern names its scheme.
function getExactOriginMatchPattern(url: URL) {
	const defaultPort = url.protocol === 'https:' ? '443' : '80'
	return `${ url.protocol }//${ url.hostname }:${ url.port === '' ? defaultPort : url.port }/*`
}

// Website access, including a disabled Interceptor, is stored per getHostWithPort origin and compared as an exact string. A disabled site is excluded on exactly the URLs with that origin: excluding its subdomains or other ports too would leave pages that the popup and the access policy treat as enabled without the Interceptor provider (#1701).
function getContentScriptExcludeMatchesForOrigin(origin: string) {
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

export function getContentScriptExcludeMatches(origins: readonly string[]) {
	const patterns = new Set<string>()
	for (const origin of origins) {
		for (const pattern of getContentScriptExcludeMatchesForOrigin(origin)) patterns.add(pattern)
	}
	return [...patterns]
}


// Firefox matches a pattern's host and ignores the URL's port, so a pattern that names a port matches no URL at all (Firefox bugs 1362809 and 1468162). Firefox therefore excludes each disabled origin's whole host from the registered content scripts, and registers the same scripts again for each such host, behind a first script that leaves out exactly the host's disabled origins.
export function getFirefoxContentScriptExclusions(exactOriginExcludeMatches: readonly string[]) {
	const excludeMatches = new Set<string>()
	const disabledHosts = new Map<string, { readonly matches: Set<string>, readonly disabledOrigins: Set<string> }>()
	for (const pattern of exactOriginExcludeMatches) {
		const url = new URL(pattern.slice(0, -1))
		if (url.protocol === 'file:') {
			excludeMatches.add(pattern)
			continue
		}
		const hostPattern = `${ url.protocol }//${ url.hostname }/*`
		excludeMatches.add(hostPattern)
		const disabledHost = disabledHosts.get(url.hostname) ?? { matches: new Set<string>(), disabledOrigins: new Set<string>() }
		disabledHost.matches.add(hostPattern)
		// A URL's origin leaves out its scheme's default port, as window.origin does.
		disabledHost.disabledOrigins.add(url.origin)
		disabledHosts.set(url.hostname, disabledHost)
	}
	return {
		excludeMatches: [...excludeMatches],
		disabledHosts: [...disabledHosts.values()].map(({ matches, disabledOrigins }) => ({ matches: [...matches], disabledOrigins: [...disabledOrigins] })),
	}
}

// Each content script runs once per document, guarded by its world's markers in contentScriptDocumentMarkers.ts. Both compatibility-mode providers are built from inpage.ts, so they use the same markers.
type ContentScriptDefinition = { readonly id: string, readonly js: string[], readonly world: ContentScriptWorld }
const getContentScriptDefinitions = (metamaskCompatibilityMode: boolean): readonly ContentScriptDefinition[] => [
	{ id: 'inpage2', js: asRootRelativePaths(isolatedWorldScriptPaths), world: 'ISOLATED' },
	{ id: 'inpage', js: asRootRelativePaths(getPageWorldScriptPaths(metamaskCompatibilityMode)), world: 'MAIN' },
]
// The browser polyfill types do not expose the MAIN world or matchOriginAsFallback options, which Chrome and Firefox 128 accept.
const sharedContentScriptOptions: { readonly allFrames: true, readonly runAt: 'document_start', readonly matchOriginAsFallback: true } = { allFrames: true, runAt: 'document_start', matchOriginAsFallback: true }

// Firefox matches URL globs against the URL with its credentials, and a glob's * also matches /, so no glob names exactly one origin. This first script of a disabled-host registration compares the document's origin instead. On a disabled origin it sets the world's disabledOriginKey, which the guarded script of the same registration consumes to skip; Firefox runs one registration's scripts back to back, so no other registration's script runs in between. It never claims the document, so a registration that should provide on this origin, such as the general one after the site is enabled again, still does. An opaque origin ("null") counts as disabled, because it cannot be told apart.
export function getDisabledOriginCheckCode(disabledOrigins: readonly string[], { global, disabledOriginKey }: ContentScriptDocumentMarkers) {
	return `if (window.origin === 'null' || ${ JSON.stringify(disabledOrigins) }.includes(window.origin)) Reflect.defineProperty(${ global }, Symbol.for(${ JSON.stringify(disabledOriginKey) }), { value: true, configurable: true })`
}

// Registers, updates, replaces and removes the scripting registrations to match the definitions. A failure after the first change restores the previous registrations and is rethrown for the caller to report.
async function updateRegisteredContentScripts(contentScriptDefinitions: readonly ContentScriptDefinition[], excludeMatches: string[]) {
	type RegisteredContentScript = Parameters<typeof browser.scripting.registerContentScripts>[0][0]
	type FixedContentScript = RegisteredContentScript & { world: 'MAIN' | 'ISOLATED', matchOriginAsFallback: boolean }
	const contentScripts: FixedContentScript[] = contentScriptDefinitions.map(({ id, js, world }) => ({ id, js, world, matches: injectableSitesWildcard, excludeMatches, ...sharedContentScriptOptions }))
	let previousRegisteredContentScripts: RegisteredContentScript[] | undefined
	let registrationMutationStarted = false
	try {
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

type DisabledHost = ReturnType<typeof getFirefoxContentScriptExclusions>['disabledHosts'][number]
type FirefoxContentScriptRegistration = browser.contentScripts.RegisteredContentScript
const getDisabledHostRegistrationKey = (disabledHost: DisabledHost, contentScriptDefinitions: readonly ContentScriptDefinition[]) => JSON.stringify({ ...disabledHost, scriptFiles: contentScriptDefinitions.map(({ js }) => js) })

export type FirefoxContentScriptRegistrations = ReturnType<typeof createFirefoxContentScriptRegistrations>

// Owns Firefox's registrations for disabled hosts. Firefox's own contentScripts API takes code and returns a handle that keeps the registration only while the background page that made it is loaded, which for the persistent MV2 background is the whole session, so the background creates one owner at startup and passes it to every update.
export function createFirefoxContentScriptRegistrations() {
	// Keyed by each host's patterns, disabled origins and script files, so an unchanged host keeps its registration and a compatibility mode change registers the host again with the other provider. A key is tracked only while all of its host's scripts are registered.
	const disabledHostContentScripts = new Map<string, readonly FirefoxContentScriptRegistration[]>()
	// Registrations that belong to no tracked host any more but could not be unregistered yet. Every handle that leaves a tracked host or a half-made host passes through removeContentScripts, which keeps it here until its removal succeeds, so no live registration is ever forgotten. Removing one never leaves a page without the provider, because the registrations that should match a page are all tracked hosts or the scripting registrations.
	const contentScriptsPendingRemoval: FirefoxContentScriptRegistration[] = []

	// Unregisters each registration, keeps the ones that fail pending removal for the next update, and reports each failure with the given code, because the error the caller rethrows does not carry it.
	const removeContentScripts = async (registrations: readonly FirefoxContentScriptRegistration[], failureCode: string) => {
		for (const registration of registrations) {
			try {
				await registration.unregister()
			} catch (unregisterError: unknown) {
				// Known limit: a registration the browser refuses to unregister keeps injecting with its old disabled-origin list, so it can still provide on an origin disabled since, until a later update's retry removes it; Firefox cannot change a registered script, and a MAIN-world document_start script cannot read extension state synchronously to revoke itself, so each failure is reported and the removal is retried on every update.
				contentScriptsPendingRemoval.push(registration)
				await reportUnexpectedError(unregisterError, { code: failureCode })
			}
		}
	}

	const registerDisabledHost = async (disabledHost: DisabledHost, contentScriptDefinitions: readonly ContentScriptDefinition[]) => {
		type FixedContentScriptOptions = browser.contentScripts.RegisteredContentScriptOptions & { world: ContentScriptWorld, matchOriginAsFallback: boolean }
		const registeredContentScripts: FirefoxContentScriptRegistration[] = []
		try {
			for (const { js, world } of contentScriptDefinitions) {
				const contentScript: FixedContentScriptOptions = { js: [{ code: getDisabledOriginCheckCode(disabledHost.disabledOrigins, contentScriptDocumentMarkers[world]) }, ...js.map((file) => ({ file }))], world, matches: disabledHost.matches, ...sharedContentScriptOptions }
				registeredContentScripts.push(await browser.contentScripts.register(contentScript))
			}
		} catch (registrationError: unknown) {
			// A host is tracked only with all of its scripts, so the scripts of a host that failed half way are removed, and the next update registers the host again. The registration error is rethrown unchanged; a failed removal is reported on its own.
			await removeContentScripts(registeredContentScripts, 'content_script_registration_cleanup_failed')
			throw registrationError
		}
		disabledHostContentScripts.set(getDisabledHostRegistrationKey(disabledHost, contentScriptDefinitions), registeredContentScripts)
	}

	// The key stops being tracked before its scripts are removed, so a host whose removal fails half way is never taken for a complete registration; the scripts that are left wait for the next update in contentScriptsPendingRemoval.
	const unregisterDisabledHost = async (key: string, failureCode: string) => {
		const registeredContentScripts = disabledHostContentScripts.get(key) ?? []
		disabledHostContentScripts.delete(key)
		await removeContentScripts(registeredContentScripts, failureCode)
	}

	// A disabled host's own registration is added before the scripting registrations stop matching that host, and removed only after they match it again, so the host's other origins always have a registration that provides; two that provide at once are harmless, because each script runs once per document. A stale registration never suppresses another one, because its origin check only skips its own scripts. If the scripting update fails and rolls back, the host registrations added in this update are removed again and the earlier ones are kept, which restores the previous configuration.
	const update = async (contentScriptDefinitions: readonly ContentScriptDefinition[], exactOriginExcludeMatches: readonly string[]) => {
		await removeContentScripts(contentScriptsPendingRemoval.splice(0), 'content_script_registration_cleanup_failed')
		const { excludeMatches, disabledHosts } = getFirefoxContentScriptExclusions(exactOriginExcludeMatches)
		const desiredDisabledHostKeys = new Set(disabledHosts.map((disabledHost) => getDisabledHostRegistrationKey(disabledHost, contentScriptDefinitions)))
		const addedDisabledHostKeys: string[] = []
		const registrationErrors: unknown[] = []
		for (const disabledHost of disabledHosts) {
			const key = getDisabledHostRegistrationKey(disabledHost, contentScriptDefinitions)
			if (disabledHostContentScripts.has(key)) continue
			try {
				await registerDisabledHost(disabledHost, contentScriptDefinitions)
				addedDisabledHostKeys.push(key)
			} catch (error: unknown) {
				// A host whose own registration failed is still excluded below, because giving its disabled origin the provider would ignore the user's setting; its other origins go without the provider until the next update registers it again.
				registrationErrors.push(error)
			}
		}
		try {
			await updateRegisteredContentScripts(contentScriptDefinitions, excludeMatches)
		} catch (error: unknown) {
			for (const key of addedDisabledHostKeys) await unregisterDisabledHost(key, 'content_script_registration_rollback_failed')
			// The caller reports the scripting failure with the code of its own context, so it is only rethrown here.
			throw error
		}
		for (const key of [...disabledHostContentScripts.keys()]) {
			if (!desiredDisabledHostKeys.has(key)) await unregisterDisabledHost(key, 'content_script_registration_cleanup_failed')
		}
		if (registrationErrors.length > 0) throw registrationErrors[0]
	}

	return { update }
}

// Chrome (MV3) and Firefox (MV2) both register the content scripts, so the active compatibility mode's provider runs in the page's MAIN world at document_start, before the page's own scripts and regardless of the page's CSP. Callers serialize updates, because each one reads and replaces the previous registrations, pass the background's one Firefox registration owner, and report the rethrown failure.
export async function updateContentScriptInjectionStrategy({ injectionSites: { interceptorDisabledSites }, pageWorldProvider: { metamaskCompatibilityMode } }: ContentScriptRegistrationConfiguration, firefoxContentScriptRegistrations: FirefoxContentScriptRegistrations) {
	const contentScriptDefinitions = getContentScriptDefinitions(metamaskCompatibilityMode)
	const exactOriginExcludeMatches = getContentScriptExcludeMatches(interceptorDisabledSites)
	if (browser.runtime.getManifest().manifest_version === 3) {
		await updateRegisteredContentScripts(contentScriptDefinitions, exactOriginExcludeMatches)
		return
	}
	await firefoxContentScriptRegistrations.update(contentScriptDefinitions, exactOriginExcludeMatches)
}
