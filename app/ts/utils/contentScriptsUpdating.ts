import { getInterceptorDisabledSites, getSettings } from '../background/settings.js'
import { getWebsiteOrigin } from './websiteOrigin.js'
import { Semaphore } from './semaphore.js'
import { reportUnexpectedError } from './errors.js'

const injectableSitesWildcard = ['file://*/*', 'http://*/*', 'https://*/*']
function getManifestV3ExcludeMatchesForOrigin(origin: string) {
	if (getWebsiteOrigin(origin) !== origin) return []
	const url = new URL(origin)
	if (url.protocol === 'file:') return [url.href]
	return [`${ url.protocol }//${ url.host }/*`]
}

export function getManifestV3ExcludeMatches(origins: readonly string[]) {
	const patterns = new Set<string>()
	for (const origin of origins) {
		for (const pattern of getManifestV3ExcludeMatchesForOrigin(origin)) patterns.add(pattern)
	}
	return [...patterns]
}

export const updateContentScriptInjectionStrategyManifestV3 = async () => {
	const excludeMatches = getManifestV3ExcludeMatches(getInterceptorDisabledSites(await getSettings()))
	try {
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
	} catch (error: unknown) {
		await reportUnexpectedError(error, { code: 'content_script_registration_failed' })
	}
}

let registeredManifestV2Scripts: browser.contentScripts.RegisteredContentScript | undefined
const manifestV2Registration = new Semaphore(1)

export const updateContentScriptInjectionStrategyManifestV2 = async () => await manifestV2Registration.execute(async () => {
	const excludeMatches = getManifestV3ExcludeMatches(getInterceptorDisabledSites(await getSettings()))
	try {
		// A late onCommitted/executeScript injection lets page listeners run before the private bridge capture listener.
		const registered = await browser.contentScripts.register({
			matches: injectableSitesWildcard,
			...(excludeMatches.length === 0 ? {} : { excludeMatches }),
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
		await previous?.unregister()
	} catch (error: unknown) {
		await reportUnexpectedError(error, { code: 'content_script_registration_failed' })
	}
})
