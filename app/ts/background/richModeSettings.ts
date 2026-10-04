import { DEFAULT_ACTIVE_ADDRESSES, DEFAULT_RPCS } from '../config/defaults.js'
import type { Settings } from '../types/interceptor-messages.js'
import type { AddressBookEntries } from '../types/addressBookTypes.js'
import { EthereumAddress } from '../types/wire-types.js'
import type { RichAccountBalance, RichModeState, RichToken } from '../types/richMode.js'
import { MAKE_YOU_RICH_TRANSACTION } from '../utils/constants.js'
import { filterRichTokensSupportedByAddressBook, getDefaultRichTokenAmount, normalizeRichAccountBalances, sameRichTokenIdentity } from '../utils/richTokens.js'
import { Semaphore } from '../utils/semaphore.js'
import { browserStorageLocalSafeParse, browserStorageLocalSafeParseGet, browserStorageLocalSet } from '../utils/storageUtils.js'
import { getUserAddressBookEntries } from './storageVariables.js'

// All funding and address-book mutations enter through this owner; transaction-local methods keep related writes under one lock.
const richModeSemaphore = new Semaphore(1)
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
	const { makeCurrentAddressRich: rawSelection, fixedAddressRichList: rawFixed, richNativeAmount: rawNative, richTokens: rawTokens, richAccountBalances: rawProfiles, independentActiveSimulationAddress: rawActive, activeRpcNetwork: rawNetwork } = await browser.storage.local.get([...legacyKeys, 'independentActiveSimulationAddress', 'activeRpcNetwork'])
	const selection = browserStorageLocalSafeParse({ makeCurrentAddressRich: rawSelection })
	const fixed = browserStorageLocalSafeParse({ fixedAddressRichList: rawFixed })
	const native = browserStorageLocalSafeParse({ richNativeAmount: rawNative })
	const tokens = browserStorageLocalSafeParse({ richTokens: rawTokens })?.richTokens ?? []
	const profiles = browserStorageLocalSafeParse({ richAccountBalances: rawProfiles })?.richAccountBalances ?? []
	const parsedActiveAddress = EthereumAddress.safeParse(rawActive)
	const activeAddress = parsedActiveAddress.success ? parsedActiveAddress.value : DEFAULT_ACTIVE_ADDRESSES[0]?.address
	const active = browserStorageLocalSafeParse({ activeRpcNetwork: rawNetwork })
	const fixedAddressRichList = fixed?.fixedAddressRichList ?? []
	const makeCurrentAddressRich = selection?.makeCurrentAddressRich ?? false
	const defaultNativeAmount = native?.richNativeAmount ?? MAKE_YOU_RICH_TRANSACTION.transaction.value
	const migrationAddresses = [...new Set([
		...addresses,
		...fixedAddressRichList.filter((entry) => entry.makingRich).map((entry) => entry.address),
		...(makeCurrentAddressRich && activeAddress !== undefined ? [activeAddress] : []),
	])]
	const migrationChains = [...new Set([...(chainId === undefined ? [] : [chainId]), ...(active?.activeRpcNetwork === undefined ? DEFAULT_RPCS.slice(0, 1).map((network) => network.chainId) : [active.activeRpcNetwork.chainId]), ...tokens.map((token) => token.chainId)])]
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

export async function mutateRichMode<Result>(operation: (store: ReturnType<typeof createRichModeTransaction>) => Promise<Result>, chainId?: bigint, addresses: readonly bigint[] = []) {
	return await richModeSemaphore.execute(async () => {
		const store = createRichModeTransaction(await getRichModeState(chainId, addresses))
		const result = await operation(store)
		await store.commit()
		return result
	})
}

// Imports can replace corrupt state; address-book entries and funding state are committed together.
export async function replaceRichModeState(state: RichModeState, entries?: AddressBookEntries) {
	await richModeSemaphore.execute(async () => {
		const store = createRichModeTransaction(state)
		store.replace(state)
		if (entries === undefined) await store.reconcileAddressBook(await getUserAddressBookEntries())
		else await store.updateAddressBook(() => entries)
		await store.commit()
	})
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
			const supported = filterRichTokensSupportedByAddressBook(richTokensForPresentation(state), entries)
			if (supported.length === state.tokenLayouts.length) return
			replace({
				...state,
				tokenLayouts: supported.map(({ amount: _amount, ...layout }) => layout),
				accountBalances: state.accountBalances.map((profile) => ({
					...profile,
					tokenBalances: profile.tokenBalances.filter((balance) => supported.some((token) => token.chainId === profile.chainId && sameRichTokenIdentity(token, balance))),
				})),
			})
		},
		updateAddressBook: async (update: (entries: AddressBookEntries) => AddressBookEntries) => {
			const entries = update(addressBookEntries ?? await getUserAddressBookEntries())
			addressBookEntries = entries
			await transaction.reconcileAddressBook(entries)
		},
		commit: async () => {
			if (!changed && addressBookEntries === undefined && (await browserStorageLocalSafeParseGet('richModeState'))?.richModeState !== undefined) return
			await browserStorageLocalSet(addressBookEntries === undefined ? { richModeState: state } : { richModeState: state, userAddressBookEntriesV3: addressBookEntries })
			// Publish the new owner before removing obsolete replicas; interrupted cleanup is safe because reads prefer canonical state.
			await browser.storage.local.remove(legacyKeys)
		},
	}
	return transaction
}
