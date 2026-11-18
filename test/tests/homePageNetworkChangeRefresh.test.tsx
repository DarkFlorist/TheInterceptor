import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { useLiveSimulationHomeData } from '../../app/ts/components/hooks/useLiveSimulationHomeData.js'
import type { RpcEntry } from '../../app/ts/types/rpc.js'
import type { EthereumJsonRpcRequest } from '../../app/ts/types/JsonRpc-types.js'
import { eth_getBlockByNumber_goerli_8443561_true } from '../RPCResponses.js'
import { installDomMock } from './domMock.js'

type RuntimeMessageListener = (message: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => unknown

const storageState: Record<string, unknown> = {}
const pageListeners: RuntimeMessageListener[] = []
const pageMessages: unknown[] = []
let messagesInFlight = 0
let routeBackgroundRequest: ((message: unknown) => Promise<unknown>) | undefined
// Runs once, inside the next read of this storage key, so the change commits while the home page is being built.
let duringStorageRead: { readonly key: string, readonly run: () => Promise<void> } | undefined

const getMessageMethod = (message: unknown) => typeof message === 'object' && message !== null && 'method' in message && typeof message.method === 'string' ? message.method : undefined
const isMessageToPages = (message: unknown) => typeof message === 'object' && message !== null && 'role' in message

function deliverToPages(message: unknown) {
	pageMessages.push(message)
	let response: unknown
	for (const listener of [...pageListeners]) listener(message, {}, (reply?: unknown) => { response = reply })
	return response
}

function installBrowserMock() {
	Object.defineProperty(globalThis, 'browser', {
		configurable: true,
		writable: true,
		value: {
			runtime: {
				lastError: null,
				getManifest: () => ({ manifest_version: 3 }),
				getURL: (path: string) => `chrome-extension://test-extension${ path }`,
				async sendMessage(message: unknown) {
					messagesInFlight += 1
					try {
						await new Promise((resolve) => setTimeout(resolve, 0))
						if (isMessageToPages(message)) return deliverToPages(message)
						const method = getMessageMethod(message)
						if (method === 'popup_isSimulationVisualizerOpen' || method === 'popup_isMainPopupWindowOpen') return deliverToPages(message)
						return await routeBackgroundRequest?.(message)
					} finally {
						messagesInFlight -= 1
					}
				},
				onMessage: {
					addListener(listener: RuntimeMessageListener) { pageListeners.push(listener) },
					removeListener(listener: RuntimeMessageListener) {
						const index = pageListeners.indexOf(listener)
						if (index >= 0) pageListeners.splice(index, 1)
					},
				},
				onConnect: { addListener: () => undefined, removeListener: () => undefined },
			},
			storage: {
				local: {
					async get(keys?: string | string[] | Record<string, unknown> | null) {
						const hook = duringStorageRead
						if (hook !== undefined && (keys === hook.key || (Array.isArray(keys) && keys.includes(hook.key)))) {
							duringStorageRead = undefined
							await hook.run()
						}
						if (keys === undefined || keys === null) return { ...storageState }
						if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => key in storageState).map((key) => [key, storageState[key]]))
						if (typeof keys === 'string') return keys in storageState ? { [keys]: storageState[keys] } : {}
						return Object.fromEntries(Object.entries(keys).map(([key, defaultValue]) => [key, key in storageState ? storageState[key] : defaultValue]))
					},
					async set(items: Record<string, unknown>) { Object.assign(storageState, items) },
					async remove(keys: string | string[]) {
						for (const key of Array.isArray(keys) ? keys : [keys]) delete storageState[key]
					},
				},
			},
			tabs: {
				async query() { return [] },
				async get() { return undefined },
				async update() { return undefined },
				onUpdated: { addListener: () => undefined, removeListener: () => undefined },
				onRemoved: { addListener: () => undefined, removeListener: () => undefined },
			},
			windows: {
				async get() { return undefined },
				async update() { return undefined },
				onRemoved: { addListener: () => undefined, removeListener: () => undefined },
			},
			action: { setIcon: async () => undefined, setTitle: async () => undefined, setBadgeText: async () => undefined, setBadgeBackgroundColor: async () => undefined },
			declarativeNetRequest: { getDynamicRules: async () => [], updateDynamicRules: async () => undefined, getSessionRules: async () => [], updateSessionRules: async () => undefined },
		},
	})
	Object.defineProperty(globalThis, 'chrome', { configurable: true, writable: true, value: { runtime: { id: 'test-extension' } } })
}

installBrowserMock()

