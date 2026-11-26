type ExtensionFrameHint = { readonly framed: boolean, readonly ancestorOrigin?: string, readonly referrer?: string }

// This merely enables bounded fetch preparation before context arrives. The background independently verifies its own host, source and current consent before authorizing any simulated read.
export function isExtensionFrameFetchPreparationHint({ framed, ancestorOrigin, referrer }: ExtensionFrameHint) {
	return framed && /^(?:chrome|moz)-extension:\/\//.test(ancestorOrigin ?? referrer ?? '')
}
