import { signingOperationError, isSigningOperationError } from '../signing/signingOperationError.js'
import type { SigningPageReply } from '../types/signingPageReply.js'
import type { SigningPageRequest } from '../types/directSigning.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { matchesBrowserSigningWallet } from '../signing/browserWallet.js'
import { getAddressBookAndSigningWalletBindings, getAllTabStates, saveAddressSigningWallet } from './storageVariables.js'

export async function getSigningWallets(): Promise<SigningPageReply> {
	const data = await getAddressBookAndSigningWalletBindings()
	return { ok: true, bindings: data.signingWalletBindings, tabs: await getAllTabStates() }
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
