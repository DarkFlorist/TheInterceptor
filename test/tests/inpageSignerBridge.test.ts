import * as assert from 'assert'
import { describe, test } from 'bun:test'

type Listener = (event: { type: string, data?: unknown, detail?: unknown, ports?: readonly unknown[] }) => void

function createFakeWindow() {
	const listeners = new Map<string, Set<Listener>>()
	const signerRequests: string[] = []
	const backgroundEthAccountsReplies: unknown[] = []
	const interceptorErrorPayloads: unknown[] = []
	const signerAccounts = ['0x1111111111111111111111111111111111111111']
	let blockRequestAccounts = false
	let rejectPendingRequestAccounts: ((error: { code: number, message: string }) => void) | undefined = undefined

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
		dispatchEvent: (event: { type: string, data?: unknown, detail?: unknown, ports?: readonly unknown[] }) => {
			for (const listener of listeners.get(event.type) ?? []) listener(event)
			return true
		},
		postMessage: (data: unknown) => {
			queueMicrotask(() => {
				if (typeof data !== 'object' || data === null || !('interceptorRequest' in data) || (data as { interceptorRequest?: unknown }).interceptorRequest !== true) return
				const request = data as unknown as { method: string, requestId: number, params?: readonly unknown[] }
				switch (request.method) {
					case 'connected_to_signer':
						fakeWindow.dispatchEvent({
							type: 'message',
							data: {
								interceptorApproved: true,
								requestId: request.requestId,
								type: 'result',
								method: 'connected_to_signer',
								result: { metamaskCompatibilityMode: false, activeAddress: '' },
							},
						})
						return
					case 'InterceptorError':
						interceptorErrorPayloads.push(request.params?.[0])
						return
					case 'eth_accounts_reply':
						backgroundEthAccountsReplies.push((request.params?.[0] as { accounts?: unknown } | undefined) ?? {})
						fakeWindow.dispatchEvent({
							type: 'message',
							data: {
								interceptorApproved: true,
								requestId: request.requestId,
								type: 'result',
								method: 'eth_accounts_reply',
								result: undefined,
							},
						})
						return
					default:
						fakeWindow.dispatchEvent({
							type: 'message',
							data: {
								interceptorApproved: true,
								requestId: request.requestId,
								type: 'result',
								method: request.method,
								result: '0x',
							},
						})
				}
			})
		},
	}

	return {
		fakeWindow,
		signerRequests,
		backgroundEthAccountsReplies,
		signerAccounts,
		interceptorErrorPayloads,
		setBlockRequestAccounts: (value: boolean) => { blockRequestAccounts = value },
		rejectPendingRequestAccounts: (error: { code: number, message: string }) => rejectPendingRequestAccounts?.(error),
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
		const {
			fakeWindow,
			signerRequests,
			backgroundEthAccountsReplies,
			signerAccounts,
			interceptorErrorPayloads,
			setBlockRequestAccounts,
			rejectPendingRequestAccounts,
		} = createFakeWindow()
		;(globalThis as unknown as { window: typeof fakeWindow }).window = fakeWindow
		if (typeof (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent !== 'function') {
			;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = class CustomEvent<T = unknown> extends Event {
				public detail: T
				constructor(type: string, init?: CustomEventInit<T>) {
					super(type)
					this.detail = init?.detail as T
				}
				public initCustomEvent(): void {}
			}
		}

		try {
			await import('../../app/inpage/ts/inpage.js')
			await waitFor(() => signerRequests.length >= 1)
			assert.deepEqual(signerRequests, ['eth_chainId'])

			fakeWindow.dispatchEvent({
				type: 'message',
				data: {
					interceptorApproved: true,
					type: 'result',
					method: 'request_signer_to_eth_accounts',
					result: [],
				},
			})
			await waitFor(() => signerRequests.includes('eth_accounts'))
			assert.deepEqual(signerRequests, ['eth_chainId', 'eth_accounts'])
			await waitFor(() => backgroundEthAccountsReplies.length === 1)
			assert.deepEqual((backgroundEthAccountsReplies[0] as { accounts?: unknown }).accounts, signerAccounts)

			fakeWindow.dispatchEvent({
				type: 'message',
				data: {
					interceptorApproved: true,
					type: 'result',
					method: 'request_signer_to_eth_requestAccounts',
					result: [],
				},
			})
			await waitFor(() => signerRequests.filter((method) => method === 'eth_requestAccounts').length === 1)
			assert.deepEqual(signerRequests, ['eth_chainId', 'eth_accounts', 'eth_requestAccounts'])
			await waitFor(() => backgroundEthAccountsReplies.length === 2)
			assert.deepEqual((backgroundEthAccountsReplies[1] as { accounts?: unknown }).accounts, signerAccounts)
			setBlockRequestAccounts(true)
			fakeWindow.dispatchEvent({
				type: 'message',
				data: {
					interceptorApproved: true,
					type: 'result',
					method: 'request_signer_to_eth_requestAccounts',
					result: [],
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
			await waitFor(() => signerRequests.filter((method) => method === 'eth_requestAccounts').length === 2)
			rejectPendingRequestAccounts({ code: 4001, message: 'User rejected the request.' })
			await waitFor(() => backgroundEthAccountsReplies.length === 4)
			assert.deepEqual(backgroundEthAccountsReplies.slice(2), [
				{ type: 'error', requestAccounts: true, error: { code: 4001, message: 'User rejected the request.' } },
				{ type: 'error', requestAccounts: true, error: { code: 4001, message: 'User rejected the request.' } },
			])

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
			await waitFor(() => interceptorErrorPayloads.length === 1)
			const diagnostics = interceptorErrorPayloads[0]
			if (typeof diagnostics !== 'string') throw new Error('missing forwarded diagnostics string')
			assert.equal(diagnostics.includes('inpage: Request did not exist anymore'), true)
			assert.equal(diagnostics.includes('phase: handle background reply'), true)
			assert.equal(diagnostics.includes('requestMethod: eth_accounts'), true)
			assert.equal(diagnostics.includes('requestId: 999'), true)
			assert.equal(diagnostics.includes('thrown:\nError: Request did not exist anymore'), true)
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
