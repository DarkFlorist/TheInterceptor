import * as assert from 'assert'
import { describe, run, runIfRoot, should } from '../micro-should.js'

function installBrowserMock() {
	const storageState: Record<string, unknown> = {}
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
					if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, storageState[key]]))
					if (typeof keys === 'string') return { [keys]: storageState[keys] }
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
	} as unknown as typeof globalThis.browser
	;(globalThis as typeof globalThis & { chrome: { runtime: { id: string } } }).chrome = { runtime: { id: 'test-extension' } }
}

async function loadModules() {
	return {
		...await import('../../app/ts/background/storageVariables.js'),
		...await import('../../app/ts/simulation/services/EthereumSubscriptionService.js'),
	}
}

export async function main() {
	describe('EthereumSubscriptionService', () => {
		should('removeEthereumSubscription only removes the matching socket subscription', async () => {
			installBrowserMock()
			const { getEthereumSubscriptionsAndFilters, removeEthereumSubscription, updateEthereumSubscriptionsAndFilters } = await loadModules()

			const socket = { tabId: 1, connectionName: 1n } as const
			const otherSocket = { tabId: 2, connectionName: 2n } as const
			await updateEthereumSubscriptionsAndFilters(() => ([
				{ type: 'newHeads', subscriptionOrFilterId: 'remove-me', params: { method: 'eth_subscribe', params: ['newHeads'] }, subscriptionCreatorSocket: socket },
				{ type: 'newHeads', subscriptionOrFilterId: 'keep-same-socket', params: { method: 'eth_subscribe', params: ['newHeads'] }, subscriptionCreatorSocket: socket },
				{ type: 'newHeads', subscriptionOrFilterId: 'keep-other-socket', params: { method: 'eth_subscribe', params: ['newHeads'] }, subscriptionCreatorSocket: otherSocket },
			]))

			assert.equal(await removeEthereumSubscription(socket, 'remove-me'), true)
			assert.deepEqual((await getEthereumSubscriptionsAndFilters()).map((entry) => entry.subscriptionOrFilterId), ['keep-same-socket', 'keep-other-socket'])
		})
	})
}

await runIfRoot(async () => {
	await main()
	await run()
}, import.meta)
