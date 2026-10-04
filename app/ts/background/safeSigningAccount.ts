import type { Settings } from '../types/interceptor-messages.js'
import { getUserAddressBookEntriesForChainIdMorePreciseFirst } from './addressBookStore.js'

/** Owner approval and the separate outer transaction payer remain distinct from the Safe address. */
export async function getSavedSafeSigningAccount(safeAddress: bigint | undefined, chainId: bigint) {
	if (safeAddress === undefined) return undefined
	// Resolve chain precedence before checking classification; a shadowed Safe cannot supply an owner.
	const entry = (await getUserAddressBookEntriesForChainIdMorePreciseFirst(chainId)).find((item) => item.address === safeAddress)
	return entry?.type === 'safe' ? entry.safeSigningSignerAddress : undefined
}

/** Reads saved Safe ownership on the caller’s chain snapshot; saved selections do not follow browser-wallet account changes. */
export async function hasPinnedSigningAddress(settings: Pick<Settings, 'selectedSigningAddress' | 'activeSigningSafeAddress' | 'activeRpcNetwork'>) {
	return settings.selectedSigningAddress !== undefined || settings.activeSigningSafeAddress !== undefined && await getSavedSafeSigningAccount(settings.activeSigningSafeAddress, settings.activeRpcNetwork.chainId) !== undefined
}
