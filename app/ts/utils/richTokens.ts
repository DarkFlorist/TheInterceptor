import type { AddressBookEntry, Erc1155Entry, Erc20TokenEntry } from '../types/addressBookTypes.js'
import type { StateOverrides } from '../types/ethSimulate-types.js'
import type { Erc1155StorageOrder, RichAccountBalance, RichToken, RichTokenBalance, RichTokenOption } from '../types/richMode.js'
import type { EthereumAddress } from '../types/wire-types.js'
import { encodeAbiValues } from './abiRuntime.js'
import { addressString, bytes32String } from './bigint.js'
import { keccak256 } from './ethereumPrimitives.js'
import { parseUnits } from './ethereumUnits.js'
import { getAddressBookEntriesForChainIdMorePreciseFirst } from './addressBook.js'

const DEFAULT_RICH_TOKEN_COUNT = 200_000n
export const MAX_RICH_TOKEN_AMOUNT = 2n ** 256n - 1n
export const MAX_SUPPORTED_RICH_TOKEN_DECIMALS = 255n
const MAX_DECIMALS_BEFORE_DEFAULT_AMOUNT_EXCEEDS_UINT256 = 71n


export const getDefaultRichTokenAmount = (decimals: bigint) => {
	if (decimals > MAX_DECIMALS_BEFORE_DEFAULT_AMOUNT_EXCEEDS_UINT256) return MAX_RICH_TOKEN_AMOUNT
	const defaultAmount = DEFAULT_RICH_TOKEN_COUNT * 10n ** decimals
	return defaultAmount > MAX_RICH_TOKEN_AMOUNT ? MAX_RICH_TOKEN_AMOUNT : defaultAmount
}

export const isSupportedRichTokenDecimals = (decimals: bigint) => decimals <= MAX_SUPPORTED_RICH_TOKEN_DECIMALS

export const parseRichTokenAmountInput = (value: string, decimals: bigint) => {
	const amount = parseUnits(value, Number(decimals))
	if (amount === undefined || amount <= 0n) return { valid: false as const, reason: 'InvalidAmount' as const }
	if (amount > MAX_RICH_TOKEN_AMOUNT) return { valid: false as const, reason: 'ExceedsUint256' as const }
	return { valid: true as const, amount }
}

export const getMatchingRichTokenOptions = (options: readonly RichTokenOption[], search: string, maximumResults = 50) => {
	const query = search.trim().toLowerCase()
	return options
		.filter((option) => query.length === 0 || [
			option.symbol,
			option.name,
			option.tokenAddress.toString(16),
			addressString(option.tokenAddress),
			option.tokenId?.toString(),
			option.tokenId === undefined ? option.symbol : `${ option.symbol } #${ option.tokenId.toString() }`,
		]
			.some((value) => value?.toLowerCase().includes(query) === true))
		.slice(0, maximumResults)
}

export const getErc20BalanceStorageKey = (owner: EthereumAddress, balanceSlot: bigint) => (
	BigInt(keccak256(encodeAbiValues(['address', 'uint256'], [addressString(owner), balanceSlot])))
)

export const getErc1155BalanceStorageKey = (owner: EthereumAddress, tokenId: bigint, balanceSlot: bigint, storageOrder: Erc1155StorageOrder) => {
	const outerKey = storageOrder === 'TokenIdThenOwner'
		? BigInt(keccak256(encodeAbiValues(['uint256', 'uint256'], [tokenId, balanceSlot])))
		: BigInt(keccak256(encodeAbiValues(['address', 'uint256'], [addressString(owner), balanceSlot])))
	return storageOrder === 'TokenIdThenOwner'
		? BigInt(keccak256(encodeAbiValues(['address', 'uint256'], [addressString(owner), outerKey])))
		: BigInt(keccak256(encodeAbiValues(['uint256', 'uint256'], [tokenId, outerKey])))
}

