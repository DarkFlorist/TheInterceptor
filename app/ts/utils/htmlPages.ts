export type HTMLFile = 'popup' | 'addressBook' | 'changeChain' | 'watchAsset' | 'confirmTransaction' | 'interceptorAccess' | 'settingsView' | 'websiteAccess' | 'fetchSimulationStack' | 'simulationStack' | 'gnosisSafeAppsHost'

export function getHtmlFile(file: HTMLFile, manifestVersion = browser.runtime.getManifest().manifest_version) {
	return manifestVersion === 2 ? `/html/${ file }.html` : `/html3/${ file }V3.html`
}

// Resolve the leading slash as a URL path instead of passing it to runtime.getURL, which doubles it in Firefox.
export function getHtmlPageUrl(file: HTMLFile, extensionRoot = browser.runtime.getURL(''), manifestVersion = browser.runtime.getManifest().manifest_version) {
	return new URL(getHtmlFile(file, manifestVersion), extensionRoot).href
}
