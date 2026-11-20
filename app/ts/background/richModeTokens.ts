import type { IEthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { Erc1155Entry, Erc20TokenEntry } from '../types/addressBookTypes.js'
import type { ModifyRichTokenRequest } from '../types/interceptor-reply-messages.js'
import type { RichToken } from '../types/richMode.js'
import { discoverErc1155BalanceStorage, discoverErc20BalanceStorageSlot, getDefaultRichTokenAmount, isSupportedRichTokenDecimals, MAX_RICH_TOKEN_AMOUNT, MAX_SUPPORTED_RICH_TOKEN_DECIMALS, sameRichTokenIdentity, verifyErc1155BalanceStorageSlot } from '../utils/richTokens.js'
import { getUserAddressBookEntriesForChainIdMorePreciseFirst } from './addressBookStorage.js'
import { getRichModeState, mutateRichMode, richTokensForPresentation } from './richModeSettings.js'

export type RichTokenChange = ModifyRichTokenRequest['data']
export type RichTokenChangeResult = { readonly success: true, readonly richToken: RichToken | undefined } | { readonly success: false, readonly error: string }
type RichTokenStorageClient = Pick<IEthereumClientService, 'ethSimulateV1'>

// The address-book entry that makes a token eligible for rich mode on chainId: an ERC-20 entry, or an ERC-1155 entry whose watched IDs include tokenId. The most precise chain entry supplies the metadata.
export async function getEligibleAddressBookRichToken(chainId: bigint, tokenAddress: bigint, tokenId: bigint | undefined): Promise<Erc20TokenEntry | Erc1155Entry | undefined> {
	const entries = (await getUserAddressBookEntriesForChainIdMorePreciseFirst(chainId))
		.filter((entry): entry is Erc20TokenEntry | Erc1155Entry => entry.type === 'ERC20' || entry.type === 'ERC1155')
		.filter((entry) => entry.address === tokenAddress)
	if (tokenId === undefined) return entries.find((entry): entry is Erc20TokenEntry => entry.type === 'ERC20')
	const metadataEntry = entries.find((entry): entry is Erc1155Entry => entry.type === 'ERC1155')
	const tokenIdIsWatched = entries.some((entry) => entry.type === 'ERC1155' && entry.watchedTokenIds?.includes(tokenId) === true)
	return tokenIdIsWatched ? metadataEntry : undefined
}

// Finds the balance storage layout of a token being added, through RPC probes. Returns undefined when nothing needs discovering (not an add, an ineligible token, or a layout already stored) or when no layout was found.
export async function discoverRichTokenStorage(ethereum: RichTokenStorageClient, requestAbortController: AbortController | undefined, chainId: bigint, change: RichTokenChange) {
	if (change.action !== 'Add') return undefined
	const identity = { tokenAddress: change.tokenAddress, tokenId: change.tokenId }
	const addressBookToken = await getEligibleAddressBookRichToken(chainId, change.tokenAddress, change.tokenId)
	if (addressBookToken === undefined || (addressBookToken.type === 'ERC20' && !isSupportedRichTokenDecimals(addressBookToken.decimals))) return undefined
	const current = richTokensForPresentation(await getRichModeState())
	if (current.some((token) => token.chainId === chainId && sameRichTokenIdentity(token, identity))) return undefined
	const getErc1155Storage = async () => {
		if (addressBookToken.type !== 'ERC1155' || change.tokenId === undefined) return undefined
		const cachedToken = current.find((token) =>
			token.chainId === chainId
			&& token.tokenAddress === change.tokenAddress
			&& token.tokenType === 'ERC1155'
			&& token.erc1155StorageOrder !== undefined
		)
		if (
			cachedToken?.erc1155StorageOrder !== undefined
			&& await verifyErc1155BalanceStorageSlot(
				ethereum,
				requestAbortController,
				change.tokenAddress,
				change.tokenId,
				cachedToken.balanceSlot,
				cachedToken.erc1155StorageOrder,
			)
		) {
			return { balanceSlot: cachedToken.balanceSlot, storageOrder: cachedToken.erc1155StorageOrder }
		}
		return await discoverErc1155BalanceStorage(ethereum, requestAbortController, change.tokenAddress, change.tokenId)
	}
	const discoveredErc1155Storage = await getErc1155Storage()
	const discoveredStorage = addressBookToken.type === 'ERC20'
		? { balanceSlot: await discoverErc20BalanceStorageSlot(ethereum, requestAbortController, change.tokenAddress), erc1155StorageOrder: undefined }
		: discoveredErc1155Storage === undefined
			? undefined
			: { balanceSlot: discoveredErc1155Storage.balanceSlot, erc1155StorageOrder: discoveredErc1155Storage.storageOrder }
	return discoveredStorage
}

// Applies a rich-token change for one account on chainId and commits it under the rich-mode mutation lock.
export async function applyRichTokenChange(ethereum: RichTokenStorageClient, requestAbortController: AbortController | undefined, chainId: bigint, change: RichTokenChange): Promise<RichTokenChangeResult> {
	const identity = { tokenAddress: change.tokenAddress, tokenId: change.tokenId }
	// RPC probes must not block address-book edits; eligibility and cached layouts are reread under the mutation lock before commit.
	const discoveredStorage = await discoverRichTokenStorage(ethereum, requestAbortController, chainId, change)
	return await mutateRichMode(async (store) => {
		if (change.action === 'Remove') {
			await store.updateRichAccountBalances((profiles) => profiles.map((profile) => profile.chainId === chainId && profile.address === change.address
				? { ...profile, tokenBalances: profile.tokenBalances.filter((balance) => !sameRichTokenIdentity(balance, identity)) }
				: profile))
			return { success: true as const, richToken: undefined }
		}
		if (change.action === 'SetAmount') {
			if (change.amount <= 0n) return { success: false as const, error: 'Token amount must be greater than zero.' }
			if (change.amount > MAX_RICH_TOKEN_AMOUNT) return { success: false as const, error: 'Token amount cannot exceed the maximum uint256 value.' }
			const amount = change.amount
			const richToken = (await store.getRichTokens()).find((token) => token.chainId === chainId && sameRichTokenIdentity(token, identity))
			if (richToken === undefined) return { success: false as const, error: 'Add the token before changing its amount.' }
			const profiles = await store.ensureRichAccountBalances(chainId, [change.address])
			const profile = profiles.find((candidate) => candidate.chainId === chainId && candidate.address === change.address)
			if (profile?.tokenBalances.some((balance) => sameRichTokenIdentity(balance, identity)) !== true) {
				return { success: false as const, error: 'Add the token to this account before changing its amount.' }
			}
			await store.updateRichAccountBalances((profiles) => profiles.map((profile) => profile.chainId === chainId && profile.address === change.address
				? { ...profile, tokenBalances: profile.tokenBalances.map((balance) => sameRichTokenIdentity(balance, identity) ? { ...balance, amount } : balance) }
				: profile))
			return { success: true as const, richToken }
		}

		const addTokenToAccount = async (richToken: RichToken) => {
			await store.ensureRichAccountBalances(chainId, [change.address])
			await store.updateRichAccountBalances((profiles) => profiles.map((profile) => {
				if (profile.chainId !== chainId || profile.address !== change.address) return profile
				if (profile.tokenBalances.some((balance) => sameRichTokenIdentity(balance, identity))) return profile
				return { ...profile, tokenBalances: [...profile.tokenBalances, { ...identity, amount: richToken.amount }] }
			}))
		}

		const addressBookToken = await getEligibleAddressBookRichToken(chainId, change.tokenAddress, change.tokenId)
		if (addressBookToken === undefined) {
			await store.updateRichTokens((tokens) => tokens.filter((token) => token.chainId !== chainId || !sameRichTokenIdentity(token, identity)))
			return { success: false as const, error: 'Choose an ERC-20 token or watched ERC-1155 token ID from the address book for the active chain.' }
		}
		if (addressBookToken.type === 'ERC20' && !isSupportedRichTokenDecimals(addressBookToken.decimals)) {
			return { success: false as const, error: `ERC-20 decimals cannot exceed ${ MAX_SUPPORTED_RICH_TOKEN_DECIMALS.toString() } in rich mode.` }
		}
		const current = await store.getRichTokens()
		const existing = current.find((token) => token.chainId === chainId && sameRichTokenIdentity(token, identity))
		if (existing !== undefined) {
			await addTokenToAccount(existing)
			return { success: true as const, richToken: existing }
		}

		if (discoveredStorage === undefined || discoveredStorage.balanceSlot === undefined) {
			return { success: false as const, error: 'The token uses an unsupported balance storage layout. No verified balance slot was found in the first 64 storage positions.' }
		}
		const richToken = {
			chainId,
			tokenAddress: change.tokenAddress,
			tokenType: addressBookToken.type,
			tokenId: change.tokenId,
			name: addressBookToken.name,
			symbol: addressBookToken.symbol,
			decimals: addressBookToken.type === 'ERC20' ? addressBookToken.decimals : 0n,
			amount: getDefaultRichTokenAmount(addressBookToken.type === 'ERC20' ? addressBookToken.decimals : 0n),
			balanceSlot: discoveredStorage.balanceSlot,
			erc1155StorageOrder: discoveredStorage.erc1155StorageOrder,
		}
		await store.updateRichTokens((tokens) => tokens.some((token) => token.chainId === chainId && sameRichTokenIdentity(token, identity)) ? tokens : [...tokens, richToken])
		await addTokenToAccount(richToken)
		return { success: true as const, richToken }
	}, chainId, [change.address])
}
