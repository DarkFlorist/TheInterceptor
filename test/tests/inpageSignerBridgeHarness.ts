// Shared fake page and fake background for the inpage signer bridge tests (the test/tests/inpage*.test.ts files that load app/inpage/ts/inpage.ts).
//
// Usage:
//   const { fakeWindow, sendBackgroundMessage } = createFakeWindow({ handleRequest: (request) => request.method === 'eth_sendTransaction' })   // the test answers these itself through sendBackgroundMessage
//   await withFakeInpageWindow(fakeWindow, 'unique-scenario-tag', async () => {
//   	const provider = getPageProvider(fakeWindow)     // the window.ethereum that inpage.ts installed
//   	assert.equal(await provider.request({ method: 'eth_chainId' }), '0x1')
//   })
//
// inpage.ts is a classic script that installs its provider when it runs, so every scenario imports a fresh copy through a unique `?tag` import suffix while the fake window is installed as globalThis.window.
//
// createFakeWindow plays both sides of the page: the dapp window (events, postMessage and an injected fake MetaMask signer) and the background script behind the bridge MessagePort. handleRequest sees every bridge request first and returns true when it answered or deliberately swallowed it; otherwise the default background replies in handleInpageRequest answer.
import { isObjectWithOptionalProperties, type PropertiesOf } from '../harness/assertions.js'
import { replaceGlobal } from '../harness/globals.js'

export type PageEvent = { readonly type: string, readonly data?: unknown, readonly detail?: unknown, readonly ports?: readonly MessagePort[], readonly origin?: string, readonly source?: unknown }
export type PageEventListener = (event: PageEvent) => void
export type InpageRequest = { readonly method: string, readonly requestId: number, readonly params?: readonly unknown[], readonly internal?: true, readonly replayOnDisconnect?: true }
export type SignerRequest = { readonly method: string, readonly params?: readonly unknown[] | Readonly<Record<string, unknown>> }
export type SendBackgroundMessage = (data: unknown) => void

export type FakePageWindow = {
	// Starts as the fake signer; inpage.ts replaces it with the Interceptor provider, and tests replace or delete it to model other wallets.
	ethereum?: unknown
	web3?: unknown
	readonly location: { readonly origin: string }
	readonly addEventListener: (type: string, listener: PageEventListener) => void
	readonly removeEventListener: (type: string, listener: PageEventListener) => void
	readonly dispatchEvent: (event: PageEvent) => boolean
	readonly postMessage: (data: unknown, targetOrigin?: string, transfer?: readonly Transferable[]) => void
}

type FakeWindowOptions = {
	readonly onConnectedToSignerRequest?: () => void
	readonly handleRequest?: (request: InpageRequest, sendBackgroundMessage: SendBackgroundMessage) => boolean
	// Returns the fake signer's answer for a request, or undefined to fall back to the default fake MetaMask answers.
	readonly handleSignerRequest?: (request: SignerRequest) => unknown
	readonly signerChainIdReply?: unknown
	readonly signerInitialSelectedAddress?: string
}

// These guards only reject non-objects (see isObjectWithOptionalProperties); they let tests read message fields without casts or index-signature access.
const createPropertiesGuard = <Keys extends string>() => (value: unknown): value is PropertiesOf<Keys> => isObjectWithOptionalProperties<Keys>(value)

const isBridgeRequestCandidate = createPropertiesGuard<'type' | 'method' | 'params' | 'requestId' | 'usingInterceptorWithoutSigner' | 'internal' | 'replayOnDisconnect'>()
const isMessageWithType = createPropertiesGuard<'type'>()
export const isRpcErrorCandidate = createPropertiesGuard<'code' | 'message' | 'data'>()
export const isSignerReplyCandidate = createPropertiesGuard<'success' | 'reply' | 'error' | 'forwardRequest' | 'signerProviderGeneration'>()
export const isForwardRequestCandidate = createPropertiesGuard<'requestId' | 'method' | 'params'>()
export const isChainSwitchReplyCandidate = createPropertiesGuard<'accept' | 'chainId' | 'walletSwitchRequestId' | 'error'>()
export const isEthAccountsReplyCandidate = createPropertiesGuard<'type' | 'accounts' | 'requestAccounts' | 'error' | 'signerProviderGeneration' | 'signerUnavailable'>()
export const isSafeAppsEnvelopeCandidate = createPropertiesGuard<'method' | 'params' | 'safeRequestContext'>()
const isSafeAppsReplyCandidate = createPropertiesGuard<'id' | 'success' | 'data' | 'error' | 'version'>()
export const isJsonRpcResponseCandidate = createPropertiesGuard<'jsonrpc' | 'id' | 'result' | 'error'>()

export type SafeAppsReply = PropertiesOf<'id' | 'data' | 'error' | 'version'> & { readonly success: boolean }
export type EthAccountsReplyCandidate = PropertiesOf<'type' | 'accounts' | 'requestAccounts' | 'error' | 'signerProviderGeneration' | 'signerUnavailable'>

// Safe Apps SDK replies are the window messages that carry a boolean success flag.
export const isSafeAppsReply = (value: unknown): value is SafeAppsReply => isSafeAppsReplyCandidate(value) && typeof value.success === 'boolean'

export function getRpcError(value: unknown) {
	if (!isRpcErrorCandidate(value)) throw new Error('Expected a JSON-RPC error object')
	return value
}

// Reads the signer_reply notification that inpage.ts sends once the signer answered a forwarded request.
export function parseSignerReply(request: InpageRequest) {
	const signerReply = request.params?.[0]
	if (!isSignerReplyCandidate(signerReply) || !isForwardRequestCandidate(signerReply.forwardRequest) || typeof signerReply.forwardRequest.requestId !== 'number') throw new Error('Malformed signer reply')
	return { ...signerReply, forwardRequest: { ...signerReply.forwardRequest, requestId: signerReply.forwardRequest.requestId } }
}

