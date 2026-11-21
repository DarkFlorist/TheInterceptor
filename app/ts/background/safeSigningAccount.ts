import type { Settings } from '../types/interceptor-messages.js'
import { getUserAddressBookEntriesForChainIdMorePreciseFirst } from './addressBookStore.js'
import { findSafeEntry, getSafeEntry } from '../utils/safeSigningPlan.js'
import { findActiveAddressBookEntryForChain, getActiveSigningAddress } from '../utils/activeAddressSelection.js'

/** Owner approval and the separate outer transaction payer remain distinct from the Safe address. */
// The saved Safe entry of an active address on a chain, the one input resolveSafeSigningPlan reads from the address book. A contact or contract entry at the same address does not hide it.
export async function getConfiguredSafeEntry(address: bigint | undefined, chainId: bigint) {
	if (address === undefined) return undefined
	return findSafeEntry(await getUserAddressBookEntriesForChainIdMorePreciseFirst(chainId), address, chainId)
}

export async function getSavedSafeSigningAccount(safeAddress: bigint | undefined, chainId: bigint) {
	return (await getConfiguredSafeEntry(safeAddress, chainId))?.safeSigningSignerAddress
}

// The Safe a request made in the given mode acts as, by the active selection's kind rather than its address alone. Simulation selects by address, so the entry it resolves (chain precedence, then saved order) decides; signing mode acts as a Safe unless the explicitly selected wallet account is that address. A contact sharing a Safe's address is therefore an ordinary account when it is the selection.
export async function getActiveSelectionSafeEntry(settings: Pick<Settings, 'selectedSigningAddress' | 'activeSigningSafeAddress'>, simulationMode: boolean, activeAddress: bigint, chainId: bigint) {
	const entries = await getUserAddressBookEntriesForChainIdMorePreciseFirst(chainId)
	if (simulationMode) return getSafeEntry(findActiveAddressBookEntryForChain(entries, activeAddress, chainId, 'any'))
	const selection = getActiveSigningAddress(settings)
	if (selection?.type === 'walletAccount' && selection.address === activeAddress) return undefined
	return findSafeEntry(entries, activeAddress, chainId)
}

/** Reads saved Safe ownership on the caller’s chain snapshot; saved selections do not follow browser-wallet account changes. */
export async function hasPinnedSigningAddress(settings: Pick<Settings, 'selectedSigningAddress' | 'activeSigningSafeAddress' | 'activeRpcNetwork'>) {
	return settings.selectedSigningAddress !== undefined || settings.activeSigningSafeAddress !== undefined && await getSavedSafeSigningAccount(settings.activeSigningSafeAddress, settings.activeRpcNetwork.chainId) !== undefined
}
