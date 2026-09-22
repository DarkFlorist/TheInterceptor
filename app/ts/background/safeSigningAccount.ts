import { getUserAddressBookEntriesForChainIdMorePreciseFirst } from './storageVariables.js'
import { getSettings } from './settings.js'

/** Owner approval and the separate outer transaction payer remain distinct from the Safe address. */
export async function getSavedSafeSigningAccount(safeAddress?: bigint, chainId?: bigint) {
	const settings = await getSettings()
	const address = safeAddress ?? settings.activeSigningSafeAddress
	if (address === undefined) return undefined
	const entry = (await getUserAddressBookEntriesForChainIdMorePreciseFirst(chainId ?? settings.activeRpcNetwork.chainId)).find((item) => item.type === 'safe' && item.address === address)
	return entry?.type === 'safe' ? entry.safeSigningSignerAddress : undefined
}
