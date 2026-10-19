import type { AddressBookEntryType, EntrySource } from '../types/addressBookTypes.js'
import { assertNever } from './typescript.js'

export type OnChainTokenEntry = { readonly type: AddressBookEntryType, readonly entrySource: EntrySource }

// What labels an on-chain token entry without verification: ERC20 and ERC721 entries show the name and symbol the token contract reports, while ERC1155 entries show their address and '???'. Undefined for entries that are not on-chain tokens. The switch is exhaustive, so a new entry type fails to compile until it is classified here.
export function getUnverifiedOnChainTokenLabel(entry: OnChainTokenEntry): 'tokenProvidedNameAndSymbol' | 'addressOnly' | undefined {
	if (entry.entrySource !== 'OnChain') return undefined
	switch (entry.type) {
		case 'ERC20':
		case 'ERC721': return 'tokenProvidedNameAndSymbol'
		case 'ERC1155': return 'addressOnly'
		case 'contact':
		case 'contract':
		case 'safe': return undefined
		default: return assertNever(entry.type)
	}
}

// The edit dialog asks the user to confirm a token-provided name and symbol before saving them.
export const requiresOnChainTokenMetadataConfirmation = (entry: OnChainTokenEntry) => getUnverifiedOnChainTokenLabel(entry) === 'tokenProvidedNameAndSymbol'
