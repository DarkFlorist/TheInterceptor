import type { Settings } from '../types/interceptor-messages.js'
import type { WebsiteSocket } from '../utils/requests.js'
import { getSignerExecutionError } from './signerExecutionAuthority.js'

export function usesSignerAccountIdentity(settings: Pick<Settings, 'simulationMode' | 'useSignersAddressAsActiveAddress'>) {
	return !settings.simulationMode || settings.useSignersAddressAsActiveAddress
}

// Simulation identities are chosen by the user independently of wallets. Wallet-derived identities require this frame's current signer reconciliation.
export function getSignerAccountIdentityError(settings: Pick<Settings, 'simulationMode' | 'useSignersAddressAsActiveAddress'>, socket: WebsiteSocket) {
	return usesSignerAccountIdentity(settings) ? getSignerExecutionError(socket) : undefined
}

export function getFrameVisibleAccounts(settings: Pick<Settings, 'simulationMode' | 'useSignersAddressAsActiveAddress'>, socket: WebsiteSocket, accounts: readonly bigint[]) {
	return getSignerAccountIdentityError(settings, socket) === undefined ? accounts : []
}
