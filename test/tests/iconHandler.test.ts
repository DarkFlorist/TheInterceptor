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

const originalFetch = globalThis.fetch
const originalFileReader = globalThis.FileReader
const originalWarn = console.warn

const storageState: Record<string, unknown> = {}
const tabsById = new Map<number, MockTab>()
const onUpdatedListeners: Listener[] = []
const fetchCalls: string[] = []
const warnings: string[] = []

function installSuccessfulFileReader(result: string) {
	function SuccessfulFileReader(this: {
		result: string | undefined
		onabort?: () => void
		onerror?: () => void
		onloadend?: () => void
		readAsDataURL: (_blob: Blob) => void
	}) {
		this.result = undefined
		this.readAsDataURL = () => {
			this.result = result
			this.onloadend?.()
		}
	}

	Object.defineProperty(globalThis, 'FileReader', {
		configurable: true,
		writable: true,
		value: SuccessfulFileReader,
	})
}

function installBrowserMock() {
	Reflect.set(globalThis, 'browser', {
		runtime: {
			lastError: undefined,
			async sendMessage() {
				return undefined
			},
			getManifest: () => ({ manifest_version: 3 }),
			onMessage: {
				addListener: (_listener: Listener) => undefined,
				removeListener: (_listener: Listener) => undefined,
			},
			onConnect: {
				addListener: (_listener: Listener) => undefined,
				removeListener: (_listener: Listener) => undefined,
			},
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
				return tabsById.get(tabId)
			},
			async update() {
				return undefined
			},
			async create() {
				return undefined
			},
			async reload() {
				return undefined
			},
			async remove() {
				return undefined
			},
			onUpdated: {
				addListener(listener: Listener) {
					onUpdatedListeners.push(listener)
				},
				removeListener(listener: Listener) {
					const index = onUpdatedListeners.indexOf(listener)
					if (index >= 0) onUpdatedListeners.splice(index, 1)
				},
			},
			onRemoved: {
				addListener: (_listener: Listener) => undefined,
				removeListener: (_listener: Listener) => undefined,
			},
		},
		windows: {
			async get() {
				return undefined
			},
			async update() {
				return undefined
			},
		},
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
		return new Response(new Blob(['icon'], { type: 'image/png' }), {
			status: 200,
			headers: { 'content-type': 'image/png' },
		})
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
	for (const key of Object.keys(storageState)) delete storageState[key]
	Object.defineProperty(globalThis, 'FileReader', {
		configurable: true,
		writable: true,
		value: originalFileReader,
	})
})

afterAll(() => {
	Object.defineProperty(globalThis, 'fetch', {
		configurable: true,
		writable: true,
		value: originalFetch,
	})
	Object.defineProperty(globalThis, 'FileReader', {
		configurable: true,
		writable: true,
		value: originalFileReader,
	})
	console.warn = originalWarn
})

const { retrieveWebsiteDetails } = await import('../../app/ts/background/iconHandler.js')

