import { verifyAccess } from './accessManagement.js'
import { getConfiguredSigningSafe } from './signingAddressSelection.js'
import { subscribeWebsiteLifecycle } from './websiteLifecycle.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { Settings } from '../types/interceptor-messages.js'
import type { WebsiteSocket } from '../utils/requests.js'
import { isActiveSigningSafe } from '../utils/activeAddressSelection.js'
import { getWebsiteSocketConnection, websiteSocketToString } from './backgroundUtils.js'
import { reportUnexpectedError } from '../utils/errors.js'
import { sendSubscriptionReplyOrCallBack } from './messageSending.js'
import { getSafeAppsCompatibilityMode, getSettings } from './settings.js'
import { getConfirmedSignerStateToken } from './signerStateOwnership.js'
import { getTabState, getUserAddressBookEntriesForChainIdMorePreciseFirst } from './storageVariables.js'
import { hasAccess, hasAddressAccess } from './websiteAccessPolicy.js'
import { getWebsiteActiveAddress } from './websiteActiveAddress.js'

export function isSafeAppsTopFramePort(port: browser.runtime.Port) {
	return port.sender?.frameId === undefined || port.sender.frameId === 0
}

export async function isSafeAppsConnectionEligible(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, settings: Settings) {
	const connection = getWebsiteSocketConnection(websiteTabConnections, socket)
	if (connection?.approved !== true || !isSafeAppsTopFramePort(connection.port)) return false
	const [activeAddress, tabState, activeAddresses] = await Promise.all([
		getWebsiteActiveAddress(websiteTabConnections, connection.websiteOrigin, settings, socket),
		getTabState(socket.tabId),
		getUserAddressBookEntriesForChainIdMorePreciseFirst(settings.activeRpcNetwork.chainId),
	])
	return isActiveSigningSafe(activeAddress, settings.simulationMode, settings.activeSigningSafeAddress, settings.activeRpcNetwork.chainId, tabState.signerAccounts, activeAddresses)
}