const [
	{ popupMessageHandler },
	{ changeActiveAddressAndChain },
	{ getSettings },
	{ browserStorageLocalSet },
	{ EthereumClientService },
	{ TokenPriceService },
] = await Promise.all([
	import('../../app/ts/background/popupMessageRouting.js'),
	import('../../app/ts/background/activeSettings.js'),
	import('../../app/ts/background/settings.js'),
	import('../../app/ts/utils/storageUtils.js'),
	import('../../app/ts/simulation/services/EthereumClientService.js'),
	import('../../app/ts/simulation/services/priceEstimator.js'),
])

const networkA: RpcEntry = { name: 'Network A', chainId: 1337n, httpsRpc: 'https://network-a.invalid', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: true }
const networkB: RpcEntry = { name: 'Network B', chainId: 1338n, httpsRpc: 'https://network-b.invalid', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: true }
const simulationAddress = 0xd8da6bf26964af9d7eed9e03e53415d37aa96045n
const latestBlock: unknown = JSON.parse(eth_getBlockByNumber_goerli_8443561_true).result

const createServices = (network: RpcEntry) => {
	const ethereum = new EthereumClientService({
		rpcUrl: network.httpsRpc,
		clearCache: () => undefined,
		getChainId: async () => network.chainId,
		async jsonRpcRequest(rpcRequest: EthereumJsonRpcRequest) {
			switch (rpcRequest.method) {
				case 'eth_getBlockByNumber': return latestBlock
				case 'eth_blockNumber': return '0x80d6a9'
				case 'eth_getCode': return '0x'
				case 'eth_simulateV1': return rpcRequest.params[0].blockStateCalls.map(() => ({ number: '0x1', hash: '0x0', timestamp: '0x1', gasLimit: '0x1', gasUsed: '0x0', baseFeePerGas: '0x1', calls: [] }))
				default: throw new Error(`Unexpected RPC request: ${ rpcRequest.method }`)
			}
		},
	}, async () => undefined, async () => undefined, network)
	return { ethereum, tokenPriceService: new TokenPriceService(ethereum, 60_000) }
}

let hook: ReturnType<typeof useLiveSimulationHomeData> | undefined
function HomePageConsumer({ requestFreshHomeDataOnMount }: { readonly requestFreshHomeDataOnMount: boolean }) {
	hook = useLiveSimulationHomeData({ answerMainPopupOpen: false, answerSimulationDataConsumerOpen: true, requestFreshHomeDataOnMount })
	return <p>home page</p>
}

async function settle() {
	let idleTicks = 0
	for (let tick = 0; tick < 300 && idleTicks < 4; tick++) {
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
		idleTicks = messagesInFlight === 0 && duringStorageRead === undefined ? idleTicks + 1 : 0
	}
}

const HOME_DATA_REQUESTS = new Set(['popup_refreshHomeData', 'popup_requestNewHomeData'])

// The popup also asks again after a network change. These tests answer only the requests they count, so what they see is the interrupted request's own page.
async function setUpPopup({ requestFreshHomeDataOnMount, homeDataRequestsToAnswer }: { readonly requestFreshHomeDataOnMount: boolean, readonly homeDataRequestsToAnswer: number }) {
	for (const key of Object.keys(storageState)) delete storageState[key]
	pageListeners.length = 0
	pageMessages.length = 0
	installBrowserMock()
	await browserStorageLocalSet({ activeRpcNetwork: networkA, simulationMode: true, independentActiveSimulationAddress: simulationAddress, interceptorTransactionStack: { operations: [] } })
	let current = createServices(networkA)
	const owner = { getCurrent: () => current, reset: (network: RpcEntry) => { current = createServices(network); return current } }
	let remainingHomeDataRequests = homeDataRequestsToAnswer
	routeBackgroundRequest = async (message) => {
		const method = getMessageMethod(message)
		if (method === undefined || !HOME_DATA_REQUESTS.has(method) || remainingHomeDataRequests === 0) return undefined
		remainingHomeDataRequests -= 1
		return await popupMessageHandler(new Map(), owner, message, async () => undefined)
	}
	const dom = installDomMock()
	const container = dom.document.createElement('div')
	dom.document.body.appendChild(container)
	return {
		commitNetworkChangeDuringNextHomePage: () => {
			duringStorageRead = { key: 'rpcConnectionStatus', run: async () => { await changeActiveAddressAndChain(owner, new Map(), { simulationMode: true, rpcNetwork: networkB, promptForAccessesIfNeeded: false }) } }
		},
		// Switches between the two networks while each of the next home pages is built, and counts the pages built.
		commitNetworkChangesDuringHomePages: (changes: number) => {
			const counter = { pagesBuilt: 0 }
			const armNext = (remaining: number) => {
				duringStorageRead = { key: 'rpcConnectionStatus', run: async () => {
					counter.pagesBuilt += 1
					if (remaining === 0) return
					const rpcNetwork = (await getSettings()).activeRpcNetwork.chainId === networkA.chainId ? networkB : networkA
					await changeActiveAddressAndChain(owner, new Map(), { simulationMode: true, rpcNetwork, promptForAccessesIfNeeded: false })
					armNext(remaining - 1)
				} }
			}
			armNext(changes)
			return counter
		},
		answerHomeDataRequests: (count: number) => { remainingHomeDataRequests = count },
		mount: async () => {
			await act(() => { render(<HomePageConsumer requestFreshHomeDataOnMount = { requestFreshHomeDataOnMount } />, container) })
			await settle()
		},
		cleanUp: async () => {
			routeBackgroundRequest = undefined
			await act(() => { render(null, container) })
			dom.restore()
		},
	}
}

