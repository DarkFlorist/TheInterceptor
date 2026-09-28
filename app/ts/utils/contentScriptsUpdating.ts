import { getWebsiteOrigin } from './websiteOrigin.js'
import { Semaphore } from './semaphore.js'

const injectableSitesWildcard = ['file://*/*', 'http://*/*', 'https://*/*']

export async function updateContentScriptInjectionStrategy(disabledOrigins: readonly string[]) {
	if (browser.runtime.getManifest().manifest_version === 3) return await updateContentScriptInjectionStrategyManifestV3(disabledOrigins)
	return await updateContentScriptInjectionStrategyManifestV2(disabledOrigins)
}

function getCanonicalWebsiteOrigins(origins: readonly string[]) {
	return [...new Set(origins)].filter((origin) => getWebsiteOrigin(origin) === origin)
}

export function getManifestV3ExcludeMatches(origins: readonly string[]) {
	return getCanonicalWebsiteOrigins(origins).map((origin) => {
		const url = new URL(origin)
		if (url.protocol === 'file:') return url.href
		// An omitted match-pattern port means every port, whereas URL.origin omits only the default port.
		const port = url.port || (url.protocol === 'https:' ? '443' : '80')
		return `${ url.protocol }//${ url.hostname }:${ port }/*`
	})
}

export function getManifestV2ExcludeGlobs(origins: readonly string[]) {
	// Firefox's match patterns do not match explicit ports. Globs compare the URL text, preserving the origin's port boundary.
	return getCanonicalWebsiteOrigins(origins).map((origin) => origin.startsWith('file:') ? origin : `${ origin }/*`)
}

export const updateContentScriptInjectionStrategyManifestV3 = async (disabledOrigins: readonly string[]) => {
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
		js: ['/inpage/js/inpage.js'],
		runAt: 'document_start',
		world: 'MAIN',
		matchOriginAsFallback: true
	}]
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

let registeredManifestV2Scripts: browser.contentScripts.RegisteredContentScript | undefined
const manifestV2Registration = new Semaphore(1)
const manifestV2RegistrationsPendingRemoval = new Set<browser.contentScripts.RegisteredContentScript>()

async function removeSupersededManifestV2Registrations() {
	for (const registration of manifestV2RegistrationsPendingRemoval) {
		await registration.unregister()
		manifestV2RegistrationsPendingRemoval.delete(registration)
	}
}

export const updateContentScriptInjectionStrategyManifestV2 = async (disabledOrigins: readonly string[]) => await manifestV2Registration.execute(async () => {
	// Keep failed removals reachable and finish cleanup before creating another registration.
	await removeSupersededManifestV2Registrations()
	const excludeGlobs = getManifestV2ExcludeGlobs(disabledOrigins)
	// A late onCommitted/executeScript injection lets page listeners run before the private bridge capture listener.
	const registered = await browser.contentScripts.register({
		matches: injectableSitesWildcard,
		...(excludeGlobs.length === 0 ? {} : { excludeGlobs }),
		allFrames: true,
		runAt: 'document_start',
		js: [
			{ file: '/vendor/webextension-polyfill/dist/browser-polyfill.js' },
			{ file: '/inpage/js/listenContentScript.js' },
			{ file: '/inpage/js/document_start.js' },
		],
	})
	const previous = registeredManifestV2Scripts
	registeredManifestV2Scripts = registered
	if (previous !== undefined) manifestV2RegistrationsPendingRemoval.add(previous)
	await removeSupersededManifestV2Registrations()
})
