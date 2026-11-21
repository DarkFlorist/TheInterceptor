import { getCreatedSafeProposal } from '../safe/safePendingFlow.js'
import type { PendingTransactionSafeFlow } from '../types/accessRequest.js'
import type { SafeMessageCoSignSnapshot } from '../types/safeTypes.js'
import { getSigningWalletBinding, readEligibleSigningWalletBindings } from './signingWalletStore.js'
import { isActiveAddressSigningDirectly } from '../utils/requestRouting.js'
import type { AddressBookEntry } from '../types/addressBookTypes.js'

type PendingSigner =
	| { readonly type: 'Transaction', readonly simulationMode: boolean, readonly safeFlow: PendingTransactionSafeFlow, readonly activeAddress: bigint }
	| { readonly type: 'SignableMessage', readonly simulationMode: boolean, readonly signedMessageTransaction: { readonly fakeSignedFor: bigint }, readonly safeMessageCoSignSnapshot?: Pick<SafeMessageCoSignSnapshot, 'safeSignerAddress'> }

// The account that signs a pending request. A transaction: a created Safe proposal's owner, else the account that sends it (a direct Safe execution's execution account, or the active address). A message: the Safe co-sign snapshot's owner, else the account it was created for.
const getPendingSigner = (pending: PendingSigner) => pending.type === 'Transaction'
	? getCreatedSafeProposal(pending.safeFlow)?.safeSignerAddress ?? pending.activeAddress
	: pending.safeMessageCoSignSnapshot?.safeSignerAddress ?? pending.signedMessageTransaction.fakeSignedFor

// The signing wallet of a pending request's signer. It is resolved again whenever the signer can change (a Safe proposal formed or given an owner, a Safe execution or message co-sign refreshed to another owner), so the stored wallet always belongs to the stored signer. Simulation needs no signing wallet.
export async function getPendingRequestSigningWalletBinding(pending: PendingSigner) {
	if (pending.simulationMode) return undefined
	return await getSigningWalletBinding(getPendingSigner(pending))
}

// The background's answer to whether the active address signs directly, from the same reconciled bindings the popup is sent, so the toolbar tooltip and the popup banner never disagree. The toolbar icon updates per tab, so this reads without the settings storage lock.
export async function isActiveAddressSigningDirectlyNow(activeAddress: AddressBookEntry | undefined, walletSelectedAccount: bigint | undefined) {
	return isActiveAddressSigningDirectly(activeAddress, await readEligibleSigningWalletBindings(), walletSelectedAccount)
}
