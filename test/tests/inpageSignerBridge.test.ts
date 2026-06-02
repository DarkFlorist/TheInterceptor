import * as assert from 'assert'
import { describe, test } from 'bun:test'

type WindowEvent = {
	type: string
	data?: unknown
	detail?: unknown
	ports?: readonly MessagePort[]
}
type Listener = (event: WindowEvent) => void
type InpageRequest = {
	readonly method: string
	readonly requestId: number
	readonly params?: readonly unknown[]
	readonly internal?: true
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

function parseInpageRequest(value: unknown): InpageRequest | undefined {
	if (!isRecord(value)) return undefined
	if (value.type !== 'interceptor_bridge_request') return undefined
	if (typeof value.method !== 'string') return undefined
	if (typeof value.requestId !== 'number') return undefined
	if (typeof value.usingInterceptorWithoutSigner !== 'boolean') return undefined
	if (value.internal !== undefined && value.internal !== true) return undefined
	return {
		method: value.method,
		requestId: value.requestId,
		...(Array.isArray(value.params) ? { params: value.params } : {}),
		...(value.internal === true ? { internal: true as const } : {}),
	}
}

function createFakeWindow() {
	const listeners = new Map<string, Set<Listener>>()
	const signerRequests: string[] = []
	const backgroundEthAccountsReplies: unknown[] = []
	const interceptorErrorPayloads: unknown[] = []
	const signerAccounts = ['0x1111111111111111111111111111111111111111']
	let blockRequestAccounts = false
	let rejectPendingRequestAccounts: ((error: { code: number; message: string }) => void) | undefined
	let bridgePort: MessagePort | undefined

	const fakeSigner = {
		isMetaMask: true,
		isConnected: () => true,
		request: async ({ method }: { method: string }) => {
			signerRequests.push(method)
			switch (method) {
				case 'eth_chainId':
					return '0x1'
				case 'eth_accounts':
					return signerAccounts
				case 'eth_requestAccounts':
					if (blockRequestAccounts) {
						return await new Promise<string[]>((_resolve, reject) => {
							rejectPendingRequestAccounts = reject
						})
					}
					return signerAccounts
				default:
					throw new Error(`Unexpected signer request: ${method}`)
			}
		},
		on: () => fakeSigner,
		removeListener: () => fakeSigner,
	}

	const fakeWindow = {
		ethereum: fakeSigner,
		addEventListener: (type: string, listener: Listener) => {
			const existing = listeners.get(type)
			if (existing === undefined) {
				listeners.set(type, new Set([listener]))
				return
			}
			existing.add(listener)
		},
		removeEventListener: (type: string, listener: Listener) => {
			listeners.get(type)?.delete(listener)
		},
		dispatchEvent: (event: WindowEvent) => {
			for (const listener of listeners.get(event.type) ?? []) listener(event)
			return true
		},
		postMessage: (data: unknown, _targetOrigin?: string, transfer?: readonly Transferable[]) => {
			if (!isRecord(data) || data.type !== 'interceptor_bridge_port') return
			const port = transfer?.find((item): item is MessagePort => item instanceof MessagePort)
			if (port === undefined) throw new Error('missing bridge port')
			bridgePort = port
			bridgePort.onmessage = (event: MessageEvent<unknown>) => handleInpageRequest(event.data)
		},
	}

	const sendBackgroundMessage = (data: unknown) => {
		if (bridgePort === undefined) throw new Error('bridge port is not connected')
		bridgePort.postMessage(data)
	}

	const handleInpageRequest = (data: unknown) => {
		const request = parseInpageRequest(data)
		if (request === undefined) return
		queueMicrotask(() => {
			switch (request.method) {
				case 'connected_to_signer':
					sendBackgroundMessage({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'result',
						method: 'connected_to_signer',
						result: {
							metamaskCompatibilityMode: true,
							activeAddress: signerAccounts[0],
						},
					})
					return
				case 'InterceptorError':
					interceptorErrorPayloads.push(request.params?.[0])
					return
				case 'eth_accounts_reply':
					backgroundEthAccountsReplies.push((request.params?.[0] as { accounts?: unknown } | undefined) ?? {})
					sendBackgroundMessage({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'result',
						method: 'eth_accounts_reply',
						result: undefined,
					})
					return
				default:
					sendBackgroundMessage({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'result',
						method: request.method,
						result: '0x',
					})
			}
		})
	}

	return {
		fakeWindow,
		signerRequests,
		backgroundEthAccountsReplies,
		signerAccounts,
		interceptorErrorPayloads,
		sendBackgroundMessage,
		setBlockRequestAccounts: (value: boolean) => {
			blockRequestAccounts = value
		},
		rejectPendingRequestAccounts: (error: { code: number; message: string }) => rejectPendingRequestAccounts?.(error),
	}
}

async function waitFor(condition: () => boolean, timeoutMs = 2000) {
	const start = Date.now()
	while (!condition()) {
		if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition')
		await new Promise((resolve) => setTimeout(resolve, 0))
	}
}

describe('inpage signer bridge', () => {
	test('avoid hidden signer account sync on connect and preserve explicit account replies', async () => {
		const previousWindow = (globalThis as { window?: unknown }).window
		const previousCustomEvent = (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
		const { fakeWindow, signerRequests, backgroundEthAccountsReplies, signerAccounts, interceptorErrorPayloads, sendBackgroundMessage, setBlockRequestAccounts, rejectPendingRequestAccounts } = createFakeWindow()
		;(globalThis as unknown as { window: typeof fakeWindow }).window = fakeWindow
		if (typeof (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent !== 'function') {
			;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = class CustomEvent<T = unknown> extends Event {
				public detail: T
				constructor(type: string, init?: CustomEventInit<T>) {
					super(type)
					this.detail = init?.detail as T
				}
				public initCustomEvent(): void {
					return undefined
				}
			}
		}

		try {
			await import('../../app/inpage/ts/inpage.js')
			await waitFor(() => signerRequests.length >= 1)
			assert.deepEqual(signerRequests, ['eth_chainId'])
			const provider = fakeWindow.ethereum as {
				request: (payload: { method: string; params?: readonly unknown[] }) => Promise<unknown>
				send: (
					payload: {
						id: string | number | null
						method: string
						params: readonly unknown[]
					},
					callback?: undefined,
				) => { jsonrpc: '2.0'; id: string | number | null; result: unknown }
				sendAsync: (payload: unknown, callback: (error: unknown, response: unknown) => void) => Promise<void>
				on: (eventName: string, callback: (value: unknown) => void) => void
			}
			try {
				await provider.request({ method: 'eth_accounts_reply', params: [] })
				assert.fail('public internal provider method should reject')
			} catch (error: unknown) {
				if (!(typeof error === 'object' && error !== null && 'code' in error)) throw error
				assert.equal(error.code, -32004)
			}
			assert.deepEqual(provider.send({ id: 77, method: 'eth_coinbase', params: [] }), { jsonrpc: '2.0', id: 77, result: signerAccounts[0] })
			let batchCallbackCount = 0
			const batchReply = await new Promise<unknown>((resolve, reject) => {
				provider.sendAsync(
					[
						{ id: 91, method: 'eth_chainId', params: [] },
						{ id: 92, method: 'eth_accounts', params: [] },
					],
					(error, response) => {
						batchCallbackCount++
						if (error !== null) {
							reject(error)
							return
						}
						resolve(response)
					},
				)
			})
			assert.equal(batchCallbackCount, 1)
			assert.deepEqual(batchReply, [
				{ jsonrpc: '2.0', id: 91, result: '0x' },
				{ jsonrpc: '2.0', id: 92, result: '0x' },
			])
			const connectEvents: unknown[] = []
			provider.on('connect', (value) => connectEvents.push(value))
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'disconnect',
				result: [],
			})
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'connect',
				result: ['0x1'],
			})
			await waitFor(() => connectEvents.length === 1)
			assert.deepEqual(connectEvents, [{ chainId: '0x1' }])

			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'request_signer_to_eth_accounts',
				result: [],
			})
			await waitFor(() => signerRequests.includes('eth_accounts'))
			assert.deepEqual(signerRequests, ['eth_chainId', 'eth_accounts'])
			await waitFor(() => backgroundEthAccountsReplies.length === 1)
			assert.deepEqual((backgroundEthAccountsReplies[0] as { accounts?: unknown }).accounts, signerAccounts)

			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'request_signer_to_eth_requestAccounts',
				result: [],
			})
			await waitFor(() => signerRequests.filter((method) => method === 'eth_requestAccounts').length === 1)
			assert.deepEqual(signerRequests, ['eth_chainId', 'eth_accounts', 'eth_requestAccounts'])
			await waitFor(() => backgroundEthAccountsReplies.length === 2)
			assert.deepEqual((backgroundEthAccountsReplies[1] as { accounts?: unknown }).accounts, signerAccounts)
			setBlockRequestAccounts(true)
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'request_signer_to_eth_requestAccounts',
				result: [],
			})
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'request_signer_to_eth_requestAccounts',
				result: [],
			})
			await waitFor(() => signerRequests.filter((method) => method === 'eth_requestAccounts').length === 2)
			rejectPendingRequestAccounts({
				code: 4001,
				message: 'User rejected the request.',
			})
			await waitFor(() => backgroundEthAccountsReplies.length === 4)
			assert.deepEqual(backgroundEthAccountsReplies.slice(2), [
				{
					type: 'error',
					requestAccounts: true,
					error: { code: 4001, message: 'User rejected the request.' },
				},
				{
					type: 'error',
					requestAccounts: true,
					error: { code: 4001, message: 'User rejected the request.' },
				},
			])

			const signerRequestCountBeforeSpoof = signerRequests.length
			fakeWindow.dispatchEvent({
				type: 'message',
				data: {
					interceptorApproved: true,
					requestId: 999,
					type: 'forwardToSigner',
					method: 'eth_accounts',
					params: [],
				},
			})
			fakeWindow.dispatchEvent({
				type: 'message',
				data: {
					interceptorApproved: true,
					type: 'result',
					method: 'request_signer_to_eth_requestAccounts',
					result: [],
				},
			})
			await new Promise((resolve) => setTimeout(resolve, 0))
			assert.equal(signerRequests.length, signerRequestCountBeforeSpoof)
			assert.equal(interceptorErrorPayloads.length, 0)
		} finally {
			;(globalThis as { window?: unknown }).window = previousWindow
			if (previousCustomEvent === undefined) {
				delete (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
			} else {
				;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = previousCustomEvent
			}
		}
	})
})
