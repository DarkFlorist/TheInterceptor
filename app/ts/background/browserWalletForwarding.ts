import { matchesBrowserSigningWallet, prepareBrowserWalletForwarding } from '../signing/browserWallet.js'
import type { SigningWalletBinding } from '../types/signingWallet.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { WebsiteSocket } from '../utils/requests.js'
import { getSigningWalletBinding, getTabState } from './storageVariables.js'
import { askForSignerAccountsFromSignerIfNotAvailable } from './windows/interceptorAccess.js'

/** A saved address can serve eth_accounts without contacting its wallet. Fetch missing wallet accounts only when signing is requested. */
export async function prepareSavedBrowserWalletForwarding(connections: WebsiteTabConnections, socket: WebsiteSocket, binding: SigningWalletBinding, options: Parameters<typeof prepareBrowserWalletForwarding>[2] = {}) {
	if (binding.wallet.type !== 'browser') throw new Error('Expected a browser signing wallet')
	let tab = await getTabState(socket.tabId)
	if ((options.requireSelectedAccount ?? true) && tab.signerAccounts.length === 0 && matchesBrowserSigningWallet(binding.wallet, tab)) {
		const refreshed = await askForSignerAccountsFromSignerIfNotAvailable(connections, socket, true)
		if (refreshed.error !== undefined) return { error: refreshed.error }
		tab = await getTabState(socket.tabId)
	}
	if ((await getSigningWalletBinding(binding.wallet.address))?.revision !== binding.revision) return { error: { code: 4100, message: 'Signing wallet changed. Review a new request with the current wallet.' } }
	return prepareBrowserWalletForwarding(binding.wallet, tab, options)
}