describe('retrieveWebsiteDetails favicon handling', () => {
	test('returns no icon and does not fetch when favIconUrl is undefined', async () => {
		tabsById.set(1, {
			id: 1,
			status: 'complete',
			title: 'Undefined favicon',
			url: 'https://undefined.test',
		})

		const result = await retrieveWebsiteDetails(1)

		assert.deepEqual(result, { title: 'Undefined favicon', icon: undefined })
		assert.equal(fetchCalls.length, 0)
		assert.equal(warnings.length, 0)
	})

	test('returns no icon and does not fetch when favIconUrl is empty', async () => {
		tabsById.set(2, {
			id: 2,
			status: 'complete',
			title: 'Empty favicon',
			url: 'https://empty.test',
			favIconUrl: '',
		})

		const result = await retrieveWebsiteDetails(2)

		assert.deepEqual(result, { title: 'Empty favicon', icon: undefined })
		assert.equal(fetchCalls.length, 0)
		assert.equal(warnings.length, 0)
	})

	test('warns for unsupported favicon schemes', async () => {
		tabsById.set(3, {
			id: 3,
			status: 'complete',
			title: 'Unsupported favicon',
			url: 'https://scheme.test',
			favIconUrl: 'chrome://branding/content/icon32.png',
		})

		const result = await retrieveWebsiteDetails(3)

		assert.deepEqual(result, { title: 'Unsupported favicon', icon: undefined })
		assert.equal(fetchCalls.length, 0)
		assert.deepEqual(warnings, ['Failed to load favicon for tab 3 (https://scheme.test): unsupported URL scheme chrome:'])
	})

	test('rejects file favicon urls', async () => {
		tabsById.set(6, {
			id: 6,
			status: 'complete',
			title: 'File favicon',
			url: 'https://file.test',
			favIconUrl: 'file:///etc/passwd',
		})

		const result = await retrieveWebsiteDetails(6)

		assert.deepEqual(result, { title: 'File favicon', icon: undefined })
		assert.equal(fetchCalls.length, 0)
		assert.deepEqual(warnings, ['Failed to load favicon for tab 6 (https://file.test): unsupported URL scheme file:'])
	})

	test('fetches same-origin favicon urls once for stored websites that are missing an icon', async () => {
		installSuccessfulFileReader('data:image/png;base64,b2s=')
		storageState.websiteAccess = [
			{
				website: {
					websiteOrigin: 'same-origin.test',
					icon: undefined,
					title: 'Same origin favicon',
				},
				access: true,
			},
		]
		tabsById.set(4, {
			id: 4,
			status: 'complete',
			title: 'Same origin favicon',
			url: 'https://same-origin.test/page',
			favIconUrl: '/favicon.png',
		})

		const result = await retrieveWebsiteDetails(4, 'same-origin.test')

		assert.deepEqual(result, {
			title: 'Same origin favicon',
			icon: 'data:image/png;base64,b2s=',
		})
		assert.deepEqual(fetchCalls, ['https://same-origin.test/favicon.png'])
		assert.equal(warnings.length, 0)
	})

	test('does not fetch same-origin favicon urls for websites without stored access', async () => {
		installSuccessfulFileReader('data:image/png;base64,b2s=')
		tabsById.set(11, {
			id: 11,
			status: 'complete',
			title: 'Untracked favicon',
			url: 'https://untracked.test/page',
			favIconUrl: '/favicon.png',
		})

		const result = await retrieveWebsiteDetails(11, 'untracked.test')

		assert.deepEqual(result, { title: 'Untracked favicon', icon: undefined })
		assert.equal(fetchCalls.length, 0)
		assert.equal(warnings.length, 0)
		assert.equal(onUpdatedListeners.length, 0)
	})

	test('reuses cached favicon data urls without refetching them', async () => {
		storageState.websiteAccess = [
			{
				website: {
					websiteOrigin: 'cached.test',
					icon: 'data:image/png;base64,Y2FjaGVk',
					title: 'Cached favicon',
				},
				access: true,
			},
		]
		tabsById.set(8, {
			id: 8,
			status: 'complete',
			title: 'Cached favicon',
			url: 'https://cached.test/page',
			favIconUrl: '/favicon.png',
		})

		const result = await retrieveWebsiteDetails(8, 'cached.test')

		assert.deepEqual(result, {
			title: 'Cached favicon',
			icon: 'data:image/png;base64,Y2FjaGVk',
		})
		assert.equal(fetchCalls.length, 0)
		assert.equal(warnings.length, 0)
		assert.equal(onUpdatedListeners.length, 0)
	})

	test('allows image data url favicons for stored websites without fetching them in the background', async () => {
		storageState.websiteAccess = [
			{
				website: {
					websiteOrigin: 'data-icon.test',
					icon: undefined,
					title: 'Data favicon',
				},
				access: true,
			},
		]
		tabsById.set(7, {
			id: 7,
			status: 'complete',
			title: 'Data favicon',
			url: 'https://data-icon.test/page',
			favIconUrl: 'data:image/png;base64,Zm9v',
		})

		const result = await retrieveWebsiteDetails(7, 'data-icon.test')

		assert.deepEqual(result, {
			title: 'Data favicon',
			icon: 'data:image/png;base64,Zm9v',
		})
		assert.equal(fetchCalls.length, 0)
		assert.equal(warnings.length, 0)
	})

	test('does not store data url favicons for websites without stored access', async () => {
		tabsById.set(12, {
			id: 12,
			status: 'complete',
			title: 'Untracked data favicon',
			url: 'https://untracked-data.test/page',
			favIconUrl: 'data:image/png;base64,Zm9v',
		})

		const result = await retrieveWebsiteDetails(12, 'untracked-data.test')

		assert.deepEqual(result, {
			title: 'Untracked data favicon',
			icon: undefined,
		})
		assert.equal(fetchCalls.length, 0)
		assert.equal(warnings.length, 0)
	})

	test('rejects non-image data url favicons', async () => {
		tabsById.set(9, {
			id: 9,
			status: 'complete',
			title: 'HTML favicon',
			url: 'https://html-icon.test/page',
			favIconUrl: 'data:text/html;base64,Zm9v',
		})

		const result = await retrieveWebsiteDetails(9)

		assert.deepEqual(result, { title: 'HTML favicon', icon: undefined })
		assert.equal(fetchCalls.length, 0)
		assert.deepEqual(warnings, ['Failed to load favicon for tab 9 (https://html-icon.test/page): favicon data URL was not an image or exceeded the size limit'])
	})

	test('rejects oversized data url favicons', async () => {
		tabsById.set(10, {
			id: 10,
			status: 'complete',
			title: 'Oversized favicon',
			url: 'https://oversized-icon.test/page',
			favIconUrl: `data:image/png;base64,${ 'a'.repeat(1_048_576) }`,
		})

		const result = await retrieveWebsiteDetails(10)

		assert.deepEqual(result, { title: 'Oversized favicon', icon: undefined })
		assert.equal(fetchCalls.length, 0)
		assert.deepEqual(warnings, ['Failed to load favicon for tab 10 (https://oversized-icon.test/page): favicon data URL was not an image or exceeded the size limit'])
	})

	test('rejects cross-origin favicon urls without fetching them in the background', async () => {
		tabsById.set(5, {
			id: 5,
			status: 'complete',
			title: 'Cross origin favicon',
			url: 'https://page.test/app',
			favIconUrl: 'https://cdn.test/favicon.png',
		})

		const firstResult = await retrieveWebsiteDetails(5)
		const secondResult = await retrieveWebsiteDetails(5)

		assert.deepEqual(firstResult, {
			title: 'Cross origin favicon',
			icon: undefined,
		})
		assert.deepEqual(secondResult, {
			title: 'Cross origin favicon',
			icon: undefined,
		})
		assert.equal(fetchCalls.length, 0)
		assert.deepEqual(warnings, ['Failed to load favicon for tab 5 (https://page.test/app): favicon origin https://cdn.test did not match page origin https://page.test', 'Failed to load favicon for tab 5 (https://page.test/app): favicon origin https://cdn.test did not match page origin https://page.test'])
	})
})
