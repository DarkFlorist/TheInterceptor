import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { sendSubscriptionReplyOrCallBackToPort } from '../../app/ts/background/messageSending.js'

function installBrowserMock() {
	globalThis.browser = {
		runtime: {
			lastError: undefined,
		},
	} as unknown as typeof globalThis.browser
}

describe('background messageSending port lifecycle', () => {
	test('ignores disconnected runtime lastError after posting to a content-script port', () => {
		installBrowserMock()
		let postedMessages = 0
		const port = {
			postMessage() {
				postedMessages += 1
				globalThis.browser.runtime.lastError = { message: 'Attempting to use a disconnected port object' }
			},
		} as unknown as browser.runtime.Port

		assert.doesNotThrow(() => {
			sendSubscriptionReplyOrCallBackToPort(port, { type: 'result', method: 'accountsChanged', result: [] })
		})
		assert.equal(postedMessages, 1)
	})

	test('ignores disconnected content-script ports that throw during postMessage', () => {
		installBrowserMock()
		const port = {
			postMessage() {
				throw new Error('Could not establish connection. Receiving end does not exist.')
			},
		} as unknown as browser.runtime.Port

		assert.doesNotThrow(() => {
			sendSubscriptionReplyOrCallBackToPort(port, { type: 'result', method: 'accountsChanged', result: [] })
		})
	})
})
