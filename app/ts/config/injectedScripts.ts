// Runtime paths consumed by Chrome scripting and the runtime bundler. Every file is emitted from app/inpage/ts.
export const INPAGE_SCRIPTS = {
	documentStart: '/inpage/js/document_start.js',
	provider: '/inpage/js/inpage.js',
	contentListener: '/inpage/js/listenContentScript.js',
	contentListenerBootstrap: '/inpage/js/listenContentScriptBootstrap.js',
	safeAppsHost: '/inpage/js/safeAppsHostBootstrap.js',
	prepareSafeApp: '/inpage/js/prepareSafeAppBootstrap.js',
	cancelSafeAppPreparation: '/inpage/js/cancelSafeAppPreparationBootstrap.js',
	clearSafeAppPreparationCancellation: '/inpage/js/clearSafeAppPreparationCancellationBootstrap.js',
	readDocumentOrigin: '/inpage/js/readDocumentOrigin.js',
} as const

export const PROVIDER_SCRIPTS = [INPAGE_SCRIPTS.provider] as const
// Chrome executes these files in order at document_start on selected host origins.
export const SAFE_APPS_HOST_SCRIPTS = [INPAGE_SCRIPTS.safeAppsHost, ...PROVIDER_SCRIPTS] as const
