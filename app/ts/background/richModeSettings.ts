import type { AddressBookEntries } from '../types/addressBookTypes.js'
import { richFundingRejected, richFundingSaved, type RichAccountBalance, type RichFundingResult, type RichListElement, RichModeState, type RichToken } from '../types/richMode.js'
import type { EthereumAddress } from '../types/wire-types.js'
import { MAKE_YOU_RICH_TRANSACTION } from '../utils/constants.js'
import { MAX_RICH_TOKEN_AMOUNT, normalizeRichAccountBalances } from '../utils/richTokens.js'
import { profilesForAddresses, reconcileRichModeStateWithAddressBook, richTokensForPresentation, richTokenLayout } from '../utils/richModeDerivation.js'
import { browserStorageLocalSafeParseGet } from '../utils/storageUtils.js'
import { runSettingsStorageTransaction, type StorageWrite } from './settingsStorageTransaction.js'

// The owner of rich-mode funding state. Funding mutations run under the settings storage lock; address-book writes reach it through getRichModeWritesForAddressBook so funding and address-book writes land in one storage set.
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

export async function mutateRichMode<Result extends { readonly ok: boolean }>(operation: (store: ReturnType<typeof createRichModeTransaction>) => Promise<Result>) {
	return await runSettingsStorageTransaction(async () => {
		const store = createRichModeTransaction(await getRichModeState())
		const result = await operation(store)
		return { writes: result.ok ? store.getStorageWrites() : [], result }
	})
}

// Unvalidated state transformations cannot reject; wrap their returned value in an explicit successful transaction outcome.
async function updateRichMode<Result>(operation: (store: ReturnType<typeof createRichModeTransaction>) => Promise<Result>) {
	const outcome = await mutateRichMode(async (store) => ({ ok: true, value: await operation(store) }))
	return outcome.value
}

// The funding writes that keep rich mode consistent with new address-book entries. Only addressBookStorage calls this, inside the settings storage transaction that writes those entries, so no address-book write can skip reconciliation. fundingChanged says whether any account's funded balances changed.
export async function getRichModeWritesForAddressBook(entries: AddressBookEntries, importedState?: RichModeState) {
	const store = createRichModeTransaction(await getRichModeState())
	if (importedState !== undefined) store.replace(importedState)
	const fundingChanged = await store.reconcileAddressBook(entries)
	return { writes: store.getStorageWrites(), fundingChanged }
}

function createRichModeTransaction(initial: RichModeState) {
	let state = initial
	let changed = false
	const initialSerialized = JSON.stringify(RichModeState.serialize(initial))
	const replace = (next: RichModeState) => {
		state = next
		// Compare canonical schema values, so cloned but unchanged profiles/layouts do not trigger storage writes or simulation refreshes.
		changed = JSON.stringify(RichModeState.serialize(next)) !== initialSerialized
	}
	const transaction = {
		getState: () => state,
		isChanged: () => changed,
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
		getStorageWrites: (): readonly StorageWrite[] => changed ? [richModeStateStorageWrite(state)] : [],
	}
	return transaction
}

// Rich-mode setting accessors. This module is the only entry point to rich-mode settings; settings.ts neither defines nor re-exports them.
export const getMakeCurrentAddressRich = async () => (await getRichModeState()).makeCurrentAddressRich
export const getDefaultRichNativeAmount = async () => (await getRichModeState()).defaultNativeAmount
export const getFixedAddressRichList = async () => (await getRichModeState()).fixedAddressRichList
export const getRichTokens = async () => richTokensForPresentation(await getRichModeState())

export const setMakeCurrentAddressRich = async (makeCurrentAddressRich: boolean) => { await updateMakeCurrentAddressRich(() => makeCurrentAddressRich) }
export const setRichNativeAmount = async (defaultNativeAmount: bigint) => { await updateRichMode(async (store) => { store.replace({ ...store.getState(), defaultNativeAmount }) }) }
export const setFixedMakeMeRichList = async (fixedAddressRichList: readonly RichListElement[]) => { await updateFixedMakeMeRichList(() => fixedAddressRichList) }

export async function updateMakeCurrentAddressRich(update: (enabled: boolean) => boolean): Promise<RichFundingResult> {
	return await mutateRichMode(async (store) => {
		const previous = store.getState()
		const makeCurrentAddressRich = update(previous.makeCurrentAddressRich)
		if (makeCurrentAddressRich === previous.makeCurrentAddressRich) return richFundingSaved(false)
		store.replace({ ...previous, makeCurrentAddressRich })
		return richFundingSaved(true)
	})
}

export const updateRichAccountBalances = async (update: (balances: readonly RichAccountBalance[]) => readonly RichAccountBalance[]) => await updateRichMode(async (store) => await store.updateRichAccountBalances(update))
export const ensureRichAccountBalances = async (chainId: bigint, addresses: readonly bigint[]) => await updateRichMode(async (store) => await store.ensureRichAccountBalances(chainId, addresses))
export const updateRichTokens = async (update: (tokens: readonly RichToken[]) => readonly RichToken[]) => await updateRichMode(async (store) => await store.updateRichTokens(update))

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

export async function updateFixedMakeMeRichList(update: (fixedAddressRichList: readonly RichListElement[]) => readonly RichListElement[]): Promise<RichFundingResult> {
	return await mutateRichMode(async (store) => {
		const previous = store.getState().fixedAddressRichList
		const next = update(previous)
		if (previous.length === next.length && previous.every((element, index) => {
			const nextElement = next[index]
			return nextElement !== undefined && richListElementsEqual(element, nextElement)
		})) return richFundingSaved(false)
		store.replace({ ...store.getState(), fixedAddressRichList: next })
		return richFundingSaved(true)
	})
}

export async function trackPreviousActiveAddressForMakeMeRichList(previousActiveAddress: EthereumAddress | undefined) {
	return await updateFixedMakeMeRichList((currentList) => {
		const richList = currentList
			.filter((element) => !(element.type === 'PreviousActiveAddress' && !element.makingRich))
			.map((element) => ({ ...element, type: 'UserAdded' as const }))
		if (previousActiveAddress === undefined || richList.some((element) => element.address === previousActiveAddress)) return richList
		return [...richList, { address: previousActiveAddress, makingRich: false, type: 'PreviousActiveAddress' as const }]
	})
}

// Native funding is mutated under the same transaction as token and address funding.
export async function updateRichNativeAmountForAddress(chainId: bigint, address: EthereumAddress, nativeAmount: bigint): Promise<RichFundingResult> {
	if (nativeAmount <= 0n || nativeAmount > MAX_RICH_TOKEN_AMOUNT) return richFundingRejected('Native amount must be greater than zero and fit within uint256.')
	return await mutateRichMode(async (store) => {
		await store.ensureRichAccountBalances(chainId, [address])
		let changed = false
		await store.updateRichAccountBalances((profiles) => profiles.map((profile) => {
			if (profile.chainId !== chainId || profile.address !== address || profile.nativeAmount === nativeAmount) return profile
			changed = true
			return { ...profile, nativeAmount }
		}))
		return richFundingSaved(changed)
	})
}
