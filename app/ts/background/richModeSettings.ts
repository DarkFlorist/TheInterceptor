import { DEFAULT_ACTIVE_ADDRESSES, DEFAULT_RPCS } from '../config/defaults.js'
import type { Settings } from '../types/interceptor-messages.js'
import type { AddressBookEntries } from '../types/addressBookTypes.js'
import type { RichAccountBalance, RichListElement, RichModeState, RichToken, RichTokenLayout } from '../types/richMode.js'
import type { EthereumAddress } from '../types/wire-types.js'
import { MAKE_YOU_RICH_TRANSACTION } from '../utils/constants.js'
import { reconcileRichTokenMetadata, getDefaultRichTokenAmount, normalizeRichAccountBalances, sameRichTokenIdentity } from '../utils/richTokens.js'
import { browserStorageLocalSafeParse, browserStorageLocalSafeParseGet, getStoredActiveSimulationAddressAndNetwork } from '../utils/storageUtils.js'
import { getUserAddressBookEntries, userAddressBookEntriesStorageWrite } from './addressBookStorage.js'
import { runSettingsStorageTransaction, type StorageWrite } from './settingsStorageTransaction.js'

// All funding mutations, and the address-book edits that can change funding, enter through this owner; they run under the settings storage lock so funding and address-book writes land in one storage set.
const legacyKeys = ['makeCurrentAddressRich', 'fixedAddressRichList', 'richNativeAmount', 'richTokens', 'richAccountBalances']

const withoutAmount = ({ amount: _amount, ...layout }: RichToken): RichTokenLayout => layout

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
	// Legacy token amounts applied to whichever address was made rich, so every address that can be made rich gets a profile even while it is disabled; otherwise the amounts would be lost when the legacy keys are removed.
	const migrationAddresses = [...new Set([
		...addresses,
		...fixedAddressRichList.map((entry) => entry.address),
		...(activeAddress === undefined ? [] : [activeAddress]),
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
		tokenLayouts: tokens.map(withoutAmount),
	}
}

// addRichAccountBalanceOverrides cannot fund a token balance without a layout on the profile's chain, so such balances are dropped instead of being shown as funded.
export const dropTokenBalancesWithoutLayout = (accountBalances: readonly RichAccountBalance[], tokenLayouts: readonly RichTokenLayout[]): readonly RichAccountBalance[] => {
	let changed = false
	const reconciled = accountBalances.map((profile) => {
		const tokenBalances = profile.tokenBalances.filter((balance) => tokenLayouts.some((layout) => layout.chainId === profile.chainId && sameRichTokenIdentity(layout, balance)))
		if (tokenBalances.length === profile.tokenBalances.length) return profile
		changed = true
		return { ...profile, tokenBalances }
	})
	return changed ? reconciled : accountBalances
}

// Layout metadata follows the address book and unsupported layouts are removed; balances are checked even when the layouts are unchanged. Returns the same state object when nothing changed.
export function reconcileRichModeStateWithAddressBook(state: RichModeState, entries: AddressBookEntries): RichModeState {
	const current = richTokensForPresentation(state)
	const supported = reconcileRichTokenMetadata(current, entries)
	const layoutsChanged = supported.length !== current.length || supported.some((token, index) => token !== current[index])
	const tokenLayouts = layoutsChanged ? supported.map(withoutAmount) : state.tokenLayouts
	const accountBalances = dropTokenBalancesWithoutLayout(state.accountBalances, tokenLayouts)
	if (!layoutsChanged && accountBalances === state.accountBalances) return state
	return { ...state, tokenLayouts, accountBalances }
}

// The native amount simulated for address: its stored profile's amount, or the default for an address without a profile.
export async function getRichNativeAmountForAddress(chainId: bigint, address: bigint) {
	const state = await getRichModeState(chainId, [address])
	return state.accountBalances.find((profile) => profile.chainId === chainId && profile.address === address)?.nativeAmount ?? state.defaultNativeAmount
}

const richModeStateStorageWrite = (richModeState: RichModeState): StorageWrite => ({ richModeState })

// Removing obsolete replicas after the canonical write is safe even when interrupted, because reads prefer canonical state.
export const removeLegacyRichModeKeys = async () => { await browser.storage.local.remove(legacyKeys) }

export async function mutateRichMode<Result>(operation: (store: ReturnType<typeof createRichModeTransaction>) => Promise<Result>, chainId?: bigint, addresses: readonly bigint[] = []) {
	const { result, wroteRichModeState } = await runSettingsStorageTransaction(async () => {
		const store = createRichModeTransaction(await getRichModeState(chainId, addresses))
		const result = await operation(store)
		const writes = await store.getStorageWrites()
		return { writes, result: { result, wroteRichModeState: writes.some((write) => 'richModeState' in write) } }
	})
	if (wroteRichModeState) await removeLegacyRichModeKeys()
	return result
}

// For address-book edits that can remove or change a funded token (removing, editing or replacing an entry); returns whether any account funding changed. Writes that cannot affect token entries, such as adding a missing entry or updating a Safe, use updateUserAddressBookEntries and never touch rich-mode state.
export const updateAddressBookAndReconcileRichMode = async (update: (entries: AddressBookEntries) => AddressBookEntries) => await mutateRichMode(async (store) => await store.updateAddressBook(update))

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
			replace({ ...state, tokenLayouts: tokens.map(withoutAmount) })
			return tokens
		},
		reconcileAddressBook: async (entries: AddressBookEntries) => {
			const reconciled = reconcileRichModeStateWithAddressBook(state, entries)
			if (reconciled === state) return false
			const fundingChanged = reconciled.accountBalances !== state.accountBalances
			replace(reconciled)
			return fundingChanged
		},
		updateAddressBook: async (update: (entries: AddressBookEntries) => AddressBookEntries) => {
			const entries = update(addressBookEntries ?? await getUserAddressBookEntries())
			addressBookEntries = entries
			return await transaction.reconcileAddressBook(entries)
		},
		getStorageWrites: async (): Promise<readonly StorageWrite[]> => {
			// An unchanged state is still written while only legacy keys hold it, so the first mutation persists the migration.
			const writeRichModeState = changed || (await browserStorageLocalSafeParseGet('richModeState'))?.richModeState === undefined
			return [
				...writeRichModeState ? [richModeStateStorageWrite(state)] : [],
				...addressBookEntries === undefined ? [] : [userAddressBookEntriesStorageWrite(addressBookEntries)],
			]
		},
	}
	return transaction
}

