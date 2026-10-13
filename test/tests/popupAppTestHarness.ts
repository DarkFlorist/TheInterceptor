// Shared setup for tests that render the whole popup (App) and drive it with runtime messages: wire-format home page fixtures and DOM helpers.
//
// Usage (at the top level of a test file):
//   const installRuntimeMessaging = createRuntimeMessagingInstaller()   // from test/tests/runtimeMessagingTestHarness.ts
//   const messaging = installRuntimeMessaging()
//   await act(() => { render(h(App, {}), dom.document.body) })
//   await act(() => { messaging.dispatch({ role: 'all', ...defaultHomePage(1, { icon: ICON_SIGNING, iconReason: 'Signing' }, 1) }) })
import { createPassthroughCompleteVisualizedSimulation } from '../../app/ts/types/visualizer-types.js'
import type { MockElement } from './domMock.js'
import { clickElement, findAllElements, findElement, isDisabled } from './domQueries.js'

// Fixtures in the wire format the background sends, so they are delivered to the popup's listeners without serialization.

export const defaultSettings = {
	activeSimulationAddress: undefined,
	activeRpcNetwork: {
		name: 'Ethereum',
		chainId: '0x1',
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

const defaultRpcEntries = [{ name: 'Ethereum', chainId: '0x1', httpsRpc: 'https://example.invalid', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }]
export const loadedAddress = '0x1000000000000000000000000000000000000001'
export const loadedAddressBookEntry = { type: 'contact', name: 'Loaded Account', address: loadedAddress, entrySource: 'User', useAsActiveAddress: true }

export const defaultHomePage = (tabId: number, icon: { icon: string, iconReason: string }, popupRefreshGeneration: number, dataOverrides: Record<string, unknown> = {}) => ({
	method: 'popup_UpdateHomePage',
	homeDataSource: 'fresh',
	popupRefreshGeneration,
	data: {
		visualizedSimulatorState: createPassthroughCompleteVisualizedSimulation(),
		activeAddresses: [],
		richList: [],
		makeCurrentAddressRich: false,
		hasSafeTransactionsToExport: false,
		latestUnexpectedError: undefined,
		websiteAccessAddressMetadata: [],
		tabState: {
			tabId,
			website: { websiteOrigin: `tab-${ tabId }.invalid`, icon: undefined, title: `Tab ${ tabId }` },
			signerConnected: false,
			signerName: 'NoSigner',
			signerAccounts: [],
			signerAccountError: undefined,
			signerChain: undefined,
			tabIconDetails: icon,
			activeSigningAddress: undefined,
		},
		currentBlockNumber: undefined,
		settings: defaultSettings,
		rpcConnectionStatus: undefined,
		activeSigningAddressInThisTab: undefined,
		tabId,
		rpcEntries: defaultRpcEntries,
		interceptorDisabled: false,
		preSimulationBlockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: '0xc', deltaUnit: 'Seconds' },
		...dataOverrides,
	},
})

export const defaultHomePageBootstrap = (tabId: number, icon: { icon: string, iconReason: string }, popupRefreshGeneration: number, dataOverrides: Record<string, unknown> = {}) => {
	const homePage = defaultHomePage(tabId, icon, popupRefreshGeneration, dataOverrides)
	return {
		method: 'popup_homePageBootstrap',
		popupRefreshGeneration,
		data: {
			activeAddresses: homePage.data.activeAddresses,
			hasSafeTransactionsToExport: homePage.data.hasSafeTransactionsToExport,
			tabState: homePage.data.tabState,
			settings: homePage.data.settings,
			activeSigningAddressInThisTab: homePage.data.activeSigningAddressInThisTab,
			tabId: homePage.data.tabId,
			rpcEntries: homePage.data.rpcEntries,
			interceptorDisabled: homePage.data.interceptorDisabled,
		},
	}
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
