import { NATIVE_GNOSIS_SAFE_APPS_SESSION_READY } from '../../app/ts/types/nativeGnosisSafeAppsHostContext.js'
import * as assert from 'node:assert/strict'
import { spyOn, test } from 'bun:test'
import { connectNativeGnosisSafeAppsHost } from '../../app/ts/utils/nativeGnosisSafeAppsConnection.js'
import { createPort, installBrowserMock } from './backgroundEthAccountsTestHarness.js'
import { RawInterceptedRequest } from '../../app/ts/utils/requests.js'

function harness() {
	installBrowserMock()
	const listeners = new Set<(message: unknown) => void>()
	const disconnects = new Set<() => void>()
	const requests: { readonly method: string, readonly requestId: number }[] = []
	const { port } = createPort(12, (message) => {
		if (!('data' in message)) return
		const request = RawInterceptedRequest.parse(message.data)
		requests.push(request)
		queueMicrotask(() => {
			for (const listener of listeners) listener({ type: 'result', method: 'accountsChanged', requestId: request.requestId, result: ['notification must not settle an SDK command'] })
			for (const listener of listeners) listener({ type: 'result', bridgeRequestSettled: true, requestId: request.requestId, result: request.method === 'eth_requestAccounts' ? ['0x1234'] : { kind: 'result', value: { safeAddress: '0x1234' } } })
		})
	})
	Object.assign(port, { onMessage: { addListener: (listener: (message: unknown) => void) => { listeners.add(listener) } }, onDisconnect: { addListener: (listener: () => void) => { disconnects.add(listener) } }, disconnect: () => { for (const listener of disconnects) listener() } })
	Object.assign(browser.runtime, { connect: () => port })
	const connection = connectNativeGnosisSafeAppsHost()
	queueMicrotask(() => { for (const listener of listeners) listener({ type: NATIVE_GNOSIS_SAFE_APPS_SESSION_READY }) })
	return { requests, connection, disconnects }
}

test('host waits for its own app frame then shares normal consent across SDK discovery', async () => {
	const h = harness()
	try {
		const requests = ['one', 'two'].map((id) => h.connection.request({ id, method: 'getSafeInfo' }))
		await Promise.resolve()
		assert.equal(h.requests.length, 0)
		h.connection.frameLoaded()
		const replies = await Promise.all(requests)
		assert.deepEqual(replies.map((reply) => reply.data), [{ safeAddress: '0x1234' }, { safeAddress: '0x1234' }])
		assert.deepEqual(h.requests.map((request) => request.method), ['eth_requestAccounts', 'safe_apps_request', 'safe_apps_request'])
		assert.equal(new Set(h.requests.map((request) => request.requestId)).size, 3)
	} finally { h.connection.disconnect() }
})

test('host disconnection releases requests waiting for iframe load with actionable failure', async () => {
	const h = harness()
	try {
		const reply = h.connection.request({ id: 'waiting', method: 'getSafeInfo' })
		h.connection.disconnect()
		await assert.rejects(reply, /Retry the connection/)
		assert.equal(h.requests.length, 0)
	} finally { h.connection.disconnect() }
})


test('background disconnection also releases startup waiters before the app frame loads', async () => {
	const h = harness()
	try {
		const reply = h.connection.request({ id: 'startup', method: 'getSafeInfo' })
		for (const disconnect of h.disconnects) disconnect()
		await assert.rejects(reply, /Retry the connection/)
		assert.equal(h.requests.length, 0)
	} finally { h.connection.disconnect() }
})


test('a missing background session acknowledgement becomes an actionable startup error', async () => {
	const timers = spyOn(globalThis, 'setTimeout')
	const h = harness()
	try {
		const reply = h.connection.request({ id: 'no-ack', method: 'getSafeInfo' })
		const callback = timers.mock.calls.find(([, delay]) => delay === 15_000)?.[0]
		if (typeof callback !== 'function') throw new Error('Missing background startup deadline')
		callback()
		await assert.rejects(reply, /did not finish starting.*Retry the connection/)
		assert.equal(h.requests.length, 0)
	} finally { h.connection.disconnect(); timers.mockRestore() }
})
