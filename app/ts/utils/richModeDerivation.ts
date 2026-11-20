import type { AddressBookEntries, AddressBookEntry } from '../types/addressBookTypes.js'
import type { Settings } from '../types/interceptor-messages.js'
import type { RichAccountBalance, RichModeState, RichToken, RichTokenLayout } from '../types/richMode.js'
import { getDefaultRichTokenAmount, getRichTokenOptions, reconcileRichTokenMetadata, sameRichTokenIdentity } from './richTokens.js'

// Pure derivations of rich-mode state, shared by the storage owner (richModeSettings), the popup payloads and the storage-free simulation input builder. Nothing here reads or writes storage.

// The stored layout of a presented token, which never carries a funding amount.
export const richTokenLayout = ({ amount: _amount, ...layout }: RichToken): RichTokenLayout => layout

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
	const tokenLayouts = layoutsChanged ? supported.map(richTokenLayout) : state.tokenLayouts
	const accountBalances = dropTokenBalancesWithoutLayout(state.accountBalances, tokenLayouts)
	if (!layoutsChanged && accountBalances === state.accountBalances) return state
	return { ...state, tokenLayouts, accountBalances }
}

// The rich-mode part of the popup's home data, built the same way for fresh and cached home data. addressBookEntries are the active chain's entries, most precise first.
export const buildRichModePresentation = (settings: Settings, state: RichModeState, addressBookEntries: readonly AddressBookEntry[]) => {
	const chainId = settings.activeRpcNetwork.chainId
	return {
		makeCurrentAddressRich: state.makeCurrentAddressRich,
		richNativeAmount: state.defaultNativeAmount,
		richAccountBalances: dropTokenBalancesWithoutLayout(profilesForAddresses(state, chainId, addressesBeingMadeRich(settings, state)), state.tokenLayouts),
		richTokenOptions: getRichTokenOptions(chainId, richTokensForPresentation(state), addressBookEntries),
	}
}
