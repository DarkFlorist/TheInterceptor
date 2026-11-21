import type { AddressBookEntry, SafeEntry } from '../types/addressBookTypes.js'

// Which accounts act for the active address in signing mode. The signing owner signs the Safe's approvals and the executor sends its outer transaction; for an ordinary address both are the wallet account.
export type SafeSigningPlan = { readonly signingOwner: bigint | undefined, readonly executor: bigint | undefined }

// The one fallback rule: a Safe's saved signing owner, else the account selected in the wallet; its saved execution account, else that signing owner.
export function resolveSafeSigningPlan(safeEntry: SafeEntry | undefined, walletSelectedAccount: bigint | undefined): SafeSigningPlan {
	const signingOwner = safeEntry?.safeSigningSignerAddress ?? walletSelectedAccount
	return { signingOwner, executor: safeEntry?.safeExecutionAddress ?? signingOwner }
}

export const getSafeEntry = (entry: AddressBookEntry | undefined) => entry?.type === 'safe' ? entry : undefined
