import { runInNewContext } from 'node:vm'
import { installInpageBridgeInitializer, invokeInpageBridgeInitializer } from '../../app/ts/utils/inpageBridgeProtocol.js'
import * as assert from 'assert'
import { test } from 'bun:test'
import { initializeInpageBridge } from '../../app/ts/background/inpageBridgeBootstrap.js'

const secret = 'a'.repeat(64)
const sender = { id: 'extension-id', tab: { id: 3, index: 0, active: true, highlighted: true, pinned: false, incognito: false }, frameId: 2, documentId: 'current-document' }

test('privileged bridge bootstrap targets the exact sending document and rejects other senders', async () => {
	const previousBrowser = Object.getOwnPropertyDescriptor(globalThis, 'browser')
	const injections: unknown[] = []
	Object.defineProperty(globalThis, 'browser', { configurable: true, value: {
		runtime: { id: sender.id },
		scripting: { executeScript: async (injection: unknown) => { injections.push(injection); return [{ result: true }] } },
	} })
	try {
		assert.equal(await initializeInpageBridge({ method: 'initialize_inpage_bridge', bridgeSecret: secret }, sender), true)
		assert.equal(injections.length, 1)
		const injection = injections[0]
		if (typeof injection !== 'object' || injection === null || !('target' in injection) || !('world' in injection) || !('args' in injection)) throw new Error('Missing bootstrap injection')
		assert.deepEqual(injection.target, { tabId: 3, documentIds: ['current-document'] })
		assert.equal(injection.world, 'MAIN')
		assert.deepEqual(injection.args, [secret])
		await assert.rejects(initializeInpageBridge({ method: 'initialize_inpage_bridge', bridgeSecret: secret }, { ...sender, id: 'another-extension' }), /Invalid inpage bootstrap sender/)
		await assert.rejects(initializeInpageBridge({ method: 'initialize_inpage_bridge', bridgeSecret: 'invalid' }, sender), /Invalid inpage bootstrap key/)
		const { documentId: _documentId, ...senderWithoutDocument } = sender
		await assert.rejects(initializeInpageBridge({ method: 'initialize_inpage_bridge', bridgeSecret: secret }, senderWithoutDocument), /document target/)
		assert.equal(injections.length, 1)
	} finally {
		if (previousBrowser === undefined) Reflect.deleteProperty(globalThis, 'browser')
		else Object.defineProperty(globalThis, 'browser', previousBrowser)
	}
})

test('the MAIN-world initializer installer and serialized invocation share one contract', () => {
	const mainRealm = {}
	installInpageBridgeInitializer(mainRealm, (value) => value === secret)
	const invokeSource = `(${ invokeInpageBridgeInitializer.toString() })`
	assert.equal(runInNewContext(`${ invokeSource }(${ JSON.stringify(secret) })`, mainRealm), true)
	assert.equal(runInNewContext(`${ invokeSource }('wrong-secret')`, mainRealm), false)
	assert.equal(runInNewContext(`${ invokeSource }(${ JSON.stringify(secret) })`, {}), false)
	assert.throws(() => runInNewContext(`${ invokeSource }(undefined)`, mainRealm), /Missing inpage bootstrap key/)
})