type GeneratedPopupMessage = { readonly method: string, readonly popupRefreshGeneration: number, readonly homeDataSource?: string, readonly data: { readonly activeRpcNetwork?: RpcEntry, readonly settings?: { readonly activeRpcNetwork: RpcEntry } } }
const getMessagesWithMethod = (method: string) => pageMessages.flatMap((message) => {
	if (getMessageMethod(message) !== method) return []
	const typedMessage: GeneratedPopupMessage = message
	return [typedMessage]
})

describe('a home page interrupted by a network change', () => {
	test('a fresh refresh reaches the popup, which keeps it over the settings broadcast', async () => {
		const popup = await setUpPopup({ requestFreshHomeDataOnMount: true, homeDataRequestsToAnswer: 1 })
		try {
			popup.commitNetworkChangeDuringNextHomePage()
			await popup.mount()
			assert.equal(hook?.isFreshHomeDataLoaded.value, true)
			assert.equal(hook?.rpcNetwork.value?.name, networkB.name)
			assert.equal(hook?.isSettingsLoaded.value, true)
		} finally {
			await popup.cleanUp()
		}
	})

	test('a cached home page reaches the popup, which keeps it over the settings broadcast', async () => {
		const popup = await setUpPopup({ requestFreshHomeDataOnMount: false, homeDataRequestsToAnswer: 1 })
		try {
			popup.commitNetworkChangeDuringNextHomePage()
			await popup.mount()
			assert.equal(hook?.isSettingsLoaded.value, true)
			assert.equal(hook?.rpcNetwork.value?.name, networkB.name)
		} finally {
			await popup.cleanUp()
		}
	})

	test.each([[2, 1], [3, 0]] as const)('a home page request interrupted by %d network changes publishes %d pages and settles', async (changes, publishedPages) => {
		const popup = await setUpPopup({ requestFreshHomeDataOnMount: true, homeDataRequestsToAnswer: 1 })
		try {
			await popup.mount()
			pageMessages.length = 0
			popup.answerHomeDataRequests(1)
			const counter = popup.commitNetworkChangesDuringHomePages(changes)
			await act(async () => { await browser.runtime.sendMessage({ method: 'popup_requestNewHomeData', data: { refreshSignerAccounts: false, includeWebsiteAccessAddressMetadata: false } }) })
			await settle()
			// Three attempts at most: each change starts the page over on a new snapshot, and the request gives up after the third.
			assert.equal(counter.pagesBuilt, Math.min(changes + 1, 3))
			assert.equal(getMessagesWithMethod('popup_UpdateHomePage').length, publishedPages)
		} finally {
			duringStorageRead = undefined
			await popup.cleanUp()
		}
	})

	test('two overlapping refreshes each send one page of the new network, newer than the settings broadcast', async () => {
		const popup = await setUpPopup({ requestFreshHomeDataOnMount: true, homeDataRequestsToAnswer: 1 })
		try {
			await popup.mount()
			pageMessages.length = 0
			popup.answerHomeDataRequests(2)
			popup.commitNetworkChangeDuringNextHomePage()
			await act(async () => { await Promise.all([browser.runtime.sendMessage({ method: 'popup_refreshHomeData' }), browser.runtime.sendMessage({ method: 'popup_refreshHomeData' })]) })
			await settle()

			const [settingsBroadcast] = getMessagesWithMethod('popup_settingsUpdated')
			if (settingsBroadcast === undefined) throw new Error('missing settings broadcast')
			const pages = getMessagesWithMethod('popup_UpdateHomePage')
			assert.equal(pages.length, 2)
			assert.equal(new Set(pages.map((page) => page.popupRefreshGeneration)).size, 2)
			for (const page of pages) {
				assert.equal(page.data.settings?.activeRpcNetwork.name, networkB.name)
				assert.ok(page.popupRefreshGeneration > settingsBroadcast.popupRefreshGeneration)
			}
		} finally {
			await popup.cleanUp()
		}
	})
})
