import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { act } from 'preact/test-utils'
import { h, render } from 'preact'
import { App } from '../../app/ts/components/App.js'
import { createPassthroughCompleteVisualizedSimulation } from '../../app/ts/types/visualizer-types.js'
import type { UpdateHomePage as UpdateHomePageData } from '../../app/ts/types/interceptor-messages.js'
import type { Settings } from '../../app/ts/types/interceptor-messages.js'
import { installDomMock } from './domMock.js'
import { ICON_SIGNING, ICON_SIMULATING } from '../../app/ts/utils/constants.js'

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
	const defaultHomePage = (tabId: number, icon: { icon: string; iconReason: string }, popupRefreshGeneration: number): UpdateHomePageData => ({
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
	},
})

describe('popup icon sync', () => {
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
