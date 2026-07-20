import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { act } from 'preact/test-utils'
import { h, render } from 'preact'
import { App } from '../../app/ts/components/App.js'
import { createPassthroughCompleteVisualizedSimulation } from '../../app/ts/types/visualizer-types.js'
import type { Settings } from '../../app/ts/types/interceptor-messages.js'
import { installDomMock } from './domMock.js'
import { ICON_SIGNING, ICON_SIMULATING } from '../../app/ts/utils/constants.js'
import { POPUP_PERFORMANCE_MARKS, clearPerformanceMarks } from '../../app/ts/utils/popupPerformance.js'

type RuntimeMessageListener = (message: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => void

function installBrowserMock() {
	const sentMessages: unknown[] = []
	let messageListener: RuntimeMessageListener | undefined

	Object.defineProperty(globalThis, 'browser', { configurable: true, value: {
		runtime: {
			lastError: null,
			async sendMessage(message: unknown) {
				sentMessages.push(message)
				return undefined
			},
			getManifest: () => ({ manifest_version: 3 }),
			onMessage: {
				addListener: (listener: RuntimeMessageListener) => {
					messageListener = listener
				},
				removeListener: () => undefined,
			},
			onConnect: { addListener: () => undefined, removeListener: () => undefined },
		},
		storage: {
			local: {
				async get(keys?: string | string[] | Record<string, unknown> | null) {
					if (keys === undefined || keys === null) return {}
					if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, undefined]))
					if (typeof keys === 'string') return { [keys]: undefined }
					return Object.fromEntries(Object.entries(keys).map(([key]) => [key, undefined]))
				},
				async set() { return undefined },
				async remove() { return undefined },
			},
		},
		tabs: {
			query: async () => [],
			get: async () => undefined,
			update: async () => undefined,
			onUpdated: { addListener: () => undefined, removeListener: () => undefined },
			onRemoved: { addListener: () => undefined, removeListener: () => undefined },
		},
		windows: {
			get: async () => undefined,
			update: async () => undefined,
		},
		action: {
			async setIcon() { return undefined },
			async setTitle() { return undefined },
			async setBadgeText() { return undefined },
			async setBadgeBackgroundColor() { return undefined },
		},
		browserAction: {
			async setIcon() { return undefined },
			async setTitle() { return undefined },
			async setBadgeText() { return undefined },
			async setBadgeBackgroundColor() { return undefined },
		},
		declarativeNetRequest: {
			getDynamicRules: async () => [],
			getSessionRules: async () => [],
			updateDynamicRules: async () => undefined,
			updateSessionRules: async () => undefined,
		},
	}, writable: true })

	Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { runtime: { id: 'test-extension' } }, writable: true })

	return { messageListener: () => messageListener, sentMessages }
}

function collectImageSrcs(node: { nodeType: number; childNodes?: readonly { nodeType: number; childNodes: readonly unknown[] }[]; getAttribute?: (_name: string) => string | null; }): string[] {
	if (node.nodeType === 1 && node.getAttribute !== undefined) {
		const src = node.getAttribute('src')
		if (src !== null) return [src]
	}
	if (node.childNodes === undefined) return []
	return node.childNodes.flatMap((child) => collectImageSrcs(child as { nodeType: number; childNodes: readonly { nodeType: number; childNodes: readonly unknown[] }[]; getAttribute?: (_name: string) => string | null }))
}

type TestDomNode = {
	readonly nodeType: number
	readonly tagName?: string
	readonly childNodes?: readonly TestDomNode[]
	readonly textContent?: string | null
	readonly disabled?: boolean
	readonly l?: Record<string, (event: unknown) => unknown>
	readonly blur?: () => void
	readonly getAttribute?: (name: string) => string | null
}

function collectElements(node: TestDomNode, tagName: string, results: TestDomNode[] = []) {
	if (node.tagName === tagName.toUpperCase()) results.push(node)
	for (const child of node.childNodes ?? []) collectElements(child, tagName, results)
	return results
}

function hasAriaLabel(node: TestDomNode, label: string): boolean {
	if (node.getAttribute?.('aria-label') === label) return true
	return (node.childNodes ?? []).some((child) => hasAriaLabel(child, label))
}

function hasClass(node: TestDomNode | undefined, className: string) {
	return node?.getAttribute?.('class')?.split(/\s+/).includes(className) === true
}

function findElementWithClass(node: TestDomNode, tagName: string, className: string) {
	return collectElements(node, tagName).find((element) => hasClass(element, className))
}

function isHomeDataRequest(message: unknown, refreshSignerAccounts: boolean, includeWebsiteAccessAddressMetadata: boolean) {
	return typeof message === 'object'
		&& message !== null
		&& 'method' in message
		&& message.method === 'popup_requestNewHomeData'
		&& 'data' in message
		&& typeof message.data === 'object'
		&& message.data !== null
		&& 'refreshSignerAccounts' in message.data
		&& message.data.refreshSignerAccounts === refreshSignerAccounts
		&& 'includeWebsiteAccessAddressMetadata' in message.data
		&& message.data.includeWebsiteAccessAddressMetadata === includeWebsiteAccessAddressMetadata
}

