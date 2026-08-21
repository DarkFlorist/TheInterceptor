import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { Settings } from '../types/interceptor-messages.js'
import type { WebsiteSocket } from '../utils/requests.js'
import { isActiveSigningSafe } from '../utils/activeAddressSelection.js'
import { getActiveAddress, websiteSocketToString } from './backgroundUtils.js'
import { reportUnexpectedError } from '../utils/errors.js'
import { sendSubscriptionReplyOrCallBack } from './messageSending.js'
import { getSafeAppsCompatibilityMode, getSettings } from './settings.js'
import { getActiveAddressForCurrentSignerState, getConfirmedSignerStateToken } from './signerStateOwnership.js'
import { getTabState, getUserAddressBookEntriesForChainIdMorePreciseFirst } from './storageVariables.js'
import { hasAddressAccess } from './websiteAccessPolicy.js'

function getConnectionDetails(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket) {
	return websiteTabConnections.get(socket.tabId)?.connections[websiteSocketToString(socket)]
}

export function isSafeAppsTopFramePort(port: browser.runtime.Port) {
	return port.sender?.frameId === undefined || port.sender.frameId === 0
}

async function getActiveAddressForDomain(websiteTabConnections: WebsiteTabConnections, websiteOrigin: string, settings: Settings, socket: WebsiteSocket) {
	const activeAddress = await getActiveAddressForCurrentSignerState(websiteTabConnections, settings, socket.tabId, async () => await getActiveAddress(settings, socket.tabId))
	if (activeAddress === undefined) return undefined
	return hasAddressAccess(settings.websiteAccess, websiteOrigin, activeAddress) === 'hasAccess' ? activeAddress : undefined
}

export async function isSafeAppsConnectionEligible(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, settings: Settings) {
	const connection = getConnectionDetails(websiteTabConnections, socket)
	if (connection?.approved !== true || !isSafeAppsTopFramePort(connection.port)) return false
	const [activeAddress, tabState, activeAddresses] = await Promise.all([
		getActiveAddressForDomain(websiteTabConnections, connection.websiteOrigin, settings, socket),
		getTabState(socket.tabId),
		getUserAddressBookEntriesForChainIdMorePreciseFirst(settings.activeRpcNetwork.chainId),
	])
	return isActiveSigningSafe(activeAddress, settings.simulationMode, settings.activeSigningSafeAddress, settings.activeRpcNetwork.chainId, tabState.signerAccounts, activeAddresses)
}

function createSafeAppsCompatibilityCoordinator() {
	const publicationTokens = new Map<string, object>()
	const signerAccountDiscoveryTabs = new Set<number>()
	const beginPublication = (socket: WebsiteSocket) => {
		const socketIdentifier = websiteSocketToString(socket)
		const token = {}
		publicationTokens.set(socketIdentifier, token)
		return { socketIdentifier, token }
	}
	const isCurrentPublication = (socketIdentifier: string, token: object) => publicationTokens.get(socketIdentifier) === token
	const send = (websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, enabled: boolean) => {
		sendSubscriptionReplyOrCallBack(websiteTabConnections, socket, { type: 'result' as const, method: 'safe_apps_compatibility', result: { enabled } })
	}
	const requestSignerAccountDiscovery = (websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket) => {
		if (signerAccountDiscoveryTabs.has(socket.tabId)) return true
		const signerStateToken = getConfirmedSignerStateToken(websiteTabConnections, socket.tabId)
		if (signerStateToken === undefined) return false
		signerAccountDiscoveryTabs.add(socket.tabId)
		const sent = sendSubscriptionReplyOrCallBack(websiteTabConnections, signerStateToken.socket, { type: 'result' as const, method: 'request_signer_to_eth_accounts', result: [] })
		if (!sent) signerAccountDiscoveryTabs.delete(socket.tabId)
		return sent
	}
	const refreshPort = async (websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, signerAccountsKnown: boolean) => {
		const { socketIdentifier, token } = beginPublication(socket)
		const [enabled, settings] = await Promise.all([getSafeAppsCompatibilityMode(), getSettings()])
		const connection = getConnectionDetails(websiteTabConnections, socket)
		const tabState = await getTabState(socket.tabId)
		const shouldDiscoverSignerAccounts = enabled
			&& connection?.approved === true
			&& isSafeAppsTopFramePort(connection.port)
			&& !settings.simulationMode
			&& settings.activeSigningSafeAddress !== undefined
			&& tabState.signerConnected
			&& tabState.signerAccounts.length === 0
			&& !signerAccountsKnown
		if (shouldDiscoverSignerAccounts && requestSignerAccountDiscovery(websiteTabConnections, socket)) return
		const eligible = enabled && await isSafeAppsConnectionEligible(websiteTabConnections, socket, settings)
		if (!isCurrentPublication(socketIdentifier, token)) return
		// Re-read persisted state after async eligibility work; a newer publication invalidates this token while state transitions are being applied.
		const [latestEnabled, latestSettings] = await Promise.all([getSafeAppsCompatibilityMode(), getSettings()])
		const latestEligible = latestEnabled && await isSafeAppsConnectionEligible(websiteTabConnections, socket, latestSettings)
		if (!isCurrentPublication(socketIdentifier, token)) return
		send(websiteTabConnections, socket, eligible && latestEligible)
	}
	const refreshApprovedTabPorts = async (websiteTabConnections: WebsiteTabConnections, tabId: number, signerAccountsKnown: boolean) => {
		const connections = Object.values(websiteTabConnections.get(tabId)?.connections ?? {})
		await Promise.all(connections.filter((connection) => connection?.approved === true).map(async (connection) => await refreshPort(websiteTabConnections, connection.socket, signerAccountsKnown)))
	}
	return {
		connectionApproved(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket) {
			void refreshPort(websiteTabConnections, socket, false).catch((error: unknown) => { void reportUnexpectedError(error) })
		},
		connectionDisconnected(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket) {
			beginPublication(socket)
			send(websiteTabConnections, socket, false)
			publicationTokens.delete(websiteSocketToString(socket))
			signerAccountDiscoveryTabs.delete(socket.tabId)
		},
		connectionRemoved(socket: WebsiteSocket) {
			publicationTokens.delete(websiteSocketToString(socket))
			signerAccountDiscoveryTabs.delete(socket.tabId)
		},
		signerConnectionChanged(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket) {
			signerAccountDiscoveryTabs.delete(socket.tabId)
			void refreshPort(websiteTabConnections, socket, false).catch((error: unknown) => { void reportUnexpectedError(error) })
		},
		signerAccountsSettled(socket: WebsiteSocket) {
			signerAccountDiscoveryTabs.delete(socket.tabId)
		},
		signerAccountsChanged(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket) {
			signerAccountDiscoveryTabs.delete(socket.tabId)
			void refreshApprovedTabPorts(websiteTabConnections, socket.tabId, true).catch((error: unknown) => { void reportUnexpectedError(error) })
		},
		async refreshApprovedPorts(websiteTabConnections: WebsiteTabConnections) {
			const sends: Promise<void>[] = []
			for (const tabConnection of websiteTabConnections.values()) {
				for (const connection of Object.values(tabConnection.connections)) {
					if (connection?.approved !== true) continue
					sends.push(refreshPort(websiteTabConnections, connection.socket, false))
				}
			}
			await Promise.all(sends)
		},
	}
}

export const safeAppsCompatibilityCoordinator = createSafeAppsCompatibilityCoordinator()
