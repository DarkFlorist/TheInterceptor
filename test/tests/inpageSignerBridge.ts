import * as assert from 'assert'
import { describe, runIfRoot, should, run } from '../micro-should.js'

type Listener = (event: { type: string, data?: unknown, detail?: unknown, ports?: readonly unknown[] }) => void

function createFakeWindow() {
	const listeners = new Map<string, Set<Listener>>()
	const signerRequests: string[] = []
	const backgroundEthAccountsReplies: unknown[] = []
	const signerAccounts = ['0x1111111111111111111111111111111111111111']

	const fakeSigner = {
		isMetaMask: true,
		isConnected: () => true,
		request: async ({ method }: { method: string }) => {
			signerRequests.push(method)
			switch (method) {
				case 'eth_chainId':
					return '0x1'
				case 'eth_accounts':
				case 'eth_requestAccounts':
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
					case 'eth_accounts_reply':
						backgroundEthAccountsReplies.push((request.params?.[0] as { accounts?: unknown } | undefined) ?? {})
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

	return { fakeWindow, signerRequests, backgroundEthAccountsReplies, signerAccounts }
}

async function waitFor(condition: () => boolean, timeoutMs = 2000) {
	const start = Date.now()
	while (!condition()) {
		if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition')
		await new Promise((resolve) => setTimeout(resolve, 0))
	}
}

export async function main() {
	describe('inpage signer bridge', () => {
		should('avoid hidden signer account sync on connect and preserve explicit account replies', async () => {
			const previousWindow = (globalThis as { window?: unknown }).window
			const previousCustomEvent = (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
			const { fakeWindow, signerRequests, backgroundEthAccountsReplies, signerAccounts } = createFakeWindow()
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
}

await runIfRoot(async () => {
	await main()
	await run()
}, import.meta)
