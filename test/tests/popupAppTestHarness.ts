// Shared setup for tests that render the whole popup (App) and drive it with runtime messages: home page message fixtures and DOM helpers.
//
// Usage (at the top level of a test file):
//   const installRuntimeMessaging = createRuntimeMessagingInstaller()   // from test/tests/runtimeMessagingTestHarness.ts
//   const messaging = installRuntimeMessaging()
//   await act(() => { render(h(App, {}), dom.document.body) })
//   await act(() => { messaging.dispatch({ role: 'all', ...defaultHomePage(1, { icon: ICON_SIGNING, iconReason: 'Signing' }, 1) }) })
import type { AddressBookEntry } from '../../app/ts/types/addressBookTypes.js'
import { HomePageBootstrap, UpdateHomePage, type Settings } from '../../app/ts/types/interceptor-messages.js'
import type { RpcEntry } from '../../app/ts/types/rpc.js'
import type { TabIconDetails, TabState } from '../../app/ts/types/user-interface-types.js'
import { createPassthroughCompleteVisualizedSimulation } from '../../app/ts/types/visualizer-types.js'
import { serialize } from '../../app/ts/types/wire-types.js'
import type { MockElement } from './domMock.js'
import { clickElement, findAllElements, findElement, isDisabled } from './domQueries.js'

// Fixtures use the app's message types, and the message builders serialize them through the UpdateHomePage and HomePageBootstrap codecs, so a home page payload change fails these fixtures at compile time instead of letting them drift from what the background sends.

export const defaultSettings: Settings = {
	activeSimulationAddress: undefined,
	activeSigningSafeAddress: undefined,
	activeRpcNetwork: {
		name: 'Ethereum',
		chainId: 1n,
		httpsRpc: 'https://example.invalid',
		currencyName: 'Ether?',
		currencyTicker: 'ETH?',
		primary: false,
		minimized: true,
	},
	openedPage: { page: 'Home' },
	useSignersAddressAsActiveAddress: false,
	websiteAccess: [],
	simulationMode: false,
}

const defaultRpcEntry: RpcEntry = { name: 'Ethereum', chainId: 1n, httpsRpc: 'https://example.invalid', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
export const loadedAddress = 0x1000000000000000000000000000000000000001n
export const loadedAddressBookEntry: AddressBookEntry = { type: 'contact', name: 'Loaded Account', address: loadedAddress, entrySource: 'User', useAsActiveAddress: true }

export const defaultTabState = (tabId: number, tabIconDetails: TabIconDetails): TabState => ({
	tabId,
	website: { websiteOrigin: `tab-${ tabId }.invalid`, icon: undefined, title: `Tab ${ tabId }` },
	signerConnected: false,
	signerName: 'NoSigner',
	signerAccounts: [],
	signerAccountError: undefined,
	signerChain: undefined,
	tabIconDetails,
	activeSigningAddress: undefined,
})

const createHomePageData = (tabId: number, tabIconDetails: TabIconDetails, dataOverrides: Partial<UpdateHomePage['data']>): UpdateHomePage['data'] => ({
	visualizedSimulatorState: createPassthroughCompleteVisualizedSimulation(),
	activeAddresses: [],
	richList: [],
	makeCurrentAddressRich: false,
	hasSafeTransactionsToExport: false,
	latestUnexpectedError: undefined,
	websiteAccessAddressMetadata: [],
	tabState: defaultTabState(tabId, tabIconDetails),
	currentBlockNumber: undefined,
	settings: defaultSettings,
	rpcConnectionStatus: undefined,
	activeSigningAddressInThisTab: undefined,
	tabId,
	rpcEntries: [defaultRpcEntry],
	interceptorDisabled: false,
	preSimulationBlockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
	...dataOverrides,
})

// Returns a serialized popup_UpdateHomePage message for the given tab; dataOverrides replaces fields of its data.
export function defaultHomePage(tabId: number, tabIconDetails: TabIconDetails, popupRefreshGeneration: number, dataOverrides: Partial<UpdateHomePage['data']> = {}, homeDataSource: UpdateHomePage['homeDataSource'] = 'fresh') {
	const homePage: UpdateHomePage = {
		method: 'popup_UpdateHomePage',
		homeDataSource,
		popupRefreshGeneration,
		data: createHomePageData(tabId, tabIconDetails, dataOverrides),
	}
	return serialize(UpdateHomePage, homePage)
}

// Returns a serialized popup_homePageBootstrap message carrying the bootstrap subset of the default home page data; dataOverrides replaces fields of its data.
export function defaultHomePageBootstrap(tabId: number, tabIconDetails: TabIconDetails, popupRefreshGeneration: number, dataOverrides: Partial<HomePageBootstrap['data']> = {}) {
	const homePageData = createHomePageData(tabId, tabIconDetails, {})
	const homePageBootstrap: HomePageBootstrap = {
		method: 'popup_homePageBootstrap',
		popupRefreshGeneration,
		data: {
			activeAddresses: homePageData.activeAddresses,
			hasSafeTransactionsToExport: homePageData.hasSafeTransactionsToExport,
			tabState: homePageData.tabState,
			settings: homePageData.settings,
			activeSigningAddressInThisTab: homePageData.activeSigningAddressInThisTab,
			tabId: homePageData.tabId,
			rpcEntries: homePageData.rpcEntries,
			interceptorDisabled: homePageData.interceptorDisabled,
			...dataOverrides,
		},
	}
	return serialize(HomePageBootstrap, homePageBootstrap)
}

// DOM helpers

export const collectImageSources = (root: MockElement) => findAllElements(root, (element) => element.hasAttribute('src')).flatMap((element) => element.getAttribute('src') ?? [])

export const hasAriaLabel = (root: MockElement, label: string) => findElement(root, (element) => element.getAttribute('aria-label') === label) !== undefined

export function isButtonDisabled(button: MockElement | undefined) {
	if (button === undefined) throw new Error('Expected the button to be rendered')
	return isDisabled(button)
}

// Clicks like a user: the popup's handlers read currentTarget.value and blur the clicked button.
export async function clickPopupElement(element: MockElement) {
	await clickElement(element, {
		currentTarget: {
			blur: () => element.blur(),
			value: element.getAttribute('value') ?? undefined,
		},
		clientX: 0,
		clientY: 0,
	})
}
