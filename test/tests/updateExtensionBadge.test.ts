import * as assert from 'assert'
import { describe, test } from 'bun:test'

type BadgeTextCall = browser.browserAction._SetBadgeTextDetails
type BadgeColorCall = browser.action._SetBadgeBackgroundColorDetails

function installBrowserMock() {
	const storageState: Record<string, unknown> = {}
	const badgeTextCalls: BadgeTextCall[] = []
	const badgeColorCalls: BadgeColorCall[] = []

	Object.defineProperty(globalThis, 'browser', {
		configurable: true,
		writable: true,
		value: {
			runtime: {
				lastError: null,
				async sendMessage() {
					return undefined
				},
				getManifest: () => ({ manifest_version: 3 }),
				onMessage: {
					addListener: () => undefined,
					removeListener: () => undefined,
				},
				onConnect: {
					addListener: () => undefined,
					removeListener: () => undefined,
				},
			},
			storage: {
				local: {
					async get(keys?: string | string[] | Record<string, unknown> | null) {
						if (keys === undefined || keys === null) return { ...storageState }
						if (Array.isArray(keys))
							return Object.fromEntries(
								keys
									.filter((key) => key in storageState)
									.map((key) => [key, storageState[key]]),
							)
						if (typeof keys === 'string')
							return keys in storageState ? { [keys]: storageState[keys] } : {}
						return Object.fromEntries(
							Object.entries(keys).map(([key, defaultValue]) => [
								key,
								key in storageState ? storageState[key] : defaultValue,
							]),
						)
					},
					async set(items: Record<string, unknown>) {
						Object.assign(storageState, items)
					},
					async remove(keys: string | string[]) {
						for (const key of Array.isArray(keys) ? keys : [keys])
							delete storageState[key]
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
				onUpdated: {
					addListener: () => undefined,
					removeListener: () => undefined,
				},
				onRemoved: {
					addListener: () => undefined,
					removeListener: () => undefined,
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
				async setBadgeText(details: BadgeTextCall) {
					badgeTextCalls.push(details)
					return undefined
				},
				async setBadgeBackgroundColor(details: BadgeColorCall) {
					badgeColorCalls.push(details)
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
				async setBadgeText(details: BadgeTextCall) {
					badgeTextCalls.push(details)
					return undefined
				},
				async setBadgeBackgroundColor(details: BadgeColorCall) {
					badgeColorCalls.push(details)
					return undefined
				},
			},
		},
	})
	Object.defineProperty(globalThis, 'chrome', {
		configurable: true,
		writable: true,
		value: { runtime: { id: 'test-extension' } },
	})

	return { badgeTextCalls, badgeColorCalls }
}

describe('updateExtensionBadge', () => {
	test('keeps the warning badge visible for a disconnected overdue retry', async () => {
		const { badgeTextCalls, badgeColorCalls } = installBrowserMock()
		const { setRpcConnectionStatus } = await import(
			'../../app/ts/background/storageVariables.js'
		)
		const { updateExtensionBadge } = await import(
			'../../app/ts/background/iconHandler.js'
		)

		await setRpcConnectionStatus({
			isConnected: false,
			lastConnnectionAttempt: new Date('2024-01-01T00:00:00.000Z'),
			latestBlock: undefined,
			rpcNetwork: {
				name: 'Test Chain',
				chainId: 1337n,
				httpsRpc: 'https://example.invalid',
				currencyName: 'Ether',
				currencyTicker: 'ETH',
				currencyLogoUri: undefined,
				primary: true,
				minimized: true,
			},
			retrying: true,
		})

		await updateExtensionBadge()

		assert.equal(badgeTextCalls.at(-1)?.text, '!')
		assert.equal(badgeColorCalls.at(-1)?.color, '#FFC107')
	})
})
