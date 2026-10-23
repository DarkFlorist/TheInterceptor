import { isTopFrameId, websiteSocketToString, type WebsiteSocket } from '../utils/requests.js'

// Socket bookkeeping never grants permission. The owning coordinator supplies invalidation for authority and leases.
export function createChildSignerSockets(onSocketInvalidated: (socketKey: string, tabId: number) => void, onSocketRegistered: (socketKey: string) => void) {
	const currentSocketKeysByTab = new Map<number, Map<number, string>>()
	const frameIdsBySocketKey = new Map<string, number>()
	const pendingRemovalTimers = new Map<string, ReturnType<typeof setTimeout>>()

	function cancelRemoval(key: string) {
		const pending = pendingRemovalTimers.get(key)
		if (pending !== undefined) clearTimeout(pending)
		pendingRemovalTimers.delete(key)
	}

	function register(socket: WebsiteSocket, frameId: number) {
		if (isTopFrameId(frameId)) return false
		const key = websiteSocketToString(socket)
		onSocketRegistered(key)
		cancelRemoval(key)
		const currentForTab = currentSocketKeysByTab.get(socket.tabId) ?? new Map<number, string>()
		currentSocketKeysByTab.set(socket.tabId, currentForTab)
		const previousKey = currentForTab.get(frameId)
		if (previousKey === key) return false
		currentForTab.set(frameId, key)
		frameIdsBySocketKey.set(key, frameId)
		if (previousKey !== undefined) {
			cancelRemoval(previousKey)
			frameIdsBySocketKey.delete(previousKey)
			onSocketInvalidated(previousKey, socket.tabId)
		}
		return true
	}

	function unregister(socket: WebsiteSocket) {
		const key = websiteSocketToString(socket)
		onSocketInvalidated(key, socket.tabId)
		cancelRemoval(key)
		const frameId = frameIdsBySocketKey.get(key)
		frameIdsBySocketKey.delete(key)
		if (frameId === undefined) return false
		const currentForTab = currentSocketKeysByTab.get(socket.tabId)
		if (currentForTab?.get(frameId) !== key) return false
		currentForTab.delete(frameId)
		if (currentForTab.size === 0) currentSocketKeysByTab.delete(socket.tabId)
		return true
	}

	function scheduleRemoval(socket: WebsiteSocket) {
		const key = websiteSocketToString(socket)
		if (!frameIdsBySocketKey.has(key) || pendingRemovalTimers.has(key)) return false
		const timeout = setTimeout(() => {
			pendingRemovalTimers.delete(key)
			unregister(socket)
		}, 1000)
		pendingRemovalTimers.set(key, timeout)
		return true
	}

	function isCurrent(socket: WebsiteSocket, frameId: number | undefined) {
		return frameId !== undefined && !isTopFrameId(frameId) && currentSocketKeysByTab.get(socket.tabId)?.get(frameId) === websiteSocketToString(socket)
	}

	function containsCurrentSocket(socket: WebsiteSocket) {
		return isCurrent(socket, frameIdsBySocketKey.get(websiteSocketToString(socket)))
	}

	function clearTab(tabId: number) {
		currentSocketKeysByTab.delete(tabId)
		for (const [key] of frameIdsBySocketKey) {
			if (!key.startsWith(`${ tabId }-`)) continue
			frameIdsBySocketKey.delete(key)
			onSocketInvalidated(key, tabId)
		}
		for (const [key] of pendingRemovalTimers) {
			if (key.startsWith(`${ tabId }-`)) cancelRemoval(key)
		}
	}

	return { register, unregister, scheduleRemoval, isCurrent, containsCurrentSocket, clearTab, isEmpty: () => currentSocketKeysByTab.size === 0 && frameIdsBySocketKey.size === 0 && pendingRemovalTimers.size === 0 }
}
