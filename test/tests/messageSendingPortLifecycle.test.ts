import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { replyToInterceptedRequest, sendSubscriptionReplyOrCallBackToPort } from '../../app/ts/background/messageSending.js'
import { websiteSocketToString } from '../../app/ts/background/backgroundUtils.js'

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

	test('does not log request-scoped lifecycle messages at the bridge layer', () => {
		installBrowserMock()
		const warnings: unknown[][] = []
		const originalWarn = console.warn
		console.warn = (...args: unknown[]) => { warnings.push(args) }
		try {
			const port = {
				postMessage() {
					return undefined
				},
			} as unknown as browser.runtime.Port

			sendSubscriptionReplyOrCallBackToPort(port, { type: 'result', method: 'connect', result: [1n], requestId: 7 })
			sendSubscriptionReplyOrCallBackToPort(port, { type: 'result', method: 'accountsChanged', result: [], requestId: 7 })

			assert.equal(warnings.length, 0)
		} finally {
			console.warn = originalWarn
		}
	})

	test('does not log standalone eth_accounts replies at the bridge layer', () => {
		installBrowserMock()
		const warnings: unknown[][] = []
		const originalWarn = console.warn
		console.warn = (...args: unknown[]) => { warnings.push(args) }
		try {
			const socket = { tabId: 1, connectionName: 0n }
			const port = {
				postMessage() {
					return undefined
				},
			} as unknown as browser.runtime.Port
			const connectionKey = websiteSocketToString(socket)
			const websiteTabConnections = new Map([[socket.tabId, { connections: {
				[connectionKey]: { port, socket, websiteOrigin: 'https://example.test', approved: true, wantsToConnect: true },
			} }]])

			replyToInterceptedRequest(websiteTabConnections, {
				type: 'result',
				method: 'eth_accounts',
				result: [0x1111111111111111111111111111111111111111n],
				uniqueRequestIdentifier: { requestId: 7, requestSocket: socket },
			})

			assert.equal(warnings.some((args) => String(args[0]).includes('[Interceptor access debug]')), false)
		} finally {
			console.warn = originalWarn
		}
	})
})
