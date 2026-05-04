import * as assert from 'assert'
import { afterAll, afterEach, describe, test } from 'bun:test'

type MockTab = {
	id: number
	status?: 'loading' | 'complete'
	title?: string
	favIconUrl?: string
	url?: string
}

type Listener = (tabId: number, info: browser.tabs._OnUpdatedChangeInfo) => void
type FetchImplementation = (url: string) => Promise<Response>

const originalFetch = globalThis.fetch
const originalWarn = console.warn

const storageState: Record<string, unknown> = {}
const tabsById = new Map<number, MockTab>()
const onUpdatedListeners: Listener[] = []
const fetchCalls: string[] = []
const warnings: string[] = []

let fetchImplementation: FetchImplementation = async () => new Response(new Blob(['icon'], { type: 'image/png' }), { status: 200, headers: { 'content-type': 'image/png' } })

function installBrowserMock() {
	Reflect.set(globalThis, 'browser', {
		runtime: {
			lastError: undefined,
			async sendMessage() {
				return undefined
			},
			getManifest: () => ({ manifest_version: 3 }),
			onMessage: { addListener: (_listener: Listener) => undefined, removeListener: (_listener: Listener) => undefined },
			onConnect: { addListener: (_listener: Listener) => undefined, removeListener: (_listener: Listener) => undefined },
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
			async get(tabId: number) { return tabsById.get(tabId) },
			async update() { return undefined },
			async create() { return undefined },
			async reload() { return undefined },
			async remove() { return undefined },
			onUpdated: {
				addListener(listener: Listener) { onUpdatedListeners.push(listener) },
				removeListener(listener: Listener) {
					const index = onUpdatedListeners.indexOf(listener)
					if (index >= 0) onUpdatedListeners.splice(index, 1)
				},
			},
			onRemoved: { addListener: (_listener: Listener) => undefined, removeListener: (_listener: Listener) => undefined },
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
	})
	Reflect.set(globalThis, 'chrome', { runtime: { id: 'test-extension' } })
}

installBrowserMock()
Object.defineProperty(globalThis, 'fetch', {
	configurable: true,
	writable: true,
	value: async (input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
		fetchCalls.push(url)
		return await fetchImplementation(url)
	},
})
console.warn = (...args: unknown[]) => {
	warnings.push(args.map((arg) => String(arg)).join(' '))
}

afterEach(() => {
	tabsById.clear()
	onUpdatedListeners.splice(0, onUpdatedListeners.length)
	fetchCalls.splice(0, fetchCalls.length)
	warnings.splice(0, warnings.length)
	fetchImplementation = async () => new Response(new Blob(['icon'], { type: 'image/png' }), { status: 200, headers: { 'content-type': 'image/png' } })
})

afterAll(() => {
	Object.defineProperty(globalThis, 'fetch', {
		configurable: true,
		writable: true,
		value: originalFetch,
	})
	console.warn = originalWarn
})

const { retrieveWebsiteDetails } = await import('../../app/ts/background/iconHandler.js')

describe('retrieveWebsiteDetails favicon handling', () => {
	test('returns no icon and does not fetch when favIconUrl is undefined', async () => {
		tabsById.set(1, { id: 1, status: 'complete', title: 'Undefined favicon', url: 'https://undefined.test' })

		const result = await retrieveWebsiteDetails(1)

		assert.deepEqual(result, { title: 'Undefined favicon', icon: undefined })
		assert.equal(fetchCalls.length, 0)
		assert.equal(warnings.length, 0)
	})

	test('returns no icon and does not fetch when favIconUrl is empty', async () => {
		tabsById.set(2, { id: 2, status: 'complete', title: 'Empty favicon', url: 'https://empty.test', favIconUrl: '' })

		const result = await retrieveWebsiteDetails(2)

		assert.deepEqual(result, { title: 'Empty favicon', icon: undefined })
		assert.equal(fetchCalls.length, 0)
		assert.equal(warnings.length, 0)
	})

	test('warns for unsupported favicon schemes', async () => {
		tabsById.set(3, { id: 3, status: 'complete', title: 'Unsupported favicon', url: 'https://scheme.test', favIconUrl: 'chrome://branding/content/icon32.png' })

		const result = await retrieveWebsiteDetails(3)

		assert.deepEqual(result, { title: 'Unsupported favicon', icon: undefined })
		assert.equal(fetchCalls.length, 0)
		assert.deepEqual(warnings, [
			'Failed to load favicon for tab 3 (https://scheme.test): unsupported URL scheme chrome:'
		])
	})

	test('returns the title and warns on fetch failures', async () => {
		tabsById.set(4, { id: 4, status: 'complete', title: 'Fetch failed favicon', url: 'https://fail.test', favIconUrl: 'https://fail.test/favicon.png' })
		fetchImplementation = async () => { throw new TypeError('Failed to fetch') }

		const result = await retrieveWebsiteDetails(4)

		assert.deepEqual(result, { title: 'Fetch failed favicon', icon: undefined })
		assert.deepEqual(fetchCalls, ['https://fail.test/favicon.png'])
		assert.deepEqual(warnings, [
			'Failed to load favicon for tab 4 (https://fail.test): fetch failed (Failed to fetch)'
		])
	})

	test('logs repeated warnings for repeated failures', async () => {
		tabsById.set(5, { id: 5, status: 'complete', title: 'Duplicate favicon', url: 'https://duplicate.test', favIconUrl: 'https://duplicate.test/favicon.png' })
		fetchImplementation = async () => { throw new TypeError('Failed to fetch') }

		const firstResult = await retrieveWebsiteDetails(5)
		const secondResult = await retrieveWebsiteDetails(5)

		assert.deepEqual(firstResult, { title: 'Duplicate favicon', icon: undefined })
		assert.deepEqual(secondResult, { title: 'Duplicate favicon', icon: undefined })
		assert.equal(fetchCalls.length, 2)
		assert.deepEqual(warnings, [
			'Failed to load favicon for tab 5 (https://duplicate.test): fetch failed (Failed to fetch)',
			'Failed to load favicon for tab 5 (https://duplicate.test): fetch failed (Failed to fetch)'
		])
	})
})
