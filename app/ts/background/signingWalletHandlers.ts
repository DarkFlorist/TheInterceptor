import { signingOperationError, isSigningOperationError } from '../signing/signingOperationError.js'
import type { SigningPageReply } from '../types/signingPageReply.js'
import type { SigningPageRequest } from '../types/directSigning.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { browserWalletProviderId, matchesBrowserSigningWallet } from '../signing/browserWallet.js'
import { saveAddressSigningWallet } from './signingAddressBookCoordinator.js'
import { getAddressBookAndSigningWalletBindings, getSigningWalletBindings } from './signingWalletStore.js'
import { getAllTabStates } from './storageVariables.js'

// Reads no tab state, so pages that only label addresses with their wallets do not pay for every tab's browser wallet state.
export async function getSigningWalletBindingsReply(): Promise<SigningPageReply> {
	return { ok: true, bindings: await getSigningWalletBindings() }
}

// The setup page links an address to a connected browser wallet, so it gets each connected wallet's identity and accounts, and whether any provider claims an ambiguous identity.
export async function getSigningWallets(): Promise<SigningPageReply> {
	const [data, tabs] = await Promise.all([getAddressBookAndSigningWalletBindings(), getAllTabStates()])
	const browserWallets = tabs.flatMap((tab) => {
		const providerId = browserWalletProviderId(tab)
		return !tab.signerConnected || providerId === undefined ? [] : [{ tabId: tab.tabId, signerName: tab.signerName, providerId, label: tab.signerProvider?.rdns ?? tab.signerName, accounts: tab.signerAccounts }]
	})
	return { ok: true, bindings: data.signingWalletBindings, browserWallets, ambiguousBrowserWalletIdentity: tabs.some((tab) => tab.signerProvider?.ambiguous === true) }
}

export async function saveSigningWallet(request: Extract<SigningPageRequest, { method: 'signing_saveWallet' }>): Promise<SigningPageReply> {
	try {
		if (request.wallet?.type === 'browser') {
			const wallet = request.wallet
			if (!(await getAllTabStates()).some((tab) => tab.signerConnected && matchesBrowserSigningWallet(wallet, tab) && tab.signerAccounts.includes(request.address))) throw signingOperationError('Connect the browser wallet and select this account before saving it')
		}
		await saveAddressSigningWallet(request.address, request.wallet, request.revision, request.name)
		await sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
		return { ok: true }
	} catch (error) {
		if (!isSigningOperationError(error)) throw error
		return { ok: false, message: error.message }
	}
}
