import type { AddressBookEntry } from '../types/addressBookTypes.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { Settings } from '../types/interceptor-messages.js'
import type { WebsiteSocket } from '../utils/requests.js'
import { getConfiguredGnosisSafeAddressForMode, resolveConfiguredGnosisSafeForMode } from '../utils/activeAddressSelection.js'
import { getWebsiteSocketConnection, isTopFramePort } from './backgroundUtils.js'
import { getTabState, getUserAddressBookEntriesForChainIdMorePreciseFirst } from './storageVariables.js'
import { getWebsiteActiveAddress } from './websiteActiveAddress.js'
import { hasAddressAccess } from './websiteAccessPolicy.js'

// Request execution keeps the router's validated account decision instead of selecting another account during secondary-protocol admission.
export function isGnosisSafeAppsConnectionEligibleForAdmittedAddress(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, settings: Settings, admittedAddress: { readonly activeAddress: AddressBookEntry, readonly safeSigningMode: boolean }) {
	const connection = getWebsiteSocketConnection(websiteTabConnections, socket)
	if (connection?.approved !== true || !isTopFramePort(connection.port)) return false
	const { activeAddress, safeSigningMode } = admittedAddress
	return activeAddress.type === 'safe' && activeAddress.chainId === settings.activeRpcNetwork.chainId && activeAddress.address === getConfiguredGnosisSafeAddressForMode(settings) && (settings.simulationMode || safeSigningMode) && hasAddressAccess(settings.websiteAccess, connection.websiteOrigin, activeAddress) === 'hasAccess'
}

// Capability discovery resolves configuration and signer ownership itself, before the request router has admitted an account.
export async function isGnosisSafeAppsConnectionEligible(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, settings: Settings) {
	const connection = getWebsiteSocketConnection(websiteTabConnections, socket)
	if (connection?.approved !== true || !isTopFramePort(connection.port)) return false
	const [activeAddress, tabState, entries] = await Promise.all([
		getWebsiteActiveAddress(websiteTabConnections, connection.websiteOrigin, settings, socket),
		getTabState(socket.tabId),
		getUserAddressBookEntriesForChainIdMorePreciseFirst(settings.activeRpcNetwork.chainId),
	])
	const configured = resolveConfiguredGnosisSafeForMode(settings, entries, tabState.signerAccounts)
	return configured !== undefined && activeAddress?.type === 'safe' && activeAddress.address === configured.address && activeAddress.chainId === configured.chainId
}