function isButtonDisabled(button: TestDomNode | undefined) {
	return button?.disabled === true || button?.getAttribute?.('disabled') !== null
}

async function clickElement(element: TestDomNode) {
	const clickHandler = element.l === undefined ? undefined : Object.entries(element.l).find(([key]) => key.startsWith('Click'))?.[1]
	if (clickHandler === undefined) throw new Error('Expected click handler')
	await clickHandler({
		currentTarget: {
			blur: () => element.blur?.(),
			value: element.getAttribute?.('value') ?? undefined,
		},
		clientX: 0,
		clientY: 0,
		stopPropagation() { return undefined },
	})
}

function installClipboardMock() {
	const previousNavigator = globalThis.navigator
	const copiedText: string[] = []
	Object.defineProperty(globalThis, 'navigator', {
		configurable: true,
		writable: true,
		value: {
			clipboard: {
				async writeText(text: string) {
					copiedText.push(text)
				},
			},
		},
	})
	return {
		copiedText,
		restore() {
			Object.defineProperty(globalThis, 'navigator', {
				configurable: true,
				writable: true,
				value: previousNavigator,
			})
		},
	}
}

class TestClipboardEvent extends Event {
	readonly clipboardData: { getData: (type: string) => string }

	constructor(text: string) {
		super('paste')
		this.clipboardData = {
			getData: (type: string) => type === 'text' ? text : '',
		}
	}
}

