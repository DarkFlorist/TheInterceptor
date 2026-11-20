import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import type { ReadonlySignal } from '@preact/signals'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { setRpcList } from '../../app/ts/background/storageVariables.js'
import { useRpcConnectionsList } from '../../app/ts/components/hooks/useRpcConnectionsList.js'
import { MessageToPopup } from '../../app/ts/types/interceptor-messages.js'
import type { RpcEntries, RpcEntry } from '../../app/ts/types/rpc.js'
import { flushMicrotasks } from '../harness/async.js'
import type { StorageKeys } from '../harness/browserMock.js'
import { installDomMock } from './domMock.js'
import { getNormalizedText, waitForRender } from './domQueries.js'
import { createRuntimeMessagingInstaller, type RuntimeMessaging } from './runtimeMessagingTestHarness.js'

const installRuntimeMessaging = createRuntimeMessagingInstaller()

const createRpcEntry = (name: string, chainId: bigint): RpcEntry => ({
	name,
	chainId,
	httpsRpc: `https://${ name.toLowerCase().replaceAll(' ', '-') }.example`,
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: true,
})

const storedRpc = createRpcEntry('Stored RPC', 1n)
const broadcastRpc = createRpcEntry('Broadcast RPC', 10n)
const laterBroadcastRpc = createRpcEntry('Later RPC', 137n)

// Shows the connection names, and hands the returned signal to the test so it can be read after unmounting.
function RpcConnectionsProbe({ onRender }: { onRender: (rpcConnections: ReadonlySignal<RpcEntries>) => void }) {
	const rpcConnections = useRpcConnectionsList()
	onRender(rpcConnections)
	return <p>{ rpcConnections.value.map((entry) => entry.name).join(', ') }</p>
}

const broadcastRpcList = async (messaging: RuntimeMessaging, rpcEntries: RpcEntries) => await act(async () => {
	await messaging.dispatchAndAwaitListeners(MessageToPopup.serialize({ role: 'all', method: 'popup_update_rpc_list', data: rpcEntries }))
})

const requestsRpcEntries = (keys: StorageKeys) => (typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : []).includes('rpcEntries')

// Holds every rpcEntries storage read until the test releases it, so a broadcast or an unmount can happen while the initial load is in flight.
function holdRpcListReads(messaging: RuntimeMessaging) {
	const release = Promise.withResolvers<void>()
	const readStorage = messaging.browserMock.browser.storage.local.get
	messaging.browserMock.browser.storage.local.get = async (keys) => {
		const items = await readStorage(keys)
		if (requestsRpcEntries(keys)) await release.promise
		return items
	}
	return { release: () => { release.resolve() } }
}

describe('useRpcConnectionsList', () => {
	test('shows the stored connections after mounting and every later popup_update_rpc_list broadcast', async () => {
		const messaging = installRuntimeMessaging()
		const dom = installDomMock()
		try {
			await setRpcList([storedRpc])
			await act(() => { render(h(RpcConnectionsProbe, { onRender: () => undefined }), dom.document.body) })
			await waitForRender(() => getNormalizedText(dom.document.body) === 'Stored RPC', { description: 'the stored connections' })

			await broadcastRpcList(messaging, [storedRpc, broadcastRpc])
			assert.equal(getNormalizedText(dom.document.body), 'Stored RPC, Broadcast RPC')

			await broadcastRpcList(messaging, [laterBroadcastRpc])
			assert.equal(getNormalizedText(dom.document.body), 'Later RPC')
		} finally {
			await act(() => { render(undefined, dom.document.body) })
			dom.restore()
		}
	})

	test('keeps a broadcast that arrives before the initial storage read finishes', async () => {
		const messaging = installRuntimeMessaging()
		const dom = installDomMock()
		try {
			await setRpcList([storedRpc])
			const heldReads = holdRpcListReads(messaging)
			await act(() => { render(h(RpcConnectionsProbe, { onRender: () => undefined }), dom.document.body) })

			await broadcastRpcList(messaging, [broadcastRpc])
			assert.equal(getNormalizedText(dom.document.body), 'Broadcast RPC')

			heldReads.release()
			await act(async () => { await flushMicrotasks() })
			assert.equal(getNormalizedText(dom.document.body), 'Broadcast RPC')
		} finally {
			await act(() => { render(undefined, dom.document.body) })
			dom.restore()
		}
	})

	test('stops listening on unmount and ignores an initial storage read that finishes afterwards', async () => {
		const messaging = installRuntimeMessaging()
		const dom = installDomMock()
		try {
			await setRpcList([storedRpc])
			const heldReads = holdRpcListReads(messaging)
			let rpcConnections: ReadonlySignal<RpcEntries> | undefined
			await act(() => { render(h(RpcConnectionsProbe, { onRender: (entries) => { rpcConnections = entries } }), dom.document.body) })
			assert.equal(messaging.listenerCount(), 1)

			await act(() => { render(undefined, dom.document.body) })
			assert.equal(messaging.listenerCount(), 0)
			heldReads.release()
			await flushMicrotasks()

			assert.deepEqual(rpcConnections?.value, [])
		} finally {
			dom.restore()
		}
	})
})
