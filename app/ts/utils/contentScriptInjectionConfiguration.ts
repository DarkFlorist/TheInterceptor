import { getInterceptorDisabledSites, getMetamaskCompatibilityMode, getSettings } from '../background/settings.js'

const inpageScriptDirectory = 'inpage/js'

const pageWorldProviderScriptPath = `${ inpageScriptDirectory }/inpage.js`
const metamaskCompatibilityModeScriptPath = `${ inpageScriptDirectory }/metamaskCompatibilityMode.js`
export const metamaskCompatibilityModeGlobalSymbolKey = 'TheInterceptor.metamaskCompatibilityMode'
export const metamaskCompatibilityModeGlobalSymbolKeyMarker = '[[metamaskCompatibilityModeGlobalSymbolKey]]'

export type ContentScriptInjectionConfiguration = {
	readonly metamaskCompatibilityMode: boolean
	readonly interceptorDisabledSites: readonly string[]
}

export async function getContentScriptInjectionConfiguration(): Promise<ContentScriptInjectionConfiguration> {
	const [settings, metamaskCompatibilityMode] = await Promise.all([getSettings(), getMetamaskCompatibilityMode()])
	return { metamaskCompatibilityMode, interceptorDisabledSites: getInterceptorDisabledSites(settings) }
}

export function hasSameContentScriptInjectionConfiguration(first: ContentScriptInjectionConfiguration, second: ContentScriptInjectionConfiguration) {
	if (first.metamaskCompatibilityMode !== second.metamaskCompatibilityMode) return false
	const firstDisabledSites = new Set(first.interceptorDisabledSites)
	const secondDisabledSites = new Set(second.interceptorDisabledSites)
	return firstDisabledSites.size === secondDisabledSites.size && [...firstDisabledSites].every((disabledSite) => secondDisabledSites.has(disabledSite))
}

export function getPageWorldScriptPaths(metamaskCompatibilityMode: boolean): readonly string[] {
	return [
		...(metamaskCompatibilityMode ? [metamaskCompatibilityModeScriptPath] : []),
		pageWorldProviderScriptPath,
	]
}

export function getManifestV2IsolatedWorldInjections(metamaskCompatibilityMode: unknown) {
	const enabled = metamaskCompatibilityMode === true
	return [
		{ file: 'vendor/webextension-polyfill/dist/browser-polyfill.js' },
		{ file: `${ inpageScriptDirectory }/listenContentScript.js` },
		{ code: `Reflect.set(globalThis, Symbol.for(${ JSON.stringify(metamaskCompatibilityModeGlobalSymbolKey) }), ${ JSON.stringify(enabled) })` },
		{ file: `${ inpageScriptDirectory }/document_start.js` },
	] as const
}
