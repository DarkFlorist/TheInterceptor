import * as assert from 'assert'
import { describe, test } from 'bun:test'

type RuntimeMessage = {
	method?: string
	role?: string
	data?: {
		rpcConnectionStatus?: {
			retrying: boolean
		}
	}
}

type PortMessage = {
	method?: string
}

function installBrowserMock() {
	const storageState: Record<string, unknown> = {}
	const sentMessages: RuntimeMessage[] = []

	Object.defineProperty(globalThis, 'browser', {
		configurable: true,
		writable: true,
		value: {
			runtime: {
				lastError: null,
				async sendMessage(message: RuntimeMessage) {
					sentMessages.push(message)
					return undefined
				},
				getManifest: () => ({ manifest_version: 3 }),
				onMessage: { addListener: () => undefined, removeListener: () => undefined },
				onConnect: { addListener: () => undefined, removeListener: () => undefined },
			},
			storage: {
				local: {
					async get(keys?: string | string[] | Record<string, unknown> | null) {
						if (keys === undefined || keys === null) return { ...storageState }
						if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => key in storageState).map((key) => [key, storageState[key]]))
						if (typeof keys === 'string') return keys in storageState ? { [keys]: storageState[keys] } : {}
						return Object.fromEntries(Object.entries(keys).map(([key, defaultValue]) => [key, key in storageState ? storageState[key] : defaultValue]))
					},
					async set(items: Record<string, unknown>) {
						Object.assign(storageState, items)
					},
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
				async getDynamicRules() { return [] },
				async getSessionRules() { return [] },
				async updateDynamicRules() { return undefined },
				async updateSessionRules() { return undefined },
			},
			webRequest: {
				onBeforeRequest: {
					addListener: () => undefined,
					removeListener: () => undefined,
				},
			},
		},
	})
	Object.defineProperty(globalThis, 'chrome', {
		configurable: true,
		writable: true,
		value: { runtime: { id: 'test-extension' } },
	})
	Object.defineProperty(globalThis, 'location', { configurable: true, writable: true, value: { origin: '' } })

	return { sentMessages }
}

function createPort(tabId: number, onPostMessage?: (message: PortMessage) => void) {
	const messages: PortMessage[] = []
	const port = {
		name: '0x0',
		sender: { tab: { id: tabId } },
		postMessage(message: unknown) {
			const typedMessage = message as PortMessage
			messages.push(typedMessage)
			onPostMessage?.(typedMessage)
		},
	} as browser.runtime.Port
	return { port, messages }
}

async function loadModules() {
	return {
		...await import('../../app/ts/utils/storageUtils.js'),
		...await import('../../app/ts/background/settings.js'),
		...await import('../../app/ts/background/storageVariables.js'),
		...await import('../../app/ts/background/popupMessageHandlers.js'),
		...await import('../../app/ts/background/backgroundUtils.js'),
		...await import('../../app/ts/simulation/services/EthereumClientService.js'),
		...await import('../../app/ts/simulation/services/priceEstimator.js'),
	}
}

type TestModules = Awaited<ReturnType<typeof loadModules>>

