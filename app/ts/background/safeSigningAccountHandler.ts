import { signingOperationError, isSigningOperationError } from '../signing/signingOperationError.js'
import type { SigningPageReply } from '../types/signingPageReply.js'
import type { SigningPageRequest } from '../types/directSigning.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { getSafeContractState } from '../safe/safeCore.js'
import { saveSafeSigningAccounts } from './signingAddressBookCoordinator.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'

export async function setSafeSigningAccounts(request: Extract<SigningPageRequest, { method: 'signing_setSafeAccounts' }>, ethereum: EthereumClientService): Promise<SigningPageReply> {
	try {
		if (request.chainId !== ethereum.getChainId()) throw signingOperationError('Return to this Safe’s network before changing its signing accounts')
		const state = await getSafeContractState(ethereum, request.address)
		if (request.chainId !== ethereum.getChainId()) throw signingOperationError('Return to this Safe’s network before changing its signing accounts')
		await saveSafeSigningAccounts(request.chainId, request.address, request.owner, request.executor, state.owners)
		await sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
		return { ok: true }
	} catch (error) {
		if (!isSigningOperationError(error)) throw error
		return { ok: false, message: error.message }
	}
}
