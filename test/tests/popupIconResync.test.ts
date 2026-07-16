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

describe('popup icon sync', () => {
	test('marks Home first commit on the immediate default render', async () => {
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

			const simulatingButton = collectElements(dom.document.body, 'button').find((button) => button.textContent?.includes('Simulating'))
			const signingButton = collectElements(dom.document.body, 'button').find((button) => button.textContent?.includes('Signing'))
			assert.equal(simulatingButton?.getAttribute?.('class')?.includes('is-outlined'), false)
			assert.equal(signingButton?.getAttribute?.('class')?.includes('is-outlined'), true)
			assert.equal(performance.getEntriesByName(POPUP_PERFORMANCE_MARKS.homeFirstCommit).length, 1)
			assert.equal(performance.getEntriesByName(POPUP_PERFORMANCE_MARKS.refreshRendered).length, 0)
			assert.equal(sentMessages.some((message) => isHomeDataRequest(message, false, false)), true)
		} finally {
			dom.restore()
			clearPerformanceMarks()
		}
	})

	test('keeps mutation controls disabled until initial home data arrives', async () => {
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

			const richListHeader = collectElements(dom.document.body, 'header').find((header) => header.textContent?.includes('Make current account rich'))
			if (richListHeader === undefined) throw new Error('Expected rich-list header before home data loads')
			await act(async () => {
				await clickElement(richListHeader)
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
			assert.equal(isButtonDisabled(signingButtonBeforeHomeData), true)
			assert.equal(isButtonDisabled(rpcButtonBeforeHomeData), true)
			assert.equal(isButtonDisabled(timePickerModeButtonBeforeHomeData), true)
			assert.equal(isButtonDisabled(timePickerDeltaButtonBeforeHomeData), true)
			assert.equal(editButtonsBeforeHomeData.length, 0)
			assert.equal(copyButtonsBeforeHomeData.length, 0)
			assert.deepEqual(clipboardMock.copiedText, [])
			assert.equal(isButtonDisabled(richCheckboxBeforeHomeData), true)
			assert.equal(isButtonDisabled(timePickerDeltaInputBeforeHomeData), true)

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

			const buttonsAfterHomeData = collectElements(dom.document.body, 'button')
			const rpcButtonAfterHomeData = buttonsAfterHomeData.find((button) => button.textContent?.includes('Ethereum'))
			const timePickerModeButtonAfterHomeData = buttonsAfterHomeData.find((button) => button.textContent?.includes('For'))
			const timePickerDeltaButtonAfterHomeData = buttonsAfterHomeData.find((button) => button.textContent?.includes('Seconds'))
			const editButtonsAfterHomeData = buttonsAfterHomeData.filter((button) => button.textContent?.toLowerCase().includes('edit'))
			const copyButtonAfterHomeData = buttonsAfterHomeData.find((button) => button.textContent?.toLowerCase().includes('copy'))
			const timePickerDeltaInputAfterHomeData = collectElements(dom.document.body, 'input').find((input) => input.getAttribute?.('type') === 'number')
			assert.equal(isButtonDisabled(rpcButtonAfterHomeData), false)
			assert.equal(isButtonDisabled(timePickerModeButtonAfterHomeData), false)
			assert.equal(isButtonDisabled(timePickerDeltaButtonAfterHomeData), false)
			assert.equal(editButtonsAfterHomeData.length > 0, true)
			assert.notEqual(copyButtonAfterHomeData, undefined)
			if (copyButtonAfterHomeData === undefined) throw new Error('Expected active address copy action after home data loads')
			await act(async () => {
				await clickElement(copyButtonAfterHomeData)
			})
			assert.deepEqual(clipboardMock.copiedText, [loadedAddress])
			assert.equal(isButtonDisabled(timePickerDeltaInputAfterHomeData), false)
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
			assert.equal(iconSrcAfterUnknownTabUpdate?.endsWith('head-not-active.png'), true)
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
					method: 'popup_settingsUpdated',
					popupRefreshGeneration: 20,
					data: defaultSettings,
				}, undefined, () => undefined)
			})

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