const defaultSettings: Settings = {
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
const loadedAddress = '0x1000000000000000000000000000000000000001'
const loadedAddressBookEntry = { type: 'contact', name: 'Loaded Account', address: loadedAddress, entrySource: 'User', useAsActiveAddress: true }
const defaultHomePage = (tabId: number, icon: { icon: string; iconReason: string }, popupRefreshGeneration: number, dataOverrides: Record<string, unknown> = {}) => ({
	method: 'popup_UpdateHomePage',
	homeDataSource: 'fresh',
	popupRefreshGeneration,
	data: {
		visualizedSimulatorState: createPassthroughCompleteVisualizedSimulation(),
		activeAddresses: [],
		richList: [],
		makeCurrentAddressRich: false,
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

const defaultHomePageBootstrap = (tabId: number, icon: { icon: string; iconReason: string }, popupRefreshGeneration: number, dataOverrides: Record<string, unknown> = {}) => {
	const homePage = defaultHomePage(tabId, icon, popupRefreshGeneration, dataOverrides)
	return {
		method: 'popup_homePageBootstrap',
		popupRefreshGeneration,
		data: {
			activeAddresses: homePage.data.activeAddresses,
			tabState: homePage.data.tabState,
			settings: homePage.data.settings,
			activeSigningAddressInThisTab: homePage.data.activeSigningAddressInThisTab,
			tabId: homePage.data.tabId,
			rpcEntries: homePage.data.rpcEntries,
			interceptorDisabled: homePage.data.interceptorDisabled,
		},
	}
}

describe('popup icon sync', () => {
	test('renders loading instead of default popup data while requesting bootstrap and fresh home data', async () => {
		clearPerformanceMarks()
		const dom = installDomMock()
		const { sentMessages } = installBrowserMock()
		try {
			Object.defineProperty(globalThis, 'window', {
				value: {
					document: dom.document,
					addEventListener: () => undefined,
					removeEventListener: () => undefined,
				},
				configurable: true,
				writable: true,
			})

			await act(() => {
				render(h(App, {}), dom.document.body)
			})

			const loadingState = collectElements(dom.document.body, 'section').find((section) => section.getAttribute?.('aria-label') === 'Loading current popup state')
			assert.notEqual(loadingState, undefined)
			if (loadingState === undefined) throw new Error('Expected the popup loading placeholder')
			assert.equal(hasClass(loadingState, 'popup-home-card'), true)
			assert.notEqual(findElementWithClass(loadingState, 'header', 'popup-home-header-layout'), undefined)
			assert.notEqual(findElementWithClass(loadingState, 'div', 'active-address-row'), undefined)
			assert.equal(collectElements(loadingState, 'svg').length, 0)
			assert.equal(dom.document.body.textContent?.includes('vitalik.eth'), false)
			assert.equal(collectElements(dom.document.body, 'button').some((button) => button.textContent?.includes('Simulating')), false)
			assert.equal(collectElements(dom.document.body, 'button').some((button) => button.textContent?.includes('Signing')), false)
			assert.equal(performance.getEntriesByName(POPUP_PERFORMANCE_MARKS.homeFirstCommit).length, 1)
			assert.equal(performance.getEntriesByName(POPUP_PERFORMANCE_MARKS.refreshRendered).length, 0)
			assert.equal(sentMessages.some((message) => typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_requestHomePageBootstrap'), true)
			assert.equal(sentMessages.some((message) => isHomeDataRequest(message, false, false)), false)
			assert.equal(sentMessages.some((message) => typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_refreshHomeData'), true)
		} finally {
			dom.restore()
			clearPerformanceMarks()
		}
	})

	test('does not render a full cached home snapshot while waiting for current data', async () => {
		const dom = installDomMock()
		const { messageListener } = installBrowserMock()
		try {
			Object.defineProperty(globalThis, 'window', {
				value: {
					document: dom.document,
					addEventListener: () => undefined,
					removeEventListener: () => undefined,
				},
				configurable: true,
				writable: true,
			})

			await act(() => {
				render(h(App, {}), dom.document.body)
			})
			const listener = messageListener()
			assert.equal(typeof listener, 'function')
			await act(() => {
				listener?.({
					role: 'all',
					...defaultHomePage(1, { icon: ICON_SIMULATING, iconReason: 'Cached simulation' }, 50, {
						activeAddresses: [loadedAddressBookEntry],
						settings: { ...defaultSettings, activeSimulationAddress: loadedAddress, simulationMode: true },
					}),
					homeDataSource: 'cached',
				}, undefined, () => undefined)
			})

			assert.equal(hasAriaLabel(dom.document.body, 'Loading current popup state'), true)
			assert.equal(dom.document.body.textContent?.includes('Loaded Account'), false)
			assert.equal(collectElements(dom.document.body, 'button').some((button) => button.textContent?.includes('Simulating')), false)
		} finally {
			dom.restore()
		}
	})

	test('renders known signing mode and address from bootstrap home data', async () => {
		const dom = installDomMock()
		const { messageListener } = installBrowserMock()
		try {
			Object.defineProperty(globalThis, 'window', {
				value: {
					document: dom.document,
					addEventListener: () => undefined,
					removeEventListener: () => undefined,
				},
				configurable: true,
				writable: true,
			})

			await act(() => {
				render(h(App, {}), dom.document.body)
			})

			const logoSlotBeforeHomeData = collectElements(dom.document.body, 'span').find((element) => element.getAttribute?.('class')?.split(/\s+/).includes('signer-logo-slot'))
			assert.equal(logoSlotBeforeHomeData, undefined)

			const listener = messageListener()
			assert.equal(typeof listener, 'function')
			const homePageBootstrap = defaultHomePageBootstrap(1, { icon: ICON_SIGNING, iconReason: 'Signing' }, 1, {
				activeAddresses: [loadedAddressBookEntry],
				activeSigningAddressInThisTab: loadedAddress,
				tabState: {
					...defaultHomePage(1, { icon: ICON_SIGNING, iconReason: 'Signing' }, 1).data.tabState,
					signerConnected: true,
					signerName: 'MetaMask',
					signerAccounts: [loadedAddress],
				},
			})
			await act(() => {
				listener?.({
					role: 'all',
					...homePageBootstrap,
				}, undefined, () => undefined)
			})

			const logoSlotAfterCachedHomeData = collectElements(dom.document.body, 'span').find((element) => element.getAttribute?.('class')?.split(/\s+/).includes('signer-logo-slot'))
			if (logoSlotAfterCachedHomeData === undefined) throw new Error('Expected signer logo slot after bootstrap data loads')
			assert.equal(collectElements(logoSlotAfterCachedHomeData, 'img')[0]?.getAttribute?.('src'), '../img/signers/metamask.svg')
			assert.equal(collectElements(dom.document.body, 'section').some((section) => section.getAttribute?.('aria-label') === 'Loading current popup state'), false)
			assert.equal(collectElements(dom.document.body, 'div').some((div) => div.getAttribute?.('aria-label') === 'Loading active address'), false)
			assert.equal(dom.document.body.textContent?.includes('Loaded Account'), true)
			const loadedHomeCard = findElementWithClass(dom.document.body, 'section', 'popup-home-card')
			if (loadedHomeCard === undefined) throw new Error('Expected the loaded Home card')
			assert.notEqual(findElementWithClass(loadedHomeCard, 'header', 'popup-home-header-layout'), undefined)
			assert.notEqual(findElementWithClass(loadedHomeCard, 'div', 'active-address-row'), undefined)
			const signingButton = collectElements(dom.document.body, 'button').find((button) => button.textContent?.includes('Signing'))
			const simulatingButton = collectElements(dom.document.body, 'button').find((button) => button.textContent?.includes('Simulating'))
			assert.equal(signingButton?.getAttribute?.('class')?.includes('is-outlined'), false)
			assert.equal(simulatingButton?.getAttribute?.('class')?.includes('is-outlined'), true)
		} finally {
			dom.restore()
		}
	})

	test('keeps only the missing active address loading after bootstrap home data arrives', async () => {
		const dom = installDomMock()
		const { messageListener } = installBrowserMock()
		try {
			Object.defineProperty(globalThis, 'window', {
				value: {
					document: dom.document,
					addEventListener: () => undefined,
					removeEventListener: () => undefined,
				},
				configurable: true,
				writable: true,
			})

			await act(() => {
				render(h(App, {}), dom.document.body)
			})
			const listener = messageListener()
			assert.equal(typeof listener, 'function')
			const homePageBootstrap = defaultHomePageBootstrap(1, { icon: ICON_SIGNING, iconReason: 'Signing' }, 1, {
				tabState: {
					...defaultHomePage(1, { icon: ICON_SIGNING, iconReason: 'Signing' }, 1).data.tabState,
					signerName: 'MetaMask',
				},
			})
			await act(() => {
				listener?.({
					role: 'all',
					...homePageBootstrap,
				}, undefined, () => undefined)
			})

			assert.equal(collectElements(dom.document.body, 'section').some((section) => section.getAttribute?.('aria-label') === 'Loading current popup state'), false)
			const activeAddressLoading = collectElements(dom.document.body, 'div').find((div) => div.getAttribute?.('aria-label') === 'Loading active address')
			assert.notEqual(activeAddressLoading, undefined)
			assert.equal(hasClass(activeAddressLoading, 'active-address-row'), true)
			assert.equal(hasClass(activeAddressLoading, 'popup-loading-address'), true)
			assert.equal(collectElements(dom.document.body, 'svg').some((svg) => svg.getAttribute?.('class') === 'spinner'), false)
			assert.equal(dom.document.body.textContent?.includes('No address found'), false)
			assert.equal(dom.document.body.textContent?.includes('NOT CONNECTED'), false)
			assert.equal(collectElements(dom.document.body, 'button').some((button) => button.textContent?.includes('Signing')), true)
		} finally {
			dom.restore()
		}
	})

	test('requests fresh data for live updates while the initial refresh is pending', async () => {
		const dom = installDomMock()
		const { messageListener, sentMessages } = installBrowserMock()
		try {
			Object.defineProperty(globalThis, 'window', {
				value: {
					document: dom.document,
					addEventListener: () => undefined,
					removeEventListener: () => undefined,
				},
				configurable: true,
				writable: true,
			})

			await act(() => {
				render(h(App, {}), dom.document.body)
			})
			const listener = messageListener()
			assert.equal(typeof listener, 'function')
			sentMessages.splice(0)

			await act(() => {
				listener?.({
					role: 'all',
					method: 'popup_signer_name_changed',
				}, undefined, () => undefined)
			})

			assert.equal(sentMessages.some((message) => typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_refreshHomeData'), true)
			assert.equal(sentMessages.some((message) => typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_requestNewHomeData'), false)
		} finally {
			dom.restore()
		}
	})

	test('accepts fresh data for a newly active tab after rendering bootstrap data', async () => {
		const dom = installDomMock()
		const clipboardMock = installClipboardMock()
		const { messageListener } = installBrowserMock()
		try {
			Object.defineProperty(globalThis, 'window', {
				value: {
					document: dom.document,
					addEventListener: () => undefined,
					removeEventListener: () => undefined,
				},
				configurable: true,
				writable: true,
			})

			await act(() => {
				render(h(App, {}), dom.document.body)
			})

			const buttonsBeforeHomeData = collectElements(dom.document.body, 'button')
			const signingButtonBeforeHomeData = buttonsBeforeHomeData.find((button) => button.textContent?.includes('Signing'))
			const rpcButtonBeforeHomeData = buttonsBeforeHomeData.find((button) => button.textContent?.includes('Ethereum Mainnet'))
			const timePickerModeButtonBeforeHomeData = buttonsBeforeHomeData.find((button) => button.textContent?.includes('For'))
			const timePickerDeltaButtonBeforeHomeData = buttonsBeforeHomeData.find((button) => button.textContent?.includes('Seconds'))
			const editButtonsBeforeHomeData = buttonsBeforeHomeData.filter((button) => button.textContent?.toLowerCase().includes('edit'))
			const copyButtonsBeforeHomeData = buttonsBeforeHomeData.filter((button) => button.textContent?.toLowerCase().includes('copy'))
			const richCheckboxBeforeHomeData = collectElements(dom.document.body, 'input').find((input) => input.getAttribute?.('type') === 'checkbox')
			const timePickerDeltaInputBeforeHomeData = collectElements(dom.document.body, 'input').find((input) => input.getAttribute?.('type') === 'number')
			assert.equal(signingButtonBeforeHomeData, undefined)
			assert.equal(rpcButtonBeforeHomeData, undefined)
			assert.equal(timePickerModeButtonBeforeHomeData, undefined)
			assert.equal(timePickerDeltaButtonBeforeHomeData, undefined)
			assert.equal(editButtonsBeforeHomeData.length, 0)
			assert.equal(copyButtonsBeforeHomeData.length, 0)
			assert.deepEqual(clipboardMock.copiedText, [])
			assert.equal(richCheckboxBeforeHomeData, undefined)
			assert.equal(timePickerDeltaInputBeforeHomeData, undefined)

			const listener = messageListener()
			assert.equal(typeof listener, 'function')
			const bootstrapHomePage = defaultHomePageBootstrap(1, { icon: ICON_SIMULATING, iconReason: 'Simulating' }, 10, {
				activeAddresses: [loadedAddressBookEntry],
				settings: { ...defaultSettings, activeSimulationAddress: loadedAddress, simulationMode: true },
			})
			await act(() => {
				listener?.({
					role: 'all',
					...bootstrapHomePage,
				}, undefined, () => undefined)
			})

			const buttonsAfterHomeData = collectElements(dom.document.body, 'button')
			const simulatingButtonAfterHomeData = buttonsAfterHomeData.find((button) => button.textContent?.includes('Simulating'))
			const rpcButtonAfterHomeData = buttonsAfterHomeData.find((button) => button.textContent?.includes('Ethereum'))
			const timePickerModeButtonAfterHomeData = buttonsAfterHomeData.find((button) => button.textContent?.includes('For'))
			const timePickerDeltaButtonAfterHomeData = buttonsAfterHomeData.find((button) => button.textContent?.includes('Seconds'))
			const editButtonsAfterHomeData = buttonsAfterHomeData.filter((button) => button.textContent?.toLowerCase().includes('edit'))
			const copyButtonAfterHomeData = buttonsAfterHomeData.find((button) => button.textContent?.toLowerCase().includes('copy'))
			const timePickerDeltaInputAfterHomeData = collectElements(dom.document.body, 'input').find((input) => input.getAttribute?.('type') === 'number')
			assert.equal(simulatingButtonAfterHomeData?.getAttribute?.('class')?.includes('is-outlined'), false)
			assert.equal(isButtonDisabled(rpcButtonAfterHomeData), false)
			assert.equal(timePickerModeButtonAfterHomeData, undefined)
			assert.equal(timePickerDeltaButtonAfterHomeData, undefined)
			assert.equal(editButtonsAfterHomeData.length > 0, true)
			assert.notEqual(copyButtonAfterHomeData, undefined)
			if (copyButtonAfterHomeData === undefined) throw new Error('Expected active address copy action after home data loads')
			await act(async () => {
				await clickElement(copyButtonAfterHomeData)
			})
			assert.deepEqual(clipboardMock.copiedText, [loadedAddress])
			assert.equal(timePickerDeltaInputAfterHomeData, undefined)
			assert.equal(hasAriaLabel(dom.document.body, 'Loading simulation controls'), true)
			assert.equal(hasAriaLabel(dom.document.body, 'Loading current simulation state'), true)
			const loadingSimulationControls = collectElements(dom.document.body, 'div').find((element) => element.getAttribute?.('aria-label') === 'Loading simulation controls')
			const loadingSimulationState = collectElements(dom.document.body, 'div').find((element) => element.getAttribute?.('aria-label') === 'Loading current simulation state')
			assert.equal(hasClass(loadingSimulationControls, 'popup-simulation-controls'), true)
			assert.notEqual(findElementWithClass(loadingSimulationControls ?? dom.document.body, 'div', 'time-picker-row'), undefined)
			assert.notEqual(findElementWithClass(loadingSimulationState ?? dom.document.body, 'div', 'simulation-results-header'), undefined)

			await act(() => {
				listener?.({
					role: 'all',
					...defaultHomePage(2, { icon: ICON_SIMULATING, iconReason: 'Fresh tab' }, 2, {
						activeAddresses: [loadedAddressBookEntry],
						settings: { ...defaultSettings, activeSimulationAddress: loadedAddress, simulationMode: true },
					}),
				}, undefined, () => undefined)
			})
			const buttonsAfterFreshHomeData = collectElements(dom.document.body, 'button')
			assert.equal(isButtonDisabled(buttonsAfterFreshHomeData.find((button) => button.textContent?.includes('For'))), false)
			assert.equal(isButtonDisabled(buttonsAfterFreshHomeData.find((button) => button.textContent?.includes('Seconds'))), false)
			assert.equal(isButtonDisabled(collectElements(dom.document.body, 'input').find((input) => input.getAttribute?.('type') === 'number')), false)
			assert.equal(hasAriaLabel(dom.document.body, 'Loading simulation controls'), false)
			assert.equal(hasAriaLabel(dom.document.body, 'Loading current simulation state'), false)
			assert.notEqual(findElementWithClass(dom.document.body, 'div', 'popup-simulation-controls'), undefined)
			assert.notEqual(findElementWithClass(dom.document.body, 'div', 'time-picker-row'), undefined)
			assert.notEqual(findElementWithClass(dom.document.body, 'div', 'simulation-results-header'), undefined)
			assert.equal(dom.document.body.textContent?.includes('tab-2.invalid'), true)
		} finally {
			clipboardMock.restore()
			dom.restore()
		}
	})

	test('ignores pasted addresses until initial home data arrives', async () => {
		const dom = installDomMock()
		const { messageListener, sentMessages } = installBrowserMock()
		let pasteListener: ((event: Event) => void) | undefined
		const pastedAddress = '0x2000000000000000000000000000000000000002'
		try {
			Object.defineProperty(globalThis, 'ClipboardEvent', { value: TestClipboardEvent, configurable: true, writable: true })
			Object.defineProperty(globalThis, 'window', {
				value: {
					document: dom.document,
					addEventListener: (type: string, listener: (event: Event) => void) => {
						if (type === 'paste') pasteListener = listener
					},
					removeEventListener: () => undefined,
				},
				configurable: true,
				writable: true,
			})

			await act(() => {
				render(h(App, {}), dom.document.body)
			})

			assert.equal(typeof pasteListener, 'function')
			sentMessages.splice(0)
			await act(() => {
				pasteListener?.(new TestClipboardEvent(pastedAddress))
			})
			assert.equal(sentMessages.some((message) => typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_changePage'), false)

			const listener = messageListener()
			assert.equal(typeof listener, 'function')
			await act(() => {
				listener?.({
					role: 'all',
					...defaultHomePage(1, { icon: ICON_SIMULATING, iconReason: 'Simulating' }, 1, {
						activeAddresses: [loadedAddressBookEntry],
						settings: { ...defaultSettings, activeSimulationAddress: loadedAddress, simulationMode: true },
					}),
				}, undefined, () => undefined)
			})

			sentMessages.splice(0)
			await act(() => {
				pasteListener?.(new TestClipboardEvent(pastedAddress))
			})
			assert.equal(sentMessages.some((message) => typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_changePage'), true)
		} finally {
			dom.restore()
			Reflect.deleteProperty(globalThis, 'ClipboardEvent')
		}
	})

	test('requests signer refresh for signer-related live updates', async () => {
		const dom = installDomMock()
		const { messageListener, sentMessages } = installBrowserMock()
		try {
			Object.defineProperty(globalThis, 'window', {
				value: {
					document: dom.document,
					addEventListener: () => undefined,
					removeEventListener: () => undefined,
				},
				configurable: true,
				writable: true,
			})

			await act(() => {
				render(h(App, {}), dom.document.body)
			})
			const listener = messageListener()
			assert.equal(typeof listener, 'function')
			await act(() => {
				listener?.({
					role: 'all',
					...defaultHomePage(1, { icon: ICON_SIGNING, iconReason: 'Signing' }, 1),
				}, undefined, () => undefined)
			})
			sentMessages.splice(0)

			await act(() => {
				listener?.({
					role: 'all',
					method: 'popup_signer_name_changed',
				}, undefined, () => undefined)
			})

			assert.equal(sentMessages.some((message) => isHomeDataRequest(message, true, true)), true)
		} finally {
			dom.restore()
		}
	})

	test('does not request full home data after popup live simulation updates', async () => {
		const dom = installDomMock()
		const { messageListener, sentMessages } = installBrowserMock()
		try {
			Object.defineProperty(globalThis, 'window', {
				value: {
					document: dom.document,
					addEventListener: () => undefined,
					removeEventListener: () => undefined,
				},
				configurable: true,
				writable: true,
			})

			await act(() => {
				render(h(App, {}), dom.document.body)
			})
			const listener = messageListener()
			assert.equal(typeof listener, 'function')
			sentMessages.splice(0)

			await act(() => {
				listener?.({
					role: 'all',
					method: 'popup_simulation_state_changed',
					data: { visualizedSimulatorState: createPassthroughCompleteVisualizedSimulation() },
				}, undefined, () => undefined)
			})

			assert.equal(sentMessages.some((message) => typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_requestNewHomeData'), false)
		} finally {
			dom.restore()
		}
	})

	test('ignores icon updates for a different tab id', async () => {
		const dom = installDomMock()
		const { messageListener, sentMessages } = installBrowserMock()
		try {
			Object.defineProperty(globalThis, 'window', {
				value: {
					document: dom.document,
					addEventListener: () => undefined,
					removeEventListener: () => undefined,
				},
				configurable: true,
				writable: true,
			})

			await act(() => {
				render(h(App, {}), dom.document.body)
			})
			const listener = messageListener()
			assert.equal(typeof listener, 'function')
			const initialMessage = defaultHomePage(1, { icon: ICON_SIGNING, iconReason: 'Signing' }, 1)

			await act(() => {
				// first message should establish the active tab id
				listener?.({ role: 'all', ...initialMessage }, undefined, () => undefined)
			})
			assert.equal(sentMessages.length > 0, true)

			const iconSrcAfterHomePage = collectImageSrcs(dom.document.body).find((src) => src.includes('head-'))
			assert.equal(iconSrcAfterHomePage?.endsWith('head-signing.png'), true)

			await act(() => {
				// stale icon update for another tab must not override current tab icon
				listener?.({
					role: 'all',
					method: 'popup_websiteIconChanged',
					popupRefreshGeneration: 2,
					tabId: 2,
					data: { icon: ICON_SIMULATING, iconReason: 'Simulating' },
				}, undefined, () => undefined)
			})
			const iconSrcAfterWrongTabUpdate = collectImageSrcs(dom.document.body).find((src) => src.includes('head-'))
			assert.equal(iconSrcAfterWrongTabUpdate?.endsWith('head-signing.png'), true)
		} finally {
			dom.restore()
		}
	})

	test('does not apply icon updates while tab id is unknown', async () => {
		const dom = installDomMock()
		const { messageListener } = installBrowserMock()
		try {
			Object.defineProperty(globalThis, 'window', {
				value: {
					document: dom.document,
					addEventListener: () => undefined,
					removeEventListener: () => undefined,
				},
				configurable: true,
				writable: true,
			})

			await act(() => {
				render(h(App, {}), dom.document.body)
			})
			const listener = messageListener()
			assert.equal(typeof listener, 'function')

			await act(() => {
				listener?.({
					role: 'all',
					method: 'popup_websiteIconChanged',
					popupRefreshGeneration: 2,
					tabId: 2,
					data: { icon: ICON_SIMULATING, iconReason: 'Simulating' },
				}, undefined, () => undefined)
			})

			const iconSrcAfterUnknownTabUpdate = collectImageSrcs(dom.document.body).find((src) => src.includes('head-'))
			assert.equal(iconSrcAfterUnknownTabUpdate, undefined)
		} finally {
			dom.restore()
		}
	})

	test('ignores stale popup home updates', async () => {
		const dom = installDomMock()
		const { messageListener } = installBrowserMock()
		try {
			Object.defineProperty(globalThis, 'window', {
				value: {
					document: dom.document,
					addEventListener: () => undefined,
					removeEventListener: () => undefined,
				},
				configurable: true,
				writable: true,
			})

			await act(() => {
				render(h(App, {}), dom.document.body)
			})
			const listener = messageListener()
			assert.equal(typeof listener, 'function')

			await act(() => {
				listener?.({
					role: 'all',
					...defaultHomePage(1, { icon: ICON_SIGNING, iconReason: 'Signing' }, 10),
				}, undefined, () => undefined)
			})
			const iconAfterCurrentTabUpdate = collectImageSrcs(dom.document.body).find((src) => src.includes('head-'))
			assert.equal(iconAfterCurrentTabUpdate?.endsWith('head-signing.png'), true)

			await act(() => {
				listener?.({
					role: 'all',
					...defaultHomePage(1, { icon: ICON_SIMULATING, iconReason: 'Simulating' }, 5),
				}, undefined, () => undefined)
			})
			const iconAfterStaleUpdate = collectImageSrcs(dom.document.body).find((src) => src.includes('head-'))
			assert.equal(iconAfterStaleUpdate?.endsWith('head-signing.png'), true)

			await act(() => {
				listener?.({
					role: 'all',
					...defaultHomePage(1, { icon: ICON_SIMULATING, iconReason: 'Simulating' }, 20),
					method: 'popup_UpdateHomePage',
				}, undefined, () => undefined)
			})
			const iconAfterFreshUpdate = collectImageSrcs(dom.document.body).find((src) => src.includes('head-'))
			assert.equal(iconAfterFreshUpdate?.endsWith('head-simulating.png'), true)
		} finally {
			dom.restore()
		}
	})

	test('does not apply higher-generation updates for a non-current tab', async () => {
		const dom = installDomMock()
		const { messageListener } = installBrowserMock()
		try {
			Object.defineProperty(globalThis, 'window', {
				value: {
					document: dom.document,
					addEventListener: () => undefined,
					removeEventListener: () => undefined,
				},
				configurable: true,
				writable: true,
			})

			await act(() => {
				render(h(App, {}), dom.document.body)
			})
			const listener = messageListener()
			assert.equal(typeof listener, 'function')

			await act(() => {
				listener?.({
					role: 'all',
					...defaultHomePage(1, { icon: ICON_SIGNING, iconReason: 'Signing' }, 10),
				}, undefined, () => undefined)
			})
			const iconAfterCurrentTabUpdate = collectImageSrcs(dom.document.body).find((src) => src.includes('head-'))
			assert.equal(iconAfterCurrentTabUpdate?.endsWith('head-signing.png'), true)

			await act(() => {
				listener?.({
					role: 'all',
					...defaultHomePage(2, { icon: ICON_SIMULATING, iconReason: 'Simulating' }, 20),
				}, undefined, () => undefined)
			})
			const iconAfterWrongTabUpdate = collectImageSrcs(dom.document.body).find((src) => src.includes('head-'))
			assert.equal(iconAfterWrongTabUpdate?.endsWith('head-signing.png'), true)

			await act(() => {
				listener?.({
					role: 'all',
					...defaultHomePage(1, { icon: ICON_SIMULATING, iconReason: 'Simulating' }, 11),
					method: 'popup_UpdateHomePage',
				}, undefined, () => undefined)
			})
			const iconAfterCurrentTabFreshUpdate = collectImageSrcs(dom.document.body).find((src) => src.includes('head-'))
			assert.equal(iconAfterCurrentTabFreshUpdate?.endsWith('head-simulating.png'), true)
		} finally {
			dom.restore()
		}
	})

	test('non-current icon updates do not block later current tab icon updates', async () => {
		const dom = installDomMock()
		const { messageListener } = installBrowserMock()
		try {
			Object.defineProperty(globalThis, 'window', {
				value: {
					document: dom.document,
					addEventListener: () => undefined,
					removeEventListener: () => undefined,
				},
				configurable: true,
				writable: true,
			})

			await act(() => {
				render(h(App, {}), dom.document.body)
			})
			const listener = messageListener()
			assert.equal(typeof listener, 'function')

			await act(() => {
				listener?.({
					role: 'all',
					...defaultHomePage(1, { icon: ICON_SIGNING, iconReason: 'Signing' }, 10),
				}, undefined, () => undefined)
			})
			const iconAfterCurrentTabUpdate = collectImageSrcs(dom.document.body).find((src) => src.includes('head-'))
			assert.equal(iconAfterCurrentTabUpdate?.endsWith('head-signing.png'), true)

			await act(() => {
				listener?.({
					role: 'all',
					method: 'popup_websiteIconChanged',
					popupRefreshGeneration: 20,
					tabId: 2,
					data: { icon: ICON_SIMULATING, iconReason: 'Simulating' },
				}, undefined, () => undefined)
			})
			const iconAfterWrongTabIconUpdate = collectImageSrcs(dom.document.body).find((src) => src.includes('head-'))
			assert.equal(iconAfterWrongTabIconUpdate?.endsWith('head-signing.png'), true)

			await act(() => {
				listener?.({
					role: 'all',
					method: 'popup_websiteIconChanged',
					popupRefreshGeneration: 11,
					tabId: 1,
					data: { icon: ICON_SIMULATING, iconReason: 'Simulating' },
				}, undefined, () => undefined)
			})
			const iconAfterCurrentTabIconUpdate = collectImageSrcs(dom.document.body).find((src) => src.includes('head-'))
			assert.equal(iconAfterCurrentTabIconUpdate?.endsWith('head-simulating.png'), true)
		} finally {
			dom.restore()
		}
	})

	test('same-tab icon updates update refresh generation to protect stale home payloads', async () => {
		const dom = installDomMock()
		const { messageListener } = installBrowserMock()
		try {
			Object.defineProperty(globalThis, 'window', {
				value: {
					document: dom.document,
					addEventListener: () => undefined,
					removeEventListener: () => undefined,
				},
				configurable: true,
				writable: true,
			})

			await act(() => {
				render(h(App, {}), dom.document.body)
			})
			const listener = messageListener()
			assert.equal(typeof listener, 'function')

			await act(() => {
				listener?.({
					role: 'all',
					...defaultHomePage(1, { icon: ICON_SIGNING, iconReason: 'Signing' }, 10),
				}, undefined, () => undefined)
			})

			await act(() => {
				listener?.({
					role: 'all',
					method: 'popup_websiteIconChanged',
					popupRefreshGeneration: 20,
					tabId: 1,
					data: { icon: ICON_SIMULATING, iconReason: 'Simulating' },
				}, undefined, () => undefined)
			})

			await act(() => {
				listener?.({
					role: 'all',
					...defaultHomePage(1, { icon: ICON_SIGNING, iconReason: 'Signing' }, 15),
				}, undefined, () => undefined)
			})
			const iconAfterStaleHomeUpdate = collectImageSrcs(dom.document.body).find((src) => src.includes('head-'))
			assert.equal(iconAfterStaleHomeUpdate?.endsWith('head-simulating.png'), true)
		} finally {
			dom.restore()
		}
	})

	test('settings update blocks stale home updates with lower generation', async () => {
		const dom = installDomMock()
		const { messageListener, sentMessages } = installBrowserMock()
		try {
			Object.defineProperty(globalThis, 'window', {
				value: {
					document: dom.document,
					addEventListener: () => undefined,
					removeEventListener: () => undefined,
				},
				configurable: true,
				writable: true,
			})

			await act(() => {
				render(h(App, {}), dom.document.body)
			})
			const listener = messageListener()
			assert.equal(typeof listener, 'function')

			await act(() => {
				listener?.({
					role: 'all',
					...defaultHomePage(1, { icon: ICON_SIGNING, iconReason: 'Signing' }, 10),
				}, undefined, () => undefined)
			})
			const iconAfterCurrentTabUpdate = collectImageSrcs(dom.document.body).find((src) => src.includes('head-'))
			assert.equal(iconAfterCurrentTabUpdate?.endsWith('head-signing.png'), true)
			sentMessages.splice(0)

			await act(() => {
				listener?.({
					role: 'all',
					method: 'popup_settingsUpdated',
					popupRefreshGeneration: 20,
					data: defaultSettings,
				}, undefined, () => undefined)
			})
			assert.equal(sentMessages.some((message) => isHomeDataRequest(message, false, true)), true)

			await act(() => {
				listener?.({
					role: 'all',
					...defaultHomePage(1, { icon: ICON_SIMULATING, iconReason: 'Simulating' }, 5),
				}, undefined, () => undefined)
			})
			const iconAfterStaleHomeAfterSettingsUpdate = collectImageSrcs(dom.document.body).find((src) => src.includes('head-'))
			assert.equal(iconAfterStaleHomeAfterSettingsUpdate?.endsWith('head-signing.png'), true)
		} finally {
			dom.restore()
		}
	})
})
