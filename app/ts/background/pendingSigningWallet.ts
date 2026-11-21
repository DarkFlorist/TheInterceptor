import { getCreatedSafeProposal } from '../safe/safePendingFlow.js'
import type { PendingTransactionSafeFlow } from '../types/accessRequest.js'
import { getSigningWalletBinding, getSigningWalletBindings } from './signingWalletStore.js'
import { isActiveAddressSigningDirectly } from '../utils/requestRouting.js'
import type { AddressBookEntry } from '../types/addressBookTypes.js'

// The signing wallet of a pending transaction's signer: a created Safe proposal's owner, else the account that sends the transaction (a direct Safe execution's execution account, or the active address). It is resolved again whenever the Safe flow changes, so a proposal formed or given an owner by a refresh picks up that owner's Ledger or AirGap wallet. Simulation needs no signing wallet.
export async function getPendingTransactionSigningWalletBinding(pending: { readonly simulationMode: boolean, readonly safeFlow: PendingTransactionSafeFlow, readonly activeAddress: bigint }) {
	if (pending.simulationMode) return undefined
	return await getSigningWalletBinding(getCreatedSafeProposal(pending.safeFlow)?.safeSignerAddress ?? pending.activeAddress)
}

// The background's answer to whether the active address signs directly, from the same reconciled bindings the popup is sent, so the toolbar tooltip and the popup banner never disagree.
export async function isActiveAddressSigningDirectlyNow(activeAddress: AddressBookEntry | undefined, walletSelectedAccount: bigint | undefined) {
	return isActiveAddressSigningDirectly(activeAddress, await getSigningWalletBindings(), walletSelectedAccount)
}
