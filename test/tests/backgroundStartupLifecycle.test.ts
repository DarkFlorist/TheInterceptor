import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { isIgnorablePortLifecycleError, tryRegisterContentScriptPortListeners } from '../../app/ts/background/contentScriptPortLifecycle.js'

describe('background startup lifecycle', () => {
	test('ignores invalidated connect ports before listeners can be attached', () => {
		let disconnectHandlerRan = false
		let messageHandlerRan = false

		const port = {
			get onDisconnect() {
				throw new Error("Failed to read the 'onDisconnect' property from 'Object': Extension context invalidated.")
			},
			onMessage: {
				addListener: () => {
					messageHandlerRan = true
				},
			},
		} as unknown as browser.runtime.Port

		const registered = tryRegisterContentScriptPortListeners(
			port,
			() => {
				disconnectHandlerRan = true
			},
			() => {
				messageHandlerRan = true
			},
			() => undefined,
		)

		assert.equal(registered, false)
		assert.equal(disconnectHandlerRan, false)
		assert.equal(messageHandlerRan, false)
	})

	test('classifies extension context invalidation as an ignorable lifecycle error', () => {
		assert.equal(isIgnorablePortLifecycleError(new Error("Failed to read the 'onDisconnect' property from 'Object': Extension context invalidated.")), true)
	})
})
