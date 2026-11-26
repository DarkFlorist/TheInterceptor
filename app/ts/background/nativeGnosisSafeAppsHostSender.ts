type NativeHostSender = { readonly id?: string, readonly url?: string }

// Both native-host transports authorize the exact extension page before reading source-tab state; only launch query/hash data may vary.
export function getAuthorizedNativeGnosisSafeAppsHostSenderUrl(sender: NativeHostSender | undefined, extensionId: string, hostUrls: readonly string[]) {
	if (sender?.id !== extensionId || sender.url === undefined) return undefined
	const pageUrl = sender.url.split(/[?#]/)[0]
	return pageUrl !== undefined && hostUrls.includes(pageUrl) ? sender.url : undefined
}
