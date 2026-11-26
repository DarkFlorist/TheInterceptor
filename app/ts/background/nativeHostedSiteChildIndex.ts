import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { WebsiteSocket } from '../utils/requests.js'
import { websiteSocketToString } from './backgroundUtils.js'
import { getNativeHostedSiteSourceTabId } from './nativeHostedSiteContext.js'

// Index only the browser-owned launch relationship, retaining denied sources for later reapproval. Every publication still validates its live native-host context.
export function createNativeHostedSiteChildIndex() {
	const nativeChildrenBySourceTab = new Map<number, Map<string, WebsiteSocket>>()
	const sourceTabByNativeChild = new Map<string, number>()
	const remove = (socket: WebsiteSocket) => {
		const key = websiteSocketToString(socket)
		const sourceTabId = sourceTabByNativeChild.get(key)
		if (sourceTabId === undefined) return
		const children = nativeChildrenBySourceTab.get(sourceTabId)
		children?.delete(key)
		if (children?.size === 0) nativeChildrenBySourceTab.delete(sourceTabId)
		sourceTabByNativeChild.delete(key)
	}
	const track = (connections: WebsiteTabConnections, socket: WebsiteSocket) => {
		remove(socket)
		const sourceTabId = getNativeHostedSiteSourceTabId(connections, socket)
		if (sourceTabId === undefined) return
		const children = nativeChildrenBySourceTab.get(sourceTabId) ?? new Map<string, WebsiteSocket>()
		const key = websiteSocketToString(socket)
		children.set(key, socket)
		nativeChildrenBySourceTab.set(sourceTabId, children)
		sourceTabByNativeChild.set(key, sourceTabId)
	}
	return {
		track,
		remove,
		getChildren: (sourceTabId: number) => [...(nativeChildrenBySourceTab.get(sourceTabId)?.values() ?? [])],
		clear: () => { nativeChildrenBySourceTab.clear(); sourceTabByNativeChild.clear() },
	}
}
