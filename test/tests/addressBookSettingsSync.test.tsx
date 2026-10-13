import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { AddressBook } from '../../app/ts/AddressBook.js'
import { MessageToPopup } from '../../app/ts/types/interceptor-messages.js'
import type { RpcEntry } from '../../app/ts/types/rpc.js'
import { installDomMock } from './domMock.js'
import { hasMessageMethod } from './runtimeMessageMatchers.js'
import { createRuntimeMessagingInstaller } from './runtimeMessagingTestHarness.js'

const installRuntimeMessaging = createRuntimeMessagingInstaller()

const createRpcNetwork = (name: string, chainId: bigint): RpcEntry => ({
	name,
	chainId,
	httpsRpc: `https://${ chainId.toString() }.rpc.example`,
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: false,
})

const mainnet = createRpcNetwork('Ethereum Mainnet', 1n)
const sepolia = createRpcNetwork('Sepolia', 11155111n)

const createSettingsReply = (activeRpcNetwork: RpcEntry) => MessageToPopup.serialize({
	role: 'all',
	method: 'popup_requestSettingsReply',
	data: {
		useTabsInsteadOfPopup: false,
		metamaskCompatibilityMode: false,
		safeAppsCompatibilityMode: false,
		activeRpcNetwork,
		rpcEntries: [mainnet, sepolia],
	},
})

function getAddressBookQueries(sentMessages: readonly unknown[]) {
	return sentMessages.flatMap((message) => hasMessageMethod(message, 'popup_getAddressBookData') && typeof message === 'object' && message !== null && 'data' in message ? [message.data] : [])
}

describe('AddressBook settings sync', () => {
	test('adopts the active network from the first settings reply and keeps showing that chain after the active network changes', async () => {
		const dom = installDomMock()
		const messaging = installRuntimeMessaging()
		try {
			await act(() => {
				render(h(AddressBook, {}), dom.document.body)
			})
			assert.equal(messaging.sentMessages.some((message) => hasMessageMethod(message, 'popup_requestSettings')), true)
			assert.deepEqual(getAddressBookQueries(messaging.sentMessages), [])

			await act(() => { messaging.dispatch(createSettingsReply(mainnet)) })
			assert.deepEqual(getAddressBookQueries(messaging.sentMessages), [{ chainId: '0x1', filter: 'My Active Addresses', searchString: '' }])

			await act(() => { messaging.dispatch(createSettingsReply(sepolia)) })
			assert.deepEqual(getAddressBookQueries(messaging.sentMessages), [{ chainId: '0x1', filter: 'My Active Addresses', searchString: '' }])

			await act(() => {
				render(undefined, dom.document.body)
			})
			assert.equal(messaging.listenerCount(), 0)
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
		}
	})
})
