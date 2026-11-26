import { getPageWorldScriptPaths } from '../../app/ts/utils/contentScriptInjectionArtifacts.js'

type AddedScript = { readonly external: boolean, readonly src: string, readonly providerDefined: boolean }
export type InjectionObservations = { readonly providerAtFirstPageScript: boolean, readonly addedScripts: readonly AddedScript[], readonly cspViolations: number }
export type ProviderInjectionResult = { readonly providerArrived: boolean | undefined, readonly observations: InjectionObservations | undefined }

function hasExpectedExtensionPath(source: string, paths: readonly (string | undefined)[]) {
	let url: URL
	try { url = new URL(source) } catch (error: unknown) {
		if (error instanceof TypeError) return false
		throw error
	}
	return (url.protocol === 'chrome-extension:' || url.protocol === 'moz-extension:') && paths.some((path) => path !== undefined && url.pathname === `/${ path }`)
}

// MAIN-world native injection can precede page observation. For MV2's observed injection, every configured classic script must be inline or have its own ordered CSP fallback.
export function getProviderInjectionFailure({ providerArrived, observations }: ProviderInjectionResult, inlineBlocked: boolean, scripts: readonly string[] = getPageWorldScriptPaths(false)) {
	if (providerArrived !== true) return 'the provider never arrived'
	if (observations === undefined) return 'the page did not record its observations'
	if (observations.providerAtFirstPageScript) return undefined
	const first = observations.addedScripts[0]
	if (first === undefined || first.external) return 'the page did not see the inline provider script being added'
	if (!inlineBlocked) {
		if (observations.addedScripts.some((script) => script.external)) return 'the extension URL fallback ran although inline scripts were allowed'
		if (observations.addedScripts.length !== scripts.length) return `expected ${ scripts.length } inline provider/feature scripts`
		if (observations.addedScripts.some((script) => !script.providerDefined)) return 'the inline provider was not defined synchronously before its feature scripts'
		return undefined
	}
	if (observations.cspViolations < scripts.length) return 'the strict CSP did not block every inline provider/feature script'
	if (observations.addedScripts.length !== scripts.length * 2) return 'not every blocked inline script received an extension URL fallback'
	for (const [index, scriptPath] of scripts.entries()) {
		const inline = observations.addedScripts[index * 2]
		const external = observations.addedScripts[index * 2 + 1]
		if (inline?.external !== false || external?.external !== true) return 'CSP fallback scripts were not queued in inline/external pairs'
		const paths = index === 0 ? [scriptPath, getPageWorldScriptPaths(true)[0]] : [scriptPath]
		if (!hasExpectedExtensionPath(external.src, paths)) return 'CSP fallback script paths were not in provider-before-feature order'
	}
	return undefined
}
