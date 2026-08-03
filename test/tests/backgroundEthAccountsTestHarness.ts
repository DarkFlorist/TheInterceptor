import type { ResetSimulationServices } from '../../app/ts/simulation/serviceLifecycle.js'
import { EthereumJSONRpcRequestHandler } from '../../app/ts/simulation/services/EthereumJSONRpcRequestHandler.js'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import { TokenPriceService } from '../../app/ts/simulation/services/priceEstimator.js'
import type { RpcEntry } from '../../app/ts/types/rpc.js'
import type { PublishRpcConnectionStatus } from '../../app/ts/background/rpcSlowRequestTracking.js'
import { createSafeTx, safeTxToTypedDataJson } from '../../app/ts/safe/safeCore.js'
import { EthereumJsonRpcRequest } from '../../app/ts/types/JsonRpc-types.js'
import { addressString } from '../../app/ts/utils/bigint.js'

type Listener = () => void
type PortMessage = { type?: unknown, method?: unknown, result?: unknown, requestId?: unknown, error?: { code?: unknown, message?: unknown } }
export const noopPublishRpcConnectionStatus: PublishRpcConnectionStatus = async () => undefined

export function createDeferredSignal() {
	let resolveSignal = () => undefined
	const promise = new Promise<void>((resolve) => { resolveSignal = resolve })
	return { promise, resolve: () => resolveSignal() }
}

export function createDeferredValue<T>() {
	let resolveValue = (_value: T) => undefined
	const promise = new Promise<T>((resolve) => { resolveValue = resolve })
	return { promise, resolve: (value: T) => resolveValue(value) }
}

export function installBrowserMock({ deferFirstChainChangeRemoval = false, manifestVersion = 3 }: { readonly deferFirstChainChangeRemoval?: boolean, readonly manifestVersion?: 2 | 3 } = {}) {
	const storageState: Record<string, unknown> = {}
	const chainChangeRemovalStarted = createDeferredSignal()
	const chainChangeRemovalRelease = createDeferredSignal()
	let chainChangeRemovalDeferred = false
	const requestBlockingCalls = {
		declarativeNetRequestUpdates: 0,
		webRequestListenerAdds: 0,
		webRequestListenerRemovals: 0,
	}
	;(globalThis as typeof globalThis & { browser: typeof globalThis.browser }).browser = {
		runtime: {
			lastError: null,
			async sendMessage() {
				return undefined
			},
			getManifest: () => ({ manifest_version: manifestVersion }),
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
			async updateDynamicRules() {
				requestBlockingCalls.declarativeNetRequestUpdates += 1
				return undefined
			},
			async updateSessionRules() {
				requestBlockingCalls.declarativeNetRequestUpdates += 1
				return undefined
			},
		},
		webRequest: {
			onBeforeRequest: {
				addListener() {
					requestBlockingCalls.webRequestListenerAdds += 1
				},
				removeListener() {
					requestBlockingCalls.webRequestListenerRemovals += 1
				},
			},
		},
	} as unknown as typeof globalThis.browser
	;(globalThis as typeof globalThis & { chrome: { runtime: { id: string } } }).chrome = { runtime: { id: 'test-extension' } }
	;(globalThis as typeof globalThis & { location: Location }).location = { origin: '' } as unknown as Location
	return {
		waitForDeferredChainChangeRemoval: async () => await chainChangeRemovalStarted.promise,
		releaseDeferredChainChangeRemoval: chainChangeRemovalRelease.resolve,
		requestBlockingCalls,
		readStoredValue: (key: string) => storageState[key],
	}
}

export async function loadModules() {
	return {
		...await import('../../app/ts/background/accessManagement.js'),
		...await import('../../app/ts/background/activeSettings.js'),
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

export function createPort(tabId: number, onPostMessage?: (message: PortMessage) => void, frameId?: number, connectionName = 0n) {
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

export function confirmedSignerOwnership(socket: { readonly connectionName: bigint }) {
	return {
		signerStateOwner: {
			connectionName: socket.connectionName,
			confirmed: true,
			generation: 1,
			providerGeneration: 1,
		},
	}
}

export async function waitForPortMessageCount(messages: readonly PortMessage[], method: string, count: number, timeoutMs = 100) {
	const deadline = Date.now() + timeoutMs
	while (messages.filter((message) => message.method === method).length < count) {
		if (Date.now() >= deadline) throw new Error(`Missing ${ method } port message`)
		await new Promise((resolve) => setTimeout(resolve, 0))
	}
}

export function createEthereumWithGetBlockCounter(
	getBlockCalls: { count: number },
	{ initialBlockPolling = true, getCodeResult }: { readonly initialBlockPolling?: boolean, readonly getCodeResult?: Uint8Array } = {},
) {
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
				if (property === 'getCode' && getCodeResult !== undefined) return async () => getCodeResult
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

export { addressString, createSafeTx, EthereumJsonRpcRequest, safeTxToTypedDataJson }
