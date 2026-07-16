import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { replyToInterceptedRequest, replyToInterceptedRequestAfterManifestV2Reconnect, sendSubscriptionReplyOrCallBack, sendSubscriptionReplyOrCallBackAfterManifestV2Reconnect, sendSubscriptionReplyOrCallBackToPort } from '../../app/ts/background/messageSending.js'
import { websiteSocketToString } from '../../app/ts/background/backgroundUtils.js'

function installBrowserMock() {
	globalThis.browser = {
		runtime: {
			lastError: undefined,
		},
	} as unknown as typeof globalThis.browser
}

function createPort(postMessage: (message: unknown) => void): browser.runtime.Port {
	const event = {
		addListener() { return undefined },
		removeListener() { return undefined },
		hasListener() { return false },
	}
	return {
		name: 'test-port',
		disconnect() { return undefined },
		postMessage,
		onMessage: event,
		onDisconnect: event,
	}
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

	test('reports whether a request reached its exact content-script connection', () => {
		installBrowserMock()
		const socket = { tabId: 1, connectionName: 0n }
		const connectionKey = websiteSocketToString(socket)
		const connectedPort = createPort(() => {
				return undefined
		})
		const disconnectedPort = createPort(() => {
				throw new Error('Attempting to use a disconnected port object')
		})
		const createConnections = (port: browser.runtime.Port) => new Map([[socket.tabId, { connections: {
			[connectionKey]: { port, socket, websiteOrigin: 'https://example.test', approved: true, wantsToConnect: true },
		} }]])
		const message = {
			type: 'forwardToSigner' as const,
			method: 'eth_sendTransaction' as const,
			params: [{ from: 0x1111111111111111111111111111111111111111n }],
			uniqueRequestIdentifier: { requestId: 7, requestSocket: socket },
		}

		assert.equal(replyToInterceptedRequest(createConnections(connectedPort), message), true)
		assert.equal(replyToInterceptedRequest(createConnections(disconnectedPort), message), false)
		assert.equal(replyToInterceptedRequest(new Map(), message), false)
		assert.equal(replyToInterceptedRequest(new Map([[socket.tabId, { connections: {} }]]), message), false)
	})

	test('reports when a signer account request misses a disconnected content-script port', () => {
		installBrowserMock()
		const socket = { tabId: 1, connectionName: 0x123n }
		const connectionKey = websiteSocketToString(socket)
		const disconnectedPort = createPort(() => {
			throw new Error('Attempting to use a disconnected port object')
		})
		const websiteTabConnections = new Map([[socket.tabId, { connections: {
			[connectionKey]: { port: disconnectedPort, socket, websiteOrigin: 'https://example.test', approved: true, wantsToConnect: true },
		} }]])

		assert.equal(sendSubscriptionReplyOrCallBack(websiteTabConnections, socket, {
			type: 'result',
			method: 'request_signer_to_eth_requestAccounts',
			result: [],
		}), false)
	})

	test('requests an MV2 content-script reconnect and retries the exact signing route', async () => {
		const socket = { tabId: 1, connectionName: 0x123n }
		const connectionKey = websiteSocketToString(socket)
		const postedMessages: unknown[] = []
		const port = createPort((message) => { postedMessages.push(message) })
		let disconnectedPostAttempts = 0
		const disconnectedPort = createPort(() => {
			disconnectedPostAttempts += 1
			throw new Error('Attempting to use a disconnected port object')
		})
		const websiteTabConnections = new Map<number, { connections: Record<string, { port: browser.runtime.Port, socket: typeof socket, websiteOrigin: string, approved: boolean, wantsToConnect: boolean }> }>([[socket.tabId, { connections: {
			[connectionKey]: { port: disconnectedPort, socket, websiteOrigin: 'https://example.test', approved: true, wantsToConnect: true },
		} }]])
		const reconnectMessages: unknown[] = []
		globalThis.browser = {
			runtime: {
				lastError: undefined,
				getManifest: () => ({ manifest_version: 2 }),
			},
			tabs: {
				async sendMessage(_tabId: number, message: unknown) {
					reconnectMessages.push(message)
					setTimeout(() => {
						websiteTabConnections.set(socket.tabId, { connections: {
							[connectionKey]: { port, socket, websiteOrigin: 'https://example.test', approved: true, wantsToConnect: true },
						} })
					}, 100)
					return { reconnected: true }
				},
			},
		} as unknown as typeof globalThis.browser
		const message = {
			type: 'forwardToSigner' as const,
			method: 'eth_sendTransaction' as const,
			params: [{ from: 0x1111111111111111111111111111111111111111n }],
			uniqueRequestIdentifier: { requestId: 7, requestSocket: socket },
		}

		assert.equal(await replyToInterceptedRequestAfterManifestV2Reconnect(websiteTabConnections, message), true)
		assert.deepEqual(reconnectMessages, [{ method: 'interceptor_reconnect_content_script_port', connectionName: '0x123' }])
		assert.equal(disconnectedPostAttempts, 1)
		assert.equal(postedMessages.length, 1)
	})

	test('reconnects an MV2 content-script port before requesting signer accounts', async () => {
		const socket = { tabId: 1, connectionName: 0x123n }
		const connectionKey = websiteSocketToString(socket)
		const postedMessages: unknown[] = []
		const connectedPort = createPort((message) => { postedMessages.push(message) })
		const disconnectedPort = createPort(() => {
			throw new Error('Attempting to use a disconnected port object')
		})
		const websiteTabConnections = new Map<number, { connections: Record<string, { port: browser.runtime.Port, socket: typeof socket, websiteOrigin: string, approved: boolean, wantsToConnect: boolean }> }>([[socket.tabId, { connections: {
			[connectionKey]: { port: disconnectedPort, socket, websiteOrigin: 'https://example.test', approved: true, wantsToConnect: true },
		} }]])
		const reconnectMessages: unknown[] = []
		globalThis.browser = {
			runtime: {
				lastError: undefined,
				getManifest: () => ({ manifest_version: 2 }),
			},
			tabs: {
				async sendMessage(_tabId: number, message: unknown) {
					reconnectMessages.push(message)
					setTimeout(() => {
						websiteTabConnections.set(socket.tabId, { connections: {
							[connectionKey]: { port: connectedPort, socket, websiteOrigin: 'https://example.test', approved: true, wantsToConnect: true },
						} })
					}, 100)
					return { reconnected: true }
				},
			},
		} as unknown as typeof globalThis.browser
		const message = {
			type: 'result' as const,
			method: 'request_signer_to_eth_requestAccounts' as const,
			result: [] as const,
		}

		assert.equal(await sendSubscriptionReplyOrCallBackAfterManifestV2Reconnect(websiteTabConnections, socket, message), true)
		assert.deepEqual(reconnectMessages, [{ method: 'interceptor_reconnect_content_script_port', connectionName: '0x123' }])
		assert.equal(postedMessages.length, 1)
	})

	test('keeps request-scoped lifecycle bridge messages free of console warnings', () => {
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

	test('keeps standalone eth_accounts bridge replies free of console warnings', () => {
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

			assert.equal(warnings.length, 0)
		} finally {
			console.warn = originalWarn
		}
	})
})
