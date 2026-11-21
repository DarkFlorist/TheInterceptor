import type { Settings } from '../types/interceptor-messages.js'
import { getUserAddressBookEntriesForChainIdMorePreciseFirst } from './addressBookStore.js'
import { findSafeEntry } from '../safe/safeSigningPlan.js'

/** Owner approval and the separate outer transaction payer remain distinct from the Safe address. */
// The saved Safe entry of an active address on a chain, the one input resolveSafeSigningPlan reads from the address book. A contact or contract entry at the same address does not hide it.
export async function getConfiguredSafeEntry(address: bigint | undefined, chainId: bigint) {
	if (address === undefined) return undefined
	return findSafeEntry(await getUserAddressBookEntriesForChainIdMorePreciseFirst(chainId), address, chainId)
}

export async function getSavedSafeSigningAccount(safeAddress: bigint | undefined, chainId: bigint) {
	return (await getConfiguredSafeEntry(safeAddress, chainId))?.safeSigningSignerAddress
}

/** Reads saved Safe ownership on the caller’s chain snapshot; saved selections do not follow browser-wallet account changes. */
export async function hasPinnedSigningAddress(settings: Pick<Settings, 'selectedSigningAddress' | 'activeSigningSafeAddress' | 'activeRpcNetwork'>) {
	return settings.selectedSigningAddress !== undefined || settings.activeSigningSafeAddress !== undefined && await getSavedSafeSigningAccount(settings.activeSigningSafeAddress, settings.activeRpcNetwork.chainId) !== undefined
}
