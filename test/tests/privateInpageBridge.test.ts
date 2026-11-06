import * as assert from 'assert'
import { test } from 'bun:test'
import { createPrivateInpageBridge } from '../../app/inpage/ts/privateInpageBridge.js'

test('private port handoff never consults page array iterators, including a wrong-nonce attempt', () => {
	const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
	const root = new EventTarget()
	const host = { hidden: false, setAttribute: () => undefined, attachShadow: () => root, remove: () => undefined }
	Object.defineProperty(globalThis, 'window', { configurable: true, value: { document: {
		createElement: () => host, documentElement: { appendChild: () => undefined },
	} } })
	const bridge = createPrivateInpageBridge('private-capability', () => undefined)
	const nativeIterator = Array.prototype[Symbol.iterator]
	const portGetter = Object.getOwnPropertyDescriptor(MessageChannel.prototype, 'port2')
	let leakedPorts = 0
	let latePortReads = 0
	let acceptedPort: MessagePort | undefined
	let rejectedWrongNonce = false
	let acceptedCorrectNonce = false
	root.addEventListener('interceptor_private_bridge', (event) => {
		if (!(event instanceof MessageEvent) || event.data !== 'correct-nonce:private-capability') return
		acceptedPort = event.ports[0]
		event.preventDefault()
	})
	try {
		Object.defineProperty(MessageChannel.prototype, 'port2', { configurable: true, get() {
			latePortReads++
			return undefined
		} })
		Array.prototype[Symbol.iterator] = function () {
			for (let index = 0; index < this.length; index++) {
				if (this[index] instanceof MessagePort) leakedPorts++
			}
			return nativeIterator.call(this)
		}
		rejectedWrongNonce = !bridge.offerPort('wrong-nonce')
		acceptedCorrectNonce = bridge.offerPort('correct-nonce')
	} finally {
		if (portGetter === undefined) Reflect.deleteProperty(MessageChannel.prototype, 'port2')
		else Object.defineProperty(MessageChannel.prototype, 'port2', portGetter)
		Array.prototype[Symbol.iterator] = nativeIterator
		if (previousWindow === undefined) Reflect.deleteProperty(globalThis, 'window')
		else Object.defineProperty(globalThis, 'window', previousWindow)
		acceptedPort?.close()
	}
	assert.equal(rejectedWrongNonce, true)
	assert.equal(acceptedCorrectNonce, true)
	assert.ok(acceptedPort)
	assert.equal(leakedPorts, 0)
	assert.equal(latePortReads, 0)
})

test('private receive bypasses page data getters and exposes only an own-field record', async () => {
	const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
	const root = new EventTarget()
	const host = { hidden: false, setAttribute: () => undefined, attachShadow: () => root, remove: () => undefined }
	Object.defineProperty(globalThis, 'window', { configurable: true, value: { document: {
		createElement: () => host, documentElement: { appendChild: () => undefined },
	} } })
	const dataDescriptor = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data')
	let pageGetterCalls = 0
	let peer: MessagePort | undefined
	try {
		let received: ((message: { readonly data: unknown }) => void) | undefined
		const reply = new Promise<{ readonly data: unknown }>((resolve) => { received = resolve })
		const bridge = createPrivateInpageBridge('private-capability', (message) => { received?.(message) })
		root.addEventListener('interceptor_private_bridge', (event) => {
			if (!(event instanceof MessageEvent)) return
			peer = event.ports[0]
			event.preventDefault()
		})
		assert.equal(bridge.offerPort('nonce'), true)
		Object.defineProperty(MessageEvent.prototype, 'data', { configurable: true, get() {
			pageGetterCalls++
			throw new Error('Page getter must not see a private event')
		} })
		peer?.postMessage({ contentScriptCapability: 'private-reply' })
		const message = await reply
		assert.deepEqual(message.data, { contentScriptCapability: 'private-reply' })
		assert.equal(Object.hasOwn(message, 'data'), true)
		assert.equal('currentTarget' in message, false)
		assert.equal(pageGetterCalls, 0)
	} finally {
		if (dataDescriptor !== undefined) Object.defineProperty(MessageEvent.prototype, 'data', dataDescriptor)
		if (previousWindow === undefined) Reflect.deleteProperty(globalThis, 'window')
		else Object.defineProperty(globalThis, 'window', previousWindow)
		peer?.close()
	}
})
