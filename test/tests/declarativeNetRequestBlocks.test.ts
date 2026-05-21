import * as assert from 'assert'
import { describe, test } from 'bun:test'

type BrowserStorageState = Record<string, unknown>
type DeclarativeRule = {
	condition?: {
		initiatorDomains?: readonly string[]
		tabIds?: readonly number[]
	}
}
type DeclarativeRuleUpdate = {
	removeRuleIds: readonly number[]
	addRules?: readonly DeclarativeRule[]
}

function installBrowserMock() {
	const storageState: BrowserStorageState = {}
	const dynamicRuleUpdates: DeclarativeRuleUpdate[] = []
	const sessionRuleUpdates: DeclarativeRuleUpdate[] = []

	Object.defineProperty(globalThis, 'browser', { configurable: true, writable: true, value: {
		runtime: {
			lastError: null,
			connect: () => ({ postMessage: () => undefined }),
			async sendMessage() { return undefined },
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
			async getDynamicRules() { return [{ id: 7 }] },
			async getSessionRules() { return [{ id: 11 }] },
			async updateDynamicRules(update: DeclarativeRuleUpdate) {
				dynamicRuleUpdates.push(update)
			},
			async updateSessionRules(update: DeclarativeRuleUpdate) {
				sessionRuleUpdates.push(update)
			},
		},
		webRequest: {
			onBeforeRequest: {
				addListener: () => undefined,
				removeListener: () => undefined,
			},
		},
	} })
	globalThis.chrome = { runtime: { id: 'test-extension' } }

	return { dynamicRuleUpdates, sessionRuleUpdates }
}

async function loadModules() {
	return {
		...await import('../../app/ts/background/accessManagement.js'),
		...await import('../../app/ts/background/settings.js'),
	}
}

describe('declarative net request blocking', () => {
	test('uses persistent initiatorDomains only for host-scoped website blocks', async () => {
		const { dynamicRuleUpdates, sessionRuleUpdates } = installBrowserMock()
		const { getDeclarativeNetRequestInitiatorDomain, updateDeclarativeNetRequestBlocks, updateWebsiteAccess } = await loadModules()
		assert.equal(getDeclarativeNetRequestInitiatorDomain('localhost:5173'), undefined)
		assert.equal(getDeclarativeNetRequestInitiatorDomain('https://app.example:8443'), undefined)
		assert.equal(getDeclarativeNetRequestInitiatorDomain('https://app.example'), 'app.example')
		assert.equal(getDeclarativeNetRequestInitiatorDomain('example.com'), 'example.com')
		assert.equal(getDeclarativeNetRequestInitiatorDomain('http://[bad'), undefined)

		await updateWebsiteAccess(() => [
			{
				website: { websiteOrigin: 'example.com', icon: undefined, title: undefined },
				access: true,
				addressAccess: undefined,
				declarativeNetRequestBlockMode: 'block-all',
			},
			{
				website: { websiteOrigin: 'localhost:5173', icon: undefined, title: undefined },
				access: true,
				addressAccess: undefined,
				declarativeNetRequestBlockMode: 'block-all',
			},
			{
				website: { websiteOrigin: 'https://app.example', icon: undefined, title: undefined },
				access: true,
				addressAccess: undefined,
				declarativeNetRequestBlockMode: 'block-all',
			},
			{
				website: { websiteOrigin: 'http://[bad', icon: undefined, title: undefined },
				access: true,
				addressAccess: undefined,
				declarativeNetRequestBlockMode: 'block-all',
			},
		])

		await updateDeclarativeNetRequestBlocks(new Map([[1, { connections: {
			portScoped: {
				port: browser.runtime.connect(),
				socket: { tabId: 1, connectionName: 0n },
				websiteOrigin: 'localhost:5173',
				approved: false,
				wantsToConnect: false,
			},
		} }]]))

		const dynamicUpdate = dynamicRuleUpdates[0]
		if (dynamicUpdate === undefined) throw new Error('missing dynamic DNR update')
		const addedDynamicRule = dynamicUpdate.addRules?.[0]
		if (addedDynamicRule === undefined) throw new Error('missing dynamic DNR add rule')
		assert.deepEqual(dynamicUpdate.removeRuleIds, [7])
		assert.deepEqual(addedDynamicRule.condition?.initiatorDomains, ['example.com', 'app.example'])

		const sessionUpdate = sessionRuleUpdates[0]
		if (sessionUpdate === undefined) throw new Error('missing session DNR update')
		assert.deepEqual(sessionUpdate.removeRuleIds, [11])
		assert.deepEqual(sessionUpdate.addRules?.[0]?.condition?.tabIds, [1])
	})
})
