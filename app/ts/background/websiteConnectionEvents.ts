import type { InpageScriptCallBack, Settings } from '../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { WebsiteSocket } from '../utils/requests.js'
import { websiteSocketToString } from './backgroundUtils.js'
import { sendSubscriptionReplyOrCallBack } from './messageSending.js'
import { getWebsiteActiveAddress } from './websiteActiveAddress.js'

// Events sent to connected websites. This module stays below the access dialogs and the network transitions, which both send them.

const unscopedConnectionEventSuppressionCounts = new Map<string, number>()

function incrementUnscopedConnectionEventSuppression(socket: WebsiteSocket) {
	const socketIdentifier = websiteSocketToString(socket)
	unscopedConnectionEventSuppressionCounts.set(socketIdentifier, (unscopedConnectionEventSuppressionCounts.get(socketIdentifier) ?? 0) + 1)
	return socketIdentifier
}

function decrementUnscopedConnectionEventSuppression(socketIdentifier: string) {
	const previousCount = unscopedConnectionEventSuppressionCounts.get(socketIdentifier)
	if (previousCount === undefined || previousCount <= 1) {
		unscopedConnectionEventSuppressionCounts.delete(socketIdentifier)
		return
	}
	unscopedConnectionEventSuppressionCounts.set(socketIdentifier, previousCount - 1)
}

export function shouldSendUnscopedConnectionEvents(socket: WebsiteSocket) {
	return !unscopedConnectionEventSuppressionCounts.has(websiteSocketToString(socket))
}

export function withSuppressedUnscopedConnectionEventsForSocket<T>(socket: WebsiteSocket, action: () => T): T {
	const socketIdentifier = incrementUnscopedConnectionEventSuppression(socket)
	try {
		return action()
	} finally {
		decrementUnscopedConnectionEventSuppression(socketIdentifier)
	}
}

export async function withSuppressedUnscopedConnectionEventsForSocketAsync<T>(socket: WebsiteSocket, action: () => Promise<T>): Promise<T> {
	const socketIdentifier = incrementUnscopedConnectionEventSuppression(socket)
	try {
		return await action()
	} finally {
		decrementUnscopedConnectionEventSuppression(socketIdentifier)
	}
}

export function sendMessageToApprovedWebsitePorts(websiteTabConnections: WebsiteTabConnections, message: InpageScriptCallBack) {
	// inform all the tabs about the address change
	for (const [_tab, tabConnection] of websiteTabConnections.entries() ) {
		for (const key in tabConnection.connections) {
			const connection = tabConnection.connections[key]
			if (connection === undefined) throw new Error('missing connection')
			if (!connection.approved) continue
			sendSubscriptionReplyOrCallBack(websiteTabConnections, connection.socket, { type: 'result' as const, ...message })
		}
	}
}
export async function sendActiveAccountChangeToApprovedWebsitePorts(websiteTabConnections: WebsiteTabConnections, settings: Settings) {
	// inform all the tabs about the address change
	for (const [_tab, tabConnection] of websiteTabConnections.entries() ) {
		for (const key in tabConnection.connections) {
			const connection = tabConnection.connections[key]
			if (connection === undefined) throw new Error('missing connection')
			if (!connection.approved) continue
			if (!shouldSendUnscopedConnectionEvents(connection.socket)) continue
			const activeAddress = await getWebsiteActiveAddress(websiteTabConnections, connection.websiteOrigin, settings, connection.socket)
			sendSubscriptionReplyOrCallBack(websiteTabConnections, connection.socket, {
				type: 'result' as const,
				method: 'accountsChanged',
				result: activeAddress !== undefined ? [activeAddress.address] : []
			})
		}
	}
}
