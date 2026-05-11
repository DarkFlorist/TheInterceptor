import { WebsiteTabConnections } from '../types/user-interface-types.js'
import { WebsiteSocket } from '../utils/requests.js'
import { websiteSocketToString } from './backgroundUtils.js'

export function removeWebsiteTabConnection(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket) {
	const tabConnection = websiteTabConnections.get(socket.tabId)
	if (tabConnection === undefined) return
	delete tabConnection.connections[websiteSocketToString(socket)]
	if (Object.keys(tabConnection.connections).length === 0) {
		websiteTabConnections.delete(socket.tabId)
	}
}
