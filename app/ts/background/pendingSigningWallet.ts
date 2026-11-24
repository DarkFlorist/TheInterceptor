import { getSafeFlowSignerAddress, getSafePendingFlow } from '../safe/safePendingFlow.js'
import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import { getSigningWalletBinding, readEligibleSigningWalletBindings } from './signingWalletStore.js'
import { isActiveAddressSigningDirectly } from '../utils/requestRouting.js'
import type { AddressBookEntry } from '../types/addressBookTypes.js'

// The account whose signing wallet a pending request carries: the signer of its Safe flow as getSafeFlowSignerAddress names it (a created proposal's owner, a direct execution's execution account, a message co-sign's owner), else the account that sends a transaction or that a message was created for.
export function getPendingRequestSigner(pending: PendingTransactionOrSignableMessage) {
	const safeFlow = getSafePendingFlow(pending)
	if (safeFlow !== undefined) return getSafeFlowSignerAddress(safeFlow)
	return pending.type === 'Transaction' ? pending.activeAddress : pending.signedMessageTransaction.fakeSignedFor
}

// The signing wallet of a pending request's signer. It is resolved again whenever the signer can change (a Safe proposal formed or given an owner, a Safe execution or message co-sign refreshed to another owner), so the stored wallet always belongs to the stored signer. Simulation needs no signing wallet.
export async function getPendingRequestSigningWalletBinding(pending: PendingTransactionOrSignableMessage) {
	if (pending.simulationMode) return undefined
	const signer = getPendingRequestSigner(pending)
	return signer === undefined ? undefined : await getSigningWalletBinding(signer)
}

// The background's answer to whether the active address signs directly, from the same reconciled bindings the popup is sent, so the toolbar tooltip and the popup banner never disagree. The toolbar icon updates per tab, so this reads without the settings storage lock.
export async function isActiveAddressSigningDirectlyNow(activeAddress: AddressBookEntry | undefined, walletSelectedAccount: bigint | undefined) {
	return isActiveAddressSigningDirectly(activeAddress, await readEligibleSigningWalletBindings(), walletSelectedAccount)
}
