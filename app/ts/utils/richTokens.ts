import type { IEthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { AddressBookEntry, Erc1155Entry, Erc20TokenEntry } from '../types/addressBookTypes.js'
import type { StateOverrides } from '../types/ethSimulate-types.js'
import type { Erc1155StorageOrder, RichAccountBalance, RichToken, RichTokenBalance, RichTokenOption } from '../types/richMode.js'
import type { EthereumAddress } from '../types/wire-types.js'
import { Erc1155ABI, Erc20ABI } from './abi.js'
import { decodeFunctionOutputSafely, encodeAbiValues, encodeFunctionCall } from './abiRuntime.js'
import { addressString, bytes32String, stringToUint8Array } from './bigint.js'
import { keccak256 } from './ethereumPrimitives.js'
import { parseUnits } from './ethereumUnits.js'

const DEFAULT_RICH_TOKEN_COUNT = 200_000n
export const MAX_RICH_TOKEN_AMOUNT = 2n ** 256n - 1n
export const MAX_SUPPORTED_RICH_TOKEN_DECIMALS = 255n
const MAX_DECIMALS_BEFORE_DEFAULT_AMOUNT_EXCEEDS_UINT256 = 71n
const STORAGE_DISCOVERY_OWNER = 0x000000000000000000000000000000000000deadn
const STORAGE_DISCOVERY_SLOT_LIMIT = 64
const FIRST_STORAGE_DISCOVERY_VALUE = 0x123456789abcdefn
const SECOND_STORAGE_DISCOVERY_VALUE = 0xfedcba987654321n
const STORAGE_DISCOVERY_GAS_LIMIT = 500_000n

type RichTokenEthereumClient = Pick<IEthereumClientService, 'ethSimulateV1'>

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

const getErc20BalanceOfCall = (tokenAddress: EthereumAddress, owner: EthereumAddress) => ({
	to: tokenAddress,
	input: stringToUint8Array(encodeFunctionCall(Erc20ABI, 'balanceOf', [addressString(owner)])),
	gas: STORAGE_DISCOVERY_GAS_LIMIT,
})

const getErc1155BalanceOfCall = (tokenAddress: EthereumAddress, owner: EthereumAddress, tokenId: bigint) => ({
	to: tokenAddress,
	input: stringToUint8Array(encodeFunctionCall(Erc1155ABI, 'balanceOf', [addressString(owner), tokenId])),
	gas: STORAGE_DISCOVERY_GAS_LIMIT,
})

const getBalanceOverride = (tokenAddress: EthereumAddress, storageKey: bigint, amount: bigint): StateOverrides => ({
	[addressString(tokenAddress)]: {
		stateDiff: {
			[bytes32String(storageKey)]: amount,
		},
	},
})

const decodeBalanceOfResult = (abi: typeof Erc20ABI | typeof Erc1155ABI, result: { status: 'success' | 'failure', returnData: Uint8Array }) => {
	if (result.status === 'failure') return undefined
	return decodeFunctionOutputSafely(abi, 'balanceOf', result.returnData, (value): value is bigint => typeof value === 'bigint')
}

export async function verifyErc20BalanceStorageSlot(
	ethereum: RichTokenEthereumClient,
	requestAbortController: AbortController | undefined,
	tokenAddress: EthereumAddress,
	balanceSlot: bigint,
	amount = SECOND_STORAGE_DISCOVERY_VALUE,
) {
	const result = await ethereum.ethSimulateV1([{
		calls: [getErc20BalanceOfCall(tokenAddress, STORAGE_DISCOVERY_OWNER)],
		stateOverrides: getBalanceOverride(tokenAddress, getErc20BalanceStorageKey(STORAGE_DISCOVERY_OWNER, balanceSlot), amount),
	}], 'latest', requestAbortController)
	const call = result[0]?.calls[0]
	return call !== undefined && decodeBalanceOfResult(Erc20ABI, call) === amount
}

export async function discoverErc20BalanceStorageSlot(
	ethereum: RichTokenEthereumClient,
	requestAbortController: AbortController | undefined,
	tokenAddress: EthereumAddress,
) {
	const candidates = Array.from({ length: STORAGE_DISCOVERY_SLOT_LIMIT }, (_, index) => BigInt(index))
	const result = await ethereum.ethSimulateV1(candidates.map((balanceSlot) => ({
		calls: [getErc20BalanceOfCall(tokenAddress, STORAGE_DISCOVERY_OWNER)],
		stateOverrides: getBalanceOverride(tokenAddress, getErc20BalanceStorageKey(STORAGE_DISCOVERY_OWNER, balanceSlot), FIRST_STORAGE_DISCOVERY_VALUE),
	})), 'latest', requestAbortController)
	const discoveredIndex = result.findIndex((block) => {
		const call = block.calls[0]
		return call !== undefined && decodeBalanceOfResult(Erc20ABI, call) === FIRST_STORAGE_DISCOVERY_VALUE
	})
	const balanceSlot = candidates[discoveredIndex]
	if (balanceSlot === undefined) return undefined
	return await verifyErc20BalanceStorageSlot(ethereum, requestAbortController, tokenAddress, balanceSlot)
		? balanceSlot
		: undefined
}

export async function verifyErc1155BalanceStorageSlot(
	ethereum: RichTokenEthereumClient,
	requestAbortController: AbortController | undefined,
	tokenAddress: EthereumAddress,
	tokenId: bigint,
	balanceSlot: bigint,
	storageOrder: Erc1155StorageOrder,
	amount = SECOND_STORAGE_DISCOVERY_VALUE,
) {
	const result = await ethereum.ethSimulateV1([{
		calls: [getErc1155BalanceOfCall(tokenAddress, STORAGE_DISCOVERY_OWNER, tokenId)],
		stateOverrides: getBalanceOverride(tokenAddress, getErc1155BalanceStorageKey(STORAGE_DISCOVERY_OWNER, tokenId, balanceSlot, storageOrder), amount),
	}], 'latest', requestAbortController)
	const call = result[0]?.calls[0]
	return call !== undefined && decodeBalanceOfResult(Erc1155ABI, call) === amount
}

export async function discoverErc1155BalanceStorage(
	ethereum: RichTokenEthereumClient,
	requestAbortController: AbortController | undefined,
	tokenAddress: EthereumAddress,
	tokenId: bigint,
) {
	const candidates = Array.from({ length: STORAGE_DISCOVERY_SLOT_LIMIT }, (_, index) => BigInt(index))
		.flatMap((balanceSlot) => (['TokenIdThenOwner', 'OwnerThenTokenId'] as const).map((storageOrder) => ({ balanceSlot, storageOrder })))
	const result = await ethereum.ethSimulateV1(candidates.map(({ balanceSlot, storageOrder }) => ({
		calls: [getErc1155BalanceOfCall(tokenAddress, STORAGE_DISCOVERY_OWNER, tokenId)],
		stateOverrides: getBalanceOverride(tokenAddress, getErc1155BalanceStorageKey(STORAGE_DISCOVERY_OWNER, tokenId, balanceSlot, storageOrder), FIRST_STORAGE_DISCOVERY_VALUE),
	})), 'latest', requestAbortController)
	const discoveredIndex = result.findIndex((block) => {
		const call = block.calls[0]
		return call !== undefined && decodeBalanceOfResult(Erc1155ABI, call) === FIRST_STORAGE_DISCOVERY_VALUE
	})
	const discovered = candidates[discoveredIndex]
	if (discovered === undefined) return undefined
	return await verifyErc1155BalanceStorageSlot(ethereum, requestAbortController, tokenAddress, tokenId, discovered.balanceSlot, discovered.storageOrder)
		? discovered
		: undefined
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

export const isRichTokenSupportedByAddressBook = (token: RichToken, addressBookEntries: readonly AddressBookEntry[]) => addressBookEntries.some((entry) => {
	const appliesToChain = entry.chainId === token.chainId
		|| (entry.chainId === undefined && token.chainId === 1n)
		|| entry.chainId === 'AllChains'
	if (!appliesToChain || entry.address !== token.tokenAddress || entry.type !== token.tokenType) return false
	if (entry.type === 'ERC20') return token.tokenId === undefined && isSupportedRichTokenDecimals(entry.decimals)
	return token.tokenId !== undefined && entry.watchedTokenIds?.includes(token.tokenId) === true
})

export const filterRichTokensSupportedByAddressBook = (tokens: readonly RichToken[], addressBookEntries: readonly AddressBookEntry[]) => (
	tokens.filter((token) => isRichTokenSupportedByAddressBook(token, addressBookEntries))
)

type AddressBookRichTokenCandidate =
	| { metadataEntry: Erc20TokenEntry, tokenId: undefined }
	| { metadataEntry: Erc1155Entry, tokenId: bigint }

const getAddressBookRichTokenCandidates = (addressBookEntries: readonly AddressBookEntry[]): AddressBookRichTokenCandidate[] => {
	const erc20Entries = new Map<bigint, Erc20TokenEntry>()
	const erc1155Entries = new Map<bigint, { metadataEntry: Erc1155Entry, watchedTokenIds: Set<bigint> }>()
	for (const entry of addressBookEntries) {
		if (entry.type === 'ERC20' && isSupportedRichTokenDecimals(entry.decimals)) {
			if (!erc20Entries.has(entry.address)) erc20Entries.set(entry.address, entry)
			continue
		}
		if (entry.type !== 'ERC1155') continue
		const configured = erc1155Entries.get(entry.address)
		if (configured === undefined) {
			erc1155Entries.set(entry.address, { metadataEntry: entry, watchedTokenIds: new Set(entry.watchedTokenIds ?? []) })
			continue
		}
		for (const tokenId of entry.watchedTokenIds ?? []) configured.watchedTokenIds.add(tokenId)
	}
	const erc20Candidates = [...erc20Entries.values()].map((metadataEntry): AddressBookRichTokenCandidate => ({ metadataEntry, tokenId: undefined }))
	const erc1155Candidates = [...erc1155Entries.values()].flatMap(({ metadataEntry, watchedTokenIds }): AddressBookRichTokenCandidate[] => (
		[...watchedTokenIds].map((tokenId) => ({ metadataEntry, tokenId }))
	))
	return [...erc20Candidates, ...erc1155Candidates]
}

export const getRichTokenOptions = (chainId: bigint, configuredTokens: readonly RichToken[], addressBookEntries: readonly AddressBookEntry[]): RichTokenOption[] => {
	const configuredOnChain = new Map<string, RichToken>()
	for (const token of configuredTokens) {
		const tokenKey = getRichTokenIdentityKey(token)
		if (token.chainId === chainId && !configuredOnChain.has(tokenKey)) configuredOnChain.set(tokenKey, token)
	}
	return getAddressBookRichTokenCandidates(addressBookEntries).map(({ metadataEntry, tokenId }): RichTokenOption => {
			const identity = { tokenAddress: metadataEntry.address, tokenId }
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
			return configured === undefined
				? {
					...base,
					amount: getDefaultRichTokenAmount(decimals),
					balanceSlot: undefined,
					erc1155StorageOrder: undefined,
					enabled: false,
				}
				: { ...configured, ...base, enabled: true }
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
