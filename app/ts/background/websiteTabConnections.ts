import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { WebsiteSocket } from '../utils/requests.js'
import { websiteSocketToString } from './backgroundUtils.js'
import { advanceSignerStateGeneration, clearSignerDerivedTabState, getConfirmedSignerStateToken, resolveSignerStateConfirmation, runSignerStateOperation, settleSignerRequestsForReplacedState } from './signerStateOwnership.js'
import { updateTabState } from './storageVariables.js'
import { notifyWebsiteLifecycle } from './websiteLifecycle.js'

// Tab keys include retained signer owners; use these accessors whenever the caller needs live page connections.
export function hasLiveWebsiteConnections(websiteTabConnections: WebsiteTabConnections, tabId: number) {
	return Object.keys(websiteTabConnections.get(tabId)?.connections ?? {}).length > 0
}

export function getConnectedTabIds(websiteTabConnections: WebsiteTabConnections) {
	return [...websiteTabConnections.keys()].filter((tabId) => hasLiveWebsiteConnections(websiteTabConnections, tabId))
}

export async function removeWebsiteTabConnection(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, disconnectedPort: browser.runtime.Port) {
	return await runSignerStateOperation(websiteTabConnections, socket.tabId, async () => {
		const tabConnection = websiteTabConnections.get(socket.tabId)
		if (tabConnection === undefined) return false
		const connectionIdentifier = websiteSocketToString(socket)
		const currentConnection = tabConnection.connections[connectionIdentifier]
		if (currentConnection?.port !== disconnectedPort) return false
		const signerStateToken = getConfirmedSignerStateToken(websiteTabConnections, socket.tabId)
		delete tabConnection.connections[connectionIdentifier]
		tabConnection.signerExecutionOwner?.socketDisconnected(socket)
		notifyWebsiteLifecycle(websiteTabConnections.lifecycle?.connectionRemoved, socket)
		if (tabConnection.signerStateOwner?.connectionName === socket.connectionName) {
			resolveSignerStateConfirmation(tabConnection)
			advanceSignerStateGeneration(tabConnection)
			if (tabConnection.signerStateOwner === undefined) throw new Error('Signer state owner lifecycle missing')
			tabConnection.signerStateOwner.connectionName = undefined
			tabConnection.signerStateOwner.confirmed = false
			tabConnection.signerStateOwner.providerGeneration = undefined
			await updateTabState(socket.tabId, clearSignerDerivedTabState)
			settleSignerRequestsForReplacedState(signerStateToken)
		}
		// Retain the tab owner across transport reconnects to preserve document authority and pending approvals; tabs.onRemoved disposes it. Live-port consumers inspect connections rather than map membership.
		if (Object.keys(tabConnection.connections).length === 0 && tabConnection.signerExecutionOwner === undefined) websiteTabConnections.delete(socket.tabId)
		return true
	})
}
