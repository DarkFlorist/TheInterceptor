import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { ICON_NOT_ACTIVE, ICON_SIMULATING } from '../../app/ts/utils/constants.js'

type BrowserStorageState = Record<string, unknown>
type MockTab = {
	id: number
	url: string
	status: 'complete' | 'loading'
	title?: string
	favIconUrl?: string
}

function installBrowserMock(tabs: readonly MockTab[]) {
	const storageState: BrowserStorageState = {}
	const tabsById = new Map(tabs.map((tab) => [tab.id, tab]))
	const setIconCalls: browser.action._SetIconDetails[] = []
	const setTitleCalls: browser.action._SetTitleDetails[] = []

	globalThis.browser = {
		runtime: {
			lastError: null,
			async sendMessage() {
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
			async query() {
				return []
			},
			async get(tabId: number) {
				const tab = tabsById.get(tabId)
				if (tab === undefined) throw new Error(`No tab with id ${ tabId }`)
				return tab
			},
			async update() {
				return undefined
			},
			onUpdated: { addListener: () => undefined, removeListener: () => undefined },
			onRemoved: { addListener: () => undefined, removeListener: () => undefined },
		},
		windows: { get: async () => undefined, update: async () => undefined },
		action: {
			async setIcon(details: browser.action._SetIconDetails) {
				setIconCalls.push(details)
				return undefined
			},
			async setTitle(details: browser.action._SetTitleDetails) {
				setTitleCalls.push(details)
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
		webRequest: {
			onBeforeRequest: { addListener: () => undefined, removeListener: () => undefined },
		},
	} as typeof globalThis.browser
	globalThis.chrome = { runtime: { id: 'test-extension' } }

	return { setIconCalls, setTitleCalls }
}

async function loadModules() {
	return {
		...(await import('../../app/ts/background/accessManagement.js')),
		...(await import('../../app/ts/background/backgroundUtils.js')),
		...(await import('../../app/ts/background/iconHandler.js')),
		...(await import('../../app/ts/background/settings.js')),
		...(await import('../../app/ts/background/storageVariables.js')),
		...(await import('../../app/ts/background/websiteTabConnections.js')),
	}
}

function createPort(tabId: number) {
	return {
		name: '0x0',
		sender: { tab: { id: tabId } },
		postMessage: () => undefined,
	} as browser.runtime.Port
}

async function flushAsyncWork() {
	await Promise.resolve()
	await Promise.resolve()
	await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('extension icon deduping', () => {
	test('setIcon runs on the first state change and not on an identical follow-up update', async () => {
		const { setIconCalls, setTitleCalls } = installBrowserMock([{ id: 1, url: 'https://example.test', status: 'complete' }])
		const { changeSimulationMode, updateExtensionIcon, updateTabState } = await loadModules()

		await changeSimulationMode({
			simulationMode: false,
			activeSigningAddress: undefined,
		})
		await updateTabState(1, (previousState) => ({
			...previousState,
			tabIconDetails: {
				icon: ICON_SIMULATING,
				iconReason: 'The Interceptor simulates your sent transactions.',
			},
		}))

		await updateExtensionIcon(new Map(), 1, 'example.test')
		assert.equal(setIconCalls.length, 1)
		assert.equal(setTitleCalls.length, 1)

		await updateExtensionIcon(new Map(), 1, 'example.test')
		assert.equal(setIconCalls.length, 1)
		assert.equal(setTitleCalls.length, 1)
	})

	test('title-only icon updates skip setIcon', async () => {
		const { setIconCalls, setTitleCalls } = installBrowserMock([{ id: 1, url: 'https://example.test', status: 'complete' }])
		const { changeSimulationMode, updateExtensionIcon, updateTabState } = await loadModules()

		await changeSimulationMode({
			simulationMode: false,
			activeSigningAddress: undefined,
		})
		await updateTabState(1, (previousState) => ({
			...previousState,
			tabIconDetails: {
				icon: ICON_NOT_ACTIVE,
				iconReason: 'Old reason',
			},
		}))

		await updateExtensionIcon(new Map(), 1, 'example.test')
		assert.equal(setIconCalls.length, 0)
		assert.equal(setTitleCalls.length, 1)
		assert.equal(setTitleCalls[0]?.title, 'No active address selected.')
	})

	test('icon-only updates skip setTitle', async () => {
		const { setIconCalls, setTitleCalls } = installBrowserMock([{ id: 1, url: 'https://example.test', status: 'complete' }])
		const { changeSimulationMode, updateExtensionIcon, updateTabState } = await loadModules()

		await changeSimulationMode({
			simulationMode: false,
			activeSigningAddress: undefined,
		})
		await updateTabState(1, (previousState) => ({
			...previousState,
			tabIconDetails: {
				icon: ICON_SIMULATING,
				iconReason: 'No active address selected.',
			},
		}))

		await updateExtensionIcon(new Map(), 1, 'example.test')
		assert.equal(setIconCalls.length, 1)
		assert.equal(setTitleCalls.length, 0)
		assert.deepEqual(setIconCalls[0]?.path, { 128: ICON_NOT_ACTIVE })
	})

	test('access refresh collapses duplicate icon recomputations for the same tab and origin', async () => {
		const { setIconCalls, setTitleCalls } = installBrowserMock([{ id: 1, url: 'https://example.test', status: 'complete' }])
		const { changeSimulationMode, getSettings, updateTabState, updateWebsiteApprovalAccesses } = await loadModules()

		await changeSimulationMode({
			simulationMode: false,
			activeSigningAddress: undefined,
		})
		await updateTabState(1, (previousState) => ({
			...previousState,
			tabIconDetails: {
				icon: ICON_SIMULATING,
				iconReason: 'The Interceptor simulates your sent transactions.',
			},
		}))

		const port = createPort(1)
		const websiteTabConnections = new Map([
			[
				1,
				{
					connections: {
						first: {
							port,
							socket: { tabId: 1, connectionName: 0n },
							websiteOrigin: 'example.test',
							approved: false,
							wantsToConnect: false,
						},
						second: {
							port,
							socket: { tabId: 1, connectionName: 1n },
							websiteOrigin: 'example.test',
							approved: false,
							wantsToConnect: false,
						},
					},
				},
			],
		])

		await updateWebsiteApprovalAccesses({} as never, websiteTabConnections, await getSettings())
		await flushAsyncWork()

		assert.equal(setIconCalls.length, 1)
		assert.equal(setTitleCalls.length, 1)
	})

	test('last-port disconnect removes the tab entry', async () => {
		installBrowserMock([{ id: 1, url: 'https://example.test', status: 'complete' }])
		const { removeWebsiteTabConnection, websiteSocketToString } = await loadModules()

		const socket = { tabId: 1, connectionName: 0n }
		const port = createPort(1)
		const websiteTabConnections = new Map([
			[
				1,
				{
					connections: {
						[websiteSocketToString(socket)]: {
							port,
							socket,
							websiteOrigin: 'example.test',
							approved: false,
							wantsToConnect: false,
						},
					},
				},
			],
		])

		removeWebsiteTabConnection(websiteTabConnections, socket)

		assert.equal(websiteTabConnections.has(1), false)
	})
})
