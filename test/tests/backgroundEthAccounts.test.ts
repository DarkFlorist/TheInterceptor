import * as assert from 'assert'
import { describe, test } from 'bun:test'
import type { ResetSimulationServices } from '../../app/ts/simulation/serviceLifecycle.js'
import { EthereumJSONRpcRequestHandler } from '../../app/ts/simulation/services/EthereumJSONRpcRequestHandler.js'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import { TokenPriceService } from '../../app/ts/simulation/services/priceEstimator.js'
import type { RpcEntry } from '../../app/ts/types/rpc.js'
import type { PublishRpcConnectionStatus } from '../../app/ts/background/rpcSlowRequestTracking.js'
import type { WebsiteTabConnections } from '../../app/ts/types/user-interface-types.js'

type Listener = () => void
type PortMessage = { type?: unknown, method?: unknown, result?: unknown, requestId?: unknown, error?: { code?: unknown, message?: unknown } }
const noopPublishRpcConnectionStatus: PublishRpcConnectionStatus = async () => undefined
const ADDRESS_PROMPT_TIMEOUT_MS = 100

function createDeferredSignal() {
	let resolveSignal = () => undefined
	const promise = new Promise<void>((resolve) => { resolveSignal = resolve })
	return { promise, resolve: () => resolveSignal() }
}

function installBrowserMock({ deferFirstChainChangeRemoval = false } = {}) {
	const storageState: Record<string, unknown> = {}
	const chainChangeRemovalStarted = createDeferredSignal()
	const chainChangeRemovalRelease = createDeferredSignal()
	let chainChangeRemovalDeferred = false
	;(globalThis as typeof globalThis & { browser: typeof globalThis.browser }).browser = {
		runtime: {
			lastError: null,
			async sendMessage() {
				return undefined
			},
			getManifest: () => ({ manifest_version: 3 }),
			onMessage: { addListener: (_listener: Listener) => undefined, removeListener: (_listener: Listener) => undefined },
			onConnect: { addListener: (_listener: Listener) => undefined, removeListener: (_listener: Listener) => undefined },
		},
		storage: {
			local: {
				async get(keys?: string | string[] | Record<string, unknown> | null) {
					if (keys === undefined || keys === null) return { ...storageState }
					if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => key in storageState).map((key) => [key, storageState[key]]))
					if (typeof keys === 'string') return keys in storageState ? { [keys]: storageState[keys] } : {}
					return Object.fromEntries(Object.entries(keys).map(([key, defaultValue]) => [key, key in storageState ? storageState[key] : defaultValue]))
				},
				async set(items: Record<string, unknown>) {
					Object.assign(storageState, items)
				},
				async remove(keys: string | string[]) {
					const keysToRemove = Array.isArray(keys) ? keys : [keys]
					if (deferFirstChainChangeRemoval && !chainChangeRemovalDeferred && keysToRemove.includes('chainChangeConfirmationPromise')) {
						chainChangeRemovalDeferred = true
						chainChangeRemovalStarted.resolve()
						await chainChangeRemovalRelease.promise
					}
					for (const key of keysToRemove) delete storageState[key]
				},
			},
		},
		tabs: {
			async query() { return [] },
			async create() { return { id: 2, active: true } },
			async get(tabId: number) { return { id: tabId, active: true, status: 'complete' as const } },
			async update() { return undefined },
			async remove() { return undefined },
			onUpdated: { addListener: (_listener: Listener) => undefined, removeListener: (_listener: Listener) => undefined },
			onRemoved: { addListener: (_listener: Listener) => undefined, removeListener: (_listener: Listener) => undefined },
		},
		windows: {
			async create() { return { id: 2, focused: true } },
			async get(windowId: number) { return { id: windowId, focused: true } },
			async update() { return undefined },
			async remove() { return undefined },
			onRemoved: { addListener: (_listener: Listener) => undefined, removeListener: (_listener: Listener) => undefined },
		},
		action: {
			async setIcon() { return undefined },
			async setTitle() { return undefined },
			async setBadgeText() { return undefined },
			async setBadgeBackgroundColor() { return undefined },
		},
		browserAction: {
			async setIcon() { return undefined },
			async setTitle() { return undefined },
			async setBadgeText() { return undefined },
			async setBadgeBackgroundColor() { return undefined },
		},
		declarativeNetRequest: {
			async getDynamicRules() { return [] },
			async getSessionRules() { return [] },
			async updateDynamicRules() { return undefined },
			async updateSessionRules() { return undefined },
		},
	} as unknown as typeof globalThis.browser
	;(globalThis as typeof globalThis & { chrome: { runtime: { id: string } } }).chrome = { runtime: { id: 'test-extension' } }
	;(globalThis as typeof globalThis & { location: Location }).location = { origin: '' } as unknown as Location
	return {
		waitForDeferredChainChangeRemoval: async () => await chainChangeRemovalStarted.promise,
		releaseDeferredChainChangeRemoval: chainChangeRemovalRelease.resolve,
	}
}

async function loadModules() {
	return {
		...await import('../../app/ts/background/accessManagement.js'),
		...await import('../../app/ts/background/background.js'),
		...await import('../../app/ts/background/backgroundUtils.js'),
		...await import('../../app/ts/background/popupMessageHandlers.js'),
		...await import('../../app/ts/background/settings.js'),
		...await import('../../app/ts/background/storageVariables.js'),
		...await import('../../app/ts/background/websiteTabConnections.js'),
		...await import('../../app/ts/background/windows/changeChain.js'),
		...await import('../../app/ts/background/windows/interceptorAccess.js'),
		...await import('../../app/ts/background/signerStateOwnership.js'),
	}
}

function createPort(tabId: number, onPostMessage?: (message: PortMessage) => void, frameId?: number, connectionName = 0n) {
	const messages: PortMessage[] = []
	const port = {
		name: `0x${ connectionName.toString(16) }`,
		sender: { tab: { id: tabId }, ...(frameId === undefined ? {} : { frameId }) },
		postMessage(message: unknown) {
			const typedMessage = message as PortMessage
			messages.push(typedMessage)
			onPostMessage?.(typedMessage)
		},
	} as unknown as browser.runtime.Port
	return { port, messages }
}

function confirmedSignerOwnership(socket: { readonly connectionName: bigint }) {
	return {
		signerStateOwner: {
			connectionName: socket.connectionName,
			confirmed: true,
			generation: 1,
			providerGeneration: 1,
		},
	}
}

async function waitForPortMessageCount(messages: readonly PortMessage[], method: string, count: number, timeoutMs = 100) {
	const deadline = Date.now() + timeoutMs
	while (messages.filter((message) => message.method === method).length < count) {
		if (Date.now() >= deadline) throw new Error(`Missing ${ method } port message`)
		await new Promise((resolve) => setTimeout(resolve, 0))
	}
}

async function waitForPendingAddressRequest<T extends { requestAccessToAddress?: { address?: bigint } }>(
	getPendingAccessRequests: () => Promise<readonly T[]>,
	account: bigint,
	timeoutMs = ADDRESS_PROMPT_TIMEOUT_MS,
): Promise<T> {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		const pendingRequest = (await getPendingAccessRequests())[0]
		if (pendingRequest?.requestAccessToAddress?.address === account) return pendingRequest
		if (Date.now() >= deadline) throw new Error('Missing address-level pending request')
		await new Promise((resolve) => setTimeout(resolve, 0))
	}
}

function createEthereumWithGetBlockCounter(getBlockCalls: { count: number }, initialBlockPolling = true) {
	const rpcEntry: RpcEntry = {
		name: 'Test RPC',
		chainId: 1n,
		httpsRpc: 'http://127.0.0.1:8545',
		currencyName: 'Ether',
		currencyTicker: 'ETH',
		primary: true,
		minimized: false,
	}
	let blockPolling = initialBlockPolling
	const ethereum = new Proxy(
		new EthereumClientService(
			new EthereumJSONRpcRequestHandler(rpcEntry.httpsRpc),
			async () => undefined,
			async () => undefined,
			rpcEntry,
	),
		{
			get(target, property, receiver) {
				if (property === 'isBlockPolling') return () => blockPolling
				if (property === 'setBlockPolling') return (enabled: boolean) => {
					blockPolling = enabled
				}
				if (property === 'getBlock') {
					return async () => {
						getBlockCalls.count += 1
						return null
					}
				}
				return Reflect.get(target, property, receiver)
			},
		},
	)
	return {
		ethereum,
		tokenPriceService: new TokenPriceService(ethereum, 60_000),
		resetSimulationServices: (() => undefined) satisfies ResetSimulationServices,
	}
}

describe('background eth_accounts', () => {
	test('reject public calls to internal provider callback methods', async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, updateWebsiteAccess, getTabState, changeSimulationMode, setUseSignersAddressAsActiveAddress } = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		for (const [index, method] of [
			'connected_to_signer',
			'eth_accounts_reply',
			'InterceptorError',
			'signer_chainChanged',
			'signer_reply',
			'wallet_switchEthereumChain_reply',
		].entries()) {
			await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
				interceptorRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: index + 1, requestSocket: socket },
				method,
				params: [],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
			const reply = messages.at(-1)
			assert.equal(reply?.method, method)
			assert.equal(reply?.requestId, index + 1)
			assert.equal(reply?.error?.code, -32601)
		}

		assert.deepEqual((await getTabState(socket.tabId)).signerAccounts, [])
	})

	test('allow marked internal eth_accounts_reply callbacks', async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, updateWebsiteAccess, getTabState, changeSimulationMode, setUseSignersAddressAsActiveAddress } = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x3333333333333333333333333333333333333333n
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 9, requestSocket: socket },
			method: 'eth_accounts_reply',
