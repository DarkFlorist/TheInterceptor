import * as assert from 'assert'
import { beforeEach, describe, test } from 'bun:test'
import type { ExportedSettings } from '../../app/ts/types/exportedSettingsTypes.js'
import type { RpcNetwork } from '../../app/ts/types/rpc.js'

type StorageKeyInput = string | string[] | Record<string, unknown> | undefined | null

function createBrowserStorageMock() {
	const storageState: Record<string, unknown> = {}

	const getItems = (keys?: StorageKeyInput) => {
		if (keys === undefined || keys === null) return { ...storageState }
		if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => key in storageState).map((key) => [key, storageState[key]]))
		if (typeof keys === 'string') return keys in storageState ? { [keys]: storageState[keys] } : {}
		return Object.fromEntries(Object.entries(keys).map(([key, defaultValue]) => [key, key in storageState ? storageState[key] : defaultValue]))
	}

	const removeItems = (keys: string | string[]) => {
		for (const key of Array.isArray(keys) ? keys : [keys]) delete storageState[key]
	}

	const browserMock = {
		runtime: {
			lastError: undefined,
			async sendMessage() {
				return undefined
			},
			getManifest: () => ({ manifest_version: 3 }),
			onMessage: { addListener: () => undefined, removeListener: () => undefined },
			onConnect: { addListener: () => undefined, removeListener: () => undefined },
		},
		storage: {
			local: {
				async get(keys?: StorageKeyInput) {
					return getItems(keys)
				},
				async set(items: Record<string, unknown>) {
					Object.assign(storageState, items)
				},
				async remove(keys: string | string[]) {
					removeItems(keys)
				},
			},
		},
	}

	const installGlobals = () => {
		Object.defineProperty(globalThis, 'browser', { value: browserMock, configurable: true, writable: true })
		Object.defineProperty(globalThis, 'chrome', { value: { runtime: { id: 'test-extension' } }, configurable: true, writable: true })
	}

	installGlobals()

	return {
		reset() {
			for (const key of Object.keys(storageState)) delete storageState[key]
			installGlobals()
		},
	}
}

const browserMock = createBrowserStorageMock()
const settingsModulePromise = import('../../app/ts/background/settings.js')

const testRpcNetwork: RpcNetwork = {
	name: 'Test Mainnet',
	chainId: 1n,
	httpsRpc: 'https://example.test/rpc',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: true,
}

const buildVersion12Import = (useTabsInsteadOfPopup: boolean, metamaskCompatibilityMode: boolean): ExportedSettings => ({
	name: 'InterceptorSettingsAndAddressBook',
	version: '1.2',
	exportedDate: '2026-05-21',
	settings: {
		activeSimulationAddress: 0x1111111111111111111111111111111111111111n,
		rpcNetwork: testRpcNetwork,
		useSignersAddressAsActiveAddress: false,
		websiteAccess: [],
		simulationMode: true,
		addressInfos: [],
		contacts: undefined,
		useTabsInsteadOfPopup,
		metamaskCompatibilityMode,
	},
})

const buildVersion14Import = (useTabsInsteadOfPopup: boolean, metamaskCompatibilityMode: boolean, websiteAccess: ExportedSettings['settings']['websiteAccess'] = []): ExportedSettings => ({
	name: 'InterceptorSettingsAndAddressBook',
	version: '1.4',
	exportedDate: '2026-05-21',
	settings: {
		activeSimulationAddress: 0x2222222222222222222222222222222222222222n,
		rpcNetwork: testRpcNetwork,
		openedPage: { page: 'Home' },
		useSignersAddressAsActiveAddress: false,
		websiteAccess,
		simulationMode: true,
		addressBookEntries: [],
		useTabsInsteadOfPopup,
		metamaskCompatibilityMode,
	},
})

describe('settings import', () => {
	beforeEach(() => {
		browserMock.reset()
	})

	test('restores metamask compatibility mode from version 1.4 exports', async () => {
		const { getMetamaskCompatibilityMode, getUseTabsInsteadOfPopup, importSettingsAndAddressBook, setMetamaskCompatibilityMode, setUseTabsInsteadOfPopup } = await settingsModulePromise
		await setUseTabsInsteadOfPopup(true)
		await setMetamaskCompatibilityMode(false)

		await importSettingsAndAddressBook(buildVersion14Import(false, true))

		assert.equal(await getUseTabsInsteadOfPopup(), false)
		assert.equal(await getMetamaskCompatibilityMode(), true)
	})

	test('does not import version 1.2 metamask mode into the tab-popup preference', async () => {
		const { getMetamaskCompatibilityMode, getUseTabsInsteadOfPopup, importSettingsAndAddressBook, setMetamaskCompatibilityMode, setUseTabsInsteadOfPopup } = await settingsModulePromise
		await setUseTabsInsteadOfPopup(true)
		await setMetamaskCompatibilityMode(false)

		await importSettingsAndAddressBook(buildVersion12Import(false, true))

		assert.equal(await getUseTabsInsteadOfPopup(), false)
		assert.equal(await getMetamaskCompatibilityMode(), true)
	})

	test('sanitizes imported website access icons before persisting them', async () => {
		const { getWebsiteAccess, importSettingsAndAddressBook } = await settingsModulePromise
		await importSettingsAndAddressBook(buildVersion14Import(false, false, [
			{ website: { websiteOrigin: 'remote.example', icon: 'https://remote.example/favicon.png', title: 'Remote' }, access: true },
			{ website: { websiteOrigin: 'cached.example', icon: 'data:image/png;base64,Y2FjaGVk', title: 'Cached' }, access: true },
		]))

		const storedWebsiteAccess = (await browser.storage.local.get('websiteAccess')).websiteAccess
		assert.equal(Array.isArray(storedWebsiteAccess), true)
		if (!Array.isArray(storedWebsiteAccess)) throw new Error('Expected imported websiteAccess to be stored as an array')
		assert.equal(storedWebsiteAccess[0]?.website.icon, undefined)
		assert.equal(storedWebsiteAccess[1]?.website.icon, 'data:image/png;base64,Y2FjaGVk')

		const websiteAccess = await getWebsiteAccess()
		assert.equal(websiteAccess[0]?.website.icon, undefined)
		assert.equal(websiteAccess[1]?.website.icon, 'data:image/png;base64,Y2FjaGVk')
	})
})
