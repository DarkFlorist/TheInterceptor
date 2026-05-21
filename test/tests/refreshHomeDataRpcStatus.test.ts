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

	return { sentMessages }
}

describe('refreshHomeData', () => {
	test('sends a fresh home snapshot with the woken retry state', async () => {
		const browserMock = installBrowserMock()
		const [{ browserStorageLocalSet }, { defaultActiveAddresses, defaultRpcs }, { setRpcConnectionStatus }, { refreshHomeData }, { EthereumClientService }, { TokenPriceService }] = await Promise.all([
			import('../../app/ts/utils/storageUtils.js'),
			import('../../app/ts/background/settings.js'),
			import('../../app/ts/background/storageVariables.js'),
			import('../../app/ts/background/popupMessageHandlers.js'),
			import('../../app/ts/simulation/services/EthereumClientService.js'),
			import('../../app/ts/simulation/services/priceEstimator.js'),
		])

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
			clearCache() {},
			async jsonRpcRequest() {
				return await new Promise<never>(() => undefined)
			},
		}, async () => undefined, async () => undefined, rpcNetwork)
		const tokenPriceService = new TokenPriceService(ethereum, 0)

		try {
			await refreshHomeData(ethereum, tokenPriceService, false)
		} finally {
			ethereum.cleanup()
		}

		const homeUpdate = browserMock.sentMessages.findLast((message) => message.method === 'popup_UpdateHomePage')
		assert.equal(homeUpdate?.data?.rpcConnectionStatus?.retrying, true)
	})
})