function createSafeAppsCompatibilityCoordinator() {
	let active = true
	const publicationTokens = new Map<string, object>()
	const signerAccountDiscoveryTabs = new Set<number>()
	const beginPublication = (socket: WebsiteSocket) => {
		const socketIdentifier = websiteSocketToString(socket)
		const token = {}
		publicationTokens.set(socketIdentifier, token)
		return { socketIdentifier, token }
	}
	const isCurrentPublication = (socketIdentifier: string, token: object) => active && publicationTokens.get(socketIdentifier) === token
	const send = (websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, enabled: boolean, canRequestAccess = false) => {
		sendSubscriptionReplyOrCallBack(websiteTabConnections, socket, { type: 'result' as const, method: 'safe_apps_compatibility', result: { enabled, canRequestAccess } })
	}
	const requestSignerAccountDiscovery = (websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket) => {
		if (signerAccountDiscoveryTabs.has(socket.tabId)) return true
		const signerStateToken = getConfirmedSignerStateToken(websiteTabConnections, socket.tabId)
		if (signerStateToken === undefined || signerStateToken.socket.connectionName !== socket.connectionName) return false
		signerAccountDiscoveryTabs.add(socket.tabId)
		const sent = sendSubscriptionReplyOrCallBack(websiteTabConnections, signerStateToken.socket, { type: 'result' as const, method: 'request_signer_to_eth_accounts', result: [] })
		if (!sent) signerAccountDiscoveryTabs.delete(socket.tabId)
		return sent
	}
	const refreshPort = async (websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, signerAccountsKnown: boolean) => {
		const { socketIdentifier, token } = beginPublication(socket)
		if (!active) return
		const settings = await getSettings()
		const connection = getWebsiteSocketConnection(websiteTabConnections, socket)
		const tabState = await getTabState(socket.tabId)
		const safe = await getConfiguredSigningSafe(settings, tabState.signerAccounts)
		if (!isCurrentPublication(socketIdentifier, token)) return
		// Reconcile cached Safe consent within the publication generation so any newer refresh also retries it.
		const signer = getConfirmedSignerStateToken(websiteTabConnections, socket.tabId)
		if (!settings.simulationMode && safe !== undefined && connection !== undefined && !connection.approved && isSafeAppsTopFramePort(connection.port) && signer?.socket.connectionName === socket.connectionName) {
			verifyAccess(websiteTabConnections, socket, false, connection.websiteOrigin, safe, settings, { ignoreConnectionApproval: true })
		}
		const shouldDiscoverSignerAccounts = isCurrentPublication(socketIdentifier, token)
			&& connection?.approved === true
			&& isSafeAppsTopFramePort(connection.port)
			&& !settings.simulationMode
			&& settings.activeSigningSafeAddress !== undefined
			&& tabState.signerConnected
			&& tabState.signerAccounts.length === 0
			&& !signerAccountsKnown
		if (shouldDiscoverSignerAccounts && requestSignerAccountDiscovery(websiteTabConnections, socket)) return
		const eligible = await isSafeAppsConnectionEligible(websiteTabConnections, socket, settings)
		if (!isCurrentPublication(socketIdentifier, token)) return
		// Re-read persisted state after async eligibility work; a newer publication invalidates this token while state transitions are being applied.
		const latestSettings = await getSettings()
		const latestEnabled = active
		const latestEligible = latestEnabled && await isSafeAppsConnectionEligible(websiteTabConnections, socket, latestSettings)
		if (!isCurrentPublication(socketIdentifier, token)) return
		const latestConnection = getWebsiteSocketConnection(websiteTabConnections, socket)
		const entries = latestEnabled && !latestSettings.simulationMode ? await getUserAddressBookEntriesForChainIdMorePreciseFirst(latestSettings.activeRpcNetwork.chainId) : []
		const configuredSafe = entries.find((entry) => entry.type === 'safe' && entry.address === latestSettings.activeSigningSafeAddress)
		const siteAccess = latestConnection === undefined ? 'noAccess' : hasAccess(latestSettings.websiteAccess, latestConnection.websiteOrigin)
		// The Safe selection may be restored only after MetaMask exposes its account; connection must not require that selection upfront.
		const safeAccess = latestConnection === undefined ? 'noAccess' : configuredSafe === undefined ? 'askAccess' : hasAddressAccess(latestSettings.websiteAccess, latestConnection.websiteOrigin, configuredSafe)
		const canRequestAccess = latestEnabled && !latestSettings.simulationMode && latestConnection !== undefined && isSafeAppsTopFramePort(latestConnection.port)
			&& siteAccess !== 'noAccess' && siteAccess !== 'interceptorDisabled' && safeAccess !== 'noAccess' && safeAccess !== 'interceptorDisabled'
		if (!isCurrentPublication(socketIdentifier, token)) return
		send(websiteTabConnections, socket, eligible && latestEligible, canRequestAccess)
	}
	return {
		dispose(connections: WebsiteTabConnections) {
			active = false
			for (const tab of connections.values()) for (const connection of Object.values(tab.connections)) {
				if (connection !== undefined && publicationTokens.has(websiteSocketToString(connection.socket))) send(connections, connection.socket, false)
			}
			publicationTokens.clear()
			signerAccountDiscoveryTabs.clear()
		},
		connectionApproved(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket) {
			void refreshPort(websiteTabConnections, socket, false).catch(async (error: unknown) => { await reportUnexpectedError(error) })
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
		signerConnectionChanged(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, accountsRequested = false) {
			signerAccountDiscoveryTabs.delete(socket.tabId)
			// The core signer handshake already sent this passive request; do not duplicate it during feature discovery.
			if (accountsRequested) signerAccountDiscoveryTabs.add(socket.tabId)
			void refreshPort(websiteTabConnections, socket, false).catch(async (error: unknown) => { await reportUnexpectedError(error) })
		},
		signerAccountsChanged(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket) {
			signerAccountDiscoveryTabs.delete(socket.tabId)
			void refreshPort(websiteTabConnections, socket, true).catch(async (error: unknown) => { await reportUnexpectedError(error) })
		},
		async refreshPorts(websiteTabConnections: WebsiteTabConnections, includeUnapproved = false) {
			const sends: Promise<void>[] = []
			for (const tabConnection of websiteTabConnections.values()) {
				for (const connection of Object.values(tabConnection.connections)) {
					if (connection === undefined || (!includeUnapproved && !connection.approved)) continue
					sends.push(refreshPort(websiteTabConnections, connection.socket, false))
				}
			}
			await Promise.all(sends)
		},
	}
}

// The composition root owns this opt-in subscription; disabled mode has no lifecycle listener or coordinator state.
export function createSafeAppsCompatibilityFeature(connections: WebsiteTabConnections) {
	let coordinator: ReturnType<typeof createSafeAppsCompatibilityCoordinator> | undefined
	let unsubscribe: (() => void) | undefined
	const setEnabled = (enabled: boolean) => {
		if (enabled === (coordinator !== undefined)) return
		unsubscribe?.()
		unsubscribe = undefined
		coordinator?.dispose(connections)
		coordinator = enabled ? createSafeAppsCompatibilityCoordinator() : undefined
		const current = coordinator
		if (current === undefined) return
		unsubscribe = subscribeWebsiteLifecycle(connections, (event) => {
			switch (event.type) {
				case 'approvalChanged': return event.approved ? current.connectionApproved(connections, event.socket) : current.connectionDisconnected(connections, event.socket)
				case 'connectionRemoved': return current.connectionRemoved(event.socket)
				case 'signerConnected': return current.signerConnectionChanged(connections, event.socket, event.accountsRequested)
				case 'signerAccountsChanged': return current.signerAccountsChanged(connections, event.socket)
				case 'accessReconciled': void current.refreshPorts(connections).catch(async (error: unknown) => { await reportUnexpectedError(error) }); return
			}
		})
		void current.refreshPorts(connections, true).catch(async (error: unknown) => { await reportUnexpectedError(error) })
	}
	return { setEnabled, dispose: () => setEnabled(false) }
}

export async function initializeSafeAppsCompatibility(connections: WebsiteTabConnections) {
	const feature = createSafeAppsCompatibilityFeature(connections)
	let changedDuringInitialization = false
	const onChanged = (changes: { readonly safeAppsCompatibilityMode?: browser.storage.StorageChange }, area: string) => {
		if (area !== 'local' || !('safeAppsCompatibilityMode' in changes)) return
		changedDuringInitialization = true
		feature.setEnabled(changes.safeAppsCompatibilityMode?.newValue === true)
	}
	browser.storage.onChanged.addListener(onChanged)
	try {
		const enabled = await getSafeAppsCompatibilityMode()
		if (!changedDuringInitialization) feature.setEnabled(enabled)
	} catch (error) {
		browser.storage.onChanged.removeListener(onChanged)
		feature.dispose()
		throw error
	}
	return () => { browser.storage.onChanged.removeListener(onChanged); feature.dispose() }
}
