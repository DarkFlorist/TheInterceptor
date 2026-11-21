import type { AddressBookEntries, AddressBookEntry, SafeEntry } from '../types/addressBookTypes.js'

// Which accounts act for the active address in signing mode. The signing owner signs the Safe's approvals and the executor sends its outer transaction; for an ordinary address both are the wallet account.
export type SafeSigningPlan = { readonly signingOwner: bigint | undefined, readonly executor: bigint | undefined }

// The one fallback rule: a Safe's saved signing owner, else the account selected in the wallet; its saved execution account, else that signing owner.
export function resolveSafeSigningPlan(safeEntry: SafeEntry | undefined, walletSelectedAccount: bigint | undefined): SafeSigningPlan {
	const signingOwner = safeEntry?.safeSigningSignerAddress ?? walletSelectedAccount
	return { signingOwner, executor: safeEntry?.safeExecutionAddress ?? signingOwner }
}

export const getSafeEntry = (entry: AddressBookEntry | undefined) => entry?.type === 'safe' ? entry : undefined

// The Safe saved at an address on a chain. Classification is checked before the address, so a contact or contract entry at the same address never hides the Safe and its signing checks.
export const findSafeEntry = (entries: AddressBookEntries, address: bigint, chainId: bigint) => entries.find((entry): entry is SafeEntry => entry.type === 'safe' && entry.address === address && entry.chainId === chainId)