export const sameRichTokenIdentity = (
	first: Pick<RichToken, 'tokenAddress' | 'tokenId'>,
	second: Pick<RichToken, 'tokenAddress' | 'tokenId'>,
) => first.tokenAddress === second.tokenAddress && first.tokenId === second.tokenId

export const getRichTokenIdentityKey = (token: Pick<RichToken, 'tokenAddress' | 'tokenId'>) => (
	`${ token.tokenAddress.toString() }:${ token.tokenId?.toString() ?? 'erc20' }`
)

export const getRichTokenLabel = (token: Pick<RichToken, 'symbol' | 'tokenId'>) => (
	token.tokenId === undefined ? token.symbol : `${ token.symbol } #${ token.tokenId.toString() }`
)

const normalizeRichTokenBalances = (balances: readonly RichTokenBalance[]) => {
	const normalized = new Map<string, RichTokenBalance>()
	for (const balance of balances) normalized.set(getRichTokenIdentityKey(balance), balance)
	return [...normalized.values()]
}

export const normalizeRichAccountBalances = (profiles: readonly RichAccountBalance[]) => {
	const normalized = new Map<string, RichAccountBalance>()
	for (const profile of profiles) {
		const profileKey = `${ profile.chainId.toString() }:${ profile.address.toString() }`
		const previous = normalized.get(profileKey)
		normalized.set(profileKey, {
			...profile,
			tokenBalances: normalizeRichTokenBalances([...(previous?.tokenBalances ?? []), ...profile.tokenBalances]),
		})
	}
	return [...normalized.values()]
}

export type RichTokenEligibility =
	| { readonly eligible: true, readonly metadataEntry: Erc20TokenEntry | Erc1155Entry }
	| { readonly eligible: false, readonly reason: 'NotInAddressBook' | 'UnsupportedDecimals' }

// The one rich-mode eligibility rule, used by reconciliation, the token options and token changes. On chainId, an ERC-20 is eligible when the most precise ERC-20 entry for its address has supported decimals, and an ERC-1155 token ID when an ERC-1155 entry for its address watches it. The most precise entry of the type supplies the metadata.
export function getRichTokenEligibility(addressBookEntries: readonly AddressBookEntry[], chainId: bigint, token: Pick<RichToken, 'tokenAddress' | 'tokenId'>): RichTokenEligibility {
	const entries = getAddressBookEntriesForChainIdMorePreciseFirst([...addressBookEntries], chainId).filter((entry) => entry.address === token.tokenAddress)
	const tokenId = token.tokenId
	if (tokenId === undefined) {
		const erc20Entry = entries.find((entry): entry is Erc20TokenEntry => entry.type === 'ERC20')
		if (erc20Entry === undefined) return { eligible: false, reason: 'NotInAddressBook' }
		return isSupportedRichTokenDecimals(erc20Entry.decimals) ? { eligible: true, metadataEntry: erc20Entry } : { eligible: false, reason: 'UnsupportedDecimals' }
	}
	const erc1155Entry = entries.find((entry): entry is Erc1155Entry => entry.type === 'ERC1155')
	const tokenIdIsWatched = entries.some((entry) => entry.type === 'ERC1155' && entry.watchedTokenIds?.includes(tokenId) === true)
	return erc1155Entry !== undefined && tokenIdIsWatched ? { eligible: true, metadataEntry: erc1155Entry } : { eligible: false, reason: 'NotInAddressBook' }
}

export const reconcileRichTokenMetadata = (tokens: readonly RichToken[], addressBookEntries: readonly AddressBookEntry[]): readonly RichToken[] => tokens.flatMap((token) => {
	const eligibility = getRichTokenEligibility(addressBookEntries, token.chainId, token)
	if (!eligibility.eligible || eligibility.metadataEntry.type !== token.tokenType) return []
	const metadata = eligibility.metadataEntry
	const decimals = metadata.type === 'ERC20' ? metadata.decimals : 0n
	if (token.name === metadata.name && token.symbol === metadata.symbol && token.decimals === decimals) return [token]
	// Layout metadata controls defaults for future accounts; existing profile amounts remain in base units.
	return [{ ...token, name: metadata.name, symbol: metadata.symbol, decimals, amount: getDefaultRichTokenAmount(decimals) }]
})