function parseInpageRequest(value: unknown): InpageRequest | undefined {
	if (!isBridgeRequestCandidate(value)) return undefined
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
		...(value.internal === true ? { internal: value.internal } : {}),
		...(value.replayOnDisconnect === true ? { replayOnDisconnect: value.replayOnDisconnect } : {}),
	}
}

export function createFakeWindow({ onConnectedToSignerRequest, handleRequest, handleSignerRequest, signerChainIdReply = '0x1', signerInitialSelectedAddress }: FakeWindowOptions = {}) {
	const listeners = new Map<string, Set<PageEventListener>>()
	const signerRequests: string[] = []
	const backgroundEthAccountsReplies: EthAccountsReplyCandidate[] = []
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

	const fakeWindow: FakePageWindow = {
		ethereum: fakeSigner,
		location: { origin: 'https://safe-app.example' },
		...(signerInitialSelectedAddress === undefined ? {} : { web3: { accounts: [signerInitialSelectedAddress], currentProvider: fakeSigner } }),
		addEventListener: (type, listener) => {
			const existing = listeners.get(type)
			if (existing === undefined) {
				listeners.set(type, new Set([listener]))
				return
			}
			existing.add(listener)
		},
		removeEventListener: (type, listener) => {
			listeners.get(type)?.delete(listener)
		},
		dispatchEvent: (event) => {
			for (const listener of listeners.get(event.type) ?? []) listener(event)
			return true
		},
		postMessage: (data, _targetOrigin, transfer) => {
			if (isMessageWithType(data) && data.type === 'interceptor_bridge_port') {
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
				case 'eth_accounts_reply': {
					const accountsReply = request.params?.[0]
					backgroundEthAccountsReplies.push(isEthAccountsReplyCandidate(accountsReply) ? accountsReply : {})
					sendBackgroundMessage({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'result',
						method: 'eth_accounts_reply',
						result: undefined,
					})
					return
				}
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
		// The wallet provider that the page exposed as window.ethereum before inpage.ts ran.
		fakeSigner,
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

// Installs the fake window as globalThis.window and runs a fresh copy of inpage.ts, imported with the unique importTag query so earlier scenarios do not share its state.
export async function withFakeInpageWindow<T>(fakeWindow: FakePageWindow, importTag: string, runTest: () => Promise<T>) {
	const restoreWindow = replaceGlobal('window', fakeWindow)
	try {
		// The import announces the provider with new CustomEvent('eip6963:announceProvider'); the tests run only under Bun, whose CustomEvent is native, so no shim is needed.
		await import(`../../app/inpage/ts/inpage.js?${ importTag }`)
		return await runTest()
	} finally {
		restoreWindow()
	}
}

// inpage.ts rethrows an error from a dapp event listener on a zero-delay timer, so the page sees it as its own uncaught error. Such an uncaught timer error would fail the bun test run, so this wraps setTimeout and collects every error a timer callback throws instead; call restore() when the test ends.
export function captureTimerCallbackErrors() {
	const errors: unknown[] = []
	const realSetTimeout = globalThis.setTimeout
	const restore = replaceGlobal('setTimeout', (callback: () => void, delay?: number) => realSetTimeout(() => {
		try {
			callback()
		} catch (error: unknown) {
			errors.push(error)
		}
	}, delay))
	return { errors, restore }
}

// Lets queued page work run once before a test checks that nothing else happened: bridge MessagePort deliveries, the microtasks they queue and zero-delay timers that are already due. flushMicrotasks from test/harness/async.ts runs before due timers, so it would not wait for the zero-delay timers some fake background handlers use.
export async function waitOneEventLoopTurn() {
	await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
}

export type ProviderRequestPayload = { readonly method: string, readonly params?: readonly unknown[] | Readonly<Record<string, unknown>> }
export type JsonRpcResponse = PropertiesOf<'jsonrpc' | 'id' | 'result' | 'error'>

// Typed access to the window.ethereum object that inpage.ts installed. Methods and properties are read from that object when used, like a dapp holding a reference to window.ethereum would.
export function getPageProvider(fakeWindow: FakePageWindow) {
	const provider = fakeWindow.ethereum
	if (typeof provider !== 'object' || provider === null) throw new Error('window.ethereum is not an object')
	const callMethod = (name: string, ...args: readonly unknown[]): unknown => {
		const method: unknown = Reflect.get(provider, name)
		if (typeof method !== 'function') throw new Error(`window.ethereum.${ name } is not a function`)
		return Reflect.apply(method, provider, args)
	}
	return {
		object: provider,
		request: async (payload: ProviderRequestPayload): Promise<unknown> => await callMethod('request', payload),
		send: (payload: unknown): JsonRpcResponse => {
			const response = callMethod('send', payload)
			if (!isJsonRpcResponseCandidate(response)) throw new Error('window.ethereum.send did not return a JSON-RPC response object')
			return response
		},
		sendAsync: async (payload: unknown, callback: (error: unknown, response: unknown) => void): Promise<unknown> => await callMethod('sendAsync', payload, callback),
		on: (eventName: string, callback: (value: unknown) => void) => { callMethod('on', eventName, callback) },
		isConnected: (): unknown => callMethod('isConnected'),
		get selectedAddress(): unknown { return Reflect.get(provider, 'selectedAddress') },
		get chainId(): unknown { return Reflect.get(provider, 'chainId') },
		get networkVersion(): unknown { return Reflect.get(provider, 'networkVersion') },
		get isInterceptor(): unknown { return Reflect.get(provider, 'isInterceptor') },
		get isMetaMask(): unknown { return Reflect.get(provider, 'isMetaMask') },
	}
}
