// Extension-root paths of the injected scripts that do not depend on MetaMask compatibility mode; utils/contentScriptInjectionArtifacts.ts owns the page-world provider and MV2 document-start paths that do. Every file is emitted from app/inpage/ts and bundled by build/bundler.mts, which imports this module.
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
