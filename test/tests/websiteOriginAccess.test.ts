import * as assert from 'assert'
import { beforeEach, describe, test } from 'bun:test'
import type { WebsiteAccessArray } from '../../app/ts/types/websiteAccessTypes.js'

const storageState: Record<string, unknown> = {}

function installBrowserMock() {
	for (const key of Object.keys(storageState)) delete storageState[key]
	Object.defineProperty(globalThis, 'browser', {
		configurable: true,
		writable: true,
		value: {
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
		},
	})
	Object.defineProperty(globalThis, 'chrome', {
		configurable: true,
		writable: true,
		value: { runtime: { id: 'test-extension' } },
	})
}

describe('website origin access', () => {
	beforeEach(() => {
		installBrowserMock()
	})

	test('uses schemeful origins for pages', async () => {
		const { getWebsiteOrigin } = await import('../../app/ts/utils/requests.js')

		assert.equal(getWebsiteOrigin('https://example.test/path?query=1'), 'https://example.test')
		assert.equal(getWebsiteOrigin('http://example.test:8080/path'), 'http://example.test:8080')
		assert.equal(getWebsiteOrigin('file:///tmp/interceptor-test.html'), 'file://')
	})

	test('keeps legacy host-only grants as fallback without overriding exact schemeful grants', async () => {
		const { hasAccess } = await import('../../app/ts/background/accessManagement.js')
		const websiteAccess = [
			{ website: { websiteOrigin: 'legacy.example', icon: undefined, title: 'Legacy' }, access: true, addressAccess: undefined },
			{ website: { websiteOrigin: 'split.example', icon: undefined, title: 'Legacy Split' }, access: true, addressAccess: undefined },
			{ website: { websiteOrigin: 'https://split.example', icon: undefined, title: 'HTTPS Split' }, access: false, addressAccess: undefined },
		] satisfies WebsiteAccessArray

		assert.equal(hasAccess(websiteAccess, 'https://legacy.example'), 'hasAccess')
		assert.equal(hasAccess(websiteAccess, 'http://legacy.example'), 'hasAccess')
		assert.equal(hasAccess(websiteAccess, 'https://split.example'), 'noAccess')
		assert.equal(hasAccess(websiteAccess, 'http://split.example'), 'hasAccess')
	})

	test('stores newly approved websites with the scheme included', async () => {
		const { setAccess } = await import('../../app/ts/background/accessManagement.js')

		await setAccess({ websiteOrigin: 'https://new.example', icon: undefined, title: 'New' }, true, undefined)

		const storedWebsiteAccess = storageState.websiteAccess
		assert.equal(Array.isArray(storedWebsiteAccess), true)
		if (!Array.isArray(storedWebsiteAccess)) throw new Error('Expected websiteAccess to be stored as an array')
		assert.deepEqual(storedWebsiteAccess.map((entry) => entry.website.websiteOrigin), ['https://new.example'])
	})

	test('excludes disabled content scripts with scheme-aware matching', async () => {
		const { getInterceptorDisabledSiteExcludeMatches, isUrlExcludedByInterceptorDisabledSite } = await import('../../app/ts/utils/contentScriptsUpdating.js')

		assert.deepEqual(getInterceptorDisabledSiteExcludeMatches('https://scheme.example'), ['https://scheme.example/*'])
		assert.deepEqual(getInterceptorDisabledSiteExcludeMatches('http://scheme.example'), ['http://scheme.example/*'])
		assert.deepEqual(getInterceptorDisabledSiteExcludeMatches('legacy.example'), ['*://legacy.example/*', '*://*.legacy.example/*'])
		assert.deepEqual(getInterceptorDisabledSiteExcludeMatches('file://'), ['file://*/*'])
		assert.equal(isUrlExcludedByInterceptorDisabledSite(['https://scheme.example'], 'https://scheme.example/page'), true)
		assert.equal(isUrlExcludedByInterceptorDisabledSite(['https://scheme.example'], 'http://scheme.example/page'), false)
		assert.equal(isUrlExcludedByInterceptorDisabledSite(['https://scheme.example'], 'https://sub.scheme.example/page'), false)
		assert.equal(isUrlExcludedByInterceptorDisabledSite(['legacy.example'], 'http://legacy.example/page'), true)
	})

	test('keeps external request blocking domain-scoped for declarativeNetRequest compatibility', async () => {
		const { areWeBlocking } = await import('../../app/ts/background/accessManagement.js')
		storageState.websiteAccess = [{
			website: { websiteOrigin: 'https://blocked.example:8443', icon: undefined, title: 'Blocked' },
			access: true,
			addressAccess: undefined,
			declarativeNetRequestBlockMode: 'block-all',
		}]

		assert.equal(await areWeBlocking(new Map(), 1, 'http://blocked.example:3000'), true)
		assert.equal(await areWeBlocking(new Map(), 1, 'https://other.example'), false)
	})
})
