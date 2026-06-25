import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { useLiveSimulationHomeData } from '../../app/ts/components/hooks/useLiveSimulationHomeData.js'
import { SimulationStackPage } from '../../app/ts/components/pages/SimulationStackPage.js'
import { createPassthroughCompleteVisualizedSimulation } from '../../app/ts/types/visualizer-types.js'
import type { Settings, UpdateHomePage } from '../../app/ts/types/interceptor-messages.js'
import { installDomMock } from './domMock.js'

type RuntimeMessageListener = (message: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => boolean | undefined

function installBrowserMock() {
	const listeners: RuntimeMessageListener[] = []
	const sentMessages: unknown[] = []
	Object.defineProperty(globalThis, 'browser', {
		configurable: true,
		writable: true,
		value: {
			runtime: {
				lastError: null,
				async sendMessage(message: unknown) {
					sentMessages.push(message)
					return undefined
				},
				onMessage: {
					addListener(listener: RuntimeMessageListener) {
						listeners.push(listener)
					},
					removeListener(listener: RuntimeMessageListener) {
						const index = listeners.indexOf(listener)
						if (index >= 0) listeners.splice(index, 1)
					},
				},
			},
		},
	})
	Object.defineProperty(globalThis, 'chrome', {
		configurable: true,
		writable: true,
		value: { runtime: { id: 'test-extension' } },
	})
	return { listeners, sentMessages }
}

function StackVisualizerHookProbe() {
	useLiveSimulationHomeData({
		answerSimulationDataConsumerOpen: true,
		requestFreshHomeDataOnMount: false,
	})
	return <div>ready</div>
}

function CrossTabStackVisualizerHookProbe() {
	const { tabState } = useLiveSimulationHomeData({
		answerSimulationDataConsumerOpen: true,
		requestFreshHomeDataOnMount: false,
		filterByTabId: false,
	})
	return <div>{ tabState.value?.tabIconDetails.iconReason ?? 'empty' }</div>
}

function sendRuntimeMessage(listener: RuntimeMessageListener, message: unknown) {
	let response: unknown
	const returned = listener(message, {}, (nextResponse?: unknown) => {
		response = nextResponse
	})
	return { returned, response }
}

const settings: Settings = {
	activeSimulationAddress: undefined,
	activeRpcNetwork: {
		name: 'Ethereum',
		chainId: '0x1',
		httpsRpc: 'https://example.invalid',
		currencyName: 'Ether',
		currencyTicker: 'ETH',
		primary: true,
		minimized: false,
	},
	openedPage: { page: 'Home' },
	useSignersAddressAsActiveAddress: false,
	websiteAccess: [],
	simulationMode: false,
}

function createHomePageUpdate(tabId: number, popupRefreshGeneration: number, iconReason: string, numberOfAddressesMadeRich = 0): UpdateHomePage {
	return {
		method: 'popup_UpdateHomePage',
		popupRefreshGeneration,
		data: {
			visualizedSimulatorState: createPassthroughCompleteVisualizedSimulation(0, 'done', numberOfAddressesMadeRich),
			activeAddresses: [],
			richList: [],
			makeCurrentAddressRich: false,
			latestUnexpectedError: undefined,
			websiteAccessAddressMetadata: [],
			tabState: {
				tabId,
				website: { websiteOrigin: `https://tab-${ tabId }.example`, icon: undefined, title: `Tab ${ tabId }` },
				signerConnected: false,
				signerName: 'NoSigner',
				signerAccounts: [],
				signerAccountError: undefined,
				signerChain: undefined,
				tabIconDetails: { icon: '../img/head-not-active.png', iconReason },
				activeSigningAddress: undefined,
			},
			currentBlockNumber: undefined,
			settings,
			rpcConnectionStatus: undefined,
			activeSigningAddressInThisTab: undefined,
			tabId,
			rpcEntries: [settings.activeRpcNetwork],
			interceptorDisabled: false,
			preSimulationBlockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: '0x0', deltaUnit: 'Seconds' },
		},
	}
}

describe('simulation visualizer open replies', () => {
	test('stack visualizer hook answers the visualizer-open probe', async () => {
		const dom = installDomMock()
		const { listeners } = installBrowserMock()
		try {
			await act(() => {
				render(h(StackVisualizerHookProbe, {}), dom.document.body)
			})
			const listener = listeners[0]
			if (listener === undefined) throw new Error('Expected hook to register a runtime listener')

			const visualizerReply = sendRuntimeMessage(listener, { method: 'popup_isSimulationVisualizerOpen' })
			assert.equal(visualizerReply.returned, true)
			assert.deepEqual(visualizerReply.response, { method: 'popup_isSimulationVisualizerOpen', data: { isOpen: true } })
		} finally {
			dom.restore()
		}
	})

	test('stack visualizer hook accepts updates from a different tab id', async () => {
		const dom = installDomMock()
		const { listeners } = installBrowserMock()
		try {
			await act(() => {
				render(h(CrossTabStackVisualizerHookProbe, {}), dom.document.body)
			})
			const listener = listeners[0]
			if (listener === undefined) throw new Error('Expected hook to register a runtime listener')

			await act(() => {
				listener({ role: 'all', ...createHomePageUpdate(10, 1, 'First tab') }, {}, () => undefined)
			})
			assert.equal(dom.document.body.textContent?.includes('First tab'), true)

			await act(() => {
				listener({ role: 'all', ...createHomePageUpdate(11, 2, 'Second tab') }, {}, () => undefined)
			})
			assert.equal(dom.document.body.textContent?.includes('Second tab'), true)
			assert.equal(dom.document.body.textContent?.includes('First tab'), false)
		} finally {
			dom.restore()
		}
	})

	test('stack visualizer page shows rich-only state instead of the empty-state dino', async () => {
		const dom = installDomMock()
		const { listeners } = installBrowserMock()
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})
			const listener = listeners[0]
			if (listener === undefined) throw new Error('Expected page to register a runtime listener')

			await act(() => {
				listener({ role: 'all', ...createHomePageUpdate(12, 1, 'Rich tab', 2) }, {}, () => undefined)
			})

			assert.equal(dom.document.body.textContent?.includes('Simply making 2 addresses rich'), true)
			assert.equal(dom.document.body.textContent?.includes('Give me some transactions to munch on!'), false)
		} finally {
			dom.restore()
		}
	})
})
