import * as assert from 'assert'
import { describe, test } from 'bun:test'

type WindowEvent = { type: string, data?: unknown, detail?: unknown, ports?: readonly MessagePort[] }
type Listener = (event: WindowEvent) => void
type InpageRequest = { readonly method: string, readonly requestId: number, readonly params?: readonly unknown[], readonly internal?: true, readonly replayOnDisconnect?: true }
type FakeWindowOptions = {
	readonly onConnectedToSignerRequest?: () => void
	readonly handleRequest?: (request: InpageRequest, sendBackgroundMessage: (data: unknown) => void) => boolean
	readonly handleSignerRequest?: (request: { readonly method: string, readonly params?: readonly unknown[] }) => unknown | Promise<unknown>
	readonly signerChainIdReply?: unknown
	readonly signerInitialSelectedAddress?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

function parseInpageRequest(value: unknown): InpageRequest | undefined {
	if (!isRecord(value)) return undefined
	if (value.type !== 'interceptor_bridge_request') return undefined
	if (typeof value.method !== 'string') return undefined
	if (typeof value.requestId !== 'number') return undefined
	if (typeof value.usingInterceptorWithoutSigner !== 'boolean') return undefined
	if (value.internal !== undefined && value.internal !== true) return undefined
	if (value.replayOnDisconnect !== undefined && value.replayOnDisconnect !== true) return undefined
	return {
		method: value.method,
		requestId: value.requestId,
		...(Array.isArray(value.params) ? { params: value.params } : {}),
		...(value.internal === true ? { internal: true as const } : {}),
		...(value.replayOnDisconnect === true ? { replayOnDisconnect: true as const } : {}),
	}
}

function createFakeWindow({ onConnectedToSignerRequest, handleRequest, handleSignerRequest, signerChainIdReply = '0x1', signerInitialSelectedAddress }: FakeWindowOptions = {}) {
	const listeners = new Map<string, Set<Listener>>()
	const signerRequests: string[] = []
	const backgroundEthAccountsReplies: unknown[] = []
	const backgroundSignerChainChanges: unknown[] = []
	const interceptorErrorPayloads: unknown[] = []
	const signerAccounts = ['0x1111111111111111111111111111111111111111']
	const signerEventHandlers = new Map<string, Set<(value: unknown) => void>>()
	let blockRequestAccounts = false
	let rejectPendingRequestAccounts: ((error: { code: number, message: string }) => void) | undefined
	let resolvePendingRequestAccounts: ((accounts: string[]) => void) | undefined
	let bridgePort: MessagePort | undefined

	const fakeSigner = {
		...(signerInitialSelectedAddress === undefined ? {} : { selectedAddress: signerInitialSelectedAddress }),
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
						return await new Promise<string[]>((resolve, reject) => {
							resolvePendingRequestAccounts = resolve
							rejectPendingRequestAccounts = reject
						})
					}
					return signerAccounts
				default:
					throw new Error(`Unexpected signer request: ${ method }`)
			}
		},
		on: (kind: string, callback: (value: unknown) => void) => {
			const existing = signerEventHandlers.get(kind)
			if (existing === undefined) {
				signerEventHandlers.set(kind, new Set([callback]))
				return fakeSigner
			}
			existing.add(callback)
			return fakeSigner
		},
		removeListener: (kind: string, callback: (value: unknown) => void) => {
			signerEventHandlers.get(kind)?.delete(callback)
			return fakeSigner
		},
	}

	const fakeWindow = {
		ethereum: fakeSigner,
		...(signerInitialSelectedAddress === undefined ? {} : { web3: { accounts: [signerInitialSelectedAddress], currentProvider: fakeSigner } }),
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
						result: { metamaskCompatibilityMode: true },
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
		resolvePendingRequestAccounts: (accounts: string[]) => resolvePendingRequestAccounts?.(accounts),
		rejectPendingRequestAccounts: (error: { code: number, message: string }) => rejectPendingRequestAccounts?.(error),
		emitSignerEvent: (kind: string, value: unknown) => {
			for (const callback of signerEventHandlers.get(kind) ?? []) callback(value)
		},
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

function createThrowingMetaMaskProviderProperty(property: 'isMetaMask' | 'request' | 'on' | 'isBraveWallet') {
	const provider = {
		isMetaMask: true,
		isConnected: () => true,
		request: async () => undefined,
		on: () => provider,
	}
	Object.defineProperty(provider, property, {
		configurable: true,
		get: () => { throw new Error(`Invalid ${ property } getter`) },
	})
	return provider
}

async function waitFor(condition: () => boolean, timeoutMs = 2000) {
	const start = Date.now()
	while (!condition()) {
		if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition')
		await new Promise((resolve) => setTimeout(resolve, 0))
	}
}

async function withFakeInpageWindow<T>(fakeWindow: ReturnType<typeof createFakeWindow>['fakeWindow'], importPath: string, runTest: () => Promise<T>) {
	const previousWindow = (globalThis as { window?: unknown }).window
	const previousCustomEvent = (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
	;(globalThis as unknown as { window: typeof fakeWindow }).window = fakeWindow
	if (typeof (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent !== 'function') {
		;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = class CustomEvent<TDetail = unknown> extends Event {
			public detail: TDetail
			constructor(type: string, init?: CustomEventInit<TDetail>) {
				super(type)
				this.detail = init?.detail as TDetail
			}
			public initCustomEvent(): void { return undefined }
		}
	}
	try {
		await import(importPath)
		return await runTest()
	} finally {
		;(globalThis as { window?: unknown }).window = previousWindow
		if (previousCustomEvent === undefined) {
			delete (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
		} else {
			;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = previousCustomEvent
		}
	}
}

describe('inpage signer bridge', () => {
	test('annotates only public eth_requestAccounts requests for replay after disconnect', async () => {
		const bridgeRequests: InpageRequest[] = []
		const account = '0x1111111111111111111111111111111111111111'
		const transactionHash = '0x1111111111111111111111111111111111111111111111111111111111111111'
		const { fakeWindow } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessageForRequest) => {
				bridgeRequests.push(request)
				if (request.method === 'eth_requestAccounts') {
					sendBackgroundMessageForRequest({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'result',
						method: 'eth_accounts',
						result: [account],
					})
					return true
				}
				if (request.method === 'eth_sendTransaction') {
					sendBackgroundMessageForRequest({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'result',
						method: request.method,
						result: transactionHash,
					})
					return true
				}
				return false
			},
		})

		await withFakeInpageWindow(fakeWindow, '../../app/inpage/ts/inpage.js?bridge-replay-annotation', async () => {
			const provider = fakeWindow.ethereum as { request: (payload: { method: string, params?: readonly unknown[] }) => Promise<unknown> }
			assert.deepEqual(await provider.request({ method: 'eth_requestAccounts' }), [account])
			assert.equal(await provider.request({ method: 'eth_sendTransaction', params: [{ from: account }] }), transactionHash)
		})

		const accountRequest = bridgeRequests.find((request) => request.method === 'eth_requestAccounts')
		const transactionRequest = bridgeRequests.find((request) => request.method === 'eth_sendTransaction')
		assert.equal(accountRequest?.replayOnDisconnect, true)
		assert.equal(transactionRequest?.replayOnDisconnect, undefined)
		assert.equal(bridgeRequests.filter((request) => request.internal === true).every((request) => request.replayOnDisconnect === undefined), true)
	})

	test('settles the first account request and keeps signing when MetaMask initializes after Interceptor', async () => {
		const signerAccountReplies: unknown[] = []
		const connectedSignerNames: unknown[] = []
		const signerRequestMethods: string[] = []
		const signedTransactionHash = '0x2222222222222222222222222222222222222222222222222222222222222222'
		let pendingAccountRequest: InpageRequest | undefined
		const { fakeWindow, signerAccounts, sendBackgroundMessage } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessageForRequest) => {
				if (request.method === 'connected_to_signer') {
					connectedSignerNames.push(request.params?.[1])
					return false
				}
				if (request.method === 'eth_requestAccounts' && request.internal !== true) {
					pendingAccountRequest = request
					return true
				}
				if (request.method === 'eth_accounts_reply') {
					const signerAccountsReply = request.params?.[0]
					if (!isRecord(signerAccountsReply)) throw new Error('Malformed signer accounts reply')
					signerAccountReplies.push(signerAccountsReply)
					sendBackgroundMessageForRequest({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'result',
						method: 'eth_accounts_reply',
						result: undefined,
					})
					const accountRequest = pendingAccountRequest
					if (signerAccountsReply.type !== 'success' || !Array.isArray(signerAccountsReply.accounts) || accountRequest === undefined) return true
					pendingAccountRequest = undefined
					sendBackgroundMessageForRequest({
						interceptorApproved: true,
						requestId: accountRequest.requestId,
						type: 'result',
						method: 'eth_accounts',
						result: signerAccountsReply.accounts,
					})
					return true
				}
				if (request.method === 'eth_sendTransaction') {
					sendBackgroundMessageForRequest({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'forwardToSigner',
						method: request.method,
						params: request.params,
					})
					return true
				}
				if (request.method !== 'signer_reply') return false
				const signerReply = request.params?.[0]
				if (!isRecord(signerReply) || !isRecord(signerReply.forwardRequest) || typeof signerReply.forwardRequest.requestId !== 'number') throw new Error('Malformed signer reply')
				sendBackgroundMessageForRequest({
					interceptorApproved: true,
					requestId: signerReply.forwardRequest.requestId,
					type: 'result',
					method: 'eth_sendTransaction',
					result: signerReply.reply,
				})
				sendBackgroundMessageForRequest({
					interceptorApproved: true,
					requestId: request.requestId,
					type: 'result',
					method: 'signer_reply',
					result: '0x',
				})
				return true
			},
			handleSignerRequest: ({ method }) => {
				signerRequestMethods.push(method)
				if (method === 'eth_sendTransaction') return signedTransactionHash
				return undefined
			},
		})
		const lateMetaMaskProvider = fakeWindow.ethereum
		Reflect.deleteProperty(fakeWindow, 'ethereum')

		await withFakeInpageWindow(fakeWindow, '../../app/inpage/ts/inpage.js?late-metamask-first-connect-and-signing', async () => {
			const interceptorProvider = fakeWindow.ethereum
			const accountRequest = interceptorProvider.request({ method: 'eth_requestAccounts' })
			await waitFor(() => pendingAccountRequest !== undefined)
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'request_signer_to_eth_requestAccounts',
				result: [],
			})
			await new Promise((resolve) => setTimeout(resolve, 0))

			fakeWindow.addEventListener('eip6963:requestProvider', () => fakeWindow.dispatchEvent({
				type: 'eip6963:announceProvider',
				detail: {
					info: { uuid: '55555555-5555-4555-8555-555555555555', name: 'MetaMask', icon: 'data:image/svg+xml,<svg/>', rdns: 'io.metamask' },
					provider: lateMetaMaskProvider,
				},
			}))
			fakeWindow.dispatchEvent({ type: 'ethereum#initialized' })

			await waitFor(() => signerAccountReplies.length === 1, 500)
			assert.deepEqual(signerAccountReplies, [{ type: 'success', accounts: signerAccounts, requestAccounts: true }])
			assert.deepEqual(await accountRequest, signerAccounts)
			assert.equal(await interceptorProvider.request({ method: 'eth_sendTransaction', params: [{ from: signerAccounts[0] }] }), signedTransactionHash)
		})

		assert.deepEqual(connectedSignerNames, ['NoSigner', 'MetaMask'])
		assert.equal(signerRequestMethods.includes('eth_requestAccounts'), true)
		assert.equal(signerRequestMethods.includes('eth_sendTransaction'), true)
	})

	test('settles signer account discovery when no signer initializes', async () => {
		const { fakeWindow, backgroundEthAccountsReplies, sendBackgroundMessage } = createFakeWindow()
		Reflect.deleteProperty(fakeWindow, 'ethereum')

		await withFakeInpageWindow(fakeWindow, '../../app/inpage/ts/inpage.js?unavailable-signer-account-reply', async () => {
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'request_signer_to_eth_requestAccounts',
				result: [],
			})
			await waitFor(() => backgroundEthAccountsReplies.length === 1, 3500)
		})

		assert.deepEqual(backgroundEthAccountsReplies, [{
			type: 'error',
			requestAccounts: true,
			error: { code: 4900, message: 'No signer wallet became available for this page.' },
		}])
	})

	test('ignores replayed terminal replies after the original request settles', async () => {
		let capturedRequest: InpageRequest | undefined
		const { fakeWindow, interceptorErrorPayloads, sendBackgroundMessage } = createFakeWindow({
			handleRequest: (request) => {
				if (request.method !== 'eth_sendTransaction') return false
				capturedRequest = request
				return true
			},
		})

		await withFakeInpageWindow(fakeWindow, '../../app/inpage/ts/inpage.js?terminal-reply-replay', async () => {
			const provider = fakeWindow.ethereum as { request: (payload: { method: string, params?: readonly unknown[] }) => Promise<unknown> }
			const requestPromise = provider.request({ method: 'eth_sendTransaction', params: [{ from: '0x1111111111111111111111111111111111111111' }] })
			await waitFor(() => capturedRequest !== undefined)
			const request = capturedRequest
			if (request === undefined) throw new Error('request was not captured')
			const rejection = {
				interceptorApproved: true,
				requestId: request.requestId,
				type: 'result',
				method: request.method,
				error: { code: 4001, message: 'User denied transaction signature' },
			}
			sendBackgroundMessage(rejection)
			await assert.rejects(async () => await requestPromise, (error: unknown) => isRecord(error) && error.code === 4001)

			sendBackgroundMessage(rejection)
			await new Promise((resolve) => setTimeout(resolve, 0))
			assert.deepEqual(interceptorErrorPayloads, [])
		})
	})

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
			assert.deepEqual(provider.send({ id: 77, method: 'eth_coinbase', params: [] }), { jsonrpc: '2.0', id: 77, result: null })
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

	test('keeps standalone eth_accounts replies free of console warnings', async () => {
		const signerAccount = '0x1111111111111111111111111111111111111111'
		const warnings: unknown[][] = []
		const previousWarn = console.warn
		console.warn = (...args: unknown[]) => { warnings.push(args) }
		const { fakeWindow } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessageForRequest) => {
				if (request.method !== 'eth_accounts') return false
				sendBackgroundMessageForRequest({
					interceptorApproved: true,
					requestId: request.requestId,
					type: 'result',
					method: 'eth_accounts',
					result: [signerAccount],
				})
				return true
			},
		})

		try {
			await withFakeInpageWindow(fakeWindow, '../../app/inpage/ts/inpage.js?standalone-eth-accounts-no-warnings', async () => {
				const provider = fakeWindow.ethereum as {
					request: (payload: { method: string, params?: readonly unknown[] }) => Promise<unknown>
				}
				assert.deepEqual(await provider.request({ method: 'eth_accounts' }), [signerAccount])
			})
			assert.equal(warnings.length, 0)
		} finally {
			console.warn = previousWarn
		}
	})

	test('uses a concrete MetaMask provider from an unmarked legacy aggregate for signing', async () => {
		const concreteSignerRequests: string[] = []
		const aggregateSignerRequests: string[] = []
		const signedTransactionHash = '0x2222222222222222222222222222222222222222222222222222222222222222'
		const { fakeWindow } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessageForRequest) => {
				if (request.method === 'eth_sendTransaction') {
					sendBackgroundMessageForRequest({ interceptorApproved: true, requestId: request.requestId, type: 'forwardToSigner', method: request.method, params: request.params })
					return true
				}
				if (request.method !== 'signer_reply') return false
				const signerReply = request.params?.[0]
				if (!isRecord(signerReply) || !isRecord(signerReply.forwardRequest) || typeof signerReply.forwardRequest.requestId !== 'number') throw new Error('Malformed signer reply')
				sendBackgroundMessageForRequest({ interceptorApproved: true, requestId: signerReply.forwardRequest.requestId, type: 'result', method: 'eth_sendTransaction', result: signerReply.reply })
				sendBackgroundMessageForRequest({ interceptorApproved: true, requestId: request.requestId, type: 'result', method: 'signer_reply', result: '0x' })
				return true
			},
			handleSignerRequest: ({ method }) => {
				concreteSignerRequests.push(method)
				if (method === 'eth_sendTransaction') return signedTransactionHash
				return undefined
			},
		})
		const concreteMetaMaskProvider = fakeWindow.ethereum
		const invalidConnectedMetaMaskProvider = {
			isMetaMask: true,
			isConnected: true,
			request: async () => undefined,
			on: () => invalidConnectedMetaMaskProvider,
		}
		const throwingMetaMaskProvider = {
			isMetaMask: true,
			request: async () => undefined,
			on: () => { throw new Error('Invalid provider subscription') },
		}
		const throwingConnectedMetaMaskProvider = {
			isMetaMask: true,
			isConnected: () => { throw new Error('Invalid provider connection state') },
			request: async () => undefined,
			on: () => throwingConnectedMetaMaskProvider,
		}
		const conflictingMetaMaskProviders = [
			{ ...concreteMetaMaskProvider, isBraveWallet: true },
			{ ...concreteMetaMaskProvider, isCoinbaseWallet: true },
			{ ...concreteMetaMaskProvider, isInterceptor: true },
		]
		let statefulMetaMaskMarkerReads = 0
		const statefulMetaMaskProvider = { ...concreteMetaMaskProvider }
		Object.defineProperty(statefulMetaMaskProvider, 'isMetaMask', {
			get: () => {
				statefulMetaMaskMarkerReads++
				if (statefulMetaMaskMarkerReads > 3) throw new Error('MetaMask marker was read after preparation')
				return true
			},
		})
		const throwingGetterProviders = (['isMetaMask', 'request', 'on', 'isBraveWallet'] as const).map(createThrowingMetaMaskProviderProperty)
		const legacyProviders = [undefined, null, 1, ...throwingGetterProviders, invalidConnectedMetaMaskProvider, throwingConnectedMetaMaskProvider, throwingMetaMaskProvider, ...conflictingMetaMaskProviders, statefulMetaMaskProvider, concreteMetaMaskProvider]
		Object.defineProperty(legacyProviders, 0, { configurable: true, get: () => { throw new Error('Invalid legacy provider entry') } })
		const aggregateProvider = {
			providers: legacyProviders,
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				aggregateSignerRequests.push(method)
				if (method === 'eth_chainId') return '0x1'
				return await new Promise<never>(() => undefined)
			},
			on: () => aggregateProvider,
			removeListener: () => aggregateProvider,
		}
		for (const rootProperty of ['isBraveWallet', 'providerMap', 'isCoinbaseWallet'] as const) {
			Object.defineProperty(aggregateProvider, rootProperty, { get: () => { throw new Error(`Invalid aggregate ${ rootProperty }`) } })
		}
		Object.defineProperty(fakeWindow, 'ethereum', { configurable: true, writable: true, value: aggregateProvider })

		await withFakeInpageWindow(fakeWindow, '../../app/inpage/ts/inpage.js?legacy-unmarked-metamask-signing', async () => {
			const result = await fakeWindow.ethereum.request({ method: 'eth_sendTransaction', params: [{ from: '0x1111111111111111111111111111111111111111' }] })
			assert.equal(result, signedTransactionHash)
		})

		assert.equal(concreteSignerRequests.includes('eth_sendTransaction'), true)
		assert.equal(aggregateSignerRequests.includes('eth_sendTransaction'), false)
		assert.equal(statefulMetaMaskMarkerReads, 3)
	})

	test('uses an EIP-6963 announced MetaMask provider instead of Brave for signing', async () => {
		const concreteSignerRequests: string[] = []
		const aggregateSignerRequests: string[] = []
		const aggregateEventHandlers = new Map<string, (value: unknown) => void>()
		const ignoredProviderSubscriptions: string[] = []
		const announcedProviderSubscriptions: string[] = []
		const duplicateProviderSubscriptions: string[] = []
		const backgroundMessages: InpageRequest[] = []
		const signedTransactionHash = '0x1111111111111111111111111111111111111111111111111111111111111111'
		const { fakeWindow, emitSignerEvent } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessageForRequest) => {
				backgroundMessages.push(request)
				if (request.method === 'eth_sendTransaction') {
					sendBackgroundMessageForRequest({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'forwardToSigner',
						method: request.method,
						params: request.params,
					})
					return true
				}
				if (request.method !== 'signer_reply') return false
				const signerReply = request.params?.[0]
				if (!isRecord(signerReply) || !isRecord(signerReply.forwardRequest) || typeof signerReply.forwardRequest.requestId !== 'number') throw new Error('Malformed signer reply')
				sendBackgroundMessageForRequest({
					interceptorApproved: true,
					requestId: signerReply.forwardRequest.requestId,
					type: 'result',
					method: 'eth_sendTransaction',
					result: signerReply.reply,
				})
				sendBackgroundMessageForRequest({
					interceptorApproved: true,
					requestId: request.requestId,
					type: 'result',
					method: 'signer_reply',
					result: '0x',
				})
				return true
			},
			handleSignerRequest: ({ method }) => {
				concreteSignerRequests.push(method)
				if (method === 'eth_sendTransaction') return signedTransactionHash
				return undefined
			},
		})
		const concreteMetaMaskProvider = fakeWindow.ethereum
		const aggregateProvider = {
			isBraveWallet: true,
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				aggregateSignerRequests.push(method)
				if (method === 'eth_chainId') return '0x1'
				if (method === 'eth_accounts' || method === 'eth_requestAccounts') return ['0x1111111111111111111111111111111111111111']
				return await new Promise<never>(() => undefined)
			},
			on: (kind: string, callback: (value: unknown) => void) => {
				aggregateEventHandlers.set(kind, callback)
				return aggregateProvider
			},
			removeListener: () => aggregateProvider,
		}
		const announcedMetaMaskProvider = {
			isConnected: concreteMetaMaskProvider.isConnected,
			request: concreteMetaMaskProvider.request,
			on: (kind: string, callback: (value: unknown) => void) => {
				announcedProviderSubscriptions.push(kind)
				return concreteMetaMaskProvider.on(kind, callback)
			},
			removeListener: concreteMetaMaskProvider.removeListener,
		}
		const ignoredProvider = {
			request: async () => undefined,
			on: (kind: string) => {
				ignoredProviderSubscriptions.push(kind)
				return ignoredProvider
			},
		}
		const duplicateMetaMaskProvider = {
			request: async () => undefined,
			on: (kind: string) => {
				duplicateProviderSubscriptions.push(kind)
				return duplicateMetaMaskProvider
			},
		}
		const throwingAnnouncedProvider = {
			request: async () => undefined,
			on: () => { throw new Error('Invalid announced provider subscription') },
		}
		const partialSubscriptions = new Map<string, (value: unknown) => void>()
		const partiallyThrowingAnnouncedProvider = {
			request: async () => undefined,
			on: (kind: string, callback: (value: unknown) => void) => {
				partialSubscriptions.set(kind, callback)
				if (partialSubscriptions.size === 3) throw new Error('Invalid partial provider subscription')
				return partiallyThrowingAnnouncedProvider
			},
			removeListener: (kind: string) => {
				partialSubscriptions.delete(kind)
				return partiallyThrowingAnnouncedProvider
			},
		}
		let statefulRequestProviderSubscriptions = 0
		let statefulRequestReads = 0
		const statefulRequestAnnouncedProvider = {
			on: () => {
				statefulRequestProviderSubscriptions++
				return statefulRequestAnnouncedProvider
			},
			removeListener: () => statefulRequestAnnouncedProvider,
		}
		Object.defineProperty(statefulRequestAnnouncedProvider, 'request', {
			get: () => {
				statefulRequestReads++
				if (statefulRequestReads > 1) throw new Error('Invalid stateful request getter')
				return async () => undefined
			},
		})
		const metaMaskInfo = { uuid: '11111111-1111-4111-8111-111111111111', name: 'MetaMask', icon: 'data:image/png;base64,dGVzdA', rdns: 'io.metamask' }
		const throwingGetterProviders = (['isMetaMask', 'request', 'on', 'isBraveWallet'] as const).map(createThrowingMetaMaskProviderProperty)
		Object.defineProperty(fakeWindow, 'ethereum', { configurable: true, writable: true, value: aggregateProvider })
		fakeWindow.addEventListener('eip6963:requestProvider', () => {
			const hostileAnnouncementError = {
				get message() { throw new Error('Invalid hostile announcement error message getter') },
				toString() { throw new Error('Invalid hostile announcement error toString') },
			}
			const throwingDetailEvent = { type: 'eip6963:announceProvider', detail: undefined }
			Object.defineProperty(throwingDetailEvent, 'detail', { get: () => { throw hostileAnnouncementError } })
			fakeWindow.dispatchEvent(throwingDetailEvent)
			for (const detailProperty of ['provider', 'info'] as const) {
				const detail = { provider: ignoredProvider, info: metaMaskInfo }
				Object.defineProperty(detail, detailProperty, { get: () => { throw new Error(`Invalid announcement ${ detailProperty }`) } })
				fakeWindow.dispatchEvent({ type: 'eip6963:announceProvider', detail })
			}
			for (const infoProperty of ['uuid', 'name', 'icon', 'rdns'] as const) {
				const info = { ...metaMaskInfo }
				Object.defineProperty(info, infoProperty, { get: () => { throw new Error(`Invalid announcement ${ infoProperty }`) } })
				fakeWindow.dispatchEvent({ type: 'eip6963:announceProvider', detail: { provider: ignoredProvider, info } })
			}
			fakeWindow.dispatchEvent({ type: 'eip6963:announceProvider', detail: { provider: announcedMetaMaskProvider } })
			fakeWindow.dispatchEvent({ type: 'eip6963:announceProvider', detail: { info: { ...metaMaskInfo, rdns: 'com.example.wallet' }, provider: { ...ignoredProvider, isMetaMask: true } } })
			fakeWindow.dispatchEvent({ type: 'eip6963:announceProvider', detail: { info: { ...metaMaskInfo, uuid: 'not-a-uuid' }, provider: ignoredProvider } })
			fakeWindow.dispatchEvent({ type: 'eip6963:announceProvider', detail: { info: { ...metaMaskInfo, name: 'Another wallet' }, provider: ignoredProvider } })
			fakeWindow.dispatchEvent({ type: 'eip6963:announceProvider', detail: { info: { ...metaMaskInfo, icon: '' }, provider: ignoredProvider } })
			fakeWindow.dispatchEvent({ type: 'eip6963:announceProvider', detail: { info: { ...metaMaskInfo, icon: 'data:image/not-a-data-uri' }, provider: ignoredProvider } })
			fakeWindow.dispatchEvent({ type: 'eip6963:announceProvider', detail: { info: { ...metaMaskInfo, icon: 'data:image/png;base64,not@@base64' }, provider: ignoredProvider } })
			fakeWindow.dispatchEvent({ type: 'eip6963:announceProvider', detail: { info: { ...metaMaskInfo, icon: 'data:image/svg+xml,%ZZ' }, provider: ignoredProvider } })
			fakeWindow.dispatchEvent({ type: 'eip6963:announceProvider', detail: { info: metaMaskInfo, provider: { ...ignoredProvider, isMetaMask: 'yes' } } })
			fakeWindow.dispatchEvent({ type: 'eip6963:announceProvider', detail: { info: metaMaskInfo, provider: { ...ignoredProvider, isMetaMask: false } } })
			fakeWindow.dispatchEvent({ type: 'eip6963:announceProvider', detail: { info: metaMaskInfo, provider: { ...ignoredProvider, isBraveWallet: true } } })
			fakeWindow.dispatchEvent({ type: 'eip6963:announceProvider', detail: { info: metaMaskInfo, provider: { ...ignoredProvider, isCoinbaseWallet: true } } })
			fakeWindow.dispatchEvent({ type: 'eip6963:announceProvider', detail: { info: metaMaskInfo, provider: { ...ignoredProvider, isInterceptor: true } } })
			fakeWindow.dispatchEvent({ type: 'eip6963:announceProvider', detail: { info: metaMaskInfo, provider: { ...ignoredProvider, isConnected: true } } })
			fakeWindow.dispatchEvent({ type: 'eip6963:announceProvider', detail: { info: metaMaskInfo, provider: throwingAnnouncedProvider } })
			fakeWindow.dispatchEvent({ type: 'eip6963:announceProvider', detail: { info: metaMaskInfo, provider: partiallyThrowingAnnouncedProvider } })
			fakeWindow.dispatchEvent({ type: 'eip6963:announceProvider', detail: { info: metaMaskInfo, provider: statefulRequestAnnouncedProvider } })
			for (const provider of throwingGetterProviders) fakeWindow.dispatchEvent({ type: 'eip6963:announceProvider', detail: { info: metaMaskInfo, provider } })
			fakeWindow.dispatchEvent({
				type: 'eip6963:announceProvider',
				detail: {
					info: metaMaskInfo,
					provider: announcedMetaMaskProvider,
				},
			})
			fakeWindow.dispatchEvent({
				type: 'eip6963:announceProvider',
				detail: {
					info: metaMaskInfo,
					provider: duplicateMetaMaskProvider,
				},
			})
		})

		await withFakeInpageWindow(fakeWindow, '../../app/inpage/ts/inpage.js?eip6963-metamask-signing', async () => {
			const result = await fakeWindow.ethereum.request({ method: 'eth_sendTransaction', params: [{ from: '0x1111111111111111111111111111111111111111' }] })
			assert.equal(result, signedTransactionHash)
		})

		assert.equal(concreteSignerRequests.includes('eth_sendTransaction'), true)
		assert.equal(aggregateSignerRequests.includes('eth_sendTransaction'), false)
		assert.deepEqual(ignoredProviderSubscriptions, [])
		assert.deepEqual(announcedProviderSubscriptions, ['accountsChanged', 'connect', 'disconnect', 'chainChanged'])
		assert.deepEqual(duplicateProviderSubscriptions, [])
		assert.equal(partialSubscriptions.size, 0)
		assert.equal(statefulRequestProviderSubscriptions, 0)
		const hostileAnnouncementDiagnostic = backgroundMessages.find((message) => message.method === 'InterceptorError' && typeof message.params?.[0] === 'string' && message.params[0].includes('phase: read EIP-6963 MetaMask announcement'))
		if (hostileAnnouncementDiagnostic === undefined || typeof hostileAnnouncementDiagnostic.params?.[0] !== 'string') throw new Error('missing hostile EIP-6963 announcement diagnostic')
		assert.match(hostileAnnouncementDiagnostic.params[0], /Failed to read thrown-value summary: Error: Invalid hostile announcement error message getter/)
		await waitFor(() => backgroundMessages.some((message) => message.method === 'signer_chainChanged'))

		const messageCountBeforeStaleEvents = backgroundMessages.length
		aggregateEventHandlers.get('accountsChanged')?.(['0x2222222222222222222222222222222222222222'])
		aggregateEventHandlers.get('connect')?.({ chainId: '0x2' })
		aggregateEventHandlers.get('disconnect')?.({ code: 4900, message: 'disconnected' })
		aggregateEventHandlers.get('chainChanged')?.('0x2')
		await new Promise((resolve) => setTimeout(resolve, 0))
		assert.equal(backgroundMessages.length, messageCountBeforeStaleEvents)

		emitSignerEvent('chainChanged', '0x3')
		await waitFor(() => backgroundMessages.some((message) => message.method === 'signer_chainChanged' && message.params?.[0] === '0x3'))
	})

	test('normalizes object-valued MetaMask rejection data before sending signer_reply', async () => {
		const signerReplies: unknown[] = []
		const { fakeWindow } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessageForRequest) => {
				if (request.method === 'eth_sendTransaction') {
					sendBackgroundMessageForRequest({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'forwardToSigner',
						method: request.method,
						params: request.params,
					})
					return true
				}
				if (request.method !== 'signer_reply') return false
				signerReplies.push(request.params?.[0])
				sendBackgroundMessageForRequest({
					interceptorApproved: true,
					requestId: request.requestId,
					type: 'result',
					method: 'signer_reply',
					result: '0x',
				})
				return true
			},
			handleSignerRequest: ({ method }) => {
				if (method === 'eth_sendTransaction') return Promise.reject({
					code: 4001,
					message: 'MetaMask Tx Signature: User denied transaction signature.',
					data: { location: 'confirmation', cause: null },
				})
				return undefined
			},
		})

		await withFakeInpageWindow(fakeWindow, '../../app/inpage/ts/inpage.js?metamask-rejection-object-data', async () => {
			void fakeWindow.ethereum.request({ method: 'eth_sendTransaction', params: [{ from: '0x1111111111111111111111111111111111111111' }] })
			await waitFor(() => signerReplies.length === 1)
		})

		const signerReply = signerReplies[0]
		if (!isRecord(signerReply) || !isRecord(signerReply.error)) throw new Error('Malformed signer reply')
		assert.equal(signerReply.success, false)
		assert.deepEqual(signerReply.error, {
			code: 4001,
			message: 'MetaMask Tx Signature: User denied transaction signature.',
		})
		const { SignerReply } = await import('../../app/ts/types/interceptor-messages.js')
		assert.doesNotThrow(() => SignerReply.parse({ method: 'signer_reply', params: [signerReply] }))
	})

	test('serializes unusable-root NoSigner recovery before EIP-6963 MetaMask connection', async () => {
		const connectedSignerNames: unknown[] = []
		const { fakeWindow, signerRequests } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessage) => {
				if (request.method !== 'connected_to_signer') return false
				connectedSignerNames.push(request.params?.[1])
				const delay = request.params?.[1] === 'NoSigner' ? 10 : 0
				setTimeout(() => sendBackgroundMessage({
					interceptorApproved: true,
					requestId: request.requestId,
					type: 'result',
					method: 'connected_to_signer',
					result: { metamaskCompatibilityMode: true },
				}), delay)
				return true
			},
		})
		const announcedMetaMaskProvider = fakeWindow.ethereum
		const unusableRootProvider = {
			on: () => unusableRootProvider,
			removeListener: () => unusableRootProvider,
		}
		Object.defineProperty(unusableRootProvider, 'request', { get: () => { throw new Error('Invalid root request') } })
		Object.defineProperty(fakeWindow, 'ethereum', { configurable: true, writable: true, value: unusableRootProvider })
		fakeWindow.addEventListener('eip6963:requestProvider', () => fakeWindow.dispatchEvent({
			type: 'eip6963:announceProvider',
			detail: {
				info: { uuid: '33333333-3333-4333-8333-333333333333', name: 'MetaMask', icon: 'data:image/svg+xml,<svg/>', rdns: 'io.metamask' },
				provider: announcedMetaMaskProvider,
			},
		}))

		await withFakeInpageWindow(fakeWindow, '../../app/inpage/ts/inpage.js?serialized-no-signer-eip-recovery', async () => {
			await waitFor(() => connectedSignerNames.length === 2)
			await waitFor(() => signerRequests.includes('eth_chainId'))
		})

		assert.deepEqual(connectedSignerNames, ['NoSigner', 'MetaMask'])
	})

	test('does not replace Coinbase or unrecognized signers from MetaMask announcements', async () => {
		const signerCases = [
			{ name: 'CoinbaseWallet', marker: { isCoinbaseWallet: true } },
			{ name: 'NotRecognizedSigner', marker: {} },
		] as const

		for (const signerCase of signerCases) {
			const connectedSignerNames: unknown[] = []
			let announcedProviderSubscriptionCount = 0
			const { fakeWindow } = createFakeWindow({
				handleRequest: (request) => {
					if (request.method === 'connected_to_signer') connectedSignerNames.push(request.params?.[1])
					return false
				},
			})
			const signer = {
				...signerCase.marker,
				isConnected: () => true,
				request: async ({ method }: { method: string }) => method === 'eth_chainId' ? '0x1' : [],
				on: () => signer,
				removeListener: () => signer,
			}
			Object.defineProperty(fakeWindow, 'ethereum', { configurable: true, writable: true, value: signer })

			await withFakeInpageWindow(fakeWindow, `../../app/inpage/ts/inpage.js?eip6963-protect-${ signerCase.name }-${ Date.now() }-${ Math.random() }`, async () => {
				await waitFor(() => connectedSignerNames.includes(signerCase.name))
				const announcedProvider = {
					isMetaMask: true,
					request: async () => undefined,
					on: () => {
						announcedProviderSubscriptionCount++
						return announcedProvider
					},
				}
				fakeWindow.dispatchEvent({
					type: 'eip6963:announceProvider',
					detail: { info: { uuid: '22222222-2222-4222-8222-222222222222', name: 'MetaMask', icon: 'data:image/svg+xml,<svg/>', rdns: 'io.metamask' }, provider: announcedProvider },
				})
				await new Promise((resolve) => setTimeout(resolve, 0))
				assert.equal(announcedProviderSubscriptionCount, 0)
				assert.equal(connectedSignerNames.includes('MetaMask'), false)
			})
		}
	})

	test('does not let a late page announcement replace the selected Brave signer', async () => {
		const connectedSignerNames: unknown[] = []
		let announcedProviderSubscriptionCount = 0
		const { fakeWindow } = createFakeWindow({
			handleRequest: (request) => {
				if (request.method === 'connected_to_signer') connectedSignerNames.push(request.params?.[1])
				return false
			},
		})
		const braveSigner = {
			isBraveWallet: true,
			isConnected: () => true,
			request: async ({ method }: { method: string }) => method === 'eth_chainId' ? '0x1' : [],
			on: () => braveSigner,
			removeListener: () => braveSigner,
		}
		const announcedProvider = {
			isMetaMask: true,
			isConnected: () => true,
			request: async () => undefined,
			on: () => {
				announcedProviderSubscriptionCount += 1
				return announcedProvider
			},
			removeListener: () => announcedProvider,
		}
		Object.defineProperty(fakeWindow, 'ethereum', { configurable: true, writable: true, value: braveSigner })

		await withFakeInpageWindow(fakeWindow, '../../app/inpage/ts/inpage.js?eip6963-ignore-late-page-announcement', async () => {
			await waitFor(() => connectedSignerNames.includes('Brave'))
			fakeWindow.dispatchEvent({
				type: 'eip6963:announceProvider',
				detail: {
					info: { uuid: '44444444-4444-4444-8444-444444444444', name: 'MetaMask', icon: 'data:image/svg+xml,<svg/>', rdns: 'io.metamask' },
					provider: announcedProvider,
				},
			})
			await new Promise((resolve) => setTimeout(resolve, 0))
		})

		assert.equal(announcedProviderSubscriptionCount, 0)
		assert.deepEqual(connectedSignerNames, ['Brave'])
	})

	test('keeps signer selectedAddress mutations hidden until Interceptor account replay', async () => {
		const signerAccount = '0x1111111111111111111111111111111111111111'
		let mutationAttempted = false
		let pendingRequest: InpageRequest | undefined
		let pendingSendBackgroundMessage: ((data: unknown) => void) | undefined
		let exposedWindow: ReturnType<typeof createFakeWindow>['fakeWindow'] | undefined
		const createdWindow = createFakeWindow({
			signerInitialSelectedAddress: signerAccount,
			handleRequest: (request, sendBackgroundMessageForRequest) => {
				if (request.method !== 'eth_requestAccounts') return false
				if (exposedWindow === undefined) throw new Error('fake window was not initialized')
				try {
					;(exposedWindow.ethereum as { selectedAddress?: string }).selectedAddress = signerAccount
				} catch (error: unknown) {
					if (!(error instanceof TypeError)) throw error
				}
				if ('web3' in exposedWindow && exposedWindow.web3 !== undefined) {
					try {
						;(exposedWindow.web3 as { accounts?: readonly string[] }).accounts = [signerAccount]
					} catch (error: unknown) {
						if (!(error instanceof TypeError)) throw error
					}
				}
				mutationAttempted = true
				pendingRequest = request
				pendingSendBackgroundMessage = sendBackgroundMessageForRequest
				return true
			},
		})
		const { fakeWindow, signerRequests, sendBackgroundMessage } = createdWindow
		exposedWindow = fakeWindow

		await withFakeInpageWindow(fakeWindow, '../../app/inpage/ts/inpage.js?selected-address-mutation-mask', async () => {
			const provider = fakeWindow.ethereum as {
				request: (payload: { method: string, params?: readonly unknown[] }) => Promise<unknown>
				send: (payload: { id: string | number | null, method: string, params: readonly unknown[] }, callback?: undefined) => { readonly result: unknown }
				on: (eventName: string, callback: (value: unknown) => void) => void
				isConnected: () => boolean
				selectedAddress?: string
			}
			await waitFor(() => signerRequests.includes('eth_chainId'))
			assert.equal(provider.selectedAddress, undefined)
			assert.deepEqual(provider.send({ id: 1, method: 'eth_accounts', params: [] }).result, [])
			assert.deepEqual((fakeWindow as { web3?: { accounts?: unknown } }).web3?.accounts, [])

			const requestPromise = provider.request({ method: 'eth_requestAccounts' })
			await waitFor(() => mutationAttempted)
			assert.equal(provider.selectedAddress, undefined)
			assert.deepEqual(provider.send({ id: 2, method: 'eth_accounts', params: [] }).result, [])
			assert.deepEqual((fakeWindow as { web3?: { accounts?: unknown } }).web3?.accounts, [])
			if (pendingRequest === undefined || pendingSendBackgroundMessage === undefined) throw new Error('eth_requestAccounts was not captured')

			pendingSendBackgroundMessage({
				interceptorApproved: true,
				requestId: pendingRequest.requestId,
				type: 'result',
				method: 'connect',
				result: ['0x1'],
			})
			pendingSendBackgroundMessage({
				interceptorApproved: true,
				requestId: pendingRequest.requestId,
				type: 'result',
				method: 'accountsChanged',
				result: [signerAccount],
			})
			pendingSendBackgroundMessage({
				interceptorApproved: true,
				requestId: pendingRequest.requestId,
				type: 'result',
				method: 'eth_accounts',
				result: [signerAccount],
			})
			const accountReply = await requestPromise
			assert.deepEqual(accountReply, [signerAccount])
			assert.equal(provider.selectedAddress, signerAccount)
			pendingSendBackgroundMessage({
				interceptorApproved: true,
				requestId: pendingRequest.requestId,
				type: 'result',
				method: 'accountsChanged',
				result: [signerAccount],
			})
			await waitFor(() => provider.selectedAddress === signerAccount)
			assert.deepEqual(provider.send({ id: 3, method: 'eth_accounts', params: [] }).result, [signerAccount])
			assert.deepEqual((fakeWindow as { web3?: { accounts?: unknown } }).web3?.accounts, [signerAccount])

			const accountEvents: unknown[] = []
			provider.on('accountsChanged', (accounts) => accountEvents.push(accounts))
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'accountsChanged',
				result: [],
			})
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'disconnect',
				result: [],
			})
			await waitFor(() => provider.selectedAddress === undefined && !provider.isConnected())
			assert.deepEqual(accountEvents, [[]])
			assert.deepEqual(provider.send({ id: 4, method: 'eth_accounts', params: [] }).result, [])
			assert.deepEqual((fakeWindow as { web3?: { accounts?: unknown } }).web3?.accounts, [])
		})
	})

	test('freezes non-configurable writable compatibility properties before signer mutation can expose accounts', async () => {
		const signerAccount = '0x1111111111111111111111111111111111111111'
		let mutationAttempted = false
		let pendingRequest: InpageRequest | undefined
		let pendingSendBackgroundMessage: ((data: unknown) => void) | undefined
		let exposedWindow: ReturnType<typeof createFakeWindow>['fakeWindow'] | undefined
		const createdWindow = createFakeWindow({
			handleRequest: (request, sendBackgroundMessageForRequest) => {
				if (request.method !== 'eth_requestAccounts') return false
				if (exposedWindow === undefined) throw new Error('fake window was not initialized')
				try {
					;(exposedWindow.ethereum as { selectedAddress?: string }).selectedAddress = signerAccount
				} catch (error: unknown) {
					if (!(error instanceof TypeError)) throw error
				}
				if ('web3' in exposedWindow && exposedWindow.web3 !== undefined) {
					try {
						;(exposedWindow.web3 as { accounts?: readonly string[] }).accounts = [signerAccount]
					} catch (error: unknown) {
						if (!(error instanceof TypeError)) throw error
					}
				}
				mutationAttempted = true
				pendingRequest = request
				pendingSendBackgroundMessage = sendBackgroundMessageForRequest
				return true
			},
		})
		const { fakeWindow, signerRequests } = createdWindow
		exposedWindow = fakeWindow
		Object.defineProperty(fakeWindow.ethereum, 'selectedAddress', {
			configurable: false,
			enumerable: true,
			value: signerAccount,
			writable: true,
		})
		;(fakeWindow as { web3?: { accounts?: readonly string[], currentProvider: unknown } }).web3 = { accounts: [signerAccount], currentProvider: fakeWindow.ethereum }
		Object.defineProperty((fakeWindow as { web3: { accounts?: readonly string[] } }).web3, 'accounts', {
			configurable: false,
			enumerable: true,
			value: [signerAccount],
			writable: true,
		})

		await withFakeInpageWindow(fakeWindow, '../../app/inpage/ts/inpage.js?non-configurable-writable-compatibility-mask', async () => {
			const provider = fakeWindow.ethereum as {
				request: (payload: { method: string, params?: readonly unknown[] }) => Promise<unknown>
				send: (payload: { id: string | number | null, method: string, params: readonly unknown[] }, callback?: undefined) => { readonly result: unknown }
				selectedAddress?: string
			}
			await waitFor(() => signerRequests.includes('eth_chainId'))
			assert.equal(provider.selectedAddress, undefined)
			assert.deepEqual(provider.send({ id: 1, method: 'eth_accounts', params: [] }).result, [])
			assert.deepEqual((fakeWindow as { web3?: { accounts?: unknown } }).web3?.accounts, [])

			const requestPromise = provider.request({ method: 'eth_requestAccounts' })
			await waitFor(() => mutationAttempted)
			assert.equal(provider.selectedAddress, undefined)
			assert.deepEqual(provider.send({ id: 2, method: 'eth_accounts', params: [] }).result, [])
			assert.deepEqual((fakeWindow as { web3?: { accounts?: unknown } }).web3?.accounts, [])
			if (pendingRequest === undefined || pendingSendBackgroundMessage === undefined) throw new Error('eth_requestAccounts was not captured')

			pendingSendBackgroundMessage({
				interceptorApproved: true,
				requestId: pendingRequest.requestId,
				type: 'result',
				method: 'connect',
				result: ['0x1'],
			})
			pendingSendBackgroundMessage({
				interceptorApproved: true,
				requestId: pendingRequest.requestId,
				type: 'result',
				method: 'accountsChanged',
				result: [signerAccount],
			})
			pendingSendBackgroundMessage({
				interceptorApproved: true,
				requestId: pendingRequest.requestId,
				type: 'result',
				method: 'eth_accounts',
				result: [signerAccount],
			})
			assert.deepEqual(await requestPromise, [signerAccount])
			assert.equal(provider.selectedAddress, signerAccount)
			assert.deepEqual((fakeWindow as { web3?: { accounts?: unknown } }).web3?.accounts, [signerAccount])
		})
	})

	test('does not forward signer accountsChanged as an unscoped update during eth_requestAccounts', async () => {
		const signerAccount = '0x1111111111111111111111111111111111111111'
		const {
			fakeWindow,
			signerRequests,
			backgroundEthAccountsReplies,
			sendBackgroundMessage,
			setBlockRequestAccounts,
			resolvePendingRequestAccounts,
			emitSignerEvent,
		} = createFakeWindow()

		await withFakeInpageWindow(fakeWindow, '../../app/inpage/ts/inpage.js?request-accounts-suppresses-signer-event', async () => {
			await waitFor(() => signerRequests.includes('eth_chainId'))
			setBlockRequestAccounts(true)
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'request_signer_to_eth_requestAccounts',
				result: [],
			})
			await waitFor(() => signerRequests.includes('eth_requestAccounts'))
			emitSignerEvent('accountsChanged', [signerAccount])
			await new Promise((resolve) => setTimeout(resolve, 0))
			assert.deepEqual(backgroundEthAccountsReplies, [])

			resolvePendingRequestAccounts([signerAccount])
			await waitFor(() => backgroundEthAccountsReplies.length === 1)
			assert.deepEqual(backgroundEthAccountsReplies, [
				{ type: 'success', accounts: [signerAccount], requestAccounts: true },
			])
		})
	})

	test('delivers request-scoped connect and accountsChanged before eth_requestAccounts resumes even when address is cached', async () => {
		const signerAccount = '0x1111111111111111111111111111111111111111'
		const { fakeWindow, sendBackgroundMessage, signerRequests } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessageForRequest) => {
				if (request.method !== 'eth_requestAccounts') return false
				sendBackgroundMessageForRequest({
					interceptorApproved: true,
					requestId: request.requestId,
					type: 'result',
					method: 'connect',
					result: ['0x1'],
				})
				sendBackgroundMessageForRequest({
					interceptorApproved: true,
					requestId: request.requestId,
					type: 'result',
					method: 'accountsChanged',
					result: [signerAccount],
				})
				setTimeout(() => {
					setTimeout(() => {
						setTimeout(() => {
							sendBackgroundMessageForRequest({
								interceptorApproved: true,
								requestId: request.requestId,
								type: 'result',
								method: 'eth_accounts',
								result: [signerAccount],
							})
						}, 0)
					}, 0)
				}, 0)
				return true
			},
		})

		await withFakeInpageWindow(fakeWindow, '../../app/inpage/ts/inpage.js?request-scoped-accounts-changed', async () => {
			const provider = fakeWindow.ethereum as {
				request: (payload: { method: string, params?: readonly unknown[] }) => Promise<unknown>
				on: (eventName: string, callback: (value: unknown) => void) => void
			}
			await waitFor(() => typeof provider.request === 'function')
			await waitFor(() => signerRequests.includes('eth_chainId'))
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'accountsChanged',
				result: [signerAccount],
			})
			await waitFor(() => (fakeWindow.ethereum as { selectedAddress?: string }).selectedAddress === signerAccount)
			const events: string[] = []
			const accountEvents: (readonly string[])[] = []
			provider.on('accountsChanged', (accounts) => {
				events.push('accountsChanged')
				if (!Array.isArray(accounts) || !accounts.every((account): account is string => typeof account === 'string')) throw new Error('accountsChanged payload was not a string array')
				accountEvents.push(accounts)
			})
			provider.on('connect', (connectInfo) => {
				events.push('connect')
				assert.deepEqual(connectInfo, { chainId: '0x1' })
			})

			const accountReply = await provider.request({ method: 'eth_requestAccounts' }).then((accounts) => {
				events.push('resolved')
				return accounts
			})
			await waitFor(() => accountEvents.length === 1)

			assert.deepEqual(accountReply, [signerAccount])
			assert.deepEqual(accountEvents, [[signerAccount]])
			assert.deepEqual(events, ['connect', 'accountsChanged', 'resolved'])
		})
	})

	test('delivers request-scoped connect and accountsChanged before wallet_requestPermissions resumes', async () => {
		const signerAccount = '0x1212121212121212121212121212121212121212'
		const permissions = [{
			parentCapability: 'eth_accounts',
			caveats: [{
				type: 'restrictReturnedAccounts',
				value: [signerAccount],
			}],
			invoker: 'https://example.test',
		}]
		const { fakeWindow, signerRequests } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessageForRequest) => {
				if (request.method !== 'wallet_requestPermissions') return false
				sendBackgroundMessageForRequest({
					interceptorApproved: true,
					requestId: request.requestId,
					type: 'result',
					method: 'connect',
					result: ['0x1'],
				})
				sendBackgroundMessageForRequest({
					interceptorApproved: true,
					requestId: request.requestId,
					type: 'result',
					method: 'accountsChanged',
					result: [signerAccount],
				})
				sendBackgroundMessageForRequest({
					interceptorApproved: true,
					requestId: request.requestId,
					type: 'result',
					method: 'wallet_requestPermissions',
					result: permissions,
				})
				return true
			},
		})

		await withFakeInpageWindow(fakeWindow, '../../app/inpage/ts/inpage.js?request-scoped-wallet-permissions', async () => {
			const provider = fakeWindow.ethereum as {
				request: (payload: { method: string, params?: readonly unknown[] }) => Promise<unknown>
				on: (eventName: string, callback: (value: unknown) => void) => void
			}
			await waitFor(() => typeof provider.request === 'function')
			await waitFor(() => signerRequests.includes('eth_chainId'))
			const events: string[] = []
			provider.on('connect', (connectInfo) => {
				events.push('connect')
				assert.deepEqual(connectInfo, { chainId: '0x1' })
			})
			provider.on('accountsChanged', (accounts) => {
				events.push('accountsChanged')
				assert.deepEqual(accounts, [signerAccount])
			})

			const permissionReply = await provider.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] }).then((reply) => {
				events.push('resolved')
				return reply
			})

			assert.deepEqual(permissionReply, permissions)
			assert.deepEqual(events, ['connect', 'accountsChanged', 'resolved'])
		})
	})

	test('resolves eth_requestAccounts when request-scoped provider listeners throw', async () => {
		const signerAccount = '0x1111111111111111111111111111111111111111'
		const { fakeWindow, signerRequests } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessageForRequest) => {
				if (request.method !== 'eth_requestAccounts') return false
				sendBackgroundMessageForRequest({
					interceptorApproved: true,
					requestId: request.requestId,
					type: 'result',
					method: 'connect',
					result: ['0x1'],
				})
				sendBackgroundMessageForRequest({
					interceptorApproved: true,
					requestId: request.requestId,
					type: 'result',
					method: 'accountsChanged',
					result: [signerAccount],
				})
				sendBackgroundMessageForRequest({
					interceptorApproved: true,
					requestId: request.requestId,
					type: 'result',
					method: 'eth_accounts',
					result: [signerAccount],
				})
				return true
			},
		})

		await withFakeInpageWindow(fakeWindow, '../../app/inpage/ts/inpage.js?request-scoped-listener-throws', async () => {
			const provider = fakeWindow.ethereum as {
				request: (payload: { method: string, params?: readonly unknown[] }) => Promise<unknown>
				on: (eventName: string, callback: (value: unknown) => void) => void
			}
			await waitFor(() => typeof provider.request === 'function')
			await waitFor(() => signerRequests.includes('eth_chainId'))
			let connectCallbackCount = 0
			let accountCallbackCount = 0
			provider.on('connect', () => {
				connectCallbackCount += 1
				throw new Error('dapp connect listener failed')
			})
			provider.on('accountsChanged', () => {
				accountCallbackCount += 1
				throw new Error('dapp accounts listener failed')
			})

			const accountReply = await provider.request({ method: 'eth_requestAccounts' })

			assert.deepEqual(accountReply, [signerAccount])
			assert.equal(connectCallbackCount, 1)
			assert.equal(accountCallbackCount, 1)
		})
	})

	test('drops stale request-scoped provider events after eth_requestAccounts settles', async () => {
		const signerAccount = '0x1111111111111111111111111111111111111111'
		const staleAccount = '0x2222222222222222222222222222222222222222'
		let accountRequest: InpageRequest | undefined
		let sendForAccountRequest: ((data: unknown) => void) | undefined
		const { fakeWindow, signerRequests } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessageForRequest) => {
				if (request.method !== 'eth_requestAccounts') return false
				accountRequest = request
				sendForAccountRequest = sendBackgroundMessageForRequest
				sendBackgroundMessageForRequest({
					interceptorApproved: true,
					requestId: request.requestId,
					type: 'result',
					method: 'eth_accounts',
					result: [signerAccount],
				})
				return true
			},
		})

		await withFakeInpageWindow(fakeWindow, '../../app/inpage/ts/inpage.js?stale-request-scoped-events', async () => {
			const provider = fakeWindow.ethereum as {
				request: (payload: { method: string, params?: readonly unknown[] }) => Promise<unknown>
				on: (eventName: string, callback: (value: unknown) => void) => void
				isConnected: () => boolean
				selectedAddress?: string
				chainId?: string
			}
			await waitFor(() => typeof provider.request === 'function')
			await waitFor(() => signerRequests.includes('eth_chainId'))
			const events: string[] = []
			provider.on('connect', () => {
				events.push('connect')
			})
			provider.on('accountsChanged', () => {
				events.push('accountsChanged')
			})
			provider.on('disconnect', () => {
				events.push('disconnect')
			})
			provider.on('chainChanged', () => {
				events.push('chainChanged')
			})

			assert.deepEqual(await provider.request({ method: 'eth_requestAccounts' }), [signerAccount])
			const connectedAfterRequest = provider.isConnected()
			const chainIdAfterRequest = provider.chainId
			assert.equal(provider.selectedAddress, undefined)
			assert.deepEqual((fakeWindow as { web3?: { accounts?: unknown } }).web3?.accounts, [])
			if (accountRequest === undefined || sendForAccountRequest === undefined) throw new Error('eth_requestAccounts was not captured')
			sendForAccountRequest({
				interceptorApproved: true,
				requestId: accountRequest.requestId,
				type: 'result',
				method: 'connect',
				result: ['0x1'],
			})
			sendForAccountRequest({
				interceptorApproved: true,
				requestId: accountRequest.requestId,
				type: 'result',
				method: 'accountsChanged',
				result: [staleAccount],
			})
			sendForAccountRequest({
				interceptorApproved: true,
				requestId: accountRequest.requestId,
				type: 'result',
				method: 'disconnect',
				result: [],
			})
			sendForAccountRequest({
				interceptorApproved: true,
				requestId: accountRequest.requestId,
				type: 'result',
				method: 'chainChanged',
				result: '0x2',
			})
			await new Promise((resolve) => setTimeout(resolve, 0))
			await new Promise((resolve) => setTimeout(resolve, 0))

			assert.deepEqual(events, [])
			assert.equal(provider.isConnected(), connectedAfterRequest)
			assert.equal(provider.chainId, chainIdAfterRequest)
			assert.equal(provider.selectedAddress, undefined)
			assert.deepEqual((fakeWindow as { web3?: { accounts?: unknown } }).web3?.accounts, [])
		})
	})

	test('uses mapped Coinbase provider for signer requests and signer name', async () => {
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
						result: { metamaskCompatibilityMode: true },
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

		await withFakeInpageWindow(fakeWindow, '../../app/inpage/ts/inpage.js?provider-map-coinbase-binding', async () => {
			await waitFor(() => signerName !== undefined)
			await waitFor(() => signerRequests.brave.length === 1 || signerRequests.coinbase.length === 1)
			assert.equal(signerName, 'CoinbaseWallet')
			assert.deepEqual(signerRequests.coinbase, ['eth_chainId'])
			assert.deepEqual(signerRequests.brave, [])
		})
	})

	test('uses providerMap CoinbaseWallet key as signer identity when mapped provider lacks isCoinbaseWallet flag', async () => {
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
						result: { metamaskCompatibilityMode: true },
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

		await withFakeInpageWindow(fakeWindow, '../../app/inpage/ts/inpage.js?provider-map-coinbase-missing-flag', async () => {
			await waitFor(() => signerName !== undefined)
			await waitFor(() => signerRequests.brave.length === 1 || signerRequests.coinbase.length === 1)
			assert.equal(signerName, 'CoinbaseWallet')
			assert.deepEqual(signerRequests.coinbase, ['eth_chainId'])
			assert.deepEqual(signerRequests.brave, [])
		})
	})

	test('uses root signer identity when CoinbaseWallet providerMap entry is unusable', async () => {
		let signerName: string | undefined
		const signerRequests = {
			root: [] as string[],
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
						result: { metamaskCompatibilityMode: true },
					})
					return true
				}
				return false
			},
		})
		const rootSigner = {
			isMetaMask: true,
			isConnected: () => true,
			request: async ({ method }: { method: string }) => {
				signerRequests.root.push(method)
				if (method === 'eth_chainId') return '0x1'
				throw new Error(`Unexpected root signer request: ${ method }`)
			},
			on: () => rootSigner,
			removeListener: () => rootSigner,
		}
		;(fakeWindow as { ethereum: typeof rootSigner & { providerMap: Map<string, { readonly isCoinbaseWallet: true }> } }).ethereum = {
			...rootSigner,
			providerMap: new Map([['CoinbaseWallet', { isCoinbaseWallet: true }]]),
		}

		await withFakeInpageWindow(fakeWindow, '../../app/inpage/ts/inpage.js?provider-map-unusable-coinbase-entry', async () => {
			await waitFor(() => signerName !== undefined)
			await waitFor(() => signerRequests.root.length >= 1)
			assert.equal(signerName, 'MetaMask')
			assert.deepEqual(signerRequests.root, ['eth_chainId'])
		})
	})

	test('does not fall back to the root provider when mapped CoinbaseWallet chain id request fails', async () => {
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
						result: { metamaskCompatibilityMode: true },
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

		await withFakeInpageWindow(fakeWindow, '../../app/inpage/ts/inpage.js?provider-map-chain-id-no-root-fallback', async () => {
			await waitFor(() => signerName !== undefined)
			assert.equal(mappedSignerChainIdRequestCount, 1)
			assert.deepEqual(mappedSignerRequests, ['eth_chainId'])
			assert.deepEqual(rootSignerRequests, [])
			assert.deepEqual(backgroundSignerChainChanges, [])
			await waitFor(() => interceptorErrorPayloads.length === 1)
			assert.equal(String(interceptorErrorPayloads[0]).includes('temporary failure in mapped signer'), true)
			assert.equal(signerName, 'CoinbaseWallet')
		})
	})

	test('does not fall back to the root provider when mapped CoinbaseWallet eth_accounts fails', async () => {
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
						result: { metamaskCompatibilityMode: true },
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

		await withFakeInpageWindow(fakeWindow, '../../app/inpage/ts/inpage.js?provider-map-eth-accounts-no-fallback', async () => {
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
		})
	})

	test('does not fall back to the root provider when mapped CoinbaseWallet eth_requestAccounts is rejected', async () => {
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
						result: { metamaskCompatibilityMode: true },
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

		await withFakeInpageWindow(fakeWindow, '../../app/inpage/ts/inpage.js?provider-map-no-fallback-on-reject', async () => {
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
		})
	})

	test('does not fall back to the root provider when mapped CoinbaseWallet eth_requestAccounts returns 4001 with a non-standard message', async () => {
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
						result: { metamaskCompatibilityMode: true },
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

		await withFakeInpageWindow(fakeWindow, '../../app/inpage/ts/inpage.js?provider-map-eth-requestaccounts-fallback-4001-message', async () => {
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
		})
	})

	test('does not fall back to the root provider when mapped CoinbaseWallet eth_requestAccounts returns 4001 without a message', async () => {
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
						result: { metamaskCompatibilityMode: true },
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
				if (method === 'eth_requestAccounts') throw { code: 4001 }
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

		await withFakeInpageWindow(fakeWindow, '../../app/inpage/ts/inpage.js?provider-map-eth-requestaccounts-code-only-4001', async () => {
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
			assert.equal((backgroundEthAccountsReplies[0] as { error: { code: number, message: string } }).error.message, 'User rejected the request.')
			assert.equal(interceptorErrorPayloads.length, 0)
		})
	})

	test('falls back to the root provider when mapped CoinbaseWallet eth_requestAccounts fails with a non-user-rejected error', async () => {
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
						result: { metamaskCompatibilityMode: true },
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

		await withFakeInpageWindow(fakeWindow, '../../app/inpage/ts/inpage.js?provider-map-eth-requestaccounts-fallback', async () => {
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
		})
	})

	test('uses actual signer flags when providerMap has no CoinbaseWallet entry', async () => {
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
						result: { metamaskCompatibilityMode: true },
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

		await withFakeInpageWindow(fakeWindow, '../../app/inpage/ts/inpage.js?provider-map-no-coinbase', async () => {
			await waitFor(() => signerName !== undefined)
			assert.equal(signerName, 'MetaMask')
		})
	})

	test('uses mapped provider events in providerMap branch', async () => {
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
						result: { metamaskCompatibilityMode: true },
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

		await withFakeInpageWindow(fakeWindow, `../../app/inpage/ts/inpage.js?provider-map-events-${ Date.now() }-${ Math.random() }`, async () => {
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
			signerEvents.accountsChanged!(['0x1111111111111111111111111111111111111111'])
			assert.equal(typeof signerEvents.accountsChanged, 'function')
			assert.equal(typeof signerEvents.chainChanged, 'function')
			assert.equal(signerEvents.chainChanged !== undefined, true)
			assert.equal(signerEvents.accountsChanged !== undefined, true)
			await waitFor(() => backgroundMessages.some((message) => message.method === 'eth_accounts_reply' && (message.params?.[0] as { requestAccounts: boolean } | undefined)?.requestAccounts === false))
			signerEvents.chainChanged!('0x2a')
			await waitFor(() => backgroundMessages.some((message) => message.method === 'signer_chainChanged' && message.params?.[0] === '0x2a'))
		})
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
		let connectedToSigner = false
		const { fakeWindow, sendBackgroundMessage } = createFakeWindow({
			onConnectedToSignerRequest: () => {
				connectedToSigner = true
			},
		})
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

	test('skips non-configurable accessor compatibility arrays without reading descriptor value', async () => {
		let connectedToSigner = false
		const { fakeWindow } = createFakeWindow({
			onConnectedToSignerRequest: () => {
				connectedToSigner = true
			},
		})
		const web3 = { currentProvider: fakeWindow.ethereum }
		Object.defineProperty(web3, 'accounts', {
			configurable: false,
			enumerable: true,
			get: () => [],
		})
		Object.defineProperty(fakeWindow, 'web3', {
			configurable: false,
			enumerable: true,
			value: web3,
			writable: false,
		})

		await withFakeInpageWindow(fakeWindow, '../../app/inpage/ts/inpage.js?non-configurable-accessor-empty-array-compatibility', async () => {
			await waitFor(() => connectedToSigner)
			assert.equal('isInterceptor' in (fakeWindow.ethereum as Record<string, unknown>), true)
			assert.deepEqual(web3.accounts, [])
			assert.equal('isInterceptor' in (web3.currentProvider as Record<string, unknown>), true)
		})
	})

	test('updates configurable getter-only compatibility properties without throwing', async () => {
		const previousWindow = (globalThis as { window?: unknown }).window
		const previousCustomEvent = (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
		const previousWarn = console.warn
		let connectedToSigner = false
		const { fakeWindow, sendBackgroundMessage } = createFakeWindow({
			onConnectedToSignerRequest: () => {
				connectedToSigner = true
			},
		})
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
			await waitFor(() => connectedToSigner)
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'accountsChanged',
				result: ['0x1111111111111111111111111111111111111111'],
			})
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

	test('keeps controlled compatibility properties working after target becomes non-extensible', async () => {
		const previousWindow = (globalThis as { window?: unknown }).window
		const previousCustomEvent = (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
		const previousWarn = console.warn
		let fakeWindowWithSigner: { ethereum: { isMetamask?: boolean, [key: string]: unknown } } | undefined
		const { fakeWindow, sendBackgroundMessage, signerRequests } = createFakeWindow({
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
			await waitFor(() => signerRequests.includes('eth_chainId'))
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'accountsChanged',
				result: ['0x1111111111111111111111111111111111111111'],
			})
			await waitFor(() => (fakeWindow.ethereum as { selectedAddress?: unknown }).selectedAddress === '0x1111111111111111111111111111111111111111')
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
})
