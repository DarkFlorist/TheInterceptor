import { matchesBrowserSigningWallet } from '../signing/browserWallet.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { getSafeContractState } from '../safe/safeCore.js'
import { saveSafeSigningAccounts } from './storageVariables.js'
import { SigningPageRequest, DirectSigningRecord } from '../types/directSigning.js'
import { SigningWalletBindings } from '../types/signingWallet.js'
import { TabState } from '../types/user-interface-types.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import { getAddressBookAndSigningWalletBindings, getAllTabStates, saveAddressSigningWallet } from './storageVariables.js'
import { updateDirectSigning, refreshDirectSigningReview } from './directSigning.js'
import { resolvePendingTransactionOrMessage, updateConfirmTransactionView } from './windows/confirmTransaction.js'

export async function signingPageHandler(raw: unknown, ethereum: EthereumClientService, prices: TokenPriceService, connections: WebsiteTabConnections) {
	try {
		const request = SigningPageRequest.parse(raw)
		if (request.method === 'signing_wallets') {
			const data = await getAddressBookAndSigningWalletBindings()
			return { ok: true, bindings: SigningWalletBindings.serialize(data.signingWalletBindings), tabs: (await getAllTabStates()).map((tab) => TabState.serialize(tab)) }
		}
		if (request.method === 'signing_setSafeAccounts') {
			if (request.chainId !== ethereum.getChainId()) throw new Error('Return to this Safe’s network before changing its signing accounts')
			const state = await getSafeContractState(ethereum, request.address)
			if (request.chainId !== ethereum.getChainId()) throw new Error('Return to this Safe’s network before changing its signing accounts')
			await saveSafeSigningAccounts(request.chainId, request.address, request.owner, request.executor, state.owners)
			await sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
			return { ok: true }
		}
		if (request.method === 'signing_saveWallet') {
			if (request.wallet?.type === 'browser') {
				const wallet = request.wallet
				if (!(await getAllTabStates()).some((tab) => tab.signerConnected && matchesBrowserSigningWallet(wallet, tab) && tab.signerAccounts.includes(request.address))) throw new Error('Connect the browser wallet and select this account before saving it')
			}
			await saveAddressSigningWallet(request.address, request.wallet, request.revision, request.name)
			await sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
			return { ok: true }
		}
		const record = await updateDirectSigning(request)
		if (request.method === 'signing_editFees') {
			await refreshDirectSigningReview(record, ethereum, prices)
			await updateConfirmTransactionView(ethereum, prices)
		}
		if (record.phase === 'cancelled') {
			await resolvePendingTransactionOrMessage(ethereum, prices, connections, { method: 'popup_confirmDialog', data: { action: 'reject', errorString: undefined, uniqueRequestIdentifier: record.request } })
		} else if (record.input.method === 'eth_sendTransaction' ? ['submitted', 'confirmed'].includes(record.phase) : record.phase === 'signed') {
			await resolvePendingTransactionOrMessage(ethereum, prices, connections, { method: 'popup_confirmDialog', data: { action: 'signerIncluded', uniqueRequestIdentifier: record.request, signerReply: record.input.method === 'eth_sendTransaction' ? record.transactionHash : record.result } })
		}
		return { ok: true, record: DirectSigningRecord.serialize(record) }
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : 'Signing operation failed' }
	}
}
