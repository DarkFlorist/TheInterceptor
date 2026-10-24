// The last test here moves to inpageAccountEvents.test.ts together with the inpage listener-error fix whose new behaviour it asserts; that change deletes this file.
import * as assert from 'assert'
import { describe, test } from 'bun:test'

type WindowEvent = { type: string, data?: unknown, detail?: unknown, ports?: readonly MessagePort[], origin?: string, source?: unknown }
type Listener = (event: WindowEvent) => void
type InpageRequest = { readonly method: string, readonly requestId: number, readonly params?: readonly unknown[], readonly internal?: true, readonly replayOnDisconnect?: true }
type SignerRequest = { readonly method: string, readonly params?: readonly unknown[] | Readonly<Record<string, unknown>> }
type FakeWindowOptions = {
	readonly onConnectedToSignerRequest?: () => void
	readonly handleRequest?: (request: InpageRequest, sendBackgroundMessage: (data: unknown) => void) => boolean
	readonly handleSignerRequest?: (request: SignerRequest) => unknown | Promise<unknown>
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
		request: async ({ method, params }: SignerRequest) => {
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
		location: { origin: 'https://safe-app.example' },
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
			if (isRecord(data) && data.type === 'interceptor_bridge_port') {
				const port = transfer?.find((item): item is MessagePort => item instanceof MessagePort)
				if (port === undefined) throw new Error('missing bridge port')
				bridgePort = port
				bridgePort.onmessage = (event: MessageEvent<unknown>) => handleInpageRequest(event.data)
				return
			}
			queueMicrotask(() => fakeWindow.dispatchEvent({ type: 'message', data, origin: fakeWindow.location.origin, source: fakeWindow }))
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

})

