import * as assert from 'assert'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { Signal } from '@preact/signals'
import { describe, test } from 'bun:test'
import { installDateMock, installDomMock } from './domMock.js'

function installBrowserMock() {
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
				onMessage: { addListener: () => undefined, removeListener: () => undefined },
				onConnect: { addListener: () => undefined, removeListener: () => undefined },
			},
			storage: {
				local: {
					async get() { return {} },
					async set() { return undefined },
					async remove() { return undefined },
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
		},
	})
	Object.defineProperty(globalThis, 'chrome', {
		configurable: true,
		writable: true,
		value: { runtime: { id: 'test-extension' } },
	})
}

const rpcNetwork = {
	name: 'Test Chain',
	chainId: 1337n,
	httpsRpc: 'https://example.invalid',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	currencyLogoUri: undefined,
	primary: true,
	minimized: true,
}

describe('NetworkErrors', () => {
	test('shows a paused disconnect immediately on first render', async () => {
		installBrowserMock()
		const dom = installDomMock()
		const { NetworkErrors } = await import('../../app/ts/components/App.js')

		await act(() => {
			render(h(NetworkErrors, {
				rpcConnectionStatus: new Signal({
					isConnected: false,
					lastConnnectionAttempt: new Date('2024-01-01T00:00:00.000Z'),
					latestBlock: undefined,
					rpcNetwork,
					retrying: false,
				}),
			}), dom.document.body)
		})

		assert.equal(dom.document.body.textContent?.includes('Retrying resumes when the extension becomes active.'), true)
		dom.restore()
	})

	test('shows countdown copy while an active retry is pending', async () => {
		installBrowserMock()
		const dom = installDomMock()
		const clock = installDateMock('2024-01-01T00:00:00.000Z')
		const { NetworkErrors } = await import('../../app/ts/components/App.js')

		await act(() => {
			render(h(NetworkErrors, {
				rpcConnectionStatus: new Signal({
					isConnected: false,
					lastConnnectionAttempt: new Date('2024-01-01T00:00:00.000Z'),
					latestBlock: undefined,
					rpcNetwork,
					retrying: true,
				}),
			}), dom.document.body)
		})

		assert.equal(dom.document.body.textContent?.includes('Retrying in 12s.'), true)
		clock.restore()
		dom.restore()
	})

	test('shows slow request copy when the active RPC request exceeds its expected duration', async () => {
		installBrowserMock()
		const dom = installDomMock()
		const clock = installDateMock('2024-01-01T00:00:12.000Z')
		const { NetworkErrors } = await import('../../app/ts/components/App.js')

		await act(() => {
			render(h(NetworkErrors, {
				rpcConnectionStatus: new Signal({
					isConnected: true,
					lastConnnectionAttempt: new Date('2024-01-01T00:00:12.000Z'),
					latestBlock: undefined,
					rpcNetwork,
					retrying: true,
					slowRequest: {
						method: 'eth_call',
						startedAt: new Date('2024-01-01T00:00:00.000Z'),
					},
				}),
			}), dom.document.body)
		})

		assert.equal(dom.document.body.textContent?.includes('is taking longer than expected to answer eth_call'), true)
		assert.equal(dom.document.body.textContent?.includes('It has been waiting for 12s.'), true)
		clock.restore()
		dom.restore()
	})
})
