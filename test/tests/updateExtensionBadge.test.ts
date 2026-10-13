import * as assert from 'node:assert'
import { afterAll, describe, test } from 'bun:test'
import { installBrowserMock } from '../harness/browserMock.js'

const browserMock = installBrowserMock()
afterAll(browserMock.restore)

describe('updateExtensionBadge', () => {
	test('keeps the warning badge visible for a disconnected overdue retry', async () => {
		const { setRpcConnectionStatus } = await import('../../app/ts/background/storageVariables.js')
		const { updateExtensionBadge } = await import('../../app/ts/background/iconHandler.js')

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

		const badgeTextCalls = browserMock.calls.action.flatMap((call) => call.method === 'setBadgeText' ? [call.details] : [])
		const badgeColorCalls = browserMock.calls.action.flatMap((call) => call.method === 'setBadgeBackgroundColor' ? [call.details] : [])
		assert.equal(badgeTextCalls.at(-1)?.text, '!')
		assert.equal(badgeColorCalls.at(-1)?.color, '#FFC107')
	})
})
