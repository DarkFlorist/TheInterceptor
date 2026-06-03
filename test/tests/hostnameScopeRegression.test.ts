import * as assert from 'assert'
import { describe, test } from 'bun:test'

type StorageState = Record<string, unknown>

function installBrowserMock(storageState: StorageState, manifestVersion = 3) {
	const registeredContentScripts: Array<{
		excludeMatches?: readonly string[]
	}> = []
	let webRequestListener: ((details: browser.webRequest._OnBeforeRequestDetails) => unknown) | undefined

	globalThis.browser = {
		runtime: {
			lastError: null,
			async sendMessage() {
				return undefined
			},
			getManifest: () => ({ manifest_version: manifestVersion }),
			onMessage: { addListener: () => undefined, removeListener: () => undefined },
			onConnect: { addListener: () => undefined, removeListener: () => undefined },
		},
		storage: {
			local: {
				async get(keys?: string | string[] | Record<string, unknown> | null) {
					if (keys === undefined || keys === null) return { ...storageState }
					if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, storageState[key]]))
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
			async query() {
				return []
			},
			async get() {
				return undefined
			},
			async update() {
				return undefined
			},
			async reload() {
				return undefined
			},
			onUpdated: { addListener: () => undefined, removeListener: () => undefined },
			onRemoved: { addListener: () => undefined, removeListener: () => undefined },
		},
		windows: { get: async () => undefined, update: async () => undefined },
		action: {
			async setIcon() {
				return undefined
			},
			async setTitle() {
				return undefined
			},
			async setBadgeText() {
				return undefined
			},
			async setBadgeBackgroundColor() {
				return undefined
			},
		},
		browserAction: {
			async setIcon() {
				return undefined
			},
			async setTitle() {
				return undefined
			},
			async setBadgeText() {
				return undefined
			},
			async setBadgeBackgroundColor() {
				return undefined
			},
		},
		scripting: {
			async unregisterContentScripts() {
				return undefined
			},
			async registerContentScripts(scripts: Array<{ excludeMatches?: readonly string[] }>) {
				registeredContentScripts.splice(0, registeredContentScripts.length, ...scripts)
			},
		},
		declarativeNetRequest: {
			async getDynamicRules() {
				return []
			},
			async getSessionRules() {
				return []
			},
			async updateDynamicRules() {
				return undefined
			},
			async updateSessionRules() {
				return undefined
			},
		},
		webNavigation: {
			onCommitted: { addListener: () => undefined, removeListener: () => undefined },
		},
		webRequest: {
			onBeforeRequest: {
				addListener(listener: (details: browser.webRequest._OnBeforeRequestDetails) => unknown) {
					webRequestListener = listener
				},
				removeListener(listener: (details: browser.webRequest._OnBeforeRequestDetails) => unknown) {
					if (webRequestListener === listener) webRequestListener = undefined
				},
			},
		},
	} as unknown as typeof globalThis.browser

	;(globalThis as typeof globalThis & { chrome: { runtime: { id: string } } }).chrome = { runtime: { id: 'test-extension' } }

	return {
		registeredContentScripts,
		getWebRequestListener: () => webRequestListener,
	}
}