params: [{ signerProviderGeneration: 1, type: 'success', accounts: ['0x3333333333333333333333333333333333333333'], requestAccounts: false }],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		const reply = messages.at(-1)
		assert.equal(reply?.method, 'eth_accounts_reply')
		assert.equal(reply?.requestId, 9)
		assert.equal(reply?.result, '0x')
		const tabState = await getTabState(socket.tabId)
		assert.deepEqual(tabState.signerAccounts, [account])
		assert.equal(tabState.activeSigningAddress, account)
	})

	test('normalizes signer state before access and keeps unavailable discovery out of provider warnings', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			updateWebsiteAccess,
			updateTabState,
			getTabState,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const staleAccount = 0x4444444444444444444444444444444444444444n
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: staleAccount })
		await setUseSignersAddressAsActiveAddress(false)

		const socket = { tabId: 1, connectionName: 0n }
		const childSocket = { tabId: 1, connectionName: 1n }
		await updateTabState(socket.tabId, (previousState) => ({
			...previousState,
			signerName: 'MetaMask',
			signerConnected: true,
			signerAccounts: [staleAccount],
			signerChain: 1n,
			signerAccountError: { code: 4001, message: 'Stale signer error' },
			activeSigningAddress: staleAccount,
		}))
		const { port, messages } = createPort(socket.tabId, undefined, 0)
		const { port: childPort, messages: childMessages } = createPort(childSocket.tabId, undefined, 1)
		const connectionKey = websiteSocketToString(socket)
		const childConnectionKey = websiteSocketToString(childSocket)
		const connection = { port, socket, websiteOrigin, approved: false, wantsToConnect: true }
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: connection,
			[childConnectionKey]: { port: childPort, socket: childSocket, websiteOrigin, approved: false, wantsToConnect: false },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: true,
			uniqueRequestIdentifier: { requestId: 90, requestSocket: socket },
			method: 'connected_to_signer',
			params: [false, 'NoSigner', 2],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		const noSignerState = await getTabState(socket.tabId)
		assert.equal(noSignerState.signerName, 'NoSigner')
		assert.equal(noSignerState.signerConnected, false)
		assert.deepEqual(noSignerState.signerAccounts, [])
		assert.equal(noSignerState.signerChain, undefined)
		assert.equal(noSignerState.signerAccountError, undefined)
		assert.equal(noSignerState.activeSigningAddress, undefined)
		assert.equal(messages.some((message) => message.method === 'request_signer_chainId'), false)

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: true,
			uniqueRequestIdentifier: { requestId: 91, requestSocket: socket },
			method: 'eth_accounts_reply',
			params: [{
				signerProviderGeneration: 2,
				type: 'error',
				requestAccounts: false,
				signerUnavailable: true,
				error: { code: 4900, message: 'No signer wallet is available to this page. Enable your wallet extension for this site, then try again.' },
			}],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		assert.equal((await getTabState(socket.tabId)).signerAccountError, undefined)

		// Signer identity is trusted extension state and must be current before the website receives access.
		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 92, requestSocket: socket },
			method: 'connected_to_signer',
			params: [true, 'MetaMask', 3],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		const identifiedSignerState = await getTabState(socket.tabId)
		assert.equal(identifiedSignerState.signerName, 'MetaMask')
		assert.equal(identifiedSignerState.signerConnected, true)
		assert.equal(messages.some((message) => message.method === 'request_signer_chainId'), false)

		await handleInterceptedRequest(childPort, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, childSocket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: true,
			uniqueRequestIdentifier: { requestId: 94, requestSocket: childSocket },
			method: 'connected_to_signer',
			params: [false, 'NoSigner', 4],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		const stateAfterChildFrame = await getTabState(socket.tabId)
		assert.equal(stateAfterChildFrame.signerName, 'MetaMask')
		assert.equal(stateAfterChildFrame.signerConnected, true)
		assert.equal(childMessages.some((message) => message.method === 'request_signer_chainId'), false)

		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])
		connection.approved = true
		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 93, requestSocket: socket },
			method: 'eth_accounts_reply',
			params: [{ signerProviderGeneration: 3, type: 'error', requestAccounts: false, error: { code: 4900, message: 'MetaMask disconnected' } }],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		const signerErrorState = await getTabState(socket.tabId)
		assert.equal(signerErrorState.signerName, 'MetaMask')
		assert.equal(signerErrorState.signerConnected, true)
		assert.deepEqual(signerErrorState.signerAccountError, { code: 4900, message: 'MetaMask disconnected' })
	})

	test('refreshes accounts after signer identity or page ownership changes', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			updateWebsiteAccess,
			updateTabState,
			getTabState,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			createInternalMessageListener,
			INTERNAL_CHANNEL_NAME,
			registerWebsiteConnectionAndProvisionallyClaimSignerState,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const braveAccount = 0x4141414141414141414141414141414141414141n
		const metaMaskAccount = 0x4242424242424242424242424242424242424242n
		const metaMaskAccountString = '0x4242424242424242424242424242424242424242'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: braveAccount })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: metaMaskAccount, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		const signerAccountSnapshots: bigint[][] = []
		const { port: createdPort, messages } = createPort(socket.tabId, (message) => {
			if (message.method !== 'request_signer_to_eth_requestAccounts') return
			void (async () => {
				signerAccountSnapshots.push([...(await getTabState(socket.tabId)).signerAccounts])
				await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
					interceptorRequest: true,
					interceptorInternalRequest: true,
					usingInterceptorWithoutSigner: false,
					uniqueRequestIdentifier: { requestId: 202, requestSocket: socket },
					method: 'eth_accounts_reply',
					params: [{ signerProviderGeneration: 2, type: 'success', accounts: [metaMaskAccountString], requestAccounts: true }],
				}, websiteTabConnections, noopPublishRpcConnectionStatus)
			})()
		}, 0)
		const port = createdPort
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		await updateTabState(socket.tabId, (previousState) => ({
			...previousState,
			signerName: 'Brave',
			signerConnected: true,
			signerAccounts: [braveAccount],
			signerChain: 1n,
			signerAccountError: { code: 4001, message: 'Stale Brave error' },
			activeSigningAddress: braveAccount,
		}))

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 200, requestSocket: socket },
			method: 'connected_to_signer',
			params: [true, 'MetaMask', 2],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		const stateAfterMetaMaskSelection = await getTabState(socket.tabId)
		assert.equal(stateAfterMetaMaskSelection.signerName, 'MetaMask')
		assert.equal(stateAfterMetaMaskSelection.signerConnected, true)
		assert.deepEqual(stateAfterMetaMaskSelection.signerAccounts, [])
		assert.equal(stateAfterMetaMaskSelection.signerChain, undefined)
		assert.equal(stateAfterMetaMaskSelection.signerAccountError, undefined)
		assert.equal(stateAfterMetaMaskSelection.activeSigningAddress, undefined)

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 201, requestSocket: socket },
			method: 'eth_requestAccounts',
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.deepEqual(signerAccountSnapshots, [[]])
		assert.equal(messages.filter((message) => message.method === 'request_signer_to_eth_requestAccounts').length, 1)
		assert.deepEqual(messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 201).at(-1)?.result, [metaMaskAccountString])
		assert.deepEqual((await getTabState(socket.tabId)).signerAccounts, [metaMaskAccount])

		const nextSocket = { tabId: socket.tabId, connectionName: 1n }
		const { port: nextPort } = createPort(nextSocket.tabId, undefined, 0, nextSocket.connectionName)
		const tabConnection = websiteTabConnections.get(nextSocket.tabId)
		if (tabConnection === undefined) throw new Error('Missing tab connection')
		await registerWebsiteConnectionAndProvisionallyClaimSignerState(
			websiteTabConnections,
			nextSocket,
			{ port: nextPort, socket: nextSocket, websiteOrigin, approved: true, wantsToConnect: true },
			true,
		)
		await handleInterceptedRequest(nextPort, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, nextSocket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 203, requestSocket: nextSocket },
			method: 'connected_to_signer',
			params: [true, 'MetaMask', 1],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		const stateAfterNewPageConnection = await getTabState(nextSocket.tabId)
		assert.equal(stateAfterNewPageConnection.signerName, 'MetaMask')
		assert.equal(stateAfterNewPageConnection.signerConnected, true)
		assert.deepEqual(stateAfterNewPageConnection.signerAccounts, [])
		assert.equal(stateAfterNewPageConnection.signerChain, undefined)
		assert.equal(stateAfterNewPageConnection.signerAccountError, undefined)
		assert.equal(stateAfterNewPageConnection.activeSigningAddress, undefined)

		const currentSignerError = { code: 4001, message: 'Current MetaMask error' }
		await updateTabState(nextSocket.tabId, (previousState) => ({
			...previousState,
			signerAccounts: [metaMaskAccount],
			signerChain: 5n,
			signerAccountError: currentSignerError,
			activeSigningAddress: metaMaskAccount,
		}))
		const staleAccountCompletionErrors: Array<{ code: number, message: string } | undefined> = []
		const completionChannel = new BroadcastChannel(INTERNAL_CHANNEL_NAME)
		const completionListener = createInternalMessageListener((message) => {
			if (message.method !== 'window_signer_accounts_changed') return
			if (message.data.socket.connectionName !== socket.connectionName) return
			staleAccountCompletionErrors.push(message.data.error)
		})
		completionChannel.addEventListener('message', completionListener)
		try {
			await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
				interceptorRequest: true,
				interceptorInternalRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 204, requestSocket: socket },
				method: 'eth_accounts_reply',
				params: [{ signerProviderGeneration: 1, type: 'success', accounts: ['0x4141414141414141414141414141414141414141'], requestAccounts: true }],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
			await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
				interceptorRequest: true,
				interceptorInternalRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 205, requestSocket: socket },
				method: 'eth_accounts_reply',
				params: [{ signerProviderGeneration: 1, type: 'error', requestAccounts: true, error: { code: 4001, message: 'Late Brave error' } }],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
			await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
				interceptorRequest: true,
				interceptorInternalRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 206, requestSocket: socket },
				method: 'signer_chainChanged',
				params: ['0x2', 2],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
			const completionDeadline = Date.now() + 100
			while (staleAccountCompletionErrors.length < 2 && Date.now() < completionDeadline) await new Promise((resolve) => setTimeout(resolve, 0))
		} finally {
			completionChannel.removeEventListener('message', completionListener)
			completionChannel.close()
		}

		assert.deepEqual(staleAccountCompletionErrors, [])
		assert.equal(tabConnection.signerStateOwner?.connectionName, nextSocket.connectionName)
		const stateAfterStaleReplies = await getTabState(nextSocket.tabId)
		assert.deepEqual(stateAfterStaleReplies.signerAccounts, [metaMaskAccount])
		assert.equal(stateAfterStaleReplies.activeSigningAddress, metaMaskAccount)
		assert.equal(stateAfterStaleReplies.signerChain, 5n)
		assert.deepEqual(stateAfterStaleReplies.signerAccountError, currentSignerError)
	})

	test('waits for provisional page ownership before reading or requesting signer accounts', async () => {
		installBrowserMock()
		const {
			changeSimulationMode,
			getTabState,
			handleInterceptedRequest,
			registerWebsiteConnectionAndProvisionallyClaimSignerState,
			setUseSignersAddressAsActiveAddress,
			updateTabState,
			updateWebsiteAccess,
			websiteSocketToString,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const staleAccount = 0x5151515151515151515151515151515151515151n
		const currentAccount = 0x5252525252525252525252525252525252525252n
		const currentAccountString = '0x5252525252525252525252525252525252525252'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: staleAccount })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: currentAccount, access: true }] }])

		const previousSocket = { tabId: 1, connectionName: 50n }
		const restoredSocket = { tabId: 1, connectionName: 51n }
		const { port: previousPort } = createPort(previousSocket.tabId, undefined, 0, previousSocket.connectionName)
		let restoredPort: browser.runtime.Port
		const { port: createdRestoredPort, messages } = createPort(restoredSocket.tabId, (message) => {
			if (message.method !== 'request_signer_to_eth_accounts') return
			void handleInterceptedRequest(restoredPort, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, restoredSocket, {
				interceptorRequest: true,
				interceptorInternalRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 302, requestSocket: restoredSocket },
				method: 'eth_accounts_reply',
				params: [{ signerProviderGeneration: 1, type: 'success', accounts: [currentAccountString], requestAccounts: false }],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
		}, 0, restoredSocket.connectionName)
		restoredPort = createdRestoredPort
		const websiteTabConnections = new Map([[restoredSocket.tabId, {
			signerStateOwner: {
				connectionName: previousSocket.connectionName,
				confirmed: true,
				generation: 1,
				providerGeneration: 7,
			},
			connections: {
				[websiteSocketToString(previousSocket)]: { port: previousPort, socket: previousSocket, websiteOrigin, approved: true, wantsToConnect: true },
			},
		}]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		await updateTabState(restoredSocket.tabId, (previousState) => ({
			...previousState,
			signerName: 'MetaMask',
			signerConnected: true,
			signerAccounts: [staleAccount],
			signerChain: 1n,
			activeSigningAddress: staleAccount,
		}))
		await registerWebsiteConnectionAndProvisionallyClaimSignerState(
			websiteTabConnections,
			restoredSocket,
			{ port: restoredPort, socket: restoredSocket, websiteOrigin, approved: true, wantsToConnect: true },
			true,
		)

		const accountRequest = handleInterceptedRequest(restoredPort, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, restoredSocket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 300, requestSocket: restoredSocket },
			method: 'eth_accounts',
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		await new Promise((resolve) => setTimeout(resolve, 0))
		assert.equal(messages.some((message) => message.method === 'request_signer_to_eth_accounts'), false)
		assert.equal(messages.some((message) => message.method === 'eth_accounts' && message.requestId === 300), false)

		await handleInterceptedRequest(restoredPort, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, restoredSocket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 301, requestSocket: restoredSocket },
			method: 'connected_to_signer',
			params: [true, 'MetaMask', 1],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		await accountRequest

		assert.deepEqual(messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 300).at(-1)?.result, [currentAccountString])
		assert.deepEqual((await getTabState(restoredSocket.tabId)).signerAccounts, [currentAccount])
	})

	test('finishes the first account request when the signer changes on the same page port', async () => {
		installBrowserMock()
		const {
			changeSimulationMode,
			handleInterceptedRequest,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			websiteSocketToString,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x6060606060606060606060606060606060606060n
		const accountString = '0x6060606060606060606060606060606060606060'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])

		const socket = { tabId: 1, connectionName: 59n }
		let port: browser.runtime.Port
		let websiteTabConnections: WebsiteTabConnections
		const createdPort = createPort(socket.tabId, (message) => {
			if (message.method !== 'request_signer_to_eth_requestAccounts') return
			void (async () => {
				await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
					interceptorRequest: true,
					interceptorInternalRequest: true,
					usingInterceptorWithoutSigner: false,
					uniqueRequestIdentifier: { requestId: 308, requestSocket: socket },
					method: 'connected_to_signer',
					params: [true, 'MetaMask', 2],
				}, websiteTabConnections, noopPublishRpcConnectionStatus)
				await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
					interceptorRequest: true,
					interceptorInternalRequest: true,
					usingInterceptorWithoutSigner: false,
					uniqueRequestIdentifier: { requestId: 309, requestSocket: socket },
					method: 'eth_accounts_reply',
					params: [{ signerProviderGeneration: 2, type: 'success', accounts: [accountString], requestAccounts: true }],
				}, websiteTabConnections, noopPublishRpcConnectionStatus)
			})()
		}, 0, socket.connectionName)
		port = createdPort.port
		websiteTabConnections = new Map([[socket.tabId, {
			...confirmedSignerOwnership(socket),
			connections: {
				[websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
			},
		}]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: true,
			uniqueRequestIdentifier: { requestId: 307, requestSocket: socket },
			method: 'eth_requestAccounts',
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(createdPort.messages.filter((message) => message.method === 'request_signer_to_eth_requestAccounts').length, 1)
		assert.deepEqual(createdPort.messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 307).at(-1)?.result, [accountString])
	})

	test('rejects stale account and chain callbacks from an older signer epoch on the current port', async () => {
		installBrowserMock()
		const {
			changeSimulationMode,
			createInternalMessageListener,
			getTabState,
			handleInterceptedRequest,
			INTERNAL_CHANNEL_NAME,
			setUseSignersAddressAsActiveAddress,
			updateTabState,
			updateWebsiteAccess,
			websiteSocketToString,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const currentAccount = 0x6161616161616161616161616161616161616161n
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 60n }
		const { port } = createPort(socket.tabId, undefined, 0, socket.connectionName)
		const websiteTabConnections = new Map([[socket.tabId, {
			signerStateOwner: {
				connectionName: socket.connectionName,
				confirmed: true,
				generation: 4,
				providerGeneration: 2,
			},
			connections: {
				[websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
			},
		}]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const currentError = { code: 4001, message: 'Current signer error' }
		await updateTabState(socket.tabId, (previousState) => ({
			...previousState,
			signerName: 'MetaMask',
			signerConnected: true,
			signerAccounts: [currentAccount],
			signerChain: 5n,
			signerAccountError: currentError,
			activeSigningAddress: currentAccount,
		}))
		const completionErrors: Array<{ code: number, message: string } | undefined> = []
		const completionChannel = new BroadcastChannel(INTERNAL_CHANNEL_NAME)
		const completionListener = createInternalMessageListener((message) => {
			if (message.method === 'window_signer_accounts_changed' && message.data.socket.connectionName === socket.connectionName) completionErrors.push(message.data.error)
		})
		completionChannel.addEventListener('message', completionListener)
		try {
			for (const [requestId, params] of [
				[310, { signerProviderGeneration: 1, type: 'success', accounts: ['0x6262626262626262626262626262626262626262'], requestAccounts: true }],
				[311, { signerProviderGeneration: 1, type: 'error', requestAccounts: true, error: { code: 4900, message: 'Stale error' } }],
			] as const) {
				await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
					interceptorRequest: true,
					interceptorInternalRequest: true,
					usingInterceptorWithoutSigner: false,
					uniqueRequestIdentifier: { requestId, requestSocket: socket },
					method: 'eth_accounts_reply',
					params: [params],
				}, websiteTabConnections, noopPublishRpcConnectionStatus)
			}
			await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
				interceptorRequest: true,
				interceptorInternalRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 312, requestSocket: socket },
				method: 'signer_chainChanged',
				params: ['0x2', 1],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
			const completionDeadline = Date.now() + 100
			while (completionErrors.length < 2 && Date.now() < completionDeadline) await new Promise((resolve) => setTimeout(resolve, 0))
		} finally {
			completionChannel.removeEventListener('message', completionListener)
			completionChannel.close()
		}

		assert.deepEqual(completionErrors, [])
		const tabState = await getTabState(socket.tabId)
		assert.deepEqual(tabState.signerAccounts, [currentAccount])
		assert.equal(tabState.signerChain, 5n)
		assert.deepEqual(tabState.signerAccountError, currentError)
		assert.equal(tabState.activeSigningAddress, currentAccount)
	})

	test('skip simulation state refresh for eth_accounts in simulation mode', async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, changeSimulationMode, setUseSignersAddressAsActiveAddress, updateWebsiteAccess } = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x1111111111111111111111111111111111111111n
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const getBlockCalls = { count: 0 }
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter(getBlockCalls)
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 1, requestSocket: socket },
			method: 'eth_accounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(getBlockCalls.count, 0)
		assert.equal(messages.some((message) => message.method === 'request_signer_to_eth_accounts'), false)
		const ethAccountsReplies = messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 1)
		assert.deepEqual(ethAccountsReplies.at(-1)?.result, ['0x1111111111111111111111111111111111111111'])
	})

	test('site-approved eth_accounts returns empty accounts until address access is approved', async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, changeSimulationMode, setUseSignersAddressAsActiveAddress, updateWebsiteAccess } = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x1212121212121212121212121212121212121212n
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 2, requestSocket: socket },
			method: 'eth_accounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		const ethAccountsReplies = messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 2)
		assert.deepEqual(ethAccountsReplies.at(-1)?.result, [])
	})

	test('site-approved wallet_getPermissions returns no accounts until address access is approved', async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, changeSimulationMode, setUseSignersAddressAsActiveAddress, updateWebsiteAccess } = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x1313131313131313131313131313131313131313n
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 3, requestSocket: socket },
			method: 'wallet_getPermissions',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		const permissionsReplies = messages.filter((message) => message.method === 'wallet_getPermissions' && message.requestId === 3)
		assert.deepEqual(permissionsReplies.at(-1)?.result, [])
	})

	test('wallet_getPermissions returns empty when signer accounts are cached but address access is missing', async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, changeSimulationMode, setUseSignersAddressAsActiveAddress, updateWebsiteAccess, updateTabState } = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x1414141414141414141414141414141414141414n
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(true)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		await updateTabState(socket.tabId, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: undefined }))
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 4, requestSocket: socket },
			method: 'wallet_getPermissions',
		}

		await Promise.race([
			handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus),
			new Promise((_, reject) => setTimeout(() => reject(new Error('wallet_getPermissions did not resolve')), 100)),
		])

		const permissionsReplies = messages.filter((message) => message.method === 'wallet_getPermissions' && message.requestId === 4)
		assert.deepEqual(permissionsReplies.at(-1)?.result, [])
	})

	test('wallet_getPermissions returns the approved account when signer accounts are cached without an active signer address', async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, changeSimulationMode, setUseSignersAddressAsActiveAddress, updateWebsiteAccess, updateTabState } = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x1515151515151515151515151515151515151515n
		const accountString = '0x1515151515151515151515151515151515151515'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(true)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		await updateTabState(socket.tabId, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: undefined }))
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 5, requestSocket: socket },
			method: 'wallet_getPermissions',
		}

		await Promise.race([
			handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus),
			new Promise((_, reject) => setTimeout(() => reject(new Error('wallet_getPermissions did not resolve')), 100)),
		])

		const permissionsReplies = messages.filter((message) => message.method === 'wallet_getPermissions' && message.requestId === 5)
		assert.deepEqual(permissionsReplies.at(-1)?.result, [{
			parentCapability: 'eth_accounts',
			caveats: [{
				type: 'restrictReturnedAccounts',
				value: [accountString],
			}],
			invoker: websiteOrigin,
		}])
	})

	test('awaits retry-state publishing before replying to a waking RPC request', async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, changeSimulationMode, setUseSignersAddressAsActiveAddress, updateWebsiteAccess, setRpcConnectionStatus, getRpcConnectionStatus } = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x1111111111111111111111111111111111111111n
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 }, false)
		const rpcNetwork = ethereum.getRpcEntry()
		await setRpcConnectionStatus({
			isConnected: false,
			lastConnnectionAttempt: new Date('2024-01-01T00:00:00.000Z'),
			latestBlock: undefined,
			rpcNetwork,
			retrying: false,
		})
		const publishedRetryStates: boolean[] = []
		const publishRpcConnectionStatus: PublishRpcConnectionStatus = async (_method, rpcConnectionStatus) => {
			await new Promise((resolve) => setTimeout(resolve, 10))
			publishedRetryStates.push(rpcConnectionStatus.retrying)
			await setRpcConnectionStatus(rpcConnectionStatus)
		}
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 2, requestSocket: socket },
			method: 'eth_chainId',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, publishRpcConnectionStatus)

		assert.deepEqual(publishedRetryStates, [true])
		assert.equal((await getRpcConnectionStatus())?.retrying, true)
		const chainIdReplies = messages.filter((message) => message.method === 'eth_chainId' && message.requestId === 2)
		assert.equal(chainIdReplies.at(-1)?.result, 1n)
	})

	test('does not wait for retry-state publishing before replying to eth_requestAccounts', async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, changeSimulationMode, setUseSignersAddressAsActiveAddress, updateWebsiteAccess, setRpcConnectionStatus } = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x1111111111111111111111111111111111111111n
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 }, false)
		await setRpcConnectionStatus({
			isConnected: false,
			lastConnnectionAttempt: new Date('2024-01-01T00:00:00.000Z'),
			latestBlock: undefined,
			rpcNetwork: ethereum.getRpcEntry(),
			retrying: false,
		})
		let publishCalls = 0
		const publishRpcConnectionStatus: PublishRpcConnectionStatus = async () => {
			publishCalls += 1
			await new Promise(() => undefined)
		}
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 15, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, publishRpcConnectionStatus)

		assert.equal(publishCalls, 0)
		const requestAccountsReplies = messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 15)
		assert.deepEqual(requestAccountsReplies.at(-1)?.result, ['0x1111111111111111111111111111111111111111'])
	})

	test('refresh signer accounts for approved eth_accounts requests when the tab cache is empty', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			sendInternalWindowMessage,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			updateTabState,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x2222222222222222222222222222222222222222n
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId, (message) => {
			if (message.method !== 'request_signer_to_eth_accounts') return
			void (async () => {
				await updateTabState(socket.tabId, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: account }))
				sendInternalWindowMessage({
					method: 'window_signer_accounts_changed',
					data: { socket, signerStateOwnerGeneration: 1, signerProviderGeneration: 1 },
				})
			})()
		})
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 7, requestSocket: socket },
			method: 'eth_accounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(messages.filter((message) => message.method === 'request_signer_to_eth_accounts').length, 1)
		assert.equal(messages.some((message) => message.method === 'request_signer_to_eth_requestAccounts'), false)
		const ethAccountsReplies = messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 7)
		assert.deepEqual(ethAccountsReplies.at(-1)?.result, ['0x2222222222222222222222222222222222222222'])
	})

	test('routes one tab-wide signer refresh while serializing passive and interactive discovery', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			refreshSignerAccountsFromApprovedWebsitePorts,
			sendCallbackToConfirmedSignerOwner,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x2323232323232323232323232323232323232323n
		const accountString = '0x2323232323232323232323232323232323232323'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		const childSocket = { tabId: 1, connectionName: 1n }
		const { port, messages } = createPort(socket.tabId)
		const { port: childPort, messages: childMessages } = createPort(childSocket.tabId, undefined, 2, childSocket.connectionName)
		const connectionKey = websiteSocketToString(socket)
		const childConnectionKey = websiteSocketToString(childSocket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
			[childConnectionKey]: { port: childPort, socket: childSocket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const replyWithSignerAccounts = async (requestId: number, requestAccounts: boolean, accounts: readonly string[]) => {
			await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
				interceptorRequest: true,
				interceptorInternalRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId, requestSocket: socket },
				method: 'eth_accounts_reply',
				params: [{ signerProviderGeneration: 1, type: 'success', accounts, requestAccounts }],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
		}

		const passiveRequest = refreshSignerAccountsFromApprovedWebsitePorts(websiteTabConnections, false)
		await waitForPortMessageCount(messages, 'request_signer_to_eth_accounts', 1)

		const interactiveRequest = handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 71, requestSocket: socket },
			method: 'eth_requestAccounts',
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		await new Promise((resolve) => setTimeout(resolve, 0))
		const interactiveRequestsBeforePassiveReply = messages.filter((message) => message.method === 'request_signer_to_eth_requestAccounts').length

		await replyWithSignerAccounts(90, false, [])
		await waitForPortMessageCount(messages, 'request_signer_to_eth_requestAccounts', 1)
		await replyWithSignerAccounts(91, true, [accountString])
		await Promise.all([passiveRequest, interactiveRequest])

		assert.equal(interactiveRequestsBeforePassiveReply, 0)
		assert.equal(childMessages.some((message) => message.method === 'request_signer_to_eth_accounts' || message.method === 'request_signer_to_eth_requestAccounts'), false)
		assert.deepEqual(messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 71).at(-1)?.result, [accountString])
		const signerStateToken = sendCallbackToConfirmedSignerOwner(websiteTabConnections, socket.tabId, { method: 'request_signer_to_wallet_switchEthereumChain', result: 2n })
		assert.notEqual(signerStateToken, false)
		if (signerStateToken === false) throw new Error('Expected a confirmed signer owner')
		assert.equal(signerStateToken.port, port)
		assert.equal(messages.filter((message) => message.method === 'request_signer_to_wallet_switchEthereumChain').length, 1)
		assert.equal(childMessages.some((message) => message.method === 'request_signer_to_wallet_switchEthereumChain'), false)
	})

	test('uses an unapproved signer owner for tab-wide refresh when a sibling frame is approved', async () => {
		installBrowserMock()
		const {
			changeSimulationMode,
			handleInterceptedRequest,
			refreshSignerAccountsFromApprovedWebsitePorts,
			sendCallbackToConfirmedSignerOwner,
			setUseSignersAddressAsActiveAddress,
			websiteSocketToString,
			getTabState,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const socket = { tabId: 1, connectionName: 0n }
		const childSocket = { tabId: 1, connectionName: 1n }
		const { port, messages } = createPort(socket.tabId)
		const { port: childPort, messages: childMessages } = createPort(childSocket.tabId, undefined, 2, childSocket.connectionName)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: false, wantsToConnect: false },
			[websiteSocketToString(childSocket)]: { port: childPort, socket: childSocket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const account = '0x2424242424242424242424242424242424242424'
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)

		const refresh = refreshSignerAccountsFromApprovedWebsitePorts(websiteTabConnections, false)
		await waitForPortMessageCount(messages, 'request_signer_to_eth_accounts', 1)
		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 92, requestSocket: socket },
			method: 'eth_accounts_reply',
			params: [{ signerProviderGeneration: 1, type: 'success', accounts: [account], requestAccounts: false }],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		await refresh

		assert.deepEqual((await getTabState(socket.tabId)).signerAccounts, [0x2424242424242424242424242424242424242424n])
		assert.equal(childMessages.some((message) => message.method === 'request_signer_to_eth_accounts'), false)
		const signerStateToken = sendCallbackToConfirmedSignerOwner(websiteTabConnections, socket.tabId, { method: 'request_signer_to_wallet_switchEthereumChain', result: 2n })
		assert.notEqual(signerStateToken, false)
		assert.equal(messages.filter((message) => message.method === 'request_signer_to_wallet_switchEthereumChain').length, 1)
		assert.equal(childMessages.some((message) => message.method === 'request_signer_to_wallet_switchEthereumChain'), false)
		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 94, requestSocket: socket },
			method: 'signer_chainChanged',
			params: ['0x2', 1],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		assert.equal((await getTabState(socket.tabId)).signerChain, 2n)
	})

	test('settles a pending chain switch when its exact signer owner disconnects', async () => {
		installBrowserMock()
		const {
			changeSimulationMode,
			removeWebsiteTabConnection,
			resolveChainChange,
			setChainChangeConfirmationPromise,
			websiteSocketToString,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const ownerSocket = { tabId: 1, connectionName: 0n }
		const requestSocket = { tabId: 1, connectionName: 1n }
		const { port: ownerPort, messages: ownerMessages } = createPort(ownerSocket.tabId)
		const { port: requestPort, messages: requestMessages } = createPort(requestSocket.tabId, undefined, 2, requestSocket.connectionName)
		const websiteTabConnections = new Map([[ownerSocket.tabId, { ...confirmedSignerOwnership(ownerSocket), connections: {
			[websiteSocketToString(ownerSocket)]: { port: ownerPort, socket: ownerSocket, websiteOrigin, approved: false, wantsToConnect: false },
			[websiteSocketToString(requestSocket)]: { port: requestPort, socket: requestSocket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const currentRpcNetwork = {
			name: 'Current RPC',
			chainId: 1n,
			httpsRpc: 'https://current.example',
			currencyName: 'Ether',
			currencyTicker: 'ETH',
			primary: true,
			minimized: false,
		}
		const requestedRpcNetwork = {
			name: 'Requested RPC',
			chainId: 2n,
			httpsRpc: 'https://requested.example',
			currencyName: 'Ether',
			currencyTicker: 'ETH',
			primary: true,
			minimized: false,
		}
		const uniqueRequestIdentifier = { requestId: 93, requestSocket }
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier,
			method: 'wallet_switchEthereumChain' as const,
			params: [{ chainId: requestedRpcNetwork.chainId }],
		}
		await changeSimulationMode({ simulationMode: false, rpcNetwork: currentRpcNetwork, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setChainChangeConfirmationPromise({
			website,
			popupOrTabId: { type: 'popup', id: 9 },
			request,
			rpcNetwork: requestedRpcNetwork,
			simulationMode: false,
		})
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const resolution = resolveChainChange(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, {
			method: 'popup_changeChainDialog',
			data: { rpcNetwork: requestedRpcNetwork, uniqueRequestIdentifier, accept: true },
		})
		await waitForPortMessageCount(ownerMessages, 'request_signer_to_wallet_switchEthereumChain', 1)

		await removeWebsiteTabConnection(websiteTabConnections, ownerSocket, ownerPort)
		await resolution

		const reply = requestMessages.find((message) => message.method === 'wallet_switchEthereumChain' && message.requestId === uniqueRequestIdentifier.requestId)
		assert.equal(reply?.error?.code, 4900)
		assert.equal(reply?.error?.message, 'Signer connection changed before the previous wallet replied.')
	})

	test('accepts the exact solicited chain reply after the approving sibling disconnects', async () => {
		installBrowserMock()
		const {
			changeSimulationMode,
			handleInterceptedRequest,
			removeWebsiteTabConnection,
			resolveChainChange,
			setChainChangeConfirmationPromise,
			websiteSocketToString,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const ownerSocket = { tabId: 1, connectionName: 0n }
		const approvingSocket = { tabId: 1, connectionName: 1n }
		const requestSocket = { tabId: 1, connectionName: 2n }
		const { port: ownerPort, messages: ownerMessages } = createPort(ownerSocket.tabId)
		const { port: approvingPort } = createPort(approvingSocket.tabId, undefined, 2, approvingSocket.connectionName)
		const { port: requestPort, messages: requestMessages } = createPort(requestSocket.tabId, undefined, 3, requestSocket.connectionName)
		const websiteTabConnections = new Map([[ownerSocket.tabId, { ...confirmedSignerOwnership(ownerSocket), connections: {
			[websiteSocketToString(ownerSocket)]: { port: ownerPort, socket: ownerSocket, websiteOrigin, approved: false, wantsToConnect: false },
			[websiteSocketToString(approvingSocket)]: { port: approvingPort, socket: approvingSocket, websiteOrigin, approved: true, wantsToConnect: true },
			[websiteSocketToString(requestSocket)]: { port: requestPort, socket: requestSocket, websiteOrigin, approved: false, wantsToConnect: false },
		} }]])
		const currentRpcNetwork = {
			name: 'Current RPC',
			chainId: 1n,
			httpsRpc: 'https://current.example',
			currencyName: 'Ether',
			currencyTicker: 'ETH',
			primary: true,
			minimized: false,
		}
		const requestedRpcNetwork = {
			name: 'Sepolia',
			chainId: 11155111n,
			httpsRpc: 'https://sepolia.example',
			currencyName: 'Sepolia Testnet ETH',
			currencyTicker: 'SEETH',
			primary: true,
			minimized: false,
		}
		const uniqueRequestIdentifier = { requestId: 95, requestSocket }
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier,
			method: 'wallet_switchEthereumChain' as const,
			params: [{ chainId: requestedRpcNetwork.chainId }],
		}
		await changeSimulationMode({ simulationMode: false, rpcNetwork: currentRpcNetwork, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setChainChangeConfirmationPromise({
			website,
			popupOrTabId: { type: 'popup', id: 10 },
			request,
			rpcNetwork: requestedRpcNetwork,
			simulationMode: false,
		})
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const resolution = resolveChainChange(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, {
			method: 'popup_changeChainDialog',
			data: { rpcNetwork: requestedRpcNetwork, uniqueRequestIdentifier, accept: true },
		})
		await waitForPortMessageCount(ownerMessages, 'request_signer_to_wallet_switchEthereumChain', 1)
		await new Promise((resolve) => setTimeout(resolve, 0))

		await removeWebsiteTabConnection(websiteTabConnections, approvingSocket, approvingPort)
		await handleInterceptedRequest(ownerPort, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, ownerSocket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 96, requestSocket: ownerSocket },
			method: 'wallet_switchEthereumChain_reply',
			params: [{ accept: true, chainId: '0xaa36a7', signerProviderGeneration: 1 }],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		await Promise.race([
			resolution,
			new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Solicited chain reply did not settle')), 100)),
		])

		const reply = requestMessages.find((message) => message.method === 'wallet_switchEthereumChain' && message.requestId === uniqueRequestIdentifier.requestId)
		assert.equal(reply?.result, null)
	})

	test('does not let another tab chain reply settle the pending dapp switch', async () => {
		installBrowserMock()
		const {
			changeSimulationMode,
			getSettings,
			handleInterceptedRequest,
			popupChangeActiveRpc,
			resolveChainChange,
			saveCurrentTabId,
			setChainChangeConfirmationPromise,
			websiteSocketToString,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const requestSocket = { tabId: 1, connectionName: 0n }
		const popupSocket = { tabId: 2, connectionName: 0n }
		const { port: requestPort, messages: requestMessages } = createPort(requestSocket.tabId)
		const { port: popupPort, messages: popupMessages } = createPort(popupSocket.tabId)
		const websiteTabConnections = new Map([
			[requestSocket.tabId, { ...confirmedSignerOwnership(requestSocket), connections: {
				[websiteSocketToString(requestSocket)]: { port: requestPort, socket: requestSocket, websiteOrigin, approved: true, wantsToConnect: true },
			} }],
			[popupSocket.tabId, { ...confirmedSignerOwnership(popupSocket), connections: {
				[websiteSocketToString(popupSocket)]: { port: popupPort, socket: popupSocket, websiteOrigin, approved: true, wantsToConnect: true },
			} }],
		])
		const currentRpcNetwork = {
			name: 'Current RPC',
			chainId: 1n,
			httpsRpc: 'https://current.example',
			currencyName: 'Ether',
			currencyTicker: 'ETH',
			primary: true,
			minimized: false,
		}
		const requestedRpcNetwork = {
			name: 'Sepolia',
			chainId: 11155111n,
			httpsRpc: 'https://sepolia.example',
			currencyName: 'Sepolia Testnet ETH',
			currencyTicker: 'SEETH',
			primary: true,
			minimized: false,
		}
		const popupRpcNetwork = {
			name: 'Holesky',
			chainId: 17000n,
			httpsRpc: 'https://holesky.example',
			currencyName: 'Holesky Testnet ETH',
			currencyTicker: 'HOETH',
			primary: true,
			minimized: false,
		}
		const uniqueRequestIdentifier = { requestId: 97, requestSocket }
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier,
			method: 'wallet_switchEthereumChain' as const,
			params: [{ chainId: requestedRpcNetwork.chainId }],
		}
		await changeSimulationMode({ simulationMode: false, rpcNetwork: currentRpcNetwork, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setChainChangeConfirmationPromise({
			website,
			popupOrTabId: { type: 'popup', id: 11 },
			request,
			rpcNetwork: requestedRpcNetwork,
			simulationMode: false,
		})
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		let requestSettled = false
		const resolution = resolveChainChange(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, {
			method: 'popup_changeChainDialog',
			data: { rpcNetwork: requestedRpcNetwork, uniqueRequestIdentifier, accept: true },
		}).then(() => { requestSettled = true })
		await waitForPortMessageCount(requestMessages, 'request_signer_to_wallet_switchEthereumChain', 1)
		await new Promise((resolve) => setTimeout(resolve, 0))

		await saveCurrentTabId(popupSocket.tabId)
		await popupChangeActiveRpc(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, {
			method: 'popup_changeActiveRpc',
			data: popupRpcNetwork,
		}, await getSettings())
		await waitForPortMessageCount(popupMessages, 'request_signer_to_wallet_switchEthereumChain', 1)
		await handleInterceptedRequest(popupPort, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, popupSocket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 98, requestSocket: popupSocket },
			method: 'wallet_switchEthereumChain_reply',
			params: [{ accept: false, chainId: '0x4268', error: { code: 4001, message: 'Popup tab rejected' }, signerProviderGeneration: 1 }],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		await new Promise((resolve) => setTimeout(resolve, 0))
		assert.equal(requestSettled, false)

		await handleInterceptedRequest(requestPort, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, requestSocket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 99, requestSocket },
			method: 'wallet_switchEthereumChain_reply',
			params: [{ accept: false, chainId: '0xaa36a7', error: { code: 4001, message: 'Dapp tab rejected' }, signerProviderGeneration: 1 }],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		await resolution

		const reply = requestMessages.find((message) => message.method === 'wallet_switchEthereumChain' && message.requestId === uniqueRequestIdentifier.requestId)
		assert.equal(reply?.error?.code, 4001)
		assert.equal(reply?.error?.message, 'Dapp tab rejected')
	})

	test('keeps the production chain dialog guarded while signer resolution starts', async () => {
		const { waitForDeferredChainChangeRemoval, releaseDeferredChainChangeRemoval } = installBrowserMock({ deferFirstChainChangeRemoval: true })
		const {
			changeSimulationMode,
			getChainChangeConfirmationPromise,
			handleInterceptedRequest,
			openChangeChainDialog,
			resolveChainChange,
			websiteSocketToString,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const currentRpcNetwork = {
			name: 'Current RPC',
			chainId: 1n,
			httpsRpc: 'https://current.example',
			currencyName: 'Ether',
			currencyTicker: 'ETH',
			primary: true,
			minimized: false,
		}
		const requestedRpcNetwork = {
			name: 'Sepolia',
			chainId: 11155111n,
			httpsRpc: 'https://sepolia.example',
			currencyName: 'Sepolia Testnet ETH',
			currencyTicker: 'SEETH',
			primary: true,
			minimized: false,
		}
		const secondRpcNetwork = {
			name: 'Holesky',
			chainId: 17000n,
			httpsRpc: 'https://holesky.example',
			currencyName: 'Holesky Testnet ETH',
			currencyTicker: 'HOETH',
			primary: true,
			minimized: false,
		}
		const firstUniqueRequestIdentifier = { requestId: 100, requestSocket: socket }
		const firstRequest = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: firstUniqueRequestIdentifier,
			method: 'wallet_switchEthereumChain' as const,
			params: [{ chainId: requestedRpcNetwork.chainId }],
		}
		const secondUniqueRequestIdentifier = { requestId: 101, requestSocket: socket }
		const secondRequest = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: secondUniqueRequestIdentifier,
			method: 'wallet_switchEthereumChain' as const,
			params: [{ chainId: secondRpcNetwork.chainId }],
		}
		await changeSimulationMode({ simulationMode: false, rpcNetwork: currentRpcNetwork, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const firstResolution = openChangeChainDialog(
			ethereum,
			tokenPriceService,
			resetSimulationServices,
			websiteTabConnections,
			firstRequest,
			false,
			website,
			{ method: 'wallet_switchEthereumChain', params: [{ chainId: requestedRpcNetwork.chainId }] },
		)
		const pendingDeadline = Date.now() + 100
		let pendingChainChange = await getChainChangeConfirmationPromise()
		while (pendingChainChange === undefined && Date.now() < pendingDeadline) {
			await new Promise((resolve) => setTimeout(resolve, 0))
			pendingChainChange = await getChainChangeConfirmationPromise()
		}
		if (pendingChainChange === undefined) throw new Error('Missing production chain-change dialog state')
		await resolveChainChange(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, {
			method: 'popup_changeChainDialog',
			data: { rpcNetwork: requestedRpcNetwork, uniqueRequestIdentifier: firstUniqueRequestIdentifier, accept: true },
		})
		await Promise.race([
			waitForDeferredChainChangeRemoval(),
			new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Chain resolution did not start')), 100)),
		])
		await new Promise((resolve) => setTimeout(resolve, 0))

		const secondResolution = await Promise.race([
			openChangeChainDialog(
				ethereum,
				tokenPriceService,
				resetSimulationServices,
				websiteTabConnections,
				secondRequest,
				false,
				website,
				{ method: 'wallet_switchEthereumChain', params: [{ chainId: secondRpcNetwork.chainId }] },
			),
			new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Second chain dialog was not rejected')), 100)),
		])
		assert.equal(secondResolution.error?.code, 4001)

		releaseDeferredChainChangeRemoval()
		await waitForPortMessageCount(messages, 'request_signer_to_wallet_switchEthereumChain', 1)
		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 102, requestSocket: socket },
			method: 'wallet_switchEthereumChain_reply',
			params: [{ accept: false, chainId: '0xaa36a7', error: { code: 4001, message: 'First signer rejected' }, signerProviderGeneration: 1 }],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		const firstResult = await Promise.race([
			firstResolution,
			new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('First production chain dialog did not settle')), 100)),
		])
		assert.equal(firstResult.error?.message, 'First signer rejected')
	})

	test('resolves approved eth_requestAccounts after signer account state is refreshed', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			getTabState,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x4444444444444444444444444444444444444444n
		const accountString = '0x4444444444444444444444444444444444444444'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		const siblingSocket = { tabId: 1, connectionName: 1n }
		const stateAtDappReply: Array<bigint | undefined> = []
		const { port: createdPort, messages } = createPort(socket.tabId, (message) => {
			if (message.method === 'request_signer_to_eth_requestAccounts') {
				void handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
					interceptorRequest: true,
					interceptorInternalRequest: true,
					usingInterceptorWithoutSigner: false,
					uniqueRequestIdentifier: { requestId: 99, requestSocket: socket },
					method: 'eth_accounts_reply',
					params: [{ signerProviderGeneration: 1, type: 'success', accounts: [accountString], requestAccounts: true }],
				}, websiteTabConnections, noopPublishRpcConnectionStatus)
			}
			if (message.method === 'eth_accounts' && message.requestId === 9) {
				void getTabState(socket.tabId).then((tabState) => {
					stateAtDappReply.push(tabState.activeSigningAddress)
				})
			}
		})
		const port = createdPort
		const { port: siblingPort, messages: siblingMessages } = createPort(siblingSocket.tabId, undefined, undefined, siblingSocket.connectionName)
		const connectionKey = websiteSocketToString(socket)
		const siblingConnectionKey = websiteSocketToString(siblingSocket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
			[siblingConnectionKey]: { port: siblingPort, socket: siblingSocket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 9, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(messages.filter((message) => message.method === 'request_signer_to_eth_requestAccounts').length, 1)
		await new Promise((resolve) => setTimeout(resolve, 0))
		assert.deepEqual((await getTabState(socket.tabId)).signerAccounts, [account])
		assert.deepEqual(stateAtDappReply, [account])
		const requestAccountsReplies = messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 9)
		assert.deepEqual(requestAccountsReplies.at(-1)?.result, ['0x4444444444444444444444444444444444444444'])
		const requestAccountsReplyIndex = messages.findIndex((message) => message.method === 'eth_accounts' && message.requestId === 9)
		const connectMessages = messages.filter((message) => message.method === 'connect')
		const connectIndex = messages.findIndex((message) => message.method === 'connect')
		const accountChangedMessages = messages.filter((message) => message.method === 'accountsChanged')
		const accountChangedIndex = messages.findIndex((message) => message.method === 'accountsChanged')
		assert.notEqual(requestAccountsReplyIndex, -1)
		assert.notEqual(connectIndex, -1)
		assert.notEqual(accountChangedIndex, -1)
		assert.equal(connectIndex < accountChangedIndex, true)
		assert.equal(accountChangedIndex < requestAccountsReplyIndex, true)
		assert.deepEqual(connectMessages.map((message) => message.result), [['0x1']])
		assert.deepEqual(connectMessages.map((message) => message.requestId), [9])
		assert.deepEqual(accountChangedMessages.map((message) => message.result), [[accountString]])
		assert.deepEqual(accountChangedMessages.map((message) => message.requestId), [9])
		const siblingAccountChangedMessages = siblingMessages.filter((message) => message.method === 'accountsChanged')
		assert.deepEqual(siblingAccountChangedMessages.map((message) => message.result), [[accountString]])
		assert.deepEqual(siblingAccountChangedMessages.map((message) => message.requestId), [undefined])
	})

	test('suppresses unscoped connect events for requester during signer refresh with page-level access', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			updateUserAddressBookEntries,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x4545454545454545454545454545454545454545n
		const accountString = '0x4545454545454545454545454545454545454545'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateUserAddressBookEntries(() => [{
			type: 'contact',
			name: 'signer account',
			address: account,
			entrySource: 'User',
			useAsActiveAddress: true,
			askForAddressAccess: false,
		}])
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		const siblingSocket = { tabId: 1, connectionName: 1n }
		const { port: createdPort, messages } = createPort(socket.tabId, (message) => {
			if (message.method !== 'request_signer_to_eth_requestAccounts') return
			void handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
				interceptorRequest: true,
				interceptorInternalRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 100, requestSocket: socket },
				method: 'eth_accounts_reply',
				params: [{ signerProviderGeneration: 1, type: 'success', accounts: [accountString], requestAccounts: true }],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
		})
		const port = createdPort
		const { port: siblingPort, messages: siblingMessages } = createPort(siblingSocket.tabId, undefined, undefined, siblingSocket.connectionName)
		const connectionKey = websiteSocketToString(socket)
		const siblingConnectionKey = websiteSocketToString(siblingSocket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
			[siblingConnectionKey]: { port: siblingPort, socket: siblingSocket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 17, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.deepEqual(messages.filter((message) => message.method === 'connect').map((message) => message.requestId), [17])
		assert.deepEqual(messages.filter((message) => message.method === 'accountsChanged').map((message) => message.requestId), [17])
		assert.deepEqual(messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 17).map((message) => message.result), [[accountString]])
		assert.deepEqual(messages.filter((message) => message.method !== 'eth_accounts_reply').map((message) => message.method), ['request_signer_to_eth_requestAccounts', 'connect', 'accountsChanged', 'eth_accounts'])
		assert.deepEqual(siblingMessages.filter((message) => message.method === 'accountsChanged').map((message) => message.requestId), [undefined])
		assert.deepEqual(siblingMessages.filter((message) => message.method === 'accountsChanged').map((message) => message.result), [[accountString]])
	})

	test('replays account state before resolving wallet_requestPermissions after signer refresh', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x4646464646464646464646464646464646464646n
		const accountString = '0x4646464646464646464646464646464646464646'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port: createdPort, messages } = createPort(socket.tabId, (message) => {
			if (message.method !== 'request_signer_to_eth_requestAccounts') return
			void handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
				interceptorRequest: true,
				interceptorInternalRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 104, requestSocket: socket },
				method: 'eth_accounts_reply',
				params: [{ signerProviderGeneration: 1, type: 'success', accounts: [accountString], requestAccounts: true }],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
		})
		const port = createdPort
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 19, requestSocket: socket },
			method: 'wallet_requestPermissions',
			params: [{ eth_accounts: {} }],
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		const permissionResult = [{
			parentCapability: 'eth_accounts',
			caveats: [{
				type: 'restrictReturnedAccounts',
				value: [accountString],
			}],
			invoker: websiteOrigin,
		}]
		assert.deepEqual(messages.filter((message) => message.method === 'connect').map((message) => message.requestId), [19])
		assert.deepEqual(messages.filter((message) => message.method === 'accountsChanged').map((message) => message.requestId), [19])
		assert.deepEqual(messages.filter((message) => message.method === 'wallet_requestPermissions' && message.requestId === 19).map((message) => message.result), [permissionResult])
		assert.deepEqual(messages.filter((message) => message.method !== 'eth_accounts_reply').map((message) => message.method), ['request_signer_to_eth_requestAccounts', 'connect', 'accountsChanged', 'wallet_requestPermissions'])
	})

	test('replays account state after already-approved eth_requestAccounts with cached active signer address', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			updateTabState,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4an
		const accountString = '0x4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: account })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		await updateTabState(socket.tabId, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: account }))
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 11, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(messages.some((message) => message.method === 'request_signer_to_eth_requestAccounts'), false)
		assert.deepEqual(messages.filter((message) => message.method === 'connect').map((message) => message.result), [['0x1']])
		assert.deepEqual(messages.filter((message) => message.method === 'connect').map((message) => message.requestId), [11])
		assert.deepEqual(messages.filter((message) => message.method === 'accountsChanged').map((message) => message.result), [[accountString]])
		assert.deepEqual(messages.filter((message) => message.method === 'accountsChanged').map((message) => message.requestId), [11])
		const requestAccountsReplies = messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 11)
		assert.deepEqual(requestAccountsReplies.at(-1)?.result, [accountString])
		assert.deepEqual(messages.map((message) => message.method), ['connect', 'accountsChanged', 'eth_accounts'])
	})

	test('replays account state for already-approved eth_requestAccounts on signer-only networks', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			updateTabState,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4cn
		const accountString = '0x4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c'
		await changeSimulationMode({
			simulationMode: false,
			rpcNetwork: {
				name: 'Signer only',
				chainId: 1n,
				httpsRpc: undefined,
				currencyName: 'Ether?',
				currencyTicker: 'ETH?',
				primary: false,
				minimized: true,
			},
			activeSimulationAddress: undefined,
			activeSigningAddress: account,
		})
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		await updateTabState(socket.tabId, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: account }))
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 16, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(messages.some((message) => message.type === 'forwardToSigner'), false)
		assert.equal(messages.some((message) => message.method === 'request_signer_to_eth_requestAccounts'), false)
		const requestAccountsReplies = messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 16)
		assert.deepEqual(requestAccountsReplies.at(-1)?.result, [accountString])
		assert.deepEqual(messages.filter((message) => message.method === 'connect').map((message) => message.result), [['0x1']])
		assert.deepEqual(messages.filter((message) => message.method === 'connect').map((message) => message.requestId), [16])
		assert.deepEqual(messages.filter((message) => message.method === 'accountsChanged').map((message) => message.result), [[accountString]])
		assert.deepEqual(messages.filter((message) => message.method === 'accountsChanged').map((message) => message.requestId), [16])
		assert.deepEqual(messages.map((message) => message.method), ['connect', 'accountsChanged', 'eth_accounts'])
	})

	test('does not expose an active address in connected_to_signer replies', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			updateTabState,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4bn
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: account })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		await updateTabState(socket.tabId, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: account }))
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 12, requestSocket: socket },
			method: 'connected_to_signer',
			params: [true, 'MetaMask', 2],
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		const connectedReplies = messages.filter((message) => message.method === 'connected_to_signer' && message.requestId === 12)
		assert.deepEqual(connectedReplies.at(-1)?.result, { metamaskCompatibilityMode: false })
	})

	test('opens address access dialog after signer account discovery for site-approved eth_requestAccounts', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			getPendingAccessRequests,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x5555555555555555555555555555555555555555n
		const accountString = '0x5555555555555555555555555555555555555555'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId, (message) => {
			if (message.method !== 'request_signer_to_eth_requestAccounts') return
			void handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
				interceptorRequest: true,
				interceptorInternalRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 100, requestSocket: socket },
				method: 'eth_accounts_reply',
				params: [{ signerProviderGeneration: 1, type: 'success', accounts: [accountString], requestAccounts: true }],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
		})
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 10, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(messages.filter((message) => message.method === 'request_signer_to_eth_requestAccounts').length, 1)
		assert.equal(messages.some((message) => message.method === 'connect'), false)
		assert.equal(messages.some((message) => message.method === 'accountsChanged'), false)
		assert.equal(messages.some((message) => message.method === 'eth_requestAccounts' && message.requestId === 10), false)
		const pendingRequests = await getPendingAccessRequests()
		assert.equal(pendingRequests.length, 1)
		assert.equal(pendingRequests[0]?.request?.method, 'eth_requestAccounts')
		assert.equal(pendingRequests[0]?.requestAccessToAddress?.address, account)
		assert.equal(pendingRequests[0]?.originalRequestAccessToAddress?.address, account)
	})

	test('uses cached signer account instead of a stale provider-disconnected error when active signing address is missing', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			updateTabState,
			getPendingAccessRequests,
			resolveInterceptorAccess,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x6666666666666666666666666666666666666666n
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])
		await updateTabState(1, (previousState) => ({
			...previousState,
			signerAccounts: [account],
			activeSigningAddress: undefined,
			signerAccountError: { code: 4900, message: 'Stale signer error' },
		}))

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 11, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(messages.some((message) => message.method === 'request_signer_to_eth_requestAccounts'), false)
		assert.equal(messages.some((message) => message.method === 'connect'), false)
		assert.equal(messages.some((message) => message.method === 'accountsChanged'), false)
		assert.equal(messages.some((message) => message.method === 'eth_requestAccounts' && message.requestId === 11), false)
		const pendingRequests = await getPendingAccessRequests()
		assert.equal(pendingRequests.length, 1)
		assert.equal(pendingRequests[0]?.request?.method, 'eth_requestAccounts')
		assert.equal(pendingRequests[0]?.requestAccessToAddress?.address, account)
		assert.equal(pendingRequests[0]?.originalRequestAccessToAddress?.address, account)
		const pendingRequest = pendingRequests[0]
		if (pendingRequest === undefined) throw new Error('Missing pending request')
		const siteApprovalResolution = resolveInterceptorAccess(
			ethereum,
			tokenPriceService,
			resetSimulationServices,
			websiteTabConnections,
			{
				userReply: 'Approved',
				websiteOrigin,
				requestAccessToAddress: pendingRequest.requestAccessToAddress?.address,
				originalRequestAccessToAddress: pendingRequest.originalRequestAccessToAddress?.address,
				accessRequestId: pendingRequest.accessRequestId,
			},
			noopPublishRpcConnectionStatus,
		)
		await siteApprovalResolution
		assert.equal(messages.some((message) => message.method === 'accountsChanged' && Array.isArray(message.result) && message.result.length === 0), false)
		assert.deepEqual(messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 11).at(-1)?.result, ['0x6666666666666666666666666666666666666666'])
	})

	test('reuses a persisted access dialog when the same eth_requestAccounts is replayed after restart', async () => {
		installBrowserMock()
		const {
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			getPendingAccessRequests,
			getSettings,
		} = await loadModules()
		const { getActiveAddressEntry } = await import('../../app/ts/background/metadataUtils.js')
		const firstWorkerAccess = await import('../../app/ts/background/windows/interceptorAccess.js?access-dialog-worker-before-restart')
		const restartedWorkerAccess = await import('../../app/ts/background/windows/interceptorAccess.js?access-dialog-worker-after-restart')
		const websiteOrigin = 'https://app.safe.global'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x6677667766776677667766776677667766776677n
		const accountString = '0x6677667766776677667766776677667766776677'
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 111, requestSocket: socket },
			method: 'eth_requestAccounts',
		} as const
		const requestAccessToAddress = await getActiveAddressEntry(account)
		const settings = await getSettings()

		await firstWorkerAccess.requestAccessFromUser(
			ethereum,
			tokenPriceService,
			resetSimulationServices,
			websiteTabConnections,
			socket,
			website,
			request,
			requestAccessToAddress,
			settings,
			account,
			noopPublishRpcConnectionStatus,
		)
		await restartedWorkerAccess.requestAccessFromUser(
			ethereum,
			tokenPriceService,
			resetSimulationServices,
			websiteTabConnections,
			socket,
			website,
			request,
			requestAccessToAddress,
			settings,
			account,
			noopPublishRpcConnectionStatus,
		)

		assert.equal((await getPendingAccessRequests()).length, 1)
		assert.equal(messages.some((message) => message.requestId === 111), false)
		const pendingRequest = (await getPendingAccessRequests())[0]
		if (pendingRequest === undefined) throw new Error('Missing pending request after worker restart')
		await restartedWorkerAccess.resolveInterceptorAccess(
			ethereum,
			tokenPriceService,
			resetSimulationServices,
			websiteTabConnections,
			{
				userReply: 'Approved',
				requestAccessToAddress: pendingRequest.requestAccessToAddress?.address,
				originalRequestAccessToAddress: pendingRequest.originalRequestAccessToAddress?.address,
				accessRequestId: pendingRequest.accessRequestId,
			},
			noopPublishRpcConnectionStatus,
		)

		assert.deepEqual(messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 111).map((message) => message.result), [[accountString]])
	})

	test('uses refreshed website access after signer account discovery', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			getPendingAccessRequests,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x7777777777777777777777777777777777777777n
		const accountString = '0x7777777777777777777777777777777777777777'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId, (message) => {
			if (message.method !== 'request_signer_to_eth_requestAccounts') return
			void (async () => {
				await updateWebsiteAccess(() => [{ website, access: false, addressAccess: undefined }])
				await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
					interceptorRequest: true,
					interceptorInternalRequest: true,
					usingInterceptorWithoutSigner: false,
					uniqueRequestIdentifier: { requestId: 101, requestSocket: socket },
					method: 'eth_accounts_reply',
					params: [{ signerProviderGeneration: 1, type: 'success', accounts: [accountString], requestAccounts: true }],
				}, websiteTabConnections, noopPublishRpcConnectionStatus)
			})()
		})
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 12, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(messages.filter((message) => message.method === 'request_signer_to_eth_requestAccounts').length, 1)
		assert.equal(messages.some((message) => message.method === 'connect'), false)
		assert.equal(messages.some((message) => message.method === 'accountsChanged'), false)
		assert.equal((await getPendingAccessRequests()).length, 0)
		const requestAccountsReplies = messages.filter((message) => message.method === 'eth_requestAccounts' && message.requestId === 12)
		assert.equal(requestAccountsReplies.at(-1)?.error?.code, 4100)
		assert.equal(requestAccountsReplies.at(-1)?.error?.message, 'The requested method and/or account has not been authorized by the user.')
	})

	test('does not connect an unapproved port when signer rejects site-approved eth_requestAccounts', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId, (message) => {
			if (message.method !== 'request_signer_to_eth_requestAccounts') return
			void handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
				interceptorRequest: true,
				interceptorInternalRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 102, requestSocket: socket },
				method: 'eth_accounts_reply',
				params: [{ signerProviderGeneration: 1, type: 'error', requestAccounts: true, error: { code: 4001, message: 'User rejected the request.' } }],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
		})
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 13, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(messages.filter((message) => message.method === 'request_signer_to_eth_requestAccounts').length, 1)
		assert.equal(messages.some((message) => message.method === 'connect'), false)
		assert.equal(messages.some((message) => message.method === 'accountsChanged'), false)
		const requestAccountsReplies = messages.filter((message) => message.method === 'eth_requestAccounts' && message.requestId === 13)
		assert.equal(requestAccountsReplies.at(-1)?.error?.code, 4001)
		assert.equal(requestAccountsReplies.at(-1)?.error?.message, 'User rejected the request.')
	})

	test('does not connect an unapproved port when signer returns empty accounts for site-approved eth_requestAccounts', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId, (message) => {
			if (message.method !== 'request_signer_to_eth_requestAccounts') return
			void handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
				interceptorRequest: true,
				interceptorInternalRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 103, requestSocket: socket },
				method: 'eth_accounts_reply',
				params: [{ signerProviderGeneration: 1, type: 'success', accounts: [], requestAccounts: true }],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
		})
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 14, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(messages.filter((message) => message.method === 'request_signer_to_eth_requestAccounts').length, 1)
		assert.equal(messages.some((message) => message.method === 'connect'), false)
		assert.equal(messages.some((message) => message.method === 'accountsChanged'), false)
		const requestAccountsReplies = messages.filter((message) => message.method === 'eth_requestAccounts' && message.requestId === 14)
		assert.equal(requestAccountsReplies.at(-1)?.error?.code, 4100)
		assert.equal(requestAccountsReplies.at(-1)?.error?.message, 'The requested method and/or account has not been authorized by the user.')
	})

	test('preserves the signer account-access rejection for approved eth_requestAccounts', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			getTabState,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		let port: browser.runtime.Port
		const { port: createdPort, messages } = createPort(socket.tabId, (message) => {
			if (message.method !== 'request_signer_to_eth_requestAccounts') return
			void (async () => {
				await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
					interceptorRequest: true,
					interceptorInternalRequest: true,
					usingInterceptorWithoutSigner: false,
					uniqueRequestIdentifier: { requestId: 99, requestSocket: socket },
					method: 'eth_accounts_reply',
					params: [{ signerProviderGeneration: 1, type: 'error', requestAccounts: true, error: { code: 4001, message: 'User rejected the request.' } }],
				}, websiteTabConnections, noopPublishRpcConnectionStatus)
			})()
		})
		port = createdPort
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 8, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(messages.filter((message) => message.method === 'request_signer_to_eth_requestAccounts').length, 1)
		const requestAccountsReplies = messages.filter((message) => message.method === 'eth_requestAccounts' && message.requestId === 8)
		assert.equal(requestAccountsReplies.at(-1)?.error?.code, 4001)
		assert.equal(requestAccountsReplies.at(-1)?.error?.message, 'User rejected the request.')
		assert.deepEqual((await getTabState(socket.tabId)).signerAccounts, [])
	})

	test('maps unavailable signer errors only for interactive account connection methods', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			getTabState,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const unavailableSignerError = {
			code: 4900,
			message: 'No signer wallet is available to this page. Enable your wallet extension for this site, then try again.',
		}
		const accountRequests = [
			{ method: 'eth_requestAccounts', signerRequestMethod: 'request_signer_to_eth_requestAccounts', expectedPublicErrorCode: 4001, requestAccounts: true },
			{ method: 'wallet_requestPermissions', signerRequestMethod: 'request_signer_to_eth_requestAccounts', expectedPublicErrorCode: 4001, requestAccounts: true },
			{ method: 'eth_accounts', signerRequestMethod: 'request_signer_to_eth_accounts', expectedPublicErrorCode: 4900, requestAccounts: false },
			{ method: 'wallet_getPermissions', signerRequestMethod: 'request_signer_to_eth_accounts', expectedPublicErrorCode: 4900, requestAccounts: false },
		] as const
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		let port: browser.runtime.Port
		let internalRequestId = 104
		const { port: createdPort, messages } = createPort(socket.tabId, (message) => {
			const accountRequest = accountRequests.find((candidate) => candidate.signerRequestMethod === message.method)
			if (accountRequest === undefined) return
			internalRequestId += 1
			void handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
				interceptorRequest: true,
				interceptorInternalRequest: true,
				usingInterceptorWithoutSigner: true,
				uniqueRequestIdentifier: { requestId: internalRequestId, requestSocket: socket },
				method: 'eth_accounts_reply',
				params: [{ signerProviderGeneration: 1, type: 'error', requestAccounts: accountRequest.requestAccounts, signerUnavailable: true, error: unavailableSignerError }],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
		})
		port = createdPort
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		for (const [requestIndex, accountRequest] of accountRequests.entries()) {
			const requestId = 15 + requestIndex
			await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
				interceptorRequest: true,
				usingInterceptorWithoutSigner: true,
				uniqueRequestIdentifier: { requestId, requestSocket: socket },
				method: accountRequest.method,
			}, websiteTabConnections, noopPublishRpcConnectionStatus)

			const replies = messages.filter((message) => message.method === accountRequest.method && message.requestId === requestId)
			assert.equal(replies.length, 1)
			assert.deepEqual(replies[0]?.error, {
				...unavailableSignerError,
				code: accountRequest.expectedPublicErrorCode,
			})
			assert.equal(messages.some((message) => (message.method === 'connect' || message.method === 'accountsChanged') && message.requestId === requestId), false)
		}
		assert.equal((await getTabState(socket.tabId)).signerAccountError, undefined)
	})

	test('ignores a provider-disconnected completion from a sibling socket', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			sendInternalWindowMessage,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x2424242424242424242424242424242424242424n
		const accountString = '0x2424242424242424242424242424242424242424'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		const siblingSocket = { tabId: 1, connectionName: 1n }
		const { port, messages } = createPort(socket.tabId)
		const { port: siblingPort } = createPort(siblingSocket.tabId, undefined, undefined, siblingSocket.connectionName)
		const connectionKey = websiteSocketToString(socket)
		const siblingConnectionKey = websiteSocketToString(siblingSocket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
			[siblingConnectionKey]: { port: siblingPort, socket: siblingSocket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: true,
			uniqueRequestIdentifier: { requestId: 18, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		const requestPromise = handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)
		await waitForPortMessageCount(messages, 'request_signer_to_eth_requestAccounts', 1)
		sendInternalWindowMessage({
			method: 'window_signer_accounts_changed',
			data: {
				socket: siblingSocket,
				signerStateOwnerGeneration: 1,
				signerProviderGeneration: 1,
				error: { code: 4900, message: 'Sibling signer is unavailable' },
			},
		})
		await new Promise((resolve) => setTimeout(resolve, 0))
		assert.equal(messages.some((message) => message.requestId === 18), false)

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 105, requestSocket: socket },
			method: 'eth_accounts_reply',
			params: [{ signerProviderGeneration: 1, type: 'success', accounts: [accountString], requestAccounts: true }],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		await requestPromise

		const requestAccountsReplies = messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 18)
		assert.equal(requestAccountsReplies.length, 1)
		assert.deepEqual(requestAccountsReplies[0]?.result, [accountString])
	})

	test('keeps sibling connection events when popup approval resolves eth_requestAccounts', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			updateTabState,
			getPendingAccessRequests,
			resolveInterceptorAccess,
			getSettings,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x6868686868686868686868686868686868686868n
		const accountString = '0x6868686868686868686868686868686868686868'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: account })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])
		await updateTabState(1, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: account }))

		const socket = { tabId: 1, connectionName: 0n }
		const siblingSocket = { tabId: 1, connectionName: 1n }
		const { port, messages } = createPort(socket.tabId)
		const { port: siblingPort, messages: siblingMessages } = createPort(siblingSocket.tabId, undefined, undefined, siblingSocket.connectionName)
		const connectionKey = websiteSocketToString(socket)
		const siblingConnectionKey = websiteSocketToString(siblingSocket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
			[siblingConnectionKey]: { port: siblingPort, socket: siblingSocket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 18, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(messages.some((message) => message.method === 'connect'), false)
		assert.equal(messages.some((message) => message.method === 'accountsChanged'), false)
		assert.equal(siblingMessages.length, 0)
		const pendingRequests = await getPendingAccessRequests()
		assert.equal(pendingRequests.length, 1)
		const pendingRequest = pendingRequests[0]
		if (pendingRequest === undefined) throw new Error('Missing pending request')
		const siteApprovalResolution = resolveInterceptorAccess(
			ethereum,
			tokenPriceService,
			resetSimulationServices,
			websiteTabConnections,
			{
				userReply: 'Approved',
				websiteOrigin,
				requestAccessToAddress: pendingRequest.requestAccessToAddress?.address,
				originalRequestAccessToAddress: pendingRequest.originalRequestAccessToAddress?.address,
				accessRequestId: pendingRequest.accessRequestId,
			},
			noopPublishRpcConnectionStatus,
		)
		await siteApprovalResolution

		const requestLifecycleMessages = messages.filter((message) => message.method === 'connect' || message.method === 'accountsChanged' || message.method === 'chainChanged')
		assert.deepEqual(requestLifecycleMessages.map((message) => message.method), ['connect', 'accountsChanged'])
		assert.deepEqual(requestLifecycleMessages.map((message) => message.requestId), [18, 18])
		assert.deepEqual(messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 18).at(-1)?.result, [accountString])
		const siblingLifecycleMessages = siblingMessages.filter((message) => message.method === 'connect' || message.method === 'accountsChanged' || message.method === 'chainChanged')
		assert.deepEqual(siblingLifecycleMessages.map((message) => message.method), ['connect', 'accountsChanged', 'chainChanged'])
		assert.deepEqual(siblingLifecycleMessages.map((message) => message.requestId), [undefined, undefined, undefined])
		assert.deepEqual(siblingLifecycleMessages.map((message) => message.result), [['0x1'], [accountString], '0x1'])
		const access = (await getSettings()).websiteAccess.find((entry) => entry.website.websiteOrigin === websiteOrigin)
		assert.equal(access?.access, true)
		assert.deepEqual(access?.addressAccess, [{ address: account, access: true }])
	})

	test('falls back to the pending request address when popup approval reply omits address fields', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			updateTabState,
			getPendingAccessRequests,
			resolveInterceptorAccess,
			getSettings,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x6969696969696969696969696969696969696969n
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: account })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])
		await updateTabState(1, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: account }))

		const socket = { tabId: 1, connectionName: 0n }
		const { port } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 21, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		const pendingRequest = (await getPendingAccessRequests())[0]
		if (pendingRequest === undefined) throw new Error('Missing pending request')
		const siteApprovalResolution = resolveInterceptorAccess(
			ethereum,
			tokenPriceService,
			resetSimulationServices,
			websiteTabConnections,
			{
				userReply: 'Approved',
				requestAccessToAddress: undefined,
				originalRequestAccessToAddress: undefined,
				accessRequestId: pendingRequest.accessRequestId,
			},
			noopPublishRpcConnectionStatus,
		)
		await siteApprovalResolution

		const access = (await getSettings()).websiteAccess.find((entry) => entry.website.websiteOrigin === websiteOrigin)
		assert.equal(access?.access, true)
		assert.deepEqual(access?.addressAccess, [{ address: account, access: true }])
	})

	test('popup-approved wallet_requestPermissions stores address access and returns restrictReturnedAccounts', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			updateTabState,
			getPendingAccessRequests,
			resolveInterceptorAccess,
			getSettings,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x6767676767676767676767676767676767676767n
		const accountString = '0x6767676767676767676767676767676767676767'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: account })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])
		await updateTabState(1, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: account }))

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 22, requestSocket: socket },
			method: 'wallet_requestPermissions',
			params: [{ eth_accounts: {} }],
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		const pendingRequest = (await getPendingAccessRequests())[0]
		if (pendingRequest === undefined) throw new Error('Missing pending request')
		const siteApprovalResolution = resolveInterceptorAccess(
			ethereum,
			tokenPriceService,
			resetSimulationServices,
			websiteTabConnections,
			{
				userReply: 'Approved',
				requestAccessToAddress: pendingRequest.requestAccessToAddress?.address,
				originalRequestAccessToAddress: pendingRequest.originalRequestAccessToAddress?.address,
				accessRequestId: pendingRequest.accessRequestId,
			},
			noopPublishRpcConnectionStatus,
		)
		await siteApprovalResolution

		const permissionReply = messages.filter((message) => message.method === 'wallet_requestPermissions' && message.requestId === 22).at(-1)
		assert.deepEqual(permissionReply?.result, [{
			parentCapability: 'eth_accounts',
			caveats: [{
				type: 'restrictReturnedAccounts',
				value: [accountString],
			}],
			invoker: websiteOrigin,
		}])
		const access = (await getSettings()).websiteAccess.find((entry) => entry.website.websiteOrigin === websiteOrigin)
		assert.equal(access?.access, true)
		assert.deepEqual(access?.addressAccess, [{ address: account, access: true }])
	})

	test('simulation-mode wallet_requestPermissions still prompts for address access when only the site socket is approved', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			getPendingAccessRequests,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x7171717171717171717171717171717171717171n
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 24, requestSocket: socket },
			method: 'wallet_requestPermissions',
			params: [{ eth_accounts: {} }],
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(messages.some((message) => message.method === 'wallet_requestPermissions' && message.requestId === 24), false)
		const pendingRequests = await getPendingAccessRequests()
		assert.equal(pendingRequests.length, 1)
		assert.equal(pendingRequests[0]?.request?.method, 'wallet_requestPermissions')
		assert.equal(pendingRequests[0]?.requestAccessToAddress?.address, account)
	})

	test('site-approved wallet_requestPermissions still prompts for address access before completing', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			getPendingAccessRequests,
			resolveInterceptorAccess,
			getSettings,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x6767676767676767676767676767676767676767n
		const accountString = '0x6767676767676767676767676767676767676767'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: account })
		await setUseSignersAddressAsActiveAddress(false)

		const socket = { tabId: 1, connectionName: 0n }
		let port: browser.runtime.Port
		const { port: createdPort, messages } = createPort(socket.tabId, (message) => {
			if (message.method !== 'request_signer_to_eth_requestAccounts') return
			void handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
				interceptorRequest: true,
				interceptorInternalRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 230, requestSocket: socket },
				method: 'eth_accounts_reply',
				params: [{ signerProviderGeneration: 1, type: 'success', accounts: [accountString], requestAccounts: true }],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
		})
		port = createdPort
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 23, requestSocket: socket },
			method: 'wallet_requestPermissions',
			params: [{ eth_accounts: {} }],
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		const siteLevelPendingRequest = (await getPendingAccessRequests())[0]
		if (siteLevelPendingRequest === undefined) throw new Error('Missing site-level pending request')
		assert.equal(siteLevelPendingRequest.requestAccessToAddress, undefined)
		const siteApprovalResolution = resolveInterceptorAccess(
			ethereum,
			tokenPriceService,
			resetSimulationServices,
			websiteTabConnections,
			{
				userReply: 'Approved',
				requestAccessToAddress: undefined,
				originalRequestAccessToAddress: undefined,
				accessRequestId: siteLevelPendingRequest.accessRequestId,
			},
			noopPublishRpcConnectionStatus,
		)

		const addressLevelPendingRequest = await waitForPendingAddressRequest(getPendingAccessRequests, account)
		assert.equal(addressLevelPendingRequest.requestAccessToAddress?.address, account)
		await resolveInterceptorAccess(
			ethereum,
			tokenPriceService,
			resetSimulationServices,
			websiteTabConnections,
			{
				userReply: 'Approved',
				requestAccessToAddress: addressLevelPendingRequest.requestAccessToAddress?.address,
				originalRequestAccessToAddress: addressLevelPendingRequest.originalRequestAccessToAddress?.address,
				accessRequestId: addressLevelPendingRequest.accessRequestId,
			},
			noopPublishRpcConnectionStatus,
		)
		await siteApprovalResolution

		const permissionReply = messages.filter((message) => message.method === 'wallet_requestPermissions' && message.requestId === 23).at(-1)
		assert.deepEqual(permissionReply?.result, [{
			parentCapability: 'eth_accounts',
			caveats: [{
				type: 'restrictReturnedAccounts',
				value: [accountString],
			}],
			invoker: websiteOrigin,
		}])
		const access = (await getSettings()).websiteAccess.find((entry) => entry.website.websiteOrigin === websiteOrigin)
		assert.equal(access?.access, true)
		assert.deepEqual(access?.addressAccess, [{ address: account, access: true }])
	})

	test('site-approved wallet_requestPermissions replays for address access after releasing the popup semaphore', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			requestAccessFromUser,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			getPendingAccessRequests,
			getSettings,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x7373737373737373737373737373737373737373n
		const accountString = '0x7373737373737373737373737373737373737373'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		let port: browser.runtime.Port
		const { port: createdPort, messages } = createPort(socket.tabId, (message) => {
			if (message.method !== 'request_signer_to_eth_requestAccounts') return
			void handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
				interceptorRequest: true,
				interceptorInternalRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 731, requestSocket: socket },
				method: 'eth_accounts_reply',
				params: [{ signerProviderGeneration: 1, type: 'success', accounts: [accountString], requestAccounts: true }],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
		})
		port = createdPort
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 73, requestSocket: socket },
			method: 'wallet_requestPermissions',
			params: [{ eth_accounts: {} }],
		}

		await Promise.race([
			requestAccessFromUser(
				ethereum,
				tokenPriceService,
				resetSimulationServices,
				websiteTabConnections,
				socket,
				website,
				request,
				undefined,
				await getSettings(),
				undefined,
				noopPublishRpcConnectionStatus,
			),
			new Promise((_, reject) => setTimeout(() => reject(new Error('requestAccessFromUser did not resolve')), 100)),
		])

		const pendingRequests = await getPendingAccessRequests()
		assert.equal(messages.some((message) => message.method === 'wallet_requestPermissions' && message.requestId === 73 && message.error?.code === -32002), false)
		assert.equal(pendingRequests.length, 1)
		assert.equal(pendingRequests[0]?.request?.uniqueRequestIdentifier.requestId, 73)
		assert.equal(pendingRequests[0]?.requestAccessToAddress?.address, account)
	})

	test('site-approved wallet_requestPermissions keeps the replay-owned address prompt when signer state appears before approval', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			getPendingAccessRequests,
			resolveInterceptorAccess,
			updateTabState,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x7272727272727272727272727272727272727272n
		const accountString = '0x7272727272727272727272727272727272727272'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 25, requestSocket: socket },
			method: 'wallet_requestPermissions',
			params: [{ eth_accounts: {} }],
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		const siteLevelPendingRequest = (await getPendingAccessRequests())[0]
		if (siteLevelPendingRequest === undefined) throw new Error('Missing site-level pending request')
		await updateTabState(socket.tabId, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: account }))
		const siteApprovalResolution = resolveInterceptorAccess(
			ethereum,
			tokenPriceService,
			resetSimulationServices,
			websiteTabConnections,
			{
				userReply: 'Approved',
				requestAccessToAddress: undefined,
				originalRequestAccessToAddress: undefined,
				accessRequestId: siteLevelPendingRequest.accessRequestId,
			},
			noopPublishRpcConnectionStatus,
		)

		const addressLevelPendingRequest = await waitForPendingAddressRequest(getPendingAccessRequests, account)
		assert.equal(addressLevelPendingRequest.request?.method, 'wallet_requestPermissions')
		assert.equal(addressLevelPendingRequest.request?.uniqueRequestIdentifier.requestId, 25)
		assert.equal(messages.some((message) => message.method === 'wallet_requestPermissions' && message.requestId === 25 && message.error?.code === -32002), false)
		await resolveInterceptorAccess(
			ethereum,
			tokenPriceService,
			resetSimulationServices,
			websiteTabConnections,
			{
				userReply: 'Approved',
				requestAccessToAddress: addressLevelPendingRequest.requestAccessToAddress?.address,
				originalRequestAccessToAddress: addressLevelPendingRequest.originalRequestAccessToAddress?.address,
				accessRequestId: addressLevelPendingRequest.accessRequestId,
			},
			noopPublishRpcConnectionStatus,
		)
		await siteApprovalResolution

		const permissionReply = messages.filter((message) => message.method === 'wallet_requestPermissions' && message.requestId === 25).at(-1)
		assert.deepEqual(permissionReply?.result, [{
			parentCapability: 'eth_accounts',
			caveats: [{
				type: 'restrictReturnedAccounts',
				value: [accountString],
			}],
			invoker: websiteOrigin,
		}])
	})

	test('delivers accountsChanged before an approved active-address switch resolves', async () => {
		installBrowserMock()
		const { changeActiveAddressAndChain, websiteSocketToString, changeSimulationMode, setUseSignersAddressAsActiveAddress, updateWebsiteAccess } = await loadModules()
		const websiteOrigin = 'https://app.safe.global'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const previousAccount = 0x1111111111111111111111111111111111111111n
		const nextAccount = 0x2222222222222222222222222222222222222222n
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: previousAccount, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{
			website,
			access: true,
			addressAccess: [{ address: previousAccount, access: true }, { address: nextAccount, access: true }],
		}])

		const socket = { tabId: 171, connectionName: 171n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		await changeActiveAddressAndChain(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, {
			simulationMode: true,
			activeAddress: nextAccount,
		})

		assert.deepEqual(messages.map((message) => message.method), ['accountsChanged'])
		assert.deepEqual(messages[0]?.result, ['0x2222222222222222222222222222222222222222'])
	})

	test('clears dapp accounts and finishes opening access approval when the active address is unapproved', async () => {
		installBrowserMock()
		const {
			changeActiveAddressAndChain,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			getPendingAccessRequests,
			clearPendingAccessRequests,
			resolveInterceptorAccess,
		} = await loadModules()
		const websiteOrigin = 'https://app.safe.global'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const previousAccount = 0x3333333333333333333333333333333333333333n
		const nextAccount = 0x4444444444444444444444444444444444444444n
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: previousAccount, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{
			website,
			access: true,
			addressAccess: [{ address: previousAccount, access: true }],
		}])

		const socket = { tabId: 172, connectionName: 172n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		await changeActiveAddressAndChain(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, {
			simulationMode: true,
			activeAddress: nextAccount,
		})

		assert.deepEqual(messages.map((message) => message.method), ['accountsChanged', 'disconnect'])
		assert.deepEqual(messages[0]?.result, [])
		assert.equal(websiteTabConnections.get(socket.tabId)?.connections[connectionKey]?.approved, false)
		const pendingRequest = (await getPendingAccessRequests()).find((request) => request.requestAccessToAddress?.address === nextAccount)
		if (pendingRequest === undefined) throw new Error('Missing address access request')
		assert.equal(pendingRequest.requestAccessToAddress?.address, nextAccount)
		await resolveInterceptorAccess(
			ethereum,
			tokenPriceService,
			resetSimulationServices,
			websiteTabConnections,
			{
				userReply: 'Rejected',
				requestAccessToAddress: pendingRequest.requestAccessToAddress?.address,
				originalRequestAccessToAddress: pendingRequest.originalRequestAccessToAddress?.address,
				accessRequestId: pendingRequest.accessRequestId,
			},
			noopPublishRpcConnectionStatus,
		)
		await clearPendingAccessRequests()
	})

	test('wallet_revokePermissions clears website account access and keeps the website entry', async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, changeSimulationMode, setUseSignersAddressAsActiveAddress, updateWebsiteAccess, getSettings } = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x1111111111111111111111111111111111111111n
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 10, requestSocket: socket },
			method: 'wallet_revokePermissions',
			params: [{ eth_accounts: {} }],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		const accessLossEvents = messages.filter((message) => message.method === 'accountsChanged' || message.method === 'disconnect')
		assert.deepEqual(accessLossEvents.map((message) => message.method), ['accountsChanged', 'disconnect'])
		assert.deepEqual(accessLossEvents[0]?.result, [])
		const revokeReplies = messages.filter((message) => message.method === 'wallet_revokePermissions' && message.requestId === 10)
		assert.equal(revokeReplies.at(-1)?.result, null)
		assert.equal(websiteTabConnections.get(socket.tabId)?.connections[connectionKey]?.approved, false)
		const access = (await getSettings()).websiteAccess.find((entry) => entry.website.websiteOrigin === websiteOrigin)
		assert.notEqual(access, undefined)
		assert.equal(access?.website.websiteOrigin, websiteOrigin)
		assert.equal(access?.access, undefined)
		assert.equal(access?.addressAccess, undefined)
	})

	test('wallet_revokePermissions succeeds when the website is already unauthorized', async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, changeSimulationMode, setUseSignersAddressAsActiveAddress, updateWebsiteAccess, getSettings, getPendingAccessRequests } = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x1111111111111111111111111111111111111111n
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: false, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 11, requestSocket: socket },
			method: 'wallet_revokePermissions',
			params: [{ eth_accounts: {} }],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		const revokeReplies = messages.filter((message) => message.method === 'wallet_revokePermissions' && message.requestId === 11)
		assert.equal(revokeReplies.at(-1)?.result, null)
		const access = (await getSettings()).websiteAccess.find((entry) => entry.website.websiteOrigin === websiteOrigin)
		assert.notEqual(access, undefined)
		assert.equal(access?.website.websiteOrigin, websiteOrigin)
		assert.equal(access?.access, false)
		assert.equal(access?.addressAccess, undefined)

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 15, requestSocket: socket },
			method: 'eth_requestAccounts',
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		const pendingRequests = await getPendingAccessRequests()
		assert.equal(pendingRequests.length, 0)
	})

	test('wallet_revokePermissions succeeds when the Interceptor is disabled for the website', async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, changeSimulationMode, setUseSignersAddressAsActiveAddress, updateWebsiteAccess, getSettings } = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x1111111111111111111111111111111111111111n
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }], interceptorDisabled: true }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 12, requestSocket: socket },
			method: 'wallet_revokePermissions',
			params: [{ eth_accounts: {} }],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		const revokeReplies = messages.filter((message) => message.method === 'wallet_revokePermissions' && message.requestId === 12)
		assert.equal(revokeReplies.at(-1)?.result, null)
		const access = (await getSettings()).websiteAccess.find((entry) => entry.website.websiteOrigin === websiteOrigin)
		assert.notEqual(access, undefined)
		assert.equal(access?.website.websiteOrigin, websiteOrigin)
		assert.equal(access?.access, undefined)
		assert.equal(access?.addressAccess, undefined)
		assert.equal(access?.interceptorDisabled, true)
	})

	test('wallet_revokePermissions causes later account requests to prompt again instead of auto-denying', async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, changeSimulationMode, setUseSignersAddressAsActiveAddress, updateWebsiteAccess, getPendingAccessRequests, updateWebsiteApprovalAccesses, getSettings } = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x1111111111111111111111111111111111111111n
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 13, requestSocket: socket },
			method: 'wallet_revokePermissions',
			params: [{ eth_accounts: {} }],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(websiteTabConnections.get(socket.tabId)?.connections[connectionKey]?.approved, false)
		assert.equal(websiteTabConnections.get(socket.tabId)?.connections[connectionKey]?.wantsToConnect, false)
		await updateWebsiteApprovalAccesses(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, await getSettings(), true)
		assert.equal((await getPendingAccessRequests()).length, 0)

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 14, requestSocket: socket },
			method: 'eth_requestAccounts',
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		const pendingRequests = await getPendingAccessRequests()
		assert.equal(pendingRequests.length, 1)
		assert.equal(pendingRequests[0]?.website.websiteOrigin, websiteOrigin)
	})

	test('wallet_revokePermissions rejects unsupported permission params without revoking access', async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, changeSimulationMode, setUseSignersAddressAsActiveAddress, updateWebsiteAccess, getSettings } = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x1111111111111111111111111111111111111111n
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const unsupportedParams: unknown[] = [
			[],
			[{ wallet_switchEthereumChain: {} }],
			[{ wallet_snap: {} }],
			[{ eth_accounts: {}, wallet_snap: {} }],
			[{ eth_accounts: { foo: 1 } }],
		]
		for (const [index, params] of unsupportedParams.entries()) {
			const requestId = 13 + index
			await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
				interceptorRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId, requestSocket: socket },
				method: 'wallet_revokePermissions',
				params,
			}, websiteTabConnections, noopPublishRpcConnectionStatus)

			const revokeReplies = messages.filter((message) => message.method === 'wallet_revokePermissions' && message.requestId === requestId)
			assert.equal(revokeReplies.at(-1)?.error?.code, -32700)
			assert.equal(websiteTabConnections.get(socket.tabId)?.connections[connectionKey]?.approved, true)
			const access = (await getSettings()).websiteAccess.find((entry) => entry.website.websiteOrigin === websiteOrigin)
			assert.equal(access?.access, true)
			assert.deepEqual(access?.addressAccess, [{ address: account, access: true }])
		}
	})

	test('stored websites without an active decision remain promptable instead of denied', async () => {
		installBrowserMock()
		const { hasAccess, hasAddressAccess } = await loadModules()
		const websiteOrigin = 'https://example.test'
		const address = { address: 0x1111111111111111111111111111111111111111n, askForAddressAccess: true, type: 'contact', name: 'Test Address' } as const

		assert.equal(hasAccess([{ website: { websiteOrigin, icon: undefined, title: undefined }, addressAccess: undefined }], websiteOrigin), 'askAccess')
		assert.equal(hasAddressAccess([{ website: { websiteOrigin, icon: undefined, title: undefined }, addressAccess: undefined }], websiteOrigin, address), 'askAccess')
		assert.equal(hasAccess([], websiteOrigin), 'askAccess')
		assert.equal(hasAddressAccess([], websiteOrigin, address), 'askAccess')
	})
})
