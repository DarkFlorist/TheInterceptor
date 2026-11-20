// Extension-root paths of the injected scripts that do not depend on MetaMask compatibility mode; utils/contentScriptInjectionArtifacts.ts owns the page-world provider and MV2 document-start paths that do. Every file is emitted from app/inpage/ts and bundled by build/bundler.mts, which imports this module. None of these is web-accessible: Chrome runs registered content scripts and scripting.executeScript files in the MAIN world without web_accessible_resources, which only governs loading a file by its extension URL (only MV2's document_start.ts <script src> fallback does that; MV3 still lists the page-world providers from an old inpage/* listing).
export const INPAGE_SCRIPTS = {
	contentListener: '/inpage/js/listenContentScript.js',
	contentListenerBootstrap: '/inpage/js/listenContentScriptBootstrap.js',
	safeAppsHost: '/inpage/js/safeAppsHostBootstrap.js',
	prepareSafeApp: '/inpage/js/prepareSafeAppBootstrap.js',
	cancelSafeAppPreparation: '/inpage/js/cancelSafeAppPreparationBootstrap.js',
	clearSafeAppPreparationCancellation: '/inpage/js/clearSafeAppPreparationCancellationBootstrap.js',
	readDocumentOrigin: '/inpage/js/readDocumentOrigin.js',
} as const

export const INJECTABLE_SITES_WILDCARD = ['file://*/*', 'http://*/*', 'https://*/*']
