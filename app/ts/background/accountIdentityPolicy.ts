import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { Settings } from '../types/interceptor-messages.js'
import type { WebsiteSocket } from '../utils/requests.js'
import { getSignerExecutionOwner, getSignerExecutionError } from './signerExecutionAuthority.js'

export function usesSignerAccountIdentity(settings: Pick<Settings, 'simulationMode' | 'useSignersAddressAsActiveAddress'>) {
	return !settings.simulationMode || settings.useSignersAddressAsActiveAddress
}

// Simulation identities are chosen by the user independently of wallets. Wallet-derived identities require this frame's current signer reconciliation.
export function getSignerAccountIdentityError(websiteTabConnections: WebsiteTabConnections, settings: Pick<Settings, 'simulationMode' | 'useSignersAddressAsActiveAddress'>, socket: WebsiteSocket) {
	return usesSignerAccountIdentity(settings) ? getSignerExecutionError(getSignerExecutionOwner(websiteTabConnections, socket.tabId), socket) : undefined
}

export function getFrameVisibleAccounts(websiteTabConnections: WebsiteTabConnections, settings: Pick<Settings, 'simulationMode' | 'useSignersAddressAsActiveAddress'>, socket: WebsiteSocket, accounts: readonly bigint[]) {
	return getSignerAccountIdentityError(websiteTabConnections, settings, socket) === undefined ? accounts : []
}
