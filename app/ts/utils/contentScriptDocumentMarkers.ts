// inpage.ts and listenContentScriptBootstrap.ts are compiled as standalone classic scripts (tsconfig-inpage.json: module none, its own rootDir), so they cannot import this module; they repeat these keys, and contentScriptDocumentMarkers.test.ts checks that both copies match.
export type ContentScriptWorld = 'MAIN' | 'ISOLATED'

// The provider (MAIN world) and the bridge (isolated world) each run once per document. The first copy of a script to run claims the document under claimedKey, so a second registration that matches the same document does nothing. A Firefox disabled-host registration's origin check sets disabledOriginKey on a disabled origin, and the guarded script of that same registration consumes it and skips without claiming the document, so the check never suppresses another registration's script.
export type ContentScriptDocumentMarkers = {
	readonly global: 'window' | 'globalThis'
	readonly claimedKey: string
	readonly disabledOriginKey: string
}

export const contentScriptDocumentMarkers: { readonly [world in ContentScriptWorld]: ContentScriptDocumentMarkers } = {
	MAIN: { global: 'window', claimedKey: 'TheInterceptor.pageProvider', disabledOriginKey: 'TheInterceptor.pageProviderOnDisabledOrigin' },
	ISOLATED: { global: 'globalThis', claimedKey: 'TheInterceptor.contentScriptBridge', disabledOriginKey: 'TheInterceptor.contentScriptBridgeOnDisabledOrigin' },
}
