import type { Settings } from '../types/interceptor-messages.js'
import type { WebsiteSocket } from '../utils/requests.js'
import { getSignerExecutionError } from './signerExecutionAuthority.js'

// Simulation identities are chosen by the user independently of wallets. Wallet-derived identities require this frame's current signer reconciliation.
export function getSignerAccountIdentityError(settings: Pick<Settings, 'simulationMode' | 'useSignersAddressAsActiveAddress'>, socket: WebsiteSocket) {
	return !settings.simulationMode || settings.useSignersAddressAsActiveAddress ? getSignerExecutionError(socket) : undefined
}

export function getFrameVisibleAccounts(settings: Pick<Settings, 'simulationMode' | 'useSignersAddressAsActiveAddress'>, socket: WebsiteSocket, accounts: readonly bigint[]) {
	return getSignerAccountIdentityError(settings, socket) === undefined ? accounts : []
}
