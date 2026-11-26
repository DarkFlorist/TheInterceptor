import * as assert from 'assert'
import { test } from 'bun:test'
import { createGnosisSafeAppsTransport } from '../../app/shared/ts/gnosisSafeAppsTransport.js'
import { createGnosisSafeHostHarness } from '../fixtures/gnosisSafeAppsHostHarness.js'

test('shared Gnosis Safe Apps transport delivers both directions only from its own window and origin and releases listeners', async () => {
	const { origin, emitMessage, fakeWindow, framePort, restoreGlobals } = createGnosisSafeHostHarness()
	try {
		const transport = createGnosisSafeAppsTransport(window)
		const received: unknown[] = []
		const unsubscribe = transport.subscribe(({ data }) => received.push(data))
		emitMessage({ id: 'foreign-origin' }, 'https://unrelated.example')
		emitMessage({ id: 'foreign-source' }, origin, framePort)
		fakeWindow.dispatchEvent(new Event('message'))
		transport.post({ id: 'request', method: 'getSafeInfo' })
		transport.post({ id: 'request', success: true })
		await Promise.resolve()
		assert.deepEqual(received, [{ id: 'request', method: 'getSafeInfo' }, { id: 'request', success: true }])
		unsubscribe()
		transport.post({ id: 'after-disposal' })
		await Promise.resolve()
		assert.equal(received.length, 2)
	} finally { restoreGlobals() }
})