// Every ERC-20 address and watched ERC-1155 token ID named by the address book, ERC-20 tokens first, each once.
const getAddressBookTokenIdentities = (addressBookEntries: readonly AddressBookEntry[]) => {
	const erc20Identities = [...new Set(addressBookEntries.flatMap((entry) => entry.type === 'ERC20' ? [entry.address] : []))].map((tokenAddress) => ({ tokenAddress, tokenId: undefined }))
	const erc1155Keys = new Map<string, { tokenAddress: bigint, tokenId: bigint }>()
	for (const entry of addressBookEntries) {
		if (entry.type !== 'ERC1155') continue
		for (const tokenId of entry.watchedTokenIds ?? []) erc1155Keys.set(getRichTokenIdentityKey({ tokenAddress: entry.address, tokenId }), { tokenAddress: entry.address, tokenId })
	}
	return [...erc20Identities, ...erc1155Keys.values()]
}

export const getRichTokenOptions = (chainId: bigint, configuredTokens: readonly RichToken[], addressBookEntries: readonly AddressBookEntry[]): RichTokenOption[] => {
	const configuredOnChain = new Map<string, RichToken>()
	for (const token of configuredTokens) {
		const tokenKey = getRichTokenIdentityKey(token)
		if (token.chainId === chainId && !configuredOnChain.has(tokenKey)) configuredOnChain.set(tokenKey, token)
	}
	return getAddressBookTokenIdentities(addressBookEntries).flatMap((identity): RichTokenOption[] => {
			const eligibility = getRichTokenEligibility(addressBookEntries, chainId, identity)
			if (!eligibility.eligible) return []
			const { metadataEntry } = eligibility
			const tokenId = identity.tokenId
			const configured = configuredOnChain.get(getRichTokenIdentityKey(identity))
			const decimals = metadataEntry.type === 'ERC20' ? metadataEntry.decimals : 0n
			const base = {
				chainId,
				tokenAddress: metadataEntry.address,
				tokenType: metadataEntry.type,
				tokenId,
				name: metadataEntry.name,
				symbol: metadataEntry.symbol,
				decimals,
				logoUri: metadataEntry.logoUri,
			}
			return [configured === undefined
				? {
					...base,
					amount: getDefaultRichTokenAmount(decimals),
					balanceSlot: undefined,
					erc1155StorageOrder: undefined,
					enabled: false,
				}
				: { ...configured, ...base, enabled: true }]
	})
}

export const addRichAccountBalanceOverrides = (
	stateOverrides: StateOverrides,
	accountBalances: readonly RichAccountBalance[],
	richTokens: readonly RichToken[],
): StateOverrides => {
	let result = stateOverrides
	for (const account of accountBalances) {
		const accountKey = addressString(account.address)
		result = { ...result, [accountKey]: { ...result[accountKey], balance: account.nativeAmount } }
		for (const balance of account.tokenBalances) {
			const token = richTokens.find((candidate) => candidate.chainId === account.chainId && sameRichTokenIdentity(candidate, balance))
			if (token === undefined) continue
			const storageKey = token.tokenType === 'ERC20'
				? getErc20BalanceStorageKey(account.address, token.balanceSlot)
				: token.tokenId === undefined || token.erc1155StorageOrder === undefined
					? undefined
					: getErc1155BalanceStorageKey(account.address, token.tokenId, token.balanceSlot, token.erc1155StorageOrder)
			if (storageKey === undefined) continue
			const tokenKey = addressString(token.tokenAddress)
			const existingOverride = result[tokenKey]
			result = {
				...result,
				[tokenKey]: {
					...existingOverride,
					stateDiff: { ...existingOverride?.stateDiff, [bytes32String(storageKey)]: balance.amount },
				},
			}
		}
	}
	return result
}
