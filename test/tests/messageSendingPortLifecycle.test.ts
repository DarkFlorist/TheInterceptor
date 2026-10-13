import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { replyToInterceptedRequest, replyToInterceptedRequestAfterManifestV2Reconnect, sendSubscriptionReplyOrCallBack, sendSubscriptionReplyOrCallBackAfterManifestV2Reconnect, sendSubscriptionReplyOrCallBackToPort } from '../../app/ts/background/messageSending.js'
import { websiteSocketToString } from '../../app/ts/background/backgroundUtils.js'
import type { InterceptedRequestForward, SubscriptionReplyOrCallBack } from '../../app/ts/types/interceptor-messages.js'
import type { TabConnection, WebsiteTabConnections } from '../../app/ts/types/user-interface-types.js'
import type { WebsiteSocket } from '../../app/ts/utils/requests.js'
import { createMockPort } from '../harness/browserMock.js'
import { replaceProperty } from '../harness/globals.js'
import { createPerTestBrowserMockInstaller } from '../harness/perTest.js'

const installTestBrowserMock = createPerTestBrowserMockInstaller()

const createDisconnectedPort = () => createMockPort({ onPostMessage: () => { throw new Error('Attempting to use a disconnected port object') } })

const createTabConnection = (socket: WebsiteSocket, port: browser.runtime.Port): TabConnection => ({ connections: {
	[websiteSocketToString(socket)]: { port, socket, websiteOrigin: 'https://example.test', approved: true, wantsToConnect: true },
} })

const createWebsiteTabConnections = (socket: WebsiteSocket, port: browser.runtime.Port): WebsiteTabConnections => new Map([[socket.tabId, createTabConnection(socket, port)]])

