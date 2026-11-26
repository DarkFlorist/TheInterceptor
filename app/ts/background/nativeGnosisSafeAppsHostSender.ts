type NativeHostSender = { readonly id?: string, readonly url?: string }

// Transports authorize the exact extension host before reading source-tab state. A child-frame transport supplies its browser-reported sender.tab.url; direct host transports use sender.url.
export function getAuthorizedNativeGnosisSafeAppsHostSenderUrl(sender: NativeHostSender | undefined, extensionId: string, hostUrls: readonly string[], hostPageUrl = sender?.url) {
	if (sender?.id !== extensionId || hostPageUrl === undefined) return undefined
	const pageUrl = hostPageUrl.split(/[?#]/)[0]
	return pageUrl !== undefined && hostUrls.includes(pageUrl) ? hostPageUrl : undefined
}
