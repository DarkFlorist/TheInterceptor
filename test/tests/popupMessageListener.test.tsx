import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { addNoReplyExpectingBrowserRuntimeOnMessageListener } from '../../app/ts/utils/browser.js'
import { type PopupMessageHandler, usePopupMessage } from '../../app/ts/components/hooks/usePopupMessage.js'
import { usePopupSettingsSnapshot } from '../../app/ts/components/hooks/usePopupSettingsSnapshot.js'
import { MessageToPopup } from '../../app/ts/types/interceptor-messages.js'
import type { RpcNetwork } from '../../app/ts/types/rpc.js'
import { installDomMock } from './domMock.js'
import { waitFor } from '../harness/async.js'
import { getMessageMethods } from './runtimeMessageMatchers.js'
import { createRuntimeMessagingInstaller } from './runtimeMessagingTestHarness.js'

const installRuntimeMessaging = createRuntimeMessagingInstaller()

function PopupMessageProbe({ handlePopupMessage }: { handlePopupMessage: PopupMessageHandler }) {
	usePopupMessage(handlePopupMessage)
	return <div />
}

const addressBookChangedMessage = { role: 'all', method: 'popup_addressBookEntriesChanged' }

const rpcNetwork: RpcNetwork = {
	name: 'Ethereum Mainnet',
	chainId: 1n,
	httpsRpc: 'https://rpc.example',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: false,
}

const settingsReplyMessage = MessageToPopup.serialize({
	role: 'all',
	method: 'popup_requestSettingsReply',
	data: {
		useTabsInsteadOfPopup: true,
		metamaskCompatibilityMode: false,
		safeAppsCompatibilityMode: false,
		activeRpcNetwork: rpcNetwork,
		rpcEntries: [rpcNetwork],
	},
})

const settingsUpdatedMessage = MessageToPopup.serialize({
	role: 'all',
	method: 'popup_settingsUpdated',
	popupRefreshGeneration: 1,
	data: {
		activeSimulationAddress: undefined,
		activeSigningSafeAddress: undefined,
		activeRpcNetwork: rpcNetwork,
		openedPage: { page: 'Home' },
		useSignersAddressAsActiveAddress: false,
		websiteAccess: [],
		simulationMode: true,
	},
})

describe('popup runtime message listeners', () => {
	test('the returned unsubscribe removes exactly the listener that was registered', () => {
		const messaging = installRuntimeMessaging()
		const receivedMessages: unknown[] = []
		const unsubscribe = addNoReplyExpectingBrowserRuntimeOnMessageListener((message) => { receivedMessages.push(message) })
		assert.equal(messaging.listenerCount(), 1)
		messaging.dispatch('first')
		unsubscribe()
		assert.equal(messaging.listenerCount(), 0)
		messaging.dispatch('second')
		assert.deepEqual(receivedMessages, ['first'])
	})

	test('reports handler errors thrown before the first await instead of letting them escape the listener', async () => {
		const messaging = installRuntimeMessaging()
		const unsubscribe = addNoReplyExpectingBrowserRuntimeOnMessageListener(() => { throw new Error('handler failed') })
		assert.doesNotThrow(() => messaging.dispatch('message'))
		await waitFor(() => messaging.sentMessages.length > 0, { description: 'the unexpected error report' })
		assert.deepEqual(getMessageMethods(messaging.sentMessages), ['popup_UnexpectedErrorOccured'])
		unsubscribe()
	})

	test('usePopupMessage passes parsed messages to the latest handler and unsubscribes on unmount', async () => {
		const dom = installDomMock()
		const messaging = installRuntimeMessaging()
		try {
			const firstHandlerMessages: string[] = []
			const latestHandlerMessages: string[] = []
			await act(() => {
				render(h(PopupMessageProbe, { handlePopupMessage: (message) => { firstHandlerMessages.push(message.method) } }), dom.document.body)
			})
			assert.equal(messaging.listenerCount(), 1)

			await act(() => {
				render(h(PopupMessageProbe, { handlePopupMessage: (message) => { latestHandlerMessages.push(message.method) } }), dom.document.body)
			})
			assert.equal(messaging.listenerCount(), 1, 're-rendering must not register another listener')

			messaging.dispatch({ method: 'not_a_popup_message' })
			messaging.dispatch(addressBookChangedMessage)
			assert.deepEqual(firstHandlerMessages, [])
			assert.deepEqual(latestHandlerMessages, ['popup_addressBookEntriesChanged'])

			await act(() => {
				render(undefined, dom.document.body)
			})
			assert.equal(messaging.listenerCount(), 0)
			messaging.dispatch(addressBookChangedMessage)
			assert.deepEqual(latestHandlerMessages, ['popup_addressBookEntriesChanged'])
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
		}
	})
})

describe('usePopupSettingsSnapshot', () => {
	// Written by the probe on every render; read through readLatestSnapshot so the test's own reset does not narrow later reads to undefined.
	const probe: { latestSnapshot?: ReturnType<typeof usePopupSettingsSnapshot> } = {}
	const readLatestSnapshot = () => probe.latestSnapshot
	function SettingsSnapshotProbe() {
		probe.latestSnapshot = usePopupSettingsSnapshot()
		return <div />
	}

	test('requests settings on mount and again after a settings change, keeping the latest reply', async () => {
		const dom = installDomMock()
		const messaging = installRuntimeMessaging()
		probe.latestSnapshot = undefined
		try {
			await act(() => {
				render(h(SettingsSnapshotProbe, {}), dom.document.body)
			})
			assert.deepEqual(getMessageMethods(messaging.sentMessages), ['popup_requestSettings'])
			assert.equal(readLatestSnapshot()?.value, undefined)

			await act(() => { messaging.dispatch(settingsReplyMessage) })
			assert.equal(readLatestSnapshot()?.value?.useTabsInsteadOfPopup, true)
			assert.deepEqual(readLatestSnapshot()?.value?.rpcEntries.map((entry) => entry.httpsRpc), ['https://rpc.example'])

			await act(() => { messaging.dispatch(settingsUpdatedMessage) })
			assert.deepEqual(getMessageMethods(messaging.sentMessages), ['popup_requestSettings', 'popup_requestSettings'])

			await act(() => {
				render(undefined, dom.document.body)
			})
			assert.equal(messaging.listenerCount(), 0)
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
			probe.latestSnapshot = undefined
		}
	})
})
