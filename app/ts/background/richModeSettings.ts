import { DEFAULT_ACTIVE_ADDRESSES, DEFAULT_RPCS } from '../config/defaults.js'
import type { Settings } from '../types/interceptor-messages.js'
import type { AddressBookEntries } from '../types/addressBookTypes.js'
import type { RichAccountBalance, RichModeState, RichToken } from '../types/richMode.js'
import { MAKE_YOU_RICH_TRANSACTION } from '../utils/constants.js'
import { reconcileRichTokenMetadata, getDefaultRichTokenAmount, normalizeRichAccountBalances, sameRichTokenIdentity } from '../utils/richTokens.js'
import { browserStorageLocalSafeParse, browserStorageLocalSafeParseGet, getStoredActiveSimulationAddressAndNetwork } from '../utils/storageUtils.js'
import { getUserAddressBookEntries, userAddressBookEntriesStorageWrite } from './addressBookStorage.js'
import { runSettingsStorageTransaction, type StorageWrite } from './settingsStorageTransaction.js'

// All funding and address-book mutations enter through this owner; they run under the settings storage lock so funding and address-book writes land in one storage set.
const legacyKeys = ['makeCurrentAddressRich', 'fixedAddressRichList', 'richNativeAmount', 'richTokens', 'richAccountBalances']

export const richTokensForPresentation = (state: RichModeState): readonly RichToken[] => state.tokenLayouts.map((layout) => ({ ...layout, amount: getDefaultRichTokenAmount(layout.decimals) }))

export const addressesBeingMadeRich = (settings: Settings, state: RichModeState): readonly bigint[] => settings.simulationMode ? [
	...state.fixedAddressRichList.filter((entry) => entry.makingRich).map((entry) => entry.address),
	...(state.makeCurrentAddressRich && settings.activeSimulationAddress !== undefined ? [settings.activeSimulationAddress] : []),
] : []

export const profilesForAddresses = (state: RichModeState, chainId: bigint, addresses: readonly bigint[]): readonly RichAccountBalance[] => [
	...state.accountBalances,
	...[...new Set(addresses)].filter((address) => !state.accountBalances.some((profile) => profile.chainId === chainId && profile.address === address))
		.map((address) => ({ chainId, address, nativeAmount: state.defaultNativeAmount, tokenBalances: [] })),
]

// Reads only project legacy data; the next mutation persists migration. Simulation reads never repair storage, prune tokens, or acquire a mutation lock.
export async function getRichModeState(chainId?: bigint, addresses: readonly bigint[] = []): Promise<RichModeState> {
	const stored = await browserStorageLocalSafeParseGet('richModeState')
	if (stored?.richModeState !== undefined) return stored.richModeState
	const { richModeState: rawState } = await browser.storage.local.get('richModeState')
	if (rawState !== undefined) {
		console.warn('richModeState was corrupt; startup or the next mutation will reset funding state.')
		return { makeCurrentAddressRich: false, fixedAddressRichList: [], defaultNativeAmount: MAKE_YOU_RICH_TRANSACTION.transaction.value, tokenLayouts: [], accountBalances: [] }
	}
	const { makeCurrentAddressRich: rawSelection, fixedAddressRichList: rawFixed, richNativeAmount: rawNative, richTokens: rawTokens, richAccountBalances: rawProfiles } = await browser.storage.local.get(legacyKeys)
	const migrationContext = await getStoredActiveSimulationAddressAndNetwork()
	const selection = browserStorageLocalSafeParse({ makeCurrentAddressRich: rawSelection })
	const fixed = browserStorageLocalSafeParse({ fixedAddressRichList: rawFixed })
	const native = browserStorageLocalSafeParse({ richNativeAmount: rawNative })
	const tokens = browserStorageLocalSafeParse({ richTokens: rawTokens })?.richTokens ?? []
	const profiles = browserStorageLocalSafeParse({ richAccountBalances: rawProfiles })?.richAccountBalances ?? []
	const activeAddress = migrationContext.activeSimulationAddress ?? DEFAULT_ACTIVE_ADDRESSES[0]?.address
	const fixedAddressRichList = fixed?.fixedAddressRichList ?? []
	const makeCurrentAddressRich = selection?.makeCurrentAddressRich ?? false
	const defaultNativeAmount = native?.richNativeAmount ?? MAKE_YOU_RICH_TRANSACTION.transaction.value
	const migrationAddresses = [...new Set([
		...addresses,
		...fixedAddressRichList.filter((entry) => entry.makingRich).map((entry) => entry.address),
		...(makeCurrentAddressRich && activeAddress !== undefined ? [activeAddress] : []),
	])]
	const migrationChains = [...new Set([...(chainId === undefined ? [] : [chainId]), ...(migrationContext.activeRpcNetwork === undefined ? DEFAULT_RPCS.slice(0, 1).map((network) => network.chainId) : [migrationContext.activeRpcNetwork.chainId]), ...tokens.map((token) => token.chainId)])]
	const accountBalances = rawProfiles === undefined
		? migrationChains.flatMap((migrationChainId) => migrationAddresses.map((address): RichAccountBalance => ({
			chainId: migrationChainId,
			address,
			nativeAmount: defaultNativeAmount,
			tokenBalances: tokens.filter((token) => token.chainId === migrationChainId).map((token) => ({ tokenAddress: token.tokenAddress, tokenId: token.tokenId, amount: token.amount })),
		})))
		: normalizeRichAccountBalances(profiles)
	return {
		makeCurrentAddressRich, fixedAddressRichList, defaultNativeAmount, accountBalances,
		tokenLayouts: tokens.map(({ amount: _amount, ...layout }) => layout),
	}
}

