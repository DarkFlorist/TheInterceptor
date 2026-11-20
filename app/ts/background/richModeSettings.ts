import type { AddressBookEntries } from '../types/addressBookTypes.js'
import type { RichAccountBalance, RichListElement, RichModeState, RichToken } from '../types/richMode.js'
import type { EthereumAddress } from '../types/wire-types.js'
import { MAKE_YOU_RICH_TRANSACTION } from '../utils/constants.js'
import { normalizeRichAccountBalances } from '../utils/richTokens.js'
import { profilesForAddresses, reconcileRichModeStateWithAddressBook, richTokensForPresentation, richTokenLayout } from '../utils/richModeDerivation.js'
import { browserStorageLocalSafeParseGet } from '../utils/storageUtils.js'
import { getUserAddressBookEntries, userAddressBookEntriesStorageWrite } from './addressBookStorage.js'
import { runSettingsStorageTransaction, type StorageWrite } from './settingsStorageTransaction.js'

// All funding mutations, and the address-book edits that can change funding, enter through this owner; they run under the settings storage lock so funding and address-book writes land in one storage set.
export const emptyRichModeState: RichModeState = { makeCurrentAddressRich: false, fixedAddressRichList: [], defaultNativeAmount: MAKE_YOU_RICH_TRANSACTION.transaction.value, tokenLayouts: [], accountBalances: [] }

// A plain read of the canonical funding state. The startup migration (richModeMigration) converts legacy keys and repairs a corrupt value before anything else runs, so an absent value means no funding is configured.
export async function getRichModeState(): Promise<RichModeState> {
	return (await browserStorageLocalSafeParseGet('richModeState'))?.richModeState ?? emptyRichModeState
}

// The native amount simulated for address: its stored profile's amount, or the default for an address without a profile.
export async function getRichNativeAmountForAddress(chainId: bigint, address: bigint) {
	const state = await getRichModeState()
	return state.accountBalances.find((profile) => profile.chainId === chainId && profile.address === address)?.nativeAmount ?? state.defaultNativeAmount
}

export const richModeStateStorageWrite = (richModeState: RichModeState): StorageWrite => ({ richModeState })

export async function mutateRichMode<Result>(operation: (store: ReturnType<typeof createRichModeTransaction>) => Promise<Result>) {
	return await runSettingsStorageTransaction(async () => {
		const store = createRichModeTransaction(await getRichModeState())
		const result = await operation(store)
		return { writes: store.getStorageWrites(), result }
	})
}

// For address-book edits that can remove or change a funded token (removing, editing or replacing an entry); returns whether any account funding changed. Writes that cannot affect token entries, such as adding a missing entry or updating a Safe, use updateUserAddressBookEntries and never touch rich-mode state.
export const updateAddressBookAndReconcileRichMode = async (update: (entries: AddressBookEntries) => AddressBookEntries) => await mutateRichMode(async (store) => await store.updateAddressBook(update))

// The settings import replaces funding state and the address book in its own storage transaction, so it composes these writes instead of taking the lock again.
export async function getImportedRichModeStorageWrites(state: RichModeState, entries: AddressBookEntries) {
	const store = createRichModeTransaction(state)
	store.replace(state)
	await store.updateAddressBook(() => entries)
	return store.getStorageWrites()
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
			replace({ ...state, tokenLayouts: tokens.map(richTokenLayout) })
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
		getStorageWrites: (): readonly StorageWrite[] => {
			return [
				...changed ? [richModeStateStorageWrite(state)] : [],
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
export const ensureRichAccountBalances = async (chainId: bigint, addresses: readonly bigint[]) => await mutateRichMode(async (store) => await store.ensureRichAccountBalances(chainId, addresses))
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
