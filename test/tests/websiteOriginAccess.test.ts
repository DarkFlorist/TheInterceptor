import * as assert from 'assert'
import { describe, test } from 'bun:test'
import type { AddressBookEntry } from '../../app/ts/types/addressBookTypes.js'
import type { WebsiteAccessArray } from '../../app/ts/types/websiteAccessTypes.js'

type BrowserStorageState = Record<string, unknown>

function installBrowserMock() {
	const storageState: BrowserStorageState = {}
	Object.defineProperty(globalThis, 'browser', { configurable: true, writable: true, value: {
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
	} })
	Object.defineProperty(globalThis, 'chrome', { configurable: true, writable: true, value: { runtime: { id: 'test-extension' } } })
	return storageState
}

async function loadModules() {
	installBrowserMock()
	return {
		...await import('../../app/ts/background/accessManagement.js'),
		...await import('../../app/ts/background/settings.js'),
		...await import('../../app/ts/utils/requests.js'),
	}
}

const address = 0x1111111111111111111111111111111111111111n
const addressBookEntry: AddressBookEntry = {
	type: 'contact',
	name: 'Test Account',
	address,
	entrySource: 'User',
	askForAddressAccess: true,
	chainId: 'AllChains',
}

describe('website origin access', () => {
	test('getOriginWithPort preserves http and https scheme', async () => {
		const { getHostWithPortFromOriginLike, getOriginWithPort } = await loadModules()
		assert.equal(getOriginWithPort('https://example.com/a'), 'https://example.com')
		assert.equal(getOriginWithPort('http://example.com/a'), 'http://example.com')
		assert.equal(getOriginWithPort('https://example.com:8443/a'), 'https://example.com:8443')
		assert.equal(getOriginWithPort('http://example.com:8443/a'), 'http://example.com:8443')
		assert.equal(getHostWithPortFromOriginLike('https://example.com:8443'), 'example.com:8443')
	})

	test('schemeful website access entries do not grant the opposite scheme', async () => {
		const { hasAccess, hasAddressAccess } = await loadModules()
		const websiteAccess: WebsiteAccessArray = [{
			website: { websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
			access: true,
			addressAccess: [{ address, access: true }],
		}]

		assert.equal(hasAccess(websiteAccess, 'https://example.com'), 'hasAccess')
		assert.equal(hasAccess(websiteAccess, 'http://example.com'), 'notFound')
		assert.equal(hasAddressAccess(websiteAccess, 'https://example.com', addressBookEntry), 'hasAccess')
		assert.equal(hasAddressAccess(websiteAccess, 'http://example.com', addressBookEntry), 'notFound')
	})

	test('legacy host-only access remains a fallback and exact schemeful entries win', async () => {
		const { hasAccess, hasAddressAccess } = await loadModules()
		const websiteAccess: WebsiteAccessArray = [
			{
				website: { websiteOrigin: 'example.com', icon: undefined, title: undefined },
				access: true,
				addressAccess: [{ address, access: true }],
			},
			{
				website: { websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
				access: false,
				addressAccess: [{ address, access: false }],
			},
		]

		assert.equal(hasAccess(websiteAccess, 'http://example.com'), 'hasAccess')
		assert.equal(hasAddressAccess(websiteAccess, 'http://example.com', addressBookEntry), 'hasAccess')
		assert.equal(hasAccess(websiteAccess, 'https://example.com'), 'noAccess')
		assert.equal(hasAddressAccess(websiteAccess, 'https://example.com', addressBookEntry), 'noAccess')
	})

	test('new access writes keep schemeful website origins', async () => {
		const { getWebsiteAccess, setAccess } = await loadModules()

		await setAccess({ websiteOrigin: 'https://example.com', icon: undefined, title: undefined }, true, undefined)

		assert.deepEqual((await getWebsiteAccess()).map((entry) => entry.website.websiteOrigin), ['https://example.com'])
	})
})
