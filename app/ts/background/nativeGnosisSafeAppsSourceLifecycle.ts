type SourceLifecycleEvents = {
	readonly onRemoved: { readonly addListener: (listener: (tabId: number) => void) => void, readonly removeListener: (listener: (tabId: number) => void) => void }
	readonly onUpdated: { readonly addListener: (listener: (tabId: number, change: { readonly url?: string }) => void) => void, readonly removeListener: (listener: (tabId: number, change: { readonly url?: string }) => void) => void }
}

function getOrigin(url: string) {
	try { return new URL(url).origin } catch (error: unknown) {
		if (error instanceof TypeError) return undefined
		throw error
	}
}

// Source-tab lifecycle is authoritative even when storage permissions do not change. Ordinary same-origin navigation keeps the current app session.
export function observeNativeGnosisSafeAppsSource(sourceTabId: number, origin: string, onDisconnect: () => void, events: SourceLifecycleEvents = browser.tabs) {
	let active = true
	let disconnected = false
	const disconnect = () => {
		if (!active || disconnected) return
		disconnected = true
		onDisconnect()
	}
	const removed = (tabId: number) => { if (tabId === sourceTabId) disconnect() }
	const updated = (tabId: number, change: { readonly url?: string }) => {
		if (tabId === sourceTabId && change.url !== undefined && getOrigin(change.url) !== origin) disconnect()
	}
	events.onRemoved.addListener(removed)
	events.onUpdated.addListener(updated)
	return () => {
		active = false
		events.onRemoved.removeListener(removed)
		events.onUpdated.removeListener(updated)
	}
}