describe('hostname scope regressions', () => {
	test('MV3 content script exclusions include disabled hostnames stored with ports', async () => {
		const storageState: StorageState = {
			websiteAccess: [
				{
					website: {
						websiteOrigin: 'localhost:3000',
						icon: undefined,
						title: 'Local app',
					},
					addressAccess: [],
					interceptorDisabled: true,
				},
			],
		}
		const { registeredContentScripts } = installBrowserMock(storageState)
		const { updateContentScriptInjectionStrategyManifestV3 } = await import('../../app/ts/utils/contentScriptsUpdating.js')

		await updateContentScriptInjectionStrategyManifestV3()

		assert.equal(registeredContentScripts.length, 2)
		assert.deepEqual(registeredContentScripts[0]?.excludeMatches, ['*://localhost/*'])
		assert.deepEqual(registeredContentScripts[1]?.excludeMatches, ['*://localhost/*'])
	})

	test('removing one origin clears hostname-scoped website access entries', async () => {
		const storageState: StorageState = {
			websiteAccess: [
				{
					website: {
						websiteOrigin: 'localhost:3000',
						icon: undefined,
						title: 'App A',
					},
					addressAccess: [],
					interceptorDisabled: true,
					declarativeNetRequestBlockMode: 'block-all',
				},
				{
					website: {
						websiteOrigin: 'localhost:5173',
						icon: undefined,
						title: 'App B',
					},
					addressAccess: [],
					access: true,
				},
				{
					website: {
						websiteOrigin: 'otherhost.test:3000',
						icon: undefined,
						title: 'Other Host',
					},
					addressAccess: [],
					access: true,
				},
			],
			activeRpcNetwork: {
				name: 'Ethereum Mainnet',
				chainId: 1n,
				httpsRpc: 'https://ethereum.dark.florist',
				currencyName: 'Ether',
				currencyTicker: 'ETH',
				currencyLogoUri: '../img/ethereum.svg',
				primary: true,
				minimized: true,
			},
			activeSimulationAddress: 0xd8da6bf26964af9d7eed9e03e53415d37aa96045n,
			openedPageV2: { page: 'Home' },
			useSignersAddressAsActiveAddress: false,
			simulationMode: true,
		}
		installBrowserMock(storageState)
		const { removeWebsiteAccess } = await import('../../app/ts/background/popupMessageHandlers.js')

		await removeWebsiteAccess({} as never, {} as never, {} as never, new Map(), {
			method: 'popup_removeWebsiteAccess',
			data: { websiteOrigin: 'localhost:3000' },
		})

		assert.deepEqual(storageState.websiteAccess, [
			{
				website: {
					websiteOrigin: 'otherhost.test:3000',
					icon: undefined,
					title: 'Other Host',
				},
				addressAccess: [],
				access: true,
			},
		])
	})

	test('MV2 blocking treats same-host different-port traffic as first-party', async () => {
		const storageState: StorageState = {
			websiteAccess: [
				{
					website: {
						websiteOrigin: 'localhost:3000',
						icon: undefined,
						title: 'Local app',
					},
					addressAccess: [],
					declarativeNetRequestBlockMode: 'block-all',
				},
			],
			activeRpcNetwork: {
				name: 'Ethereum Mainnet',
				chainId: 1n,
				httpsRpc: 'https://ethereum.dark.florist',
				currencyName: 'Ether',
				currencyTicker: 'ETH',
				currencyLogoUri: '../img/ethereum.svg',
				primary: true,
				minimized: true,
			},
			activeSimulationAddress: 0xd8da6bf26964af9d7eed9e03e53415d37aa96045n,
			openedPageV2: { page: 'Home' },
			useSignersAddressAsActiveAddress: false,
			simulationMode: true,
		}
		const { getWebRequestListener } = installBrowserMock(storageState, 2)
		const { updateDeclarativeNetRequestBlocks } = await import('../../app/ts/background/accessManagement.js')

		await updateDeclarativeNetRequestBlocks(new Map())

		const listener = getWebRequestListener()
		assert.notEqual(listener, undefined)
		const sameHostResult = listener?.({
			tabId: 10,
			originUrl: 'http://localhost:3000',
			url: 'http://localhost:5173/asset.js',
			type: 'xmlhttprequest',
		} as browser.webRequest._OnBeforeRequestDetails)
		const crossHostResult = listener?.({
			tabId: 10,
			originUrl: 'http://localhost:3000',
			url: 'http://api.otherhost.test/asset.js',
			type: 'xmlhttprequest',
		} as browser.webRequest._OnBeforeRequestDetails)

		assert.deepEqual(sameHostResult, {})
		assert.deepEqual(crossHostResult, { cancel: true })
	})

	test('bulk interceptor access edits normalize host-scoped settings across sibling origins', async () => {
		const storageState: StorageState = {
			websiteAccess: [
				{
					website: {
						websiteOrigin: 'localhost:3000',
						icon: undefined,
						title: 'App A',
					},
					addressAccess: [],
					access: true,
					declarativeNetRequestBlockMode: 'disabled',
				},
				{
					website: {
						websiteOrigin: 'localhost:5173',
						icon: undefined,
						title: 'App B',
					},
					addressAccess: [],
					access: true,
					declarativeNetRequestBlockMode: 'disabled',
				},
			],
			activeRpcNetwork: {
				name: 'Ethereum Mainnet',
				chainId: 1n,
				httpsRpc: 'https://ethereum.dark.florist',
				currencyName: 'Ether',
				currencyTicker: 'ETH',
				currencyLogoUri: '../img/ethereum.svg',
				primary: true,
				minimized: true,
			},
			activeSimulationAddress: 0xd8da6bf26964af9d7eed9e03e53415d37aa96045n,
			openedPageV2: { page: 'Home' },
			useSignersAddressAsActiveAddress: false,
			simulationMode: true,
		}
		installBrowserMock(storageState)
		const { changeInterceptorAccess } = await import('../../app/ts/background/popupMessageHandlers.js')

		await changeInterceptorAccess({} as never, {} as never, {} as never, new Map(), {
			method: 'popup_changeInterceptorAccess',
			data: [
				{
					oldEntry: {
						website: {
							websiteOrigin: 'localhost:3000',
							icon: undefined,
							title: 'App A',
						},
						addressAccess: [],
						access: true,
						declarativeNetRequestBlockMode: 'disabled',
					},
					newEntry: {
						website: {
							websiteOrigin: 'localhost:3000',
							icon: undefined,
							title: 'App A',
						},
						addressAccess: [],
						access: true,
						declarativeNetRequestBlockMode: 'block-all',
					},
					removed: false,
				},
			],
		})

		assert.deepEqual(storageState.websiteAccess, [
			{
				website: {
					websiteOrigin: 'localhost:3000',
					icon: undefined,
					title: 'App A',
				},
				addressAccess: [],
				access: true,
				declarativeNetRequestBlockMode: 'block-all',
			},
			{
				website: {
					websiteOrigin: 'localhost:5173',
					icon: undefined,
					title: 'App B',
				},
				addressAccess: [],
				access: true,
				declarativeNetRequestBlockMode: 'block-all',
			},
		])
	})
})
