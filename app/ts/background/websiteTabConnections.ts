import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { WebsiteSocket } from '../utils/requests.js'
import { websiteSocketToString } from './backgroundUtils.js'

export function removeWebsiteTabConnection(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, disconnectedPort: browser.runtime.Port) {
	const tabConnection = websiteTabConnections.get(socket.tabId)
	if (tabConnection === undefined) return
	const connectionIdentifier = websiteSocketToString(socket)
	const currentConnection = tabConnection.connections[connectionIdentifier]
	if (currentConnection?.port !== disconnectedPort) return
	delete tabConnection.connections[connectionIdentifier]
	if (Object.keys(tabConnection.connections).length === 0) {
		websiteTabConnections.delete(socket.tabId)
	}
}
