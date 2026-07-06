import * as assert from 'assert'
import { describe, test } from 'bun:test'

type WindowEvent = { type: string, data?: unknown, detail?: unknown, ports?: readonly MessagePort[] }
type Listener = (event: WindowEvent) => void
type InpageRequest = { readonly method: string, readonly requestId: number, readonly params?: readonly unknown[], readonly internal?: true }
type FakeWindowOptions = {
	readonly onConnectedToSignerRequest?: () => void
	readonly handleRequest?: (request: InpageRequest, sendBackgroundMessage: (data: unknown) => void) => boolean
	readonly handleSignerRequest?: (request: { readonly method: string, readonly params?: readonly unknown[] }) => unknown | Promise<unknown>
	readonly signerChainIdReply?: unknown
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

function createFakeWindow({ onConnectedToSignerRequest, handleRequest, handleSignerRequest, signerChainIdReply = '0x1' }: FakeWindowOptions = {}) {
	const listeners = new Map<string, Set<Listener>>()
	const signerRequests: string[] = []
	const backgroundEthAccountsReplies: unknown[] = []
	const backgroundSignerChainChanges: unknown[] = []
	const interceptorErrorPayloads: unknown[] = []
	const signerAccounts = ['0x1111111111111111111111111111111111111111']
	let blockRequestAccounts = false
	let rejectPendingRequestAccounts: ((error: { code: number, message: string }) => void) | undefined
	let bridgePort: MessagePort | undefined

	const fakeSigner = {
		isMetaMask: true,
		isConnected: () => true,
		request: async ({ method, params }: { method: string, params?: readonly unknown[] }) => {
			const customReply = handleSignerRequest?.({ method, ...(params === undefined ? {} : { params }) })
			if (customReply !== undefined) return await customReply
			signerRequests.push(method)
			switch (method) {
				case 'eth_chainId':
					if (signerChainIdReply instanceof Error) throw signerChainIdReply
					return signerChainIdReply
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
					throw new Error(`Unexpected signer request: ${ method }`)
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
			if (handleRequest?.(request, sendBackgroundMessage) === true) return
			switch (request.method) {
				case 'connected_to_signer':
					onConnectedToSignerRequest?.()
					sendBackgroundMessage({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'result',
						method: 'connected_to_signer',
						result: { metamaskCompatibilityMode: true, activeAddress: signerAccounts[0] },
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
				case 'signer_chainChanged':
					backgroundSignerChainChanges.push(request.params?.[0])
					sendBackgroundMessage({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'result',
						method: 'signer_chainChanged',
						result: '0x',
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
		backgroundSignerChainChanges,
		signerAccounts,
		interceptorErrorPayloads,
		sendBackgroundMessage,
		setBlockRequestAccounts: (value: boolean) => { blockRequestAccounts = value },
		rejectPendingRequestAccounts: (error: { code: number, message: string }) => rejectPendingRequestAccounts?.(error),
	}
}

function createLockedCompatibilitySigner() {
	const baseSigner = {
		isMetaMask: true,
		isConnected: () => true,
		request: async ({ method }: { method: string }) => {
			switch (method) {
				case 'eth_chainId':
					return '0x1'
				default:
					throw new Error(`Unexpected signer request: ${ method }`)
			}
		},
		on: () => baseSigner,
		removeListener: () => baseSigner,
	}

	Object.defineProperty(baseSigner, 'selectedAddress', {
		configurable: false,
		enumerable: true,
		get: () => undefined,
	})

	return baseSigner
}

function createConfigurableGetterOnlyCompatibilitySigner() {
	const baseSigner = {
		isMetaMask: true,
		isConnected: () => true,
		request: async ({ method }: { method: string }) => {
			switch (method) {
				case 'eth_chainId':
					return '0x1'
				default:
					throw new Error(`Unexpected signer request: ${ method }`)
			}
		},
		on: () => baseSigner,
		removeListener: () => baseSigner,
	}

	Object.defineProperty(baseSigner, 'selectedAddress', {
		configurable: true,
		enumerable: true,
		get: () => undefined,
	})

	return baseSigner
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
			sendBackgroundMessage,
			setBlockRequestAccounts,
			rejectPendingRequestAccounts,
		} = createFakeWindow()
		const originalDispatchEvent = fakeWindow.dispatchEvent
		;(globalThis as unknown as { window: typeof fakeWindow }).window = fakeWindow
		if (typeof (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent !== 'function') {
			;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = class CustomEvent<T = unknown> extends Event {
				public detail: T
				constructor(type: string, init?: CustomEventInit<T>) {
					super(type)
					this.detail = init?.detail as T
				}
				public initCustomEvent(): void { return undefined }
			}
		}

		try {
			await import('../../app/inpage/ts/inpage.js')
			await waitFor(() => signerRequests.length >= 1)
			assert.deepEqual(signerRequests, ['eth_chainId'])
			assert.strictEqual(fakeWindow.dispatchEvent, originalDispatchEvent)
			const provider = fakeWindow.ethereum as {
				request: (payload: { method: string, params?: readonly unknown[] }) => Promise<unknown>
				send: (payload: { id: string | number | null, method: string, params: readonly unknown[] }, callback?: undefined) => { jsonrpc: '2.0', id: string | number | null, result: unknown }
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
				provider.sendAsync([
					{ id: 91, method: 'eth_chainId', params: [] },
					{ id: 92, method: 'eth_accounts', params: [] },
				], (error, response) => {
					batchCallbackCount++
					if (error !== null) {
						reject(error)
						return
					}
					resolve(response)
				})
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
			rejectPendingRequestAccounts({ code: 4001, message: 'User rejected the request.' })
			await waitFor(() => backgroundEthAccountsReplies.length === 4)
			assert.deepEqual(backgroundEthAccountsReplies.slice(2), [
				{ type: 'error', requestAccounts: true, error: { code: 4001, message: 'User rejected the request.' } },
				{ type: 'error', requestAccounts: true, error: { code: 4001, message: 'User rejected the request.' } },
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

			const lateSignerRequests: string[] = []
			const lateSigner = {
				isMetaMask: true,
				isConnected: () => true,
				request: async ({ method }: { method: string }) => {
					lateSignerRequests.push(method)
					if (method === 'eth_chainId') return '0x1'
					if (method === 'eth_accounts') return signerAccounts
					throw new Error(`Unexpected late signer request: ${ method }`)
				},
				on: () => lateSigner,
				removeListener: () => lateSigner,
			}
			;(fakeWindow as { ethereum: typeof lateSigner }).ethereum = lateSigner
			fakeWindow.dispatchEvent({ type: 'ethereum#initialized' })
			await waitFor(() => lateSignerRequests.length >= 1)
			assert.equal(lateSignerRequests[0], 'eth_chainId')
			assert.equal((fakeWindow.ethereum as { isInterceptor?: boolean }).isInterceptor, true)
			assert.strictEqual(fakeWindow.dispatchEvent, originalDispatchEvent)
		} finally {
			;(globalThis as { window?: unknown }).window = previousWindow
			if (previousCustomEvent === undefined) {
				delete (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
			} else {
				;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = previousCustomEvent
			}
		}
	})

	test('uses mapped Coinbase provider for signer requests and signer name', async () => {
		const previousWindow = (globalThis as { window?: unknown }).window
		const previousCustomEvent = (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
		let signerName: string | undefined
		const signerRequests = {
			brave: [] as string[],
			coinbase: [] as string[],
		}
		const { fakeWindow } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessage) => {
				if (request.method === 'connected_to_signer') {
					signerName = request.params?.[1] as string
					sendBackgroundMessage({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'result',
						method: 'connected_to_signer',
						result: { metamaskCompatibilityMode: true, activeAddress: '0x1111111111111111111111111111111111111111' },
					})
					return true
				}
				return false
			},
		})

		const coinbaseSigner = {
			isCoinbaseWallet: true,
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				signerRequests.coinbase.push(method)
				if (method === 'eth_chainId') return '0x1'
				if (method === 'eth_accounts') return ['0x1111111111111111111111111111111111111111']
				throw new Error(`Unexpected mapped signer request: ${ method }`)
			},
			on: () => coinbaseSigner,
			removeListener: () => coinbaseSigner,
		}
		const braveSigner = {
			isBraveWallet: true,
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				signerRequests.brave.push(method)
				if (method === 'eth_chainId') return '0x99'
				throw new Error(`Unexpected brave signer request: ${ method }`)
			},
			on: () => braveSigner,
			removeListener: () => braveSigner,
		}
		;(fakeWindow as { ethereum: typeof braveSigner & { providerMap: Map<string, typeof coinbaseSigner> } }).ethereum = {
			...braveSigner,
			providerMap: new Map([['CoinbaseWallet', coinbaseSigner]]),
		}
		;(globalThis as unknown as { window: typeof fakeWindow }).window = fakeWindow
		if (typeof (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent !== 'function') {
			;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = class CustomEvent<T = unknown> extends Event {
				public detail: T
				constructor(type: string, init?: CustomEventInit<T>) {
					super(type)
					this.detail = init?.detail as T
				}
				public initCustomEvent(): void { return undefined }
			}
		}

		try {
			await import('../../app/inpage/ts/inpage.js?provider-map-coinbase-binding')
			await waitFor(() => signerName !== undefined)
			await waitFor(() => signerRequests.brave.length === 1 || signerRequests.coinbase.length === 1)
			assert.equal(signerName, 'CoinbaseWallet')
			assert.deepEqual(signerRequests.coinbase, ['eth_chainId'])
			assert.deepEqual(signerRequests.brave, [])
		} finally {
			;(globalThis as { window?: unknown }).window = previousWindow
			if (previousCustomEvent === undefined) {
				delete (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
			} else {
				;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = previousCustomEvent
			}
		}
	})

	test('uses providerMap CoinbaseWallet key as signer identity when mapped provider lacks isCoinbaseWallet flag', async () => {
		const previousWindow = (globalThis as { window?: unknown }).window
		const previousCustomEvent = (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
		let signerName: string | undefined
		const signerRequests = {
			brave: [] as string[],
			coinbase: [] as string[],
		}
		const { fakeWindow } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessage) => {
				if (request.method === 'connected_to_signer') {
					signerName = request.params?.[1] as string
					sendBackgroundMessage({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'result',
						method: 'connected_to_signer',
						result: { metamaskCompatibilityMode: true, activeAddress: '0x1111111111111111111111111111111111111111' },
					})
					return true
				}
				return false
			},
		})

		const mappedCoinbaseSigner = {
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				signerRequests.coinbase.push(method)
				if (method === 'eth_chainId') return '0x1'
				if (method === 'eth_accounts') return ['0x1111111111111111111111111111111111111111']
				throw new Error(`Unexpected mapped signer request: ${ method }`)
			},
			on: () => mappedCoinbaseSigner,
			removeListener: () => mappedCoinbaseSigner,
		}
		const braveSigner = {
			isBraveWallet: true,
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				signerRequests.brave.push(method)
				if (method === 'eth_chainId') return '0x99'
				throw new Error(`Unexpected brave signer request: ${ method }`)
			},
			on: () => braveSigner,
			removeListener: () => braveSigner,
		}
		;(fakeWindow as { ethereum: typeof braveSigner & { providerMap: Map<string, typeof mappedCoinbaseSigner> } }).ethereum = {
			...braveSigner,
			providerMap: new Map([['CoinbaseWallet', mappedCoinbaseSigner]]),
		}
		;(globalThis as unknown as { window: typeof fakeWindow }).window = fakeWindow
		if (typeof (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent !== 'function') {
			;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = class CustomEvent<T = unknown> extends Event {
				public detail: T
				constructor(type: string, init?: CustomEventInit<T>) {
					super(type)
					this.detail = init?.detail as T
				}
				public initCustomEvent(): void { return undefined }
			}
		}

		try {
			await import('../../app/inpage/ts/inpage.js?provider-map-coinbase-missing-flag')
			await waitFor(() => signerName !== undefined)
			await waitFor(() => signerRequests.brave.length === 1 || signerRequests.coinbase.length === 1)
			assert.equal(signerName, 'CoinbaseWallet')
			assert.deepEqual(signerRequests.coinbase, ['eth_chainId'])
			assert.deepEqual(signerRequests.brave, [])
		} finally {
			;(globalThis as { window?: unknown }).window = previousWindow
			if (previousCustomEvent === undefined) {
				delete (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
			} else {
				;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = previousCustomEvent
			}
		}
	})

	test('falls back to the root provider when mapped CoinbaseWallet signer request fails', async () => {
		const previousWindow = (globalThis as { window?: unknown }).window
		const previousCustomEvent = (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
		let signerName: string | undefined
		const {
			fakeWindow,
			backgroundSignerChainChanges,
			interceptorErrorPayloads,
		} = createFakeWindow({
			handleRequest: (request, sendBackgroundMessage) => {
				if (request.method === 'connected_to_signer') {
					signerName = request.params?.[1] as string
					sendBackgroundMessage({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'result',
						method: 'connected_to_signer',
						result: { metamaskCompatibilityMode: true, activeAddress: '0x1111111111111111111111111111111111111111' },
					})
					return true
				}
				return false
			},
			signerChainIdReply: '0x2',
		})
		const rootSignerRequests: string[] = []
		const mappedSignerRequests: string[] = []
		let mappedSignerChainIdRequestCount = 0
		const mappedSigner = {
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				mappedSignerRequests.push(method)
				if (method === 'eth_chainId') {
					mappedSignerChainIdRequestCount += 1
					throw new Error('temporary failure in mapped signer')
				}
				throw new Error(`Unexpected mapped signer request: ${ method }`)
			},
			on: () => mappedSigner,
			removeListener: () => mappedSigner,
		}
		const rootSigner = {
			isMetaMask: true,
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				rootSignerRequests.push(method)
				if (method === 'eth_chainId') return '0x2'
				throw new Error(`Unexpected root signer request: ${ method }`)
			},
			on: () => rootSigner,
			removeListener: () => rootSigner,
		}
		;(fakeWindow as { ethereum: typeof rootSigner & { providerMap: Map<string, typeof mappedSigner> } }).ethereum = {
			...rootSigner,
			providerMap: new Map([['CoinbaseWallet', mappedSigner]]),
		}
		;(globalThis as unknown as { window: typeof fakeWindow }).window = fakeWindow
		if (typeof (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent !== 'function') {
			;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = class CustomEvent<T = unknown> extends Event {
				public detail: T
				constructor(type: string, init?: CustomEventInit<T>) {
					super(type)
					this.detail = init?.detail as T
				}
				public initCustomEvent(): void { return undefined }
			}
		}

		try {
			await import('../../app/inpage/ts/inpage.js?provider-map-chain-id-fallback')
			await waitFor(() => signerName !== undefined)
			assert.equal(mappedSignerChainIdRequestCount, 1)
			assert.deepEqual(mappedSignerRequests, ['eth_chainId'])
			assert.deepEqual(rootSignerRequests, ['eth_chainId'])
			assert.deepEqual(backgroundSignerChainChanges, ['0x2'])
			assert.equal(interceptorErrorPayloads.length, 0)
			assert.equal(signerName, 'CoinbaseWallet')
		} finally {
			;(globalThis as { window?: unknown }).window = previousWindow
			if (previousCustomEvent === undefined) {
				delete (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
			} else {
				;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = previousCustomEvent
			}
		}
	})

	test('does not fall back to the root provider when mapped CoinbaseWallet eth_accounts fails', async () => {
		const previousWindow = (globalThis as { window?: unknown }).window
		const previousCustomEvent = (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
		let signerName: string | undefined
		const {
			fakeWindow,
			backgroundEthAccountsReplies,
			interceptorErrorPayloads,
			sendBackgroundMessage,
		} = createFakeWindow({
			handleRequest: (request, sendBackgroundMessageInternal) => {
				if (request.method === 'connected_to_signer') {
					signerName = request.params?.[1] as string
					sendBackgroundMessageInternal({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'result',
						method: 'connected_to_signer',
						result: { metamaskCompatibilityMode: true, activeAddress: '0x1111111111111111111111111111111111111111' },
					})
					return true
				}
				return false
			},
		})
		const rootSignerRequests: string[] = []
		const mappedSignerRequests: string[] = []
		const mappedSigner = {
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				mappedSignerRequests.push(method)
				if (method === 'eth_chainId') return '0x2'
				if (method === 'eth_accounts') throw { code: -32603, message: 'internal account error' }
				throw new Error(`Unexpected mapped signer request: ${ method }`)
			},
			on: () => mappedSigner,
			removeListener: () => mappedSigner,
		}
		const rootSigner = {
			isMetaMask: true,
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				rootSignerRequests.push(method)
				if (method === 'eth_chainId') return '0x2'
				if (method === 'eth_accounts') return ['0x1111111111111111111111111111111111111111']
				throw new Error(`Unexpected root signer request: ${ method }`)
			},
			on: () => rootSigner,
			removeListener: () => rootSigner,
		}
		;(fakeWindow as { ethereum: typeof rootSigner & { providerMap: Map<string, typeof mappedSigner> } }).ethereum = {
			...rootSigner,
			providerMap: new Map([['CoinbaseWallet', mappedSigner]]),
		}
		;(globalThis as unknown as { window: typeof fakeWindow }).window = fakeWindow
		if (typeof (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent !== 'function') {
			;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = class CustomEvent<T = unknown> extends Event {
				public detail: T
				constructor(type: string, init?: CustomEventInit<T>) {
					super(type)
					this.detail = init?.detail as T
				}
				public initCustomEvent(): void { return undefined }
			}
		}

		try {
			await import('../../app/inpage/ts/inpage.js?provider-map-eth-accounts-no-fallback')
			await waitFor(() => signerName !== undefined)
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'request_signer_to_eth_accounts',
				result: [],
			})
			await waitFor(() => backgroundEthAccountsReplies.length === 1)
			assert.deepEqual(mappedSignerRequests, ['eth_chainId', 'eth_accounts'])
			assert.deepEqual(rootSignerRequests, [])
			assert.equal((backgroundEthAccountsReplies[0] as { requestAccounts: boolean }).requestAccounts, false)
			assert.equal((backgroundEthAccountsReplies[0] as { error: { code: number, message: string } }).error.code, -32603)
			assert.equal((backgroundEthAccountsReplies[0] as { error: { code: number, message: string } }).error.message, 'internal account error')
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

	test('does not fall back to the root provider when mapped CoinbaseWallet eth_requestAccounts is rejected', async () => {
		const previousWindow = (globalThis as { window?: unknown }).window
		const previousCustomEvent = (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
		let signerName: string | undefined
		const {
			fakeWindow,
			backgroundEthAccountsReplies,
			interceptorErrorPayloads,
			sendBackgroundMessage,
		} = createFakeWindow({
			handleRequest: (request, sendBackgroundMessageInternal) => {
				if (request.method === 'connected_to_signer') {
					signerName = request.params?.[1] as string
					sendBackgroundMessageInternal({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'result',
						method: 'connected_to_signer',
						result: { metamaskCompatibilityMode: true, activeAddress: '0x1111111111111111111111111111111111111111' },
					})
					return true
				}
				return false
			},
		})
		const rootSignerRequests: string[] = []
		const mappedSignerRequests: string[] = []
		const mappedSigner = {
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				mappedSignerRequests.push(method)
				if (method === 'eth_chainId') return '0x2'
				if (method === 'eth_requestAccounts') throw { code: 4001, message: 'User rejected the request.' }
				throw new Error(`Unexpected mapped signer request: ${ method }`)
			},
			on: () => mappedSigner,
			removeListener: () => mappedSigner,
		}
		const rootSigner = {
			isMetaMask: true,
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				rootSignerRequests.push(method)
				if (method === 'eth_chainId') return '0x2'
				if (method === 'eth_requestAccounts') return ['0x1111111111111111111111111111111111111111']
				throw new Error(`Unexpected root signer request: ${ method }`)
			},
			on: () => rootSigner,
			removeListener: () => rootSigner,
		}
		;(fakeWindow as { ethereum: typeof rootSigner & { providerMap: Map<string, typeof mappedSigner> } }).ethereum = {
			...rootSigner,
			providerMap: new Map([['CoinbaseWallet', mappedSigner]]),
		}
		;(globalThis as unknown as { window: typeof fakeWindow }).window = fakeWindow
		if (typeof (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent !== 'function') {
			;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = class CustomEvent<T = unknown> extends Event {
				public detail: T
				constructor(type: string, init?: CustomEventInit<T>) {
					super(type)
					this.detail = init?.detail as T
				}
				public initCustomEvent(): void { return undefined }
			}
		}

		try {
			await import('../../app/inpage/ts/inpage.js?provider-map-no-fallback-on-reject')
			await waitFor(() => signerName !== undefined)
			await waitFor(() => mappedSignerRequests.includes('eth_chainId'))
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'request_signer_to_eth_requestAccounts',
				result: [],
			})
			await waitFor(() => backgroundEthAccountsReplies.length === 1)
			assert.deepEqual(signerName, 'CoinbaseWallet')
			assert.deepEqual(mappedSignerRequests, ['eth_chainId', 'eth_requestAccounts'])
			assert.deepEqual(rootSignerRequests, [])
			assert.equal(backgroundEthAccountsReplies.length, 1)
			assert.equal((backgroundEthAccountsReplies[0] as { requestAccounts: boolean }).requestAccounts, true)
			assert.equal((backgroundEthAccountsReplies[0] as { error: { code: number, message: string } }).error.code, 4001)
			assert.equal((backgroundEthAccountsReplies[0] as { error: { code: number, message: string } }).error.message, 'User rejected the request.')
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

	test('does not fall back to the root provider when mapped CoinbaseWallet eth_requestAccounts returns 4001 with a non-standard message', async () => {
		const previousWindow = (globalThis as { window?: unknown }).window
		const previousCustomEvent = (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
		let signerName: string | undefined
		const {
			fakeWindow,
			backgroundEthAccountsReplies,
			interceptorErrorPayloads,
			sendBackgroundMessage,
		} = createFakeWindow({
			handleRequest: (request, sendBackgroundMessageInternal) => {
				if (request.method === 'connected_to_signer') {
					signerName = request.params?.[1] as string
					sendBackgroundMessageInternal({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'result',
						method: 'connected_to_signer',
						result: { metamaskCompatibilityMode: true, activeAddress: '0x1111111111111111111111111111111111111111' },
					})
					return true
				}
				return false
			},
		})
		const rootSignerRequests: string[] = []
		const mappedSignerRequests: string[] = []
		const mappedSigner = {
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				mappedSignerRequests.push(method)
				if (method === 'eth_chainId') return '0x2'
				if (method === 'eth_requestAccounts') throw { code: 4001, message: 'Wallet provider rejected internally.' }
				throw new Error(`Unexpected mapped signer request: ${ method }`)
			},
			on: () => mappedSigner,
			removeListener: () => mappedSigner,
		}
		const rootSigner = {
			isMetaMask: true,
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				rootSignerRequests.push(method)
				if (method === 'eth_chainId') return '0x2'
				if (method === 'eth_requestAccounts') return ['0x1111111111111111111111111111111111111111']
				throw new Error(`Unexpected root signer request: ${ method }`)
			},
			on: () => rootSigner,
			removeListener: () => rootSigner,
		}
		;(fakeWindow as { ethereum: typeof rootSigner & { providerMap: Map<string, typeof mappedSigner> } }).ethereum = {
			...rootSigner,
			providerMap: new Map([['CoinbaseWallet', mappedSigner]]),
		}
		;(globalThis as unknown as { window: typeof fakeWindow }).window = fakeWindow
		if (typeof (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent !== 'function') {
			;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = class CustomEvent<T = unknown> extends Event {
				public detail: T
				constructor(type: string, init?: CustomEventInit<T>) {
					super(type, init)
					this.detail = init?.detail as T
				}
				public initCustomEvent(): void { return undefined }
			}
		}

		try {
			await import('../../app/inpage/ts/inpage.js?provider-map-eth-requestaccounts-fallback-4001-message')
			await waitFor(() => signerName !== undefined)
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'request_signer_to_eth_requestAccounts',
				result: [],
			})
			await waitFor(() => backgroundEthAccountsReplies.length === 1)
			assert.deepEqual(signerName, 'CoinbaseWallet')
			assert.deepEqual(mappedSignerRequests, ['eth_chainId', 'eth_requestAccounts'])
			assert.deepEqual(rootSignerRequests, [])
			assert.equal((backgroundEthAccountsReplies[0] as { requestAccounts: boolean }).requestAccounts, true)
			assert.equal((backgroundEthAccountsReplies[0] as { error: { code: number, message: string } }).error.code, 4001)
			assert.equal((backgroundEthAccountsReplies[0] as { error: { code: number, message: string } }).error.message, 'Wallet provider rejected internally.')
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

	test('falls back to the root provider when mapped CoinbaseWallet eth_requestAccounts fails with a non-user-rejected error', async () => {
		const previousWindow = (globalThis as { window?: unknown }).window
		const previousCustomEvent = (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
		let signerName: string | undefined
		const {
			fakeWindow,
			backgroundEthAccountsReplies,
			interceptorErrorPayloads,
			sendBackgroundMessage,
		} = createFakeWindow({
			handleRequest: (request, sendBackgroundMessageInternal) => {
				if (request.method === 'connected_to_signer') {
					signerName = request.params?.[1] as string
					sendBackgroundMessageInternal({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'result',
						method: 'connected_to_signer',
						result: { metamaskCompatibilityMode: true, activeAddress: '0x1111111111111111111111111111111111111111' },
					})
					return true
				}
				return false
			},
		})
		const rootSignerRequests: string[] = []
		const mappedSignerRequests: string[] = []
		const mappedSigner = {
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				mappedSignerRequests.push(method)
				if (method === 'eth_chainId') return '0x2'
				if (method === 'eth_requestAccounts') throw { code: 4100, message: 'Unknown account requested.' }
				throw new Error(`Unexpected mapped signer request: ${ method }`)
			},
			on: () => mappedSigner,
			removeListener: () => mappedSigner,
		}
		const rootSigner = {
			isMetaMask: true,
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				rootSignerRequests.push(method)
				if (method === 'eth_chainId') return '0x2'
				if (method === 'eth_requestAccounts') return ['0x1111111111111111111111111111111111111111']
				throw new Error(`Unexpected root signer request: ${ method }`)
			},
			on: () => rootSigner,
			removeListener: () => rootSigner,
		}
		;(fakeWindow as { ethereum: typeof rootSigner & { providerMap: Map<string, typeof mappedSigner> } }).ethereum = {
			...rootSigner,
			providerMap: new Map([['CoinbaseWallet', mappedSigner]]),
		}
		;(globalThis as unknown as { window: typeof fakeWindow }).window = fakeWindow
		if (typeof (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent !== 'function') {
			;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = class CustomEvent<T = unknown> extends Event {
				public detail: T
				constructor(type: string, init?: CustomEventInit<T>) {
					super(type, init)
					this.detail = init?.detail as T
				}
				public initCustomEvent(): void { return undefined }
			}
		}

		try {
			await import('../../app/inpage/ts/inpage.js?provider-map-eth-requestaccounts-fallback')
			await waitFor(() => signerName !== undefined)
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'request_signer_to_eth_requestAccounts',
				result: [],
			})
			await waitFor(() => backgroundEthAccountsReplies.length === 1)
			assert.deepEqual(signerName, 'CoinbaseWallet')
			assert.deepEqual(mappedSignerRequests, ['eth_chainId', 'eth_requestAccounts'])
			assert.deepEqual(rootSignerRequests, ['eth_requestAccounts'])
			assert.equal((backgroundEthAccountsReplies[0] as { requestAccounts: boolean }).requestAccounts, true)
			assert.equal(
				(Array.isArray((backgroundEthAccountsReplies[0] as { accounts: readonly string[] }).accounts) ? (backgroundEthAccountsReplies[0] as { accounts: readonly string[] }).accounts[0] : undefined),
				'0x1111111111111111111111111111111111111111',
			)
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

	test('uses actual signer flags when providerMap has no CoinbaseWallet entry', async () => {
		const previousWindow = (globalThis as { window?: unknown }).window
		const previousCustomEvent = (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
		let signerName: string | undefined
		const { fakeWindow } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessage) => {
				if (request.method === 'connected_to_signer') {
					signerName = request.params?.[1] as string
					sendBackgroundMessage({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'result',
						method: 'connected_to_signer',
						result: { metamaskCompatibilityMode: true, activeAddress: '0x1111111111111111111111111111111111111111' },
					})
					return true
				}
				return false
			},
		})
		const fakePrimarySigner = {
			isMetaMask: true,
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				if (method === 'eth_chainId') return '0x1'
				throw new Error(`Unexpected signer request: ${ method }`)
			},
			on: () => fakePrimarySigner,
			removeListener: () => fakePrimarySigner,
		}
		;(fakeWindow as { ethereum: typeof fakePrimarySigner & { providerMap: Map<string, Record<string, unknown>> } }).ethereum = {
			...fakePrimarySigner,
			providerMap: new Map([['OtherWallet', { request: async () => ['0x'] }]]),
		}
		;(globalThis as unknown as { window: typeof fakeWindow }).window = fakeWindow
		if (typeof (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent !== 'function') {
			;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = class CustomEvent<T = unknown> extends Event {
				public detail: T
				constructor(type: string, init?: CustomEventInit<T>) {
					super(type)
					this.detail = init?.detail as T
				}
				public initCustomEvent(): void { return undefined }
			}
		}

		try {
			await import('../../app/inpage/ts/inpage.js?provider-map-no-coinbase')
			await waitFor(() => signerName !== undefined)
			assert.equal(signerName, 'MetaMask')
		} finally {
			;(globalThis as { window?: unknown }).window = previousWindow
			if (previousCustomEvent === undefined) {
				delete (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
			} else {
				;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = previousCustomEvent
			}
		}
	})

	test('uses mapped provider events in providerMap branch', async () => {
		const previousWindow = (globalThis as { window?: unknown }).window
		const previousCustomEvent = (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
		const signerEvents: {
			connect?: (connectInfo: { chainId: string }) => void,
			disconnect?: (error: { code: number, message: string }) => void,
			chainChanged?: (chainId: string) => void,
			accountsChanged?: (accounts: readonly string[]) => void,
		} = {}
		const mappedOnKinds: string[] = []
		const rootOnKinds: string[] = []
		const backgroundMessages: { method: string, params?: readonly unknown[] }[] = []
		const { fakeWindow } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessage) => {
				backgroundMessages.push({ method: request.method, ...(request.params === undefined ? {} : { params: request.params }) })
				if (request.method === 'connected_to_signer') {
					sendBackgroundMessage({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'result',
						method: 'connected_to_signer',
						result: { metamaskCompatibilityMode: true, activeAddress: '0x1111111111111111111111111111111111111111' },
					})
					return true
				}
				if (request.method === 'eth_accounts_reply') {
					sendBackgroundMessage({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'result',
						method: request.method,
						result: undefined,
					})
					return true
				}
				if (request.method === 'signer_chainChanged') {
					sendBackgroundMessage({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'result',
						method: request.method,
						result: '0x',
					})
					return true
				}
				return false
			},
		})
		const mappedSigner = {
			isCoinbaseWallet: true,
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				if (method === 'eth_chainId') return '0x1'
				throw new Error(`Unexpected mapped signer request: ${ method }`)
			},
			on: (kind: string, callback: (...args: never[]) => void) => {
				mappedOnKinds.push(kind)
				if (kind === 'connect') signerEvents.connect = callback as (connectInfo: { chainId: string }) => void
				else if (kind === 'disconnect') signerEvents.disconnect = callback as (error: { code: number, message: string }) => void
				if (kind === 'accountsChanged') signerEvents.accountsChanged = callback as (accounts: readonly string[]) => void
				else if (kind === 'chainChanged') signerEvents.chainChanged = callback as (chainId: string) => void
				return mappedSigner
			},
			removeListener: () => mappedSigner,
		}
		const rootSigner = {
			isBraveWallet: true,
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				if (method === 'eth_chainId') return '0x2'
				throw new Error(`Unexpected root signer request: ${ method }`)
			},
			on: (kind: string) => {
				rootOnKinds.push(kind)
				return rootSigner
			},
			removeListener: () => rootSigner,
		}
		;(fakeWindow as { ethereum: typeof rootSigner & { providerMap: Map<string, typeof mappedSigner> } }).ethereum = {
			...rootSigner,
			providerMap: new Map([['CoinbaseWallet', mappedSigner]]),
		}
		;(globalThis as unknown as { window: typeof fakeWindow }).window = fakeWindow
		if (typeof (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent !== 'function') {
			;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = class CustomEvent<T = unknown> extends Event {
				public detail: T
				constructor(type: string, init?: CustomEventInit<T>) {
					super(type)
					this.detail = init?.detail as T
				}
				public initCustomEvent(): void { return undefined }
			}
		}

		try {
			await import(`../../app/inpage/ts/inpage.js?provider-map-events-${Date.now()}-${Math.random()}`)
			await waitFor(() => mappedOnKinds.length + rootOnKinds.length >= 4)
			assert.equal(mappedOnKinds.length >= 4, true)
			assert.equal(rootOnKinds.length, 0)
			assert.equal(signerEvents.accountsChanged !== undefined, true)
			await waitFor(() => signerEvents.chainChanged !== undefined)
			await waitFor(() => signerEvents.connect !== undefined)
			await waitFor(() => signerEvents.disconnect !== undefined)
			assert.equal(mappedOnKinds.includes('accountsChanged'), true)
				assert.equal(mappedOnKinds.includes('connect'), true)
				assert.equal(mappedOnKinds.includes('disconnect'), true)
				assert.equal(mappedOnKinds.includes('chainChanged'), true)
				signerEvents.connect!({ chainId: '0x99' })
				await waitFor(() => backgroundMessages.filter((message) => message.method === 'connected_to_signer' && message.params?.[0] === true && message.params?.[1] === 'CoinbaseWallet').length >= 1)
				signerEvents.disconnect!({ code: 4900, message: 'error' })
				await waitFor(() => backgroundMessages.filter((message) => message.method === 'connected_to_signer' && message.params?.[0] === false && message.params?.[1] === 'CoinbaseWallet').length >= 1)
				assert.equal(backgroundMessages.filter((message) => message.method === 'connected_to_signer' && message.params?.[0] === true && message.params?.[1] === 'CoinbaseWallet').length >= 1, true)
				assert.equal(backgroundMessages.filter((message) => message.method === 'connected_to_signer' && message.params?.[0] === false && message.params?.[1] === 'CoinbaseWallet').length >= 1, true)
				signerEvents.accountsChanged(['0x1111111111111111111111111111111111111111'])
				assert.equal(typeof signerEvents.accountsChanged, 'function')
				assert.equal(typeof signerEvents.chainChanged, 'function')
				assert.equal(signerEvents.chainChanged !== undefined, true)
				assert.equal(signerEvents.accountsChanged !== undefined, true)
				await waitFor(() => backgroundMessages.some((message) => message.method === 'eth_accounts_reply' && (message.params?.[0] as { requestAccounts: boolean } | undefined)?.requestAccounts === false))
				signerEvents.chainChanged('0x2a')
				await waitFor(() => backgroundMessages.some((message) => message.method === 'signer_chainChanged' && message.params?.[0] === '0x2a'))
		} finally {
			;(globalThis as { window?: unknown }).window = previousWindow
			if (previousCustomEvent === undefined) {
				delete (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
			} else {
				;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = previousCustomEvent
			}
		}
	})

	test('preserves string JSON-RPC error data from background replies', async () => {
		const previousWindow = (globalThis as { window?: unknown }).window
		const previousCustomEvent = (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
		const revertData = '0x08c379a0'
		const { fakeWindow, signerRequests } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessage) => {
				if (request.method !== 'eth_call') return false
				sendBackgroundMessage({
					interceptorApproved: true,
					requestId: request.requestId,
					type: 'result',
					method: 'eth_call',
					error: {
						code: -32000,
						message: 'execution reverted',
						data: revertData,
					},
				})
				return true
			},
		})
		;(globalThis as unknown as { window: typeof fakeWindow }).window = fakeWindow
		if (typeof (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent !== 'function') {
			;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = class CustomEvent<T = unknown> extends Event {
				public detail: T
				constructor(type: string, init?: CustomEventInit<T>) {
					super(type)
					this.detail = init?.detail as T
				}
				public initCustomEvent(): void { return undefined }
			}
		}

		try {
			await import('../../app/inpage/ts/inpage.js?json-rpc-error-data')
			await waitFor(() => signerRequests.length >= 1)
			const provider = fakeWindow.ethereum as {
				request: (payload: { method: string, params?: readonly unknown[] }) => Promise<unknown>
			}
			await assert.rejects(
				provider.request({ method: 'eth_call', params: [] }),
				(error: unknown) => {
					if (!isRecord(error)) return false
					assert.equal(error.code, -32000)
					assert.equal(error.message, 'execution reverted')
					assert.equal(error.data, revertData)
					return true
				},
			)
		} finally {
			;(globalThis as { window?: unknown }).window = previousWindow
			if (previousCustomEvent === undefined) {
				delete (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
			} else {
				;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = previousCustomEvent
			}
		}
	})

	test('preserves string JSON-RPC error data from signer replies', async () => {
		const previousWindow = (globalThis as { window?: unknown }).window
		const previousCustomEvent = (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
		const revertData = '0x08c379a0'
		const { fakeWindow, signerRequests } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessage) => {
				if (request.method !== 'eth_call') return false
				sendBackgroundMessage({
					interceptorApproved: true,
					requestId: request.requestId,
					type: 'forwardToSigner',
					method: 'eth_call',
					params: request.params,
					replyWithSignersReply: true,
				})
				return true
			},
			handleSignerRequest: ({ method }) => {
				if (method !== 'eth_call') return undefined
				throw { code: -32000, message: 'execution reverted', data: revertData }
			},
		})
		;(globalThis as unknown as { window: typeof fakeWindow }).window = fakeWindow
		if (typeof (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent !== 'function') {
			;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = class CustomEvent<T = unknown> extends Event {
				public detail: T
				constructor(type: string, init?: CustomEventInit<T>) {
					super(type)
					this.detail = init?.detail as T
				}
				public initCustomEvent(): void { return undefined }
			}
		}

		try {
			await import('../../app/inpage/ts/inpage.js?signer-json-rpc-error-data')
			await waitFor(() => signerRequests.length >= 1)
			const provider = fakeWindow.ethereum as {
				request: (payload: { method: string, params?: readonly unknown[] }) => Promise<unknown>
			}
			await assert.rejects(
				provider.request({ method: 'eth_call', params: [] }),
				(error: unknown) => {
					if (!isRecord(error)) return false
					assert.equal(error.code, -32000)
					assert.equal(error.message, 'execution reverted')
					assert.equal(error.data, revertData)
					return true
				},
			)
		} finally {
			;(globalThis as { window?: unknown }).window = previousWindow
			if (previousCustomEvent === undefined) {
				delete (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
			} else {
				;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = previousCustomEvent
			}
		}
	})

	test('reports signer chain id failures without defaulting to mainnet', async () => {
		const previousWindow = (globalThis as { window?: unknown }).window
		const previousCustomEvent = (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
		const previousConsoleError = console.error
		const {
			fakeWindow,
			signerRequests,
			backgroundSignerChainChanges,
			interceptorErrorPayloads,
		} = createFakeWindow({ signerChainIdReply: new Error('chain id unavailable') })
		const consoleErrors: unknown[] = []
		console.error = (...args: unknown[]) => { consoleErrors.push(args) }
		;(globalThis as unknown as { window: typeof fakeWindow }).window = fakeWindow
		if (typeof (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent !== 'function') {
			;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = class CustomEvent<T = unknown> extends Event {
				public detail: T
				constructor(type: string, init?: CustomEventInit<T>) {
					super(type)
					this.detail = init?.detail as T
				}
				public initCustomEvent(): void { return undefined }
			}
		}

		try {
			await import('../../app/inpage/ts/inpage.js?signer-chain-id-error')
			await waitFor(() => interceptorErrorPayloads.length === 1)

			assert.deepEqual(signerRequests, ['eth_chainId'])
			assert.deepEqual(backgroundSignerChainChanges, [])
			assert.equal(String(interceptorErrorPayloads[0]).includes('inpage: chain id unavailable'), true)
			assert.equal(String(interceptorErrorPayloads[0]).includes('requestMethod: eth_chainId'), true)
			assert.equal(consoleErrors.length > 0, true)
		} finally {
			console.error = previousConsoleError
			;(globalThis as { window?: unknown }).window = previousWindow
			if (previousCustomEvent === undefined) {
				delete (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
			} else {
				;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = previousCustomEvent
			}
		}
	})

	test('skips readonly compatibility properties without warning', async () => {
		const previousWindow = (globalThis as { window?: unknown }).window
		const previousCustomEvent = (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
		const previousWarn = console.warn
		const { fakeWindow } = createFakeWindow()
		const warnings: unknown[] = []
		fakeWindow.ethereum = createLockedCompatibilitySigner()
		console.warn = (...args: unknown[]) => { warnings.push(args) }
		;(globalThis as unknown as { window: typeof fakeWindow }).window = fakeWindow
		if (typeof (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent !== 'function') {
			;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = class CustomEvent<T = unknown> extends Event {
				public detail: T
				constructor(type: string, init?: CustomEventInit<T>) {
					super(type)
					this.detail = init?.detail as T
				}
				public initCustomEvent(): void { return undefined }
			}
		}

		try {
			await import('../../app/inpage/ts/inpage.js?locked-compatibility')
			await waitFor(() => 'isInterceptor' in (fakeWindow.ethereum as Record<string, unknown>))
			assert.equal((fakeWindow.ethereum as { selectedAddress?: unknown }).selectedAddress, undefined)
			assert.deepEqual(warnings, [])
		} finally {
			console.warn = previousWarn
			;(globalThis as { window?: unknown }).window = previousWindow
			if (previousCustomEvent === undefined) {
				delete (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
			} else {
				;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = previousCustomEvent
			}
		}
	})

	test('updates configurable getter-only compatibility properties without throwing', async () => {
		const previousWindow = (globalThis as { window?: unknown }).window
		const previousCustomEvent = (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
		const previousWarn = console.warn
		const { fakeWindow } = createFakeWindow()
		const warnings: unknown[] = []
		fakeWindow.ethereum = createConfigurableGetterOnlyCompatibilitySigner()
		console.warn = (...args: unknown[]) => { warnings.push(args) }
		;(globalThis as unknown as { window: typeof fakeWindow }).window = fakeWindow
		if (typeof (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent !== 'function') {
			;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = class CustomEvent<T = unknown> extends Event {
				public detail: T
				constructor(type: string, init?: CustomEventInit<T>) {
					super(type)
					this.detail = init?.detail as T
				}
				public initCustomEvent(): void { return undefined }
			}
		}

		try {
			await import('../../app/inpage/ts/inpage.js?configurable-getter-compatibility')
			await waitFor(() => (fakeWindow.ethereum as { selectedAddress?: unknown }).selectedAddress === '0x1111111111111111111111111111111111111111')
			assert.deepEqual((fakeWindow.ethereum as { selectedAddress?: unknown }).selectedAddress, '0x1111111111111111111111111111111111111111')
			assert.deepEqual(warnings, [])
		} finally {
			console.warn = previousWarn
			;(globalThis as { window?: unknown }).window = previousWindow
			if (previousCustomEvent === undefined) {
				delete (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
			} else {
				;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = previousCustomEvent
			}
		}
	})

	test('warns when compatibility assignments cannot be made on non-extensible targets', async () => {
		const previousWindow = (globalThis as { window?: unknown }).window
		const previousCustomEvent = (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
		const previousWarn = console.warn
		let fakeWindowWithSigner: { ethereum: { isMetamask?: boolean, [key: string]: unknown } } | undefined
		const { fakeWindow } = createFakeWindow({
			onConnectedToSignerRequest: () => {
				if (fakeWindowWithSigner === undefined) return
				fakeWindowWithSigner.ethereum.isMetamask = true
				Object.preventExtensions(fakeWindowWithSigner.ethereum)
			},
		})
		fakeWindowWithSigner = fakeWindow
		const warnings: string[] = []
		console.warn = (...args: unknown[]) => { warnings.push(String(args[0])) }
		;(globalThis as unknown as { window: typeof fakeWindow }).window = fakeWindow
		if (typeof (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent !== 'function') {
			;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = class CustomEvent<T = unknown> extends Event {
				public detail: T
				constructor(type: string, init?: CustomEventInit<T>) {
					super(type)
					this.detail = init?.detail as T
				}
				public initCustomEvent(): void { return undefined }
			}
		}

		try {
			await import('../../app/inpage/ts/inpage.js?non-extensible-compatibility')
			await waitFor(() => warnings.length > 0)
			assert.ok(warnings.some((warning) => warning.includes('compatibility assignment was rejected for window.ethereum.selectedAddress')))
		} finally {
			console.warn = previousWarn
			;(globalThis as { window?: unknown }).window = previousWindow
			if (previousCustomEvent === undefined) {
				delete (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
			} else {
				;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = previousCustomEvent
			}
		}
	})
})
