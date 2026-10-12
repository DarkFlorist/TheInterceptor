import type { AddressBookEntries, AddressBookEntryType, ChainIdWithUniversal, EntrySource } from '../types/addressBookTypes.js'

export function getAddressBookEntriesForChainIdMorePreciseFirst(addressBookEntries: AddressBookEntries, chainId: ChainIdWithUniversal) {
	const entries = addressBookEntries.filter((entry) => entry.chainId === chainId || (entry.chainId === undefined && chainId === 1n) || entry.chainId === 'AllChains')
	return entries.sort((x, y) => {
		if (x.entrySource === 'OnChain' && y.entrySource !== 'OnChain') return 1
		if (x.entrySource !== 'OnChain' && y.entrySource === 'OnChain') return -1
		if (typeof x.chainId === 'bigint' && typeof y.chainId !== 'bigint') return -1
		if (typeof x.chainId !== 'bigint' && typeof y.chainId === 'bigint') return 1
		return 0
	})
}

export const ON_CHAIN_TOKEN_METADATA_WARNING = 'The name and symbol for this token was provided by the token itself and we have not validated its legitimacy. A token may claim to have a name/symbol that is the same as another popular token (e.g., USDC or DAI) in an attempt to trick you. If you recognize this token\'s name, please verify elsewhere that this is the correct address for it.'

export const ON_CHAIN_TOKEN_IDENTITY_WARNING = 'This token was discovered on-chain and has not been verified by you or The Interceptor. Please verify elsewhere that this is the correct address for it.'

type TokenWarningEntry = { readonly type: AddressBookEntryType, readonly entrySource: EntrySource }

// The edit dialog asks the user to confirm this warning before saving. Only ERC20 and ERC721 entries read their name and symbol from the token contract.
export function getOnChainTokenMetadataWarning(entry: TokenWarningEntry) {
	if (entry.entrySource !== 'OnChain') return undefined
	if (entry.type !== 'ERC20' && entry.type !== 'ERC721') return undefined
	return ON_CHAIN_TOKEN_METADATA_WARNING
}

// Message for the warning sign on token cards. On-chain ERC1155 entries are labelled with their address and '???' instead of token-provided metadata, so their warning only says the token is unverified.
export function getOnChainTokenWarning(entry: TokenWarningEntry) {
	if (entry.entrySource === 'OnChain' && entry.type === 'ERC1155') return ON_CHAIN_TOKEN_IDENTITY_WARNING
	return getOnChainTokenMetadataWarning(entry)
}