describe('background messageSending port lifecycle', () => {
	test('ignores disconnected runtime lastError after posting to a content-script port', () => {
		const { browser } = installTestBrowserMock()
		let postedMessages = 0
		const { port } = createMockPort({
			onPostMessage: () => {
				postedMessages += 1
				browser.runtime.lastError = { message: 'Attempting to use a disconnected port object' }
			},
		})

		assert.doesNotThrow(() => {
			sendSubscriptionReplyOrCallBackToPort(port, { type: 'result', method: 'accountsChanged', result: [] })
		})
		assert.equal(postedMessages, 1)
	})

	test('ignores disconnected content-script ports that throw during postMessage', () => {
		installTestBrowserMock()
		const { port } = createMockPort({ onPostMessage: () => { throw new Error('Could not establish connection. Receiving end does not exist.') } })

		assert.doesNotThrow(() => {
			sendSubscriptionReplyOrCallBackToPort(port, { type: 'result', method: 'accountsChanged', result: [] })
		})
	})

	test('ignores invalid tab target errors after posting to a content-script port', () => {
		installTestBrowserMock()
		const { port } = createMockPort({ onPostMessage: () => { throw new Error('Invalid tab ID: 12') } })

		assert.doesNotThrow(() => {
			sendSubscriptionReplyOrCallBackToPort(port, { type: 'result', method: 'accountsChanged', result: [] })
		})
	})

	test('reports whether a request reached its exact content-script connection', () => {
		installTestBrowserMock()
		const socket = { tabId: 1, connectionName: 0n }
		const connectedPort = createMockPort().port
		const disconnectedPort = createDisconnectedPort().port
		const message: InterceptedRequestForward = {
			type: 'forwardToSigner',
			method: 'eth_sendTransaction',
			params: [{ from: 0x1111111111111111111111111111111111111111n }],
			uniqueRequestIdentifier: { requestId: 7, requestSocket: socket },
		}

		assert.equal(replyToInterceptedRequest(createWebsiteTabConnections(socket, connectedPort), message), true)
		assert.equal(replyToInterceptedRequest(createWebsiteTabConnections(socket, disconnectedPort), message), false)
		assert.equal(replyToInterceptedRequest(new Map(), message), false)
		assert.equal(replyToInterceptedRequest(new Map([[socket.tabId, { connections: {} }]]), message), false)
	})

	test('reports when a signer account request misses a disconnected content-script port', () => {
		installTestBrowserMock()
		const socket = { tabId: 1, connectionName: 0x123n }
		const websiteTabConnections = createWebsiteTabConnections(socket, createDisconnectedPort().port)

		assert.equal(sendSubscriptionReplyOrCallBack(websiteTabConnections, socket, {
			type: 'result',
			method: 'request_signer_to_eth_requestAccounts',
			result: [],
		}), false)
	})

	test('requests an MV2 content-script reconnect and retries the exact signing route', async () => {
		const socket = { tabId: 1, connectionName: 0x123n }
		const reconnectedPort = createMockPort()
		let disconnectedPostAttempts = 0
		const disconnectedPort = createMockPort({
			onPostMessage: () => {
				disconnectedPostAttempts += 1
				throw new Error('Attempting to use a disconnected port object')
			},
		})
		const websiteTabConnections = createWebsiteTabConnections(socket, disconnectedPort.port)
		const { calls } = installTestBrowserMock({
			manifestVersion: 2,
			tabs: [{ id: socket.tabId }],
			handlers: {
				tabMessage: () => {
					// The replacement port registers after the reconnect request resolves, so the background has to wait for it.
					setTimeout(() => {
						websiteTabConnections.set(socket.tabId, createTabConnection(socket, reconnectedPort.port))
					}, 0)
					return { reconnected: true }
				},
			},
		})
		const message: InterceptedRequestForward = {
			type: 'forwardToSigner',
			method: 'eth_sendTransaction',
			params: [{ from: 0x1111111111111111111111111111111111111111n }],
			uniqueRequestIdentifier: { requestId: 7, requestSocket: socket },
		}

		assert.equal(await replyToInterceptedRequestAfterManifestV2Reconnect(websiteTabConnections, message), true)
		assert.deepEqual(calls.tabsSendMessage.map(({ message: reconnectMessage }) => reconnectMessage), [{ method: 'interceptor_reconnect_content_script_port', connectionName: '0x123' }])
		assert.equal(disconnectedPostAttempts, 1)
		assert.equal(reconnectedPort.postedMessages.length, 1)
	})

	test('reconnects an MV2 content-script port before requesting signer accounts', async () => {
		const socket = { tabId: 1, connectionName: 0x123n }
		const reconnectedPort = createMockPort()
		const websiteTabConnections = createWebsiteTabConnections(socket, createDisconnectedPort().port)
		const { calls } = installTestBrowserMock({
			manifestVersion: 2,
			tabs: [{ id: socket.tabId }],
			handlers: {
				tabMessage: () => {
					// The replacement port registers after the reconnect request resolves, so the background has to wait for it.
					setTimeout(() => {
						websiteTabConnections.set(socket.tabId, createTabConnection(socket, reconnectedPort.port))
					}, 0)
					return { reconnected: true }
				},
			},
		})
		const message: SubscriptionReplyOrCallBack = {
			type: 'result',
			method: 'request_signer_to_eth_requestAccounts',
			result: [],
		}

		assert.equal(await sendSubscriptionReplyOrCallBackAfterManifestV2Reconnect(websiteTabConnections, socket, message), true)
		assert.deepEqual(calls.tabsSendMessage.map(({ message: reconnectMessage }) => reconnectMessage), [{ method: 'interceptor_reconnect_content_script_port', connectionName: '0x123' }])
		assert.equal(reconnectedPort.postedMessages.length, 1)
	})

	test('keeps request-scoped lifecycle bridge messages free of console warnings', () => {
		installTestBrowserMock()
		const warnings: unknown[][] = []
		const restoreWarn = replaceProperty(console, 'warn', (...args: unknown[]) => { warnings.push(args) })
		try {
			const { port } = createMockPort()

			sendSubscriptionReplyOrCallBackToPort(port, { type: 'result', method: 'connect', result: [1n], requestId: 7 })
			sendSubscriptionReplyOrCallBackToPort(port, { type: 'result', method: 'accountsChanged', result: [], requestId: 7 })

			assert.equal(warnings.length, 0)
		} finally {
			restoreWarn()
		}
	})

	test('marks direct result replies as bridge settlements but not request-scoped callbacks', () => {
		installTestBrowserMock()
		const socket = { tabId: 1, connectionName: 0n }
		const { port, postedMessages } = createMockPort()
		const websiteTabConnections = createWebsiteTabConnections(socket, port)

		replyToInterceptedRequest(websiteTabConnections, {
			type: 'result',
			method: 'eth_accounts',
			result: [],
			uniqueRequestIdentifier: { requestId: 7, requestSocket: socket },
		})
		sendSubscriptionReplyOrCallBack(websiteTabConnections, socket, {
			type: 'result',
			method: 'accountsChanged',
			result: [],
			requestId: 7,
		})

		const terminalReply = postedMessages[0]
		const intermediateEvent = postedMessages[1]
		assert.equal(typeof terminalReply === 'object' && terminalReply !== null && 'bridgeRequestSettled' in terminalReply && terminalReply.bridgeRequestSettled === true, true)
		assert.equal(typeof intermediateEvent === 'object' && intermediateEvent !== null && 'bridgeRequestSettled' in intermediateEvent, false)
	})

	test('keeps standalone eth_accounts bridge replies free of console warnings', () => {
		installTestBrowserMock()
		const warnings: unknown[][] = []
		const restoreWarn = replaceProperty(console, 'warn', (...args: unknown[]) => { warnings.push(args) })
		try {
			const socket = { tabId: 1, connectionName: 0n }
			const websiteTabConnections = createWebsiteTabConnections(socket, createMockPort().port)

			replyToInterceptedRequest(websiteTabConnections, {
				type: 'result',
				method: 'eth_accounts',
				result: [0x1111111111111111111111111111111111111111n],
				uniqueRequestIdentifier: { requestId: 7, requestSocket: socket },
			})

			assert.equal(warnings.length, 0)
		} finally {
			restoreWarn()
		}
	})
})