export async function getRichAccountBalancesForAddresses(chainId: bigint, addresses: readonly bigint[]) {
	return profilesForAddresses(await getRichModeState(chainId, addresses), chainId, addresses)
}

const richModeStateStorageWrite = (richModeState: RichModeState): StorageWrite => ({ richModeState })

// Removing obsolete replicas after the canonical write is safe even when interrupted, because reads prefer canonical state.
export const removeLegacyRichModeKeys = async () => { await browser.storage.local.remove(legacyKeys) }

export async function mutateRichMode<Result>(operation: (store: ReturnType<typeof createRichModeTransaction>) => Promise<Result>, chainId?: bigint, addresses: readonly bigint[] = []) {
	const { result, wroteRichModeState } = await runSettingsStorageTransaction(async () => {
		const store = createRichModeTransaction(await getRichModeState(chainId, addresses))
		const result = await operation(store)
		const writes = await store.getStorageWrites()
		return { writes, result: { result, wroteRichModeState: writes.length > 0 } }
	})
	if (wroteRichModeState) await removeLegacyRichModeKeys()
	return result
}

// The settings import replaces funding state and the address book in its own storage transaction, so it composes these writes instead of taking the lock again; call removeLegacyRichModeKeys after that transaction commits.
export async function getImportedRichModeStorageWrites(state: RichModeState, entries: AddressBookEntries) {
	const store = createRichModeTransaction(state)
	store.replace(state)
	await store.updateAddressBook(() => entries)
	return await store.getStorageWrites()
}

function createRichModeTransaction(initial: RichModeState) {
	let state = initial
	let changed = false
	let addressBookEntries: AddressBookEntries | undefined
	const replace = (next: RichModeState) => { state = next; changed = true }
	const transaction = {
		getState: () => state,
		replace,
		getRichTokens: async () => richTokensForPresentation(state),
		ensureRichAccountBalances: async (chainId: bigint, addresses: readonly bigint[]) => {
			const accountBalances = profilesForAddresses(state, chainId, addresses)
			if (accountBalances.length !== state.accountBalances.length) replace({ ...state, accountBalances })
			return accountBalances
		},
		updateRichAccountBalances: async (update: (profiles: readonly RichAccountBalance[]) => readonly RichAccountBalance[]) => {
			const accountBalances = normalizeRichAccountBalances(update(state.accountBalances))
			replace({ ...state, accountBalances })
			return accountBalances
		},
		updateRichTokens: async (update: (tokens: readonly RichToken[]) => readonly RichToken[]) => {
			const tokens = update(richTokensForPresentation(state))
			replace({ ...state, tokenLayouts: tokens.map(({ amount: _amount, ...layout }) => layout) })
			return tokens
		},
		reconcileAddressBook: async (entries: AddressBookEntries) => {
			const current = richTokensForPresentation(state)
			const supported = reconcileRichTokenMetadata(current, entries)
			if (supported.length === current.length && supported.every((token, index) => token === current[index])) return false
			let fundingChanged = false
			const accountBalances = state.accountBalances.map((profile) => {
				const tokenBalances = profile.tokenBalances.filter((balance) => supported.some((token) => token.chainId === profile.chainId && sameRichTokenIdentity(token, balance)))
				if (tokenBalances.length === profile.tokenBalances.length) return profile
				fundingChanged = true
				return { ...profile, tokenBalances }
			})
			replace({
				...state,
				tokenLayouts: supported.map(({ amount: _amount, ...layout }) => layout),
				accountBalances: fundingChanged ? accountBalances : state.accountBalances,
			})
			return fundingChanged
		},
		updateAddressBook: async (update: (entries: AddressBookEntries) => AddressBookEntries) => {
			const entries = update(addressBookEntries ?? await getUserAddressBookEntries())
			addressBookEntries = entries
			return await transaction.reconcileAddressBook(entries)
		},
		getStorageWrites: async (): Promise<readonly StorageWrite[]> => {
			if (!changed && addressBookEntries === undefined && (await browserStorageLocalSafeParseGet('richModeState'))?.richModeState !== undefined) return []
			return addressBookEntries === undefined ? [richModeStateStorageWrite(state)] : [richModeStateStorageWrite(state), userAddressBookEntriesStorageWrite(addressBookEntries)]
		},
	}
	return transaction
}
