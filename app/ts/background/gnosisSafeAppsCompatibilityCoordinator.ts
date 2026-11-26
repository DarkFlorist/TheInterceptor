import { initializeFeaturePreference } from './featurePreference.js'
import { verifyAccess } from './accessManagement.js'
import type { WebsiteLifecycleCallbacks } from '../types/websiteLifecycle.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { WebsiteSocket } from '../utils/requests.js'
import { resolveConfiguredGnosisSafeForMode, getConfiguredGnosisSafeEntryForMode } from '../utils/activeAddressSelection.js'
import { getWebsiteSocketConnection, isTopFramePort, websiteSocketToString } from './backgroundUtils.js'
import { reportUnexpectedError } from '../utils/errors.js'
import { sendSubscriptionReplyOrCallBack } from './messageSending.js'
import { getSettings, getGnosisSafeAppsCompatibilityMode } from './settings.js'
import { getConfirmedSignerStateToken } from './signerStateOwnership.js'
import { getTabState, getUserAddressBookEntriesForChainIdMorePreciseFirst } from './storageVariables.js'
import { hasAccess, hasAddressAccess } from './websiteAccessPolicy.js'


import { isGnosisSafeAppsConnectionEligible } from './gnosisSafeAppsConnectionEligibility.js'

function createGnosisSafeAppsCompatibilityCoordinator() {
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
	const publishGnosisSafeAppsCompatibility = (websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, enabled: boolean, canRequestAccess = false) => {
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
		const candidate = getWebsiteSocketConnection(websiteTabConnections, socket)
		if (candidate === undefined) return
		const { socketIdentifier, token } = beginPublication(socket)
		if (!active) return
		const settings = await getSettings()
		const connection = getWebsiteSocketConnection(websiteTabConnections, socket)
		const tabState = await getTabState(socket.tabId)
		const safe = resolveConfiguredGnosisSafeForMode(settings, await getUserAddressBookEntriesForChainIdMorePreciseFirst(settings.activeRpcNetwork.chainId), tabState.signerAccounts)
		if (!isCurrentPublication(socketIdentifier, token)) return
		// Reconcile cached Gnosis Safe consent within the publication generation so any newer refresh also retries it.
		const signer = getConfirmedSignerStateToken(websiteTabConnections, socket.tabId)
		if (safe !== undefined && connection !== undefined && !connection.approved && isTopFramePort(connection.port) && (settings.simulationMode || signer?.socket.connectionName === socket.connectionName)) {
			verifyAccess(websiteTabConnections, socket, false, connection.websiteOrigin, safe, settings, { ignoreConnectionApproval: true })
		}
		const shouldDiscoverSignerAccounts = isCurrentPublication(socketIdentifier, token)
			&& connection?.approved === true
			&& isTopFramePort(connection.port)
			&& !settings.simulationMode
			&& settings.activeSigningSafeAddress !== undefined
			&& tabState.signerConnected
			&& tabState.signerAccounts.length === 0
			&& !signerAccountsKnown
		if (shouldDiscoverSignerAccounts && requestSignerAccountDiscovery(websiteTabConnections, socket)) return
		const eligible = await isGnosisSafeAppsConnectionEligible(websiteTabConnections, socket, settings)
		if (!isCurrentPublication(socketIdentifier, token)) return
		// Re-read persisted state after async eligibility work; a newer publication invalidates this token while state transitions are being applied.
		const latestSettings = await getSettings()
		const latestEnabled = active
		const latestEligible = latestEnabled && await isGnosisSafeAppsConnectionEligible(websiteTabConnections, socket, latestSettings)
		if (!isCurrentPublication(socketIdentifier, token)) return
		const latestConnection = getWebsiteSocketConnection(websiteTabConnections, socket)
		const entries = latestEnabled ? await getUserAddressBookEntriesForChainIdMorePreciseFirst(latestSettings.activeRpcNetwork.chainId) : []
		const configuredSafe = getConfiguredGnosisSafeEntryForMode(latestSettings, entries)
		const siteAccess = latestConnection === undefined ? 'noAccess' : hasAccess(latestSettings.websiteAccess, latestConnection.websiteOrigin)
		// The Gnosis Safe selection may be restored only after MetaMask exposes its account; connection must not require that selection upfront.
		const safeAccess = latestConnection === undefined ? 'noAccess' : configuredSafe === undefined ? 'askAccess' : hasAddressAccess(latestSettings.websiteAccess, latestConnection.websiteOrigin, configuredSafe)
		const canRequestAccess = latestEnabled && (!latestSettings.simulationMode || configuredSafe !== undefined) && latestConnection !== undefined && isTopFramePort(latestConnection.port)
			&& siteAccess !== 'noAccess' && siteAccess !== 'interceptorDisabled' && safeAccess !== 'noAccess' && safeAccess !== 'interceptorDisabled'
		if (!isCurrentPublication(socketIdentifier, token)) return
		publishGnosisSafeAppsCompatibility(websiteTabConnections, socket, eligible && latestEligible, canRequestAccess)
	}
	return {
		dispose(connections: WebsiteTabConnections) {
			active = false
			for (const tab of connections.values()) for (const connection of Object.values(tab.connections)) {
				if (connection !== undefined && publicationTokens.has(websiteSocketToString(connection.socket))) publishGnosisSafeAppsCompatibility(connections, connection.socket, false)
			}
			publicationTokens.clear()
			signerAccountDiscoveryTabs.clear()
		},
		connectionApproved(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket) {
			void refreshPort(websiteTabConnections, socket, false).catch(async (error: unknown) => { await reportUnexpectedError(error) })
		},
		connectionDisconnected(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket) {
			if (!publicationTokens.has(websiteSocketToString(socket))) return
			beginPublication(socket)
			publishGnosisSafeAppsCompatibility(websiteTabConnections, socket, false)
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
					if (connection === undefined || !isTopFramePort(connection.port) || (!includeUnapproved && !connection.approved)) continue
					sends.push(refreshPort(websiteTabConnections, connection.socket, false))
				}
			}
			await Promise.all(sends)
		},
	}
}

