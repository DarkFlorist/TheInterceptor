import { discoverErc1155BalanceStorage, discoverErc20BalanceStorageSlot, verifyErc1155BalanceStorageSlot } from '../simulation/richTokenStorageDiscovery.js'
import type { IEthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { ModifyRichTokenRequest } from '../types/interceptor-reply-messages.js'
import { richFundingRejected, richFundingSaved, type RichFundingResult, type RichToken } from '../types/richMode.js'
import { getDefaultRichTokenAmount, getRichTokenEligibility, MAX_RICH_TOKEN_AMOUNT, MAX_SUPPORTED_RICH_TOKEN_DECIMALS, sameRichTokenIdentity } from '../utils/richTokens.js'
import { getUserAddressBookEntries } from './addressBookStorage.js'
import { getRichModeState, mutateRichMode } from './richModeSettings.js'
import { richTokensForPresentation } from '../utils/richModeDerivation.js'

export type RichTokenChange = ModifyRichTokenRequest['data']
type RichTokenStorageClient = Pick<IEthereumClientService, 'ethSimulateV1'>

// The active-chain eligibility of a token, by the shared rule in utils/richTokens.
export const getRichTokenEligibilityFromAddressBook = async (chainId: bigint, token: Pick<RichToken, 'tokenAddress' | 'tokenId'>) => getRichTokenEligibility(await getUserAddressBookEntries(), chainId, token)

// Finds the balance storage layout of a token being added, through RPC probes. Returns undefined when nothing needs discovering (not an add, an ineligible token, or a layout already stored) or when no layout was found.
export async function discoverRichTokenStorage(ethereum: RichTokenStorageClient, requestAbortController: AbortController | undefined, chainId: bigint, change: RichTokenChange) {
	if (change.action !== 'Add') return undefined
	const identity = { tokenAddress: change.tokenAddress, tokenId: change.tokenId }
	const eligibility = await getRichTokenEligibilityFromAddressBook(chainId, identity)
	if (!eligibility.eligible) return undefined
	const addressBookToken = eligibility.metadataEntry
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
export async function applyRichTokenChange(ethereum: RichTokenStorageClient, requestAbortController: AbortController | undefined, chainId: bigint, change: RichTokenChange): Promise<RichFundingResult> {
	const identity = { tokenAddress: change.tokenAddress, tokenId: change.tokenId }
	// RPC probes must not block address-book edits; eligibility and cached layouts are reread under the mutation lock before commit.
	const discoveredStorage = await discoverRichTokenStorage(ethereum, requestAbortController, chainId, change)
	return await mutateRichMode(async (store) => {
		if (change.action === 'Remove') {
			await store.updateRichAccountBalances((profiles) => profiles.map((profile) => profile.chainId === chainId && profile.address === change.address
				? { ...profile, tokenBalances: profile.tokenBalances.filter((balance) => !sameRichTokenIdentity(balance, identity)) }
				: profile))
			return richFundingSaved(store.isChanged())
		}
		if (change.action === 'SetAmount') {
			if (change.amount <= 0n) return richFundingRejected('Token amount must be greater than zero.')
			if (change.amount > MAX_RICH_TOKEN_AMOUNT) return richFundingRejected('Token amount cannot exceed the maximum uint256 value.')
			const amount = change.amount
			const richToken = (await store.getRichTokens()).find((token) => token.chainId === chainId && sameRichTokenIdentity(token, identity))
			if (richToken === undefined) return richFundingRejected('Add the token before changing its amount.')
			const profiles = await store.ensureRichAccountBalances(chainId, [change.address])
			const profile = profiles.find((candidate) => candidate.chainId === chainId && candidate.address === change.address)
			if (profile?.tokenBalances.some((balance) => sameRichTokenIdentity(balance, identity)) !== true) {
				return richFundingRejected('Add the token to this account before changing its amount.')
			}
			await store.updateRichAccountBalances((profiles) => profiles.map((profile) => profile.chainId === chainId && profile.address === change.address
				? { ...profile, tokenBalances: profile.tokenBalances.map((balance) => sameRichTokenIdentity(balance, identity) ? { ...balance, amount } : balance) }
				: profile))
			return richFundingSaved(store.isChanged(), richToken)
		}

		const addTokenToAccount = async (richToken: RichToken) => {
			await store.ensureRichAccountBalances(chainId, [change.address])
			await store.updateRichAccountBalances((profiles) => profiles.map((profile) => {
				if (profile.chainId !== chainId || profile.address !== change.address) return profile
				if (profile.tokenBalances.some((balance) => sameRichTokenIdentity(balance, identity))) return profile
				return { ...profile, tokenBalances: [...profile.tokenBalances, { ...identity, amount: richToken.amount }] }
			}))
		}

		const eligibility = await getRichTokenEligibilityFromAddressBook(chainId, identity)
		if (!eligibility.eligible) {
			if (eligibility.reason === 'UnsupportedDecimals') return richFundingRejected(`ERC-20 decimals cannot exceed ${ MAX_SUPPORTED_RICH_TOKEN_DECIMALS.toString() } in rich mode.`)
			await store.updateRichTokens((tokens) => tokens.filter((token) => token.chainId !== chainId || !sameRichTokenIdentity(token, identity)))
			return richFundingRejected('Choose an ERC-20 token or watched ERC-1155 token ID from the address book for the active chain.')
		}
		const addressBookToken = eligibility.metadataEntry
		const current = await store.getRichTokens()
		const existing = current.find((token) => token.chainId === chainId && sameRichTokenIdentity(token, identity))
		if (existing !== undefined) {
			await addTokenToAccount(existing)
			return richFundingSaved(store.isChanged(), existing)
		}

		if (discoveredStorage === undefined || discoveredStorage.balanceSlot === undefined) {
			return richFundingRejected('The token uses an unsupported balance storage layout. No verified balance slot was found in the first 64 storage positions.')
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
		return richFundingSaved(store.isChanged(), richToken)
	})
}