// Rich-mode setting accessors. This module is the only entry point to rich-mode settings; settings.ts neither defines nor re-exports them.
export const getMakeCurrentAddressRich = async () => (await getRichModeState()).makeCurrentAddressRich
export const getDefaultRichNativeAmount = async () => (await getRichModeState()).defaultNativeAmount
export const getFixedAddressRichList = async () => (await getRichModeState()).fixedAddressRichList
export const getRichTokens = async () => richTokensForPresentation(await getRichModeState())

export const setMakeCurrentAddressRich = async (makeCurrentAddressRich: boolean) => { await updateMakeCurrentAddressRich(() => makeCurrentAddressRich) }
export const setRichNativeAmount = async (defaultNativeAmount: bigint) => { await mutateRichMode(async (store) => { store.replace({ ...store.getState(), defaultNativeAmount }) }) }
export const setFixedMakeMeRichList = async (fixedAddressRichList: readonly RichListElement[]) => { await updateFixedMakeMeRichList(() => fixedAddressRichList) }

export async function updateMakeCurrentAddressRich(update: (enabled: boolean) => boolean) {
	return await mutateRichMode(async (store) => {
		const previous = store.getState()
		const makeCurrentAddressRich = update(previous.makeCurrentAddressRich)
		if (makeCurrentAddressRich === previous.makeCurrentAddressRich) return false
		store.replace({ ...previous, makeCurrentAddressRich })
		return true
	})
}

export const updateRichAccountBalances = async (update: (balances: readonly RichAccountBalance[]) => readonly RichAccountBalance[]) => await mutateRichMode(async (store) => await store.updateRichAccountBalances(update))
export const ensureRichAccountBalances = async (chainId: bigint, addresses: readonly bigint[]) => await mutateRichMode(async (store) => await store.ensureRichAccountBalances(chainId, addresses), chainId, addresses)
export const updateRichTokens = async (update: (tokens: readonly RichToken[]) => readonly RichToken[]) => await mutateRichMode(async (store) => await store.updateRichTokens(update))

function toComparableRichListElement(element: RichListElement): RichListElement {
	return {
		address: element.address,
		makingRich: element.makingRich,
		type: element.type,
	}
}

function richListElementsEqual(first: RichListElement, second: RichListElement) {
	const firstValues = Object.values(toComparableRichListElement(first))
	const secondValues = Object.values(toComparableRichListElement(second))
	return firstValues.length === secondValues.length && firstValues.every((value, index) => value === secondValues[index])
}

export async function updateFixedMakeMeRichList(update: (fixedAddressRichList: readonly RichListElement[]) => readonly RichListElement[]) {
	return await mutateRichMode(async (store) => {
		const previous = store.getState().fixedAddressRichList
		const next = update(previous)
		if (previous.length === next.length && previous.every((element, index) => {
			const nextElement = next[index]
			return nextElement !== undefined && richListElementsEqual(element, nextElement)
		})) return false
		store.replace({ ...store.getState(), fixedAddressRichList: next })
		return true
	})
}

export const reconcileRichTokensWithAddressBook = async () => await mutateRichMode(async (store) => {
	await store.reconcileAddressBook(await getUserAddressBookEntries())
	return await store.getRichTokens()
})

export async function trackPreviousActiveAddressForMakeMeRichList(previousActiveAddress: EthereumAddress | undefined) {
	return await updateFixedMakeMeRichList((currentList) => {
		const richList = currentList
			.filter((element) => !(element.type === 'PreviousActiveAddress' && !element.makingRich))
			.map((element) => ({ ...element, type: 'UserAdded' as const }))
		if (previousActiveAddress === undefined || richList.some((element) => element.address === previousActiveAddress)) return richList
		return [...richList, { address: previousActiveAddress, makingRich: false, type: 'PreviousActiveAddress' as const }]
	})
}