describe('refreshHomeData', () => {
	test('sends a fresh home snapshot with the woken retry state', async () => {
		const browserMock = installBrowserMock()
		const modules: TestModules = await loadModules()
		const { browserStorageLocalSet, defaultActiveAddresses, defaultRpcs, setRpcConnectionStatus, refreshHomeData, EthereumClientService, TokenPriceService } = modules

		const [defaultAddress] = defaultActiveAddresses
		if (defaultAddress === undefined) throw new Error('missing default address')
		const rpcNetwork = defaultRpcs[0]
		if (rpcNetwork === undefined) throw new Error('missing default rpc')

		await browserStorageLocalSet({
			activeSimulationAddress: defaultAddress.address,
			openedPageV2: { page: 'Home' },
			useSignersAddressAsActiveAddress: false,
			websiteAccess: [],
			activeRpcNetwork: rpcNetwork,
			simulationMode: false,
			makeCurrentAddressRich: false,
			fixedAddressRichList: [],
		})
		await setRpcConnectionStatus({
			isConnected: false,
			lastConnnectionAttempt: new Date('2024-01-01T00:00:00.000Z'),
			latestBlock: undefined,
			rpcNetwork,
			retrying: false,
		})

		const ethereum = new EthereumClientService({
			rpcUrl: rpcNetwork.httpsRpc,
			clearCache() { /* noop test stub */ },
			async jsonRpcRequest() {
				return await new Promise<never>(() => undefined)
			},
		}, async () => undefined, async () => undefined, rpcNetwork)
		const tokenPriceService = new TokenPriceService(ethereum, 0)

		try {
			await refreshHomeData(ethereum, tokenPriceService, new Map(), true, 1, false)
		} finally {
			ethereum.cleanup()
		}

		const homeUpdate = browserMock.sentMessages.findLast((message) => message.method === 'popup_UpdateHomePage')
		assert.equal(homeUpdate?.data?.rpcConnectionStatus?.retrying, true)
	})

	test('refresh path waits for signer accounts when missing but refresh is enabled', async () => {
		const browserMock = installBrowserMock()
		const modules: TestModules = await loadModules()
		const {
			browserStorageLocalSet,
			saveCurrentTabId,
			updateTabState,
			setRpcConnectionStatus,
			refreshHomeData,
			defaultActiveAddresses,
			defaultRpcs,
			websiteSocketToString,
			sendInternalWindowMessage,
			EthereumClientService,
			TokenPriceService,
			getTabState,
		} = modules
		const [defaultAddress] = defaultActiveAddresses
		if (defaultAddress === undefined) throw new Error('missing default address')
		const rpcNetwork = defaultRpcs[0]
		if (rpcNetwork === undefined) throw new Error('missing default rpc')
		await browserStorageLocalSet({
			activeSimulationAddress: defaultAddress.address,
			openedPageV2: { page: 'Home' },
			useSignersAddressAsActiveAddress: false,
			websiteAccess: [],
			activeRpcNetwork: rpcNetwork,
			simulationMode: false,
			makeCurrentAddressRich: false,
			fixedAddressRichList: [],
		})
		await setRpcConnectionStatus({
			isConnected: false,
			lastConnnectionAttempt: new Date('2024-01-01T00:00:00.000Z'),
			latestBlock: undefined,
			rpcNetwork,
			retrying: false,
		})
		await saveCurrentTabId(1)
		await updateTabState(1, (previousState) => ({
			...previousState,
			website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
			signerName: 'MetaMask',
			signerAccounts: [],
		}))

		const signerAccount = 0x4444444444444444444444444444444444444444n
		const socket = { tabId: 1, connectionName: 0n }
		let requestCount = 0
		const { port } = createPort(socket.tabId, async (message) => {
			if (message.method !== 'request_signer_to_eth_accounts') return
			requestCount += 1
			void updateTabState(socket.tabId, (previousState) => ({
				...previousState,
				signerAccounts: [signerAccount],
				activeSigningAddress: signerAccount,
			})).then(() => {
				sendInternalWindowMessage({ method: 'window_signer_accounts_changed', data: { socket } })
			})
		})
		const websiteTabConnections = new Map([[socket.tabId, {
			connections: {
				[websiteSocketToString(socket)]: { port, socket, websiteOrigin: 'https://example.com', approved: true, wantsToConnect: true },
			},
		}]])
		const ethereum = new EthereumClientService({
			rpcUrl: rpcNetwork.httpsRpc,
			clearCache() { /* noop test stub */ },
			async jsonRpcRequest() {
				return await new Promise<never>(() => undefined)
			},
		}, async () => undefined, async () => undefined, rpcNetwork)
		const tokenPriceService = new TokenPriceService(ethereum, 0)

		try {
			await refreshHomeData(ethereum, tokenPriceService, websiteTabConnections, true, 1, false)
		} finally {
			ethereum.cleanup()
		}

		const homeUpdate = browserMock.sentMessages.findLast((message) => message.method === 'popup_UpdateHomePage') as { data?: { tabState?: { signerAccounts?: readonly string[] } } } | undefined
		const updatedState = await getTabState(1)
		const result = homeUpdate?.data?.tabState?.signerAccounts
		assert.equal(requestCount, 1)
		assert.equal(result?.length, 1)
		assert.equal(result?.[0], '0x4444444444444444444444444444444444444444')
		assert.equal(updatedState.signerAccounts?.[0], signerAccount)
	})

	test('refresh path does not request signer accounts with no approved socket', async () => {
		const browserMock = installBrowserMock()
		const { browserStorageLocalSet, saveCurrentTabId, updateTabState, setRpcConnectionStatus, refreshHomeData, defaultActiveAddresses, defaultRpcs, EthereumClientService, TokenPriceService } = await loadModules()

		const [defaultAddress] = defaultActiveAddresses
		if (defaultAddress === undefined) throw new Error('missing default address')
		const rpcNetwork = defaultRpcs[0]
		if (rpcNetwork === undefined) throw new Error('missing default rpc')
		await browserStorageLocalSet({
			activeSimulationAddress: defaultAddress.address,
			openedPageV2: { page: 'Home' },
			useSignersAddressAsActiveAddress: false,
			websiteAccess: [],
			activeRpcNetwork: rpcNetwork,
			simulationMode: false,
			makeCurrentAddressRich: false,
			fixedAddressRichList: [],
		})
		await setRpcConnectionStatus({
			isConnected: false,
			lastConnnectionAttempt: new Date('2024-01-01T00:00:00.000Z'),
			latestBlock: undefined,
			rpcNetwork,
			retrying: false,
		})
		await saveCurrentTabId(1)
		await updateTabState(1, (previousState) => ({
			...previousState,
			website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
			signerName: 'MetaMask',
			signerAccounts: [],
		}))

		const ethereum = new EthereumClientService({
			rpcUrl: rpcNetwork.httpsRpc,
			clearCache() { /* noop test stub */ },
			async jsonRpcRequest() {
				return await new Promise<never>(() => undefined)
			},
		}, async () => undefined, async () => undefined, rpcNetwork)
		const tokenPriceService = new TokenPriceService(ethereum, 0)

		try {
			await refreshHomeData(ethereum, tokenPriceService, new Map(), true, 1, false)
		} finally {
			ethereum.cleanup()
		}

		const homeUpdate = browserMock.sentMessages.findLast((message) => message.method === 'popup_UpdateHomePage') as { data?: { tabState?: { signerAccounts?: readonly string[] } } } | undefined
		assert.equal(homeUpdate?.data?.tabState?.signerAccounts?.length, 0)
	})

	test('changeSettings refreshes home without triggering signer account refresh', async () => {
		const browserMock = installBrowserMock()
		const { browserStorageLocalSet, saveCurrentTabId, updateTabState, setRpcConnectionStatus, changeSettings, defaultActiveAddresses, defaultRpcs, EthereumClientService, TokenPriceService } = await loadModules()

		const [defaultAddress] = defaultActiveAddresses
		if (defaultAddress === undefined) throw new Error('missing default address')
		const rpcNetwork = defaultRpcs[0]
		if (rpcNetwork === undefined) throw new Error('missing default rpc')
		await browserStorageLocalSet({
			activeSimulationAddress: defaultAddress.address,
			openedPageV2: { page: 'Home' },
			useSignersAddressAsActiveAddress: false,
			websiteAccess: [],
			activeRpcNetwork: rpcNetwork,
			simulationMode: false,
			makeCurrentAddressRich: false,
			fixedAddressRichList: [],
		})
		await setRpcConnectionStatus({
			isConnected: false,
			lastConnnectionAttempt: new Date('2024-01-01T00:00:00.000Z'),
			latestBlock: undefined,
			rpcNetwork,
			retrying: false,
		})
		await saveCurrentTabId(1)
		await updateTabState(1, (previousState) => ({
			...previousState,
			website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
			signerName: 'MetaMask',
			signerAccounts: [],
		}))

		const ethereum = new EthereumClientService({
			rpcUrl: rpcNetwork.httpsRpc,
			clearCache() { /* noop test stub */ },
			async jsonRpcRequest() {
				return await new Promise<never>(() => undefined)
			},
		}, async () => undefined, async () => undefined, rpcNetwork)
		const tokenPriceService = new TokenPriceService(ethereum, 0)

		try {
			await changeSettings(ethereum, tokenPriceService, {} as never, { method: 'popup_ChangeSettings', data: {} } as never, undefined)
		} finally {
			ethereum.cleanup()
		}

		const requestMessages = browserMock.sentMessages.filter((message) => message.method === 'request_signer_to_eth_accounts')
		assert.equal(requestMessages.length, 0)
	})
})