// The composition root injects these named callbacks; disabled mode retains no coordinator state.
export function createGnosisSafeAppsCompatibilityFeature(connections: WebsiteTabConnections) {
	let coordinator: ReturnType<typeof createGnosisSafeAppsCompatibilityCoordinator> | undefined
	const lifecycle: WebsiteLifecycleCallbacks = {
		approvalChanged: (socket, approved) => approved ? coordinator?.connectionApproved(connections, socket) : coordinator?.connectionDisconnected(connections, socket),
		connectionRemoved: (socket) => coordinator?.connectionRemoved(socket),
		signerConnected: (socket, accountsRequested) => coordinator?.signerConnectionChanged(connections, socket, accountsRequested),
		signerAccountsChanged: (socket) => coordinator?.signerAccountsChanged(connections, socket),
		accessReconciled: () => { void coordinator?.refreshPorts(connections).catch(async (error: unknown) => { await reportUnexpectedError(error) }) },
	}
	const setEnabled = (enabled: boolean) => {
		if (enabled === (coordinator !== undefined)) return
		coordinator?.dispose(connections)
		coordinator = enabled ? createGnosisSafeAppsCompatibilityCoordinator() : undefined
		void coordinator?.refreshPorts(connections, true).catch(async (error: unknown) => { await reportUnexpectedError(error) })
	}
	return { lifecycle, setEnabled, dispose: () => setEnabled(false) }
}

export const initializeGnosisSafeAppsCompatibility = async (feature: Pick<ReturnType<typeof createGnosisSafeAppsCompatibilityFeature>, 'setEnabled' | 'dispose'>) => await initializeFeaturePreference(feature, 'safeAppsCompatibilityMode', getGnosisSafeAppsCompatibilityMode)
