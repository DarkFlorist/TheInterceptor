// Shared setup for tests that drive the background script's website-connection, account-access and signer flows.
//
// Usage:
//   const installBrowserMock = createRestoringBrowserMockInstaller()  // once per file; restores the globals after each test
//   const browserMock = installBrowserMock()                           // test/harness/browserMock.ts mock plus the background-specific helpers below
//   const { handleInterceptedRequest } = await loadModules()
//   const { port, messages } = createPort(socket.tabId)                // a website port whose posted messages are collected as PortMessage values
//   await waitForPortMessageCount(messages, 'accountsChanged', 1)
//
// For deferred values use Promise.withResolvers<T>().
import type { WebsiteTabConnections } from '../../app/ts/types/user-interface-types.js'
import type { SimulationServicesOwner } from '../../app/ts/simulation/serviceLifecycle.js'
import { EthereumJSONRpcRequestHandler } from '../../app/ts/simulation/services/EthereumJSONRpcRequestHandler.js'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import { TokenPriceService } from '../../app/ts/simulation/services/priceEstimator.js'
import type { RpcEntry } from '../../app/ts/types/rpc.js'
import type { PublishRpcConnectionStatus } from '../../app/ts/background/rpcSlowRequestTracking.js'
import { createSafeTx, safeTxToTypedDataJson } from '../../app/ts/safe/safeCore.js'
import { EthereumJsonRpcRequest } from '../../app/ts/types/JsonRpc-types.js'
import { addressString } from '../../app/ts/utils/bigint.js'
import { flushMicrotasks, settleWithin, waitFor } from '../harness/async.js'
import { createMockPort, installBrowserMock as installSharedBrowserMock, type BrowserMock, type BrowserMockOptions, type MockTabSeed } from '../harness/browserMock.js'
import { replaceGlobal } from '../harness/globals.js'
import { createPerTestRestorer } from '../harness/perTest.js'
import { importAllPopupMessageHandlers } from './popupMessageHandlerModules.js'

// The fields tests read from messages that the background posts to a website port; every other field is still present on the message object.
export type PortMessage = { walletSwitchRequestId?: unknown, type?: unknown, method?: unknown, result?: unknown, requestId?: unknown, error?: { code?: unknown, message?: unknown } }
export const noopPublishRpcConnectionStatus: PublishRpcConnectionStatus = async () => undefined

// Background modules keep dialog window ids between tests (the open access dialog, for example), so each mock creates tabs and windows from a fresh id range, like one long browser session that never reuses ids; otherwise closing an earlier test's dialog would close this test's new dialog.
const createdIdRangeSize = 1000
let createdIdRangeStart = 0

// The website tabs that most background tests connect ports from. They are inactive, so tabs.query({ active: true }) still finds no current tab.
const defaultWebsiteTabs: readonly MockTabSeed[] = [{ id: 1 }, { id: 2 }]

export type BackgroundBrowserMockOptions = BrowserMockOptions & {
	// Holds the first storage removal of chainChangeConfirmationPromise until releaseDeferredChainChangeRemoval() is called.
	readonly deferFirstChainChangeRemoval?: boolean
}

type RequestBlockingCalls = {
	readonly declarativeNetRequestUpdates: number
	readonly webRequestListenerAdds: number
	readonly webRequestListenerRemovals: number
}

export type BackgroundBrowserMock = BrowserMock & {
	// The same array as calls.runtimeSendMessage, under the name older tests use.
	readonly runtimeMessages: unknown[]
	readonly requestBlockingCalls: RequestBlockingCalls
	readonly readStoredValue: (key: string) => unknown
	readonly waitForDeferredChainChangeRemoval: () => Promise<void>
	readonly releaseDeferredChainChangeRemoval: () => void
}

// Installs test/harness/browserMock.ts with the extension id and location origin that the background tests expect, counts request-blocking work, and seeds defaultWebsiteTabs unless options.tabs lists the website tabs (a website port's tab must exist, or the background treats the website as closed). restore() puts back the previous browser, chrome and location globals.
export function installBackgroundBrowserMock({ deferFirstChainChangeRemoval = false, ...options }: BackgroundBrowserMockOptions = {}): BackgroundBrowserMock {
	createdIdRangeStart += createdIdRangeSize
	const browserMock = installSharedBrowserMock({
		extensionId: 'test-extension',
		tabs: defaultWebsiteTabs,
		firstCreatedIds: { tab: createdIdRangeStart, window: createdIdRangeStart },
		...options,
	})
	const restoreLocation = replaceGlobal('location', { origin: '' })

	const webRequestListenerCalls = { adds: 0, removals: 0 }
	const onBeforeRequest = browserMock.browser.webRequest.onBeforeRequest
	const addWebRequestListener = onBeforeRequest.addListener
	const removeWebRequestListener = onBeforeRequest.removeListener
	onBeforeRequest.addListener = (listener) => {
		webRequestListenerCalls.adds += 1
		addWebRequestListener(listener)
	}
	onBeforeRequest.removeListener = (listener) => {
		webRequestListenerCalls.removals += 1
		removeWebRequestListener(listener)
	}

	const chainChangeRemovalStarted = Promise.withResolvers<void>()
	const chainChangeRemovalRelease = Promise.withResolvers<void>()
	let chainChangeRemovalDeferred = false
	const localStorage = browserMock.browser.storage.local
	const removeFromLocalStorage = localStorage.remove
	localStorage.remove = async (keys) => {
		const keysToRemove = typeof keys === 'string' ? [keys] : keys
		if (deferFirstChainChangeRemoval && !chainChangeRemovalDeferred && keysToRemove.includes('chainChangeConfirmationPromise')) {
			chainChangeRemovalDeferred = true
			chainChangeRemovalStarted.resolve()
			await chainChangeRemovalRelease.promise
		}
		await removeFromLocalStorage(keys)
	}

	return {
		...browserMock,
		runtimeMessages: browserMock.calls.runtimeSendMessage,
		requestBlockingCalls: {
			get declarativeNetRequestUpdates() { return browserMock.calls.declarativeNetRequestUpdates.length },
			get webRequestListenerAdds() { return webRequestListenerCalls.adds },
			get webRequestListenerRemovals() { return webRequestListenerCalls.removals },
		},
		readStoredValue: (key) => readStorageItem(browserMock, key),
		waitForDeferredChainChangeRemoval: async () => await chainChangeRemovalStarted.promise,
		releaseDeferredChainChangeRemoval: () => { chainChangeRemovalRelease.resolve() },
		restore: () => {
			restoreLocation()
			browserMock.restore()
		},
	}
}

// The background flavour of test/harness/perTest.ts createPerTestBrowserMockInstaller: call once at file or describe level, call the returned installer in each test, and the globals those mocks replaced are restored after the test, newest first.
export function createRestoringBrowserMockInstaller(): (options?: BackgroundBrowserMockOptions) => BackgroundBrowserMock {
	const { restoreAfterTest } = createPerTestRestorer()
	return (options) => {
		const browserMock = installBackgroundBrowserMock(options)
		restoreAfterTest(browserMock.restore)
		return browserMock
	}
}

// Reads one stored local-storage value, or undefined when the key is absent, like browser.storage.local.get(key)[key].
function readStorageItem(browserMock: Pick<BrowserMock, 'readStorage'>, key: string, area: 'local' | 'session' = 'local'): unknown {
	return new Map(Object.entries(browserMock.readStorage(area))).get(key)
}

export async function loadModules() {
	const safeApps = await import('../../app/ts/background/safeAppsCompatibilityCoordinator.js')
	return {
		...await import('../../app/ts/background/accessManagement.js'),
		...await import('../../app/ts/background/activeSettings.js'),
		...await import('../../app/ts/background/background.js'),
		...await import('../../app/ts/background/backgroundUtils.js'),
		...await importAllPopupMessageHandlers(),
		...safeApps,
		initializeSafeAppsCompatibility: async (connections: WebsiteTabConnections) => {
			const feature = safeApps.createSafeAppsCompatibilityFeature(connections)
			Object.assign(connections, { lifecycle: feature.lifecycle })
			return await safeApps.initializeSafeAppsCompatibility(feature)
		},
		...await import('../../app/ts/background/websiteLifecycle.js'),
		...await import('../../app/ts/background/settings.js'),
		...await import('../../app/ts/background/storageVariables.js'),
		...await import('../../app/ts/utils/unexpectedErrorStorage.js'),
		...await import('../../app/ts/background/websiteAccessPolicy.js'),
		...await import('../../app/ts/background/websiteTabConnections.js'),
		...await import('../../app/ts/background/windows/changeChain.js'),
		...await import('../../app/ts/background/windows/interceptorAccess.js'),
		...await import('../../app/ts/background/interceptorAccessResolution.js'),
		...await import('../../app/ts/background/websiteAccessReconciliation.js'),
		...await import('../../app/ts/background/websiteRequestBlocking.js'),
		...await import('../../app/ts/background/settingsTransitionLock.js'),
		...await import('../../app/ts/background/signerStateOwnership.js'),
	}
}

const isPortMessage = (message: unknown): message is PortMessage => typeof message === 'object'
	&& message !== null
	&& (!('error' in message) || message.error === undefined || (typeof message.error === 'object' && message.error !== null))

// The background only posts JSON objects to website ports; anything else is a bug the test should surface. The original object is kept so tests can compare whole messages.
function toPortMessage(message: unknown): PortMessage {
	if (!isPortMessage(message)) throw new Error(`Expected a port message object, got ${ JSON.stringify(message) }`)
	return message
}

// A tab like the one Chrome puts in a content-script port's sender.
const createSenderTab = (tabId: number): browser.tabs.Tab => ({ id: tabId, index: 0, windowId: 1, active: true, highlighted: false, pinned: false, incognito: false })

// A content-script port for tabId, named after the connection like the injected provider names it; frameId undefined means an MV2 sender without a frame id.
export function createPort(tabId: number, onPostMessage?: (message: PortMessage) => void, frameId?: number, connectionName = 0n) {
	const messages: PortMessage[] = []
	const { port } = createMockPort({
		name: `0x${ connectionName.toString(16) }`,
		sender: { tab: createSenderTab(tabId), ...(frameId === undefined ? {} : { frameId }) },
		onPostMessage: (message) => {
			const portMessage = toPortMessage(message)
			messages.push(portMessage)
			onPostMessage?.(portMessage)
		},
	})
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

export async function waitForPortMessageCount(messages: readonly PortMessage[], method: string, count: number, timeoutMs = 1000) {
	await waitFor(() => messages.filter((message) => message.method === method).length >= count, { timeoutMs, intervalMs: 1, description: `${ count } ${ method } port message(s)` })
}

// A socket that no background or test listener waits on, so a window message for it only marks a position in the internal channel's message order.
const internalChannelMarkerSocket = { tabId: 2_147_483_647, connectionName: 0xffff_ffffn }

// Resolves once every window message the background has posted so far on its internal BroadcastChannel has reached the listeners, because a marker posted afterwards is delivered after them; use it before asserting that the background ignored or never sent such a message.
export async function waitForInternalWindowMessageDelivery() {
	const { INTERNAL_CHANNEL_NAME, sendInternalWindowMessage } = await import('../../app/ts/background/backgroundUtils.js')
	const { WindowMessage } = await import('../../app/ts/types/interceptor-messages.js')
	await flushMicrotasks()
	const receiver = new BroadcastChannel(INTERNAL_CHANNEL_NAME)
	const markerDelivered = Promise.withResolvers<void>()
	receiver.onmessage = (event) => {
		const parsed = WindowMessage.safeParse(event.data)
		if (parsed.success && parsed.value.data.socket.tabId === internalChannelMarkerSocket.tabId) markerDelivered.resolve()
	}
	try {
		sendInternalWindowMessage({ method: 'window_signer_accounts_changed', data: { socket: internalChannelMarkerSocket, signerStateOwnerGeneration: 0, signerProviderGeneration: 0 } })
		await settleWithin(markerDelivered.promise, 1000, 'The internal window message marker was not delivered')
	} finally {
		receiver.close()
	}
	await flushMicrotasks()
}

export function createEthereumWithGetBlockCounter(
	getBlockCalls: { count: number },
	{
		initialBlockPolling = true,
		getCodeResult,
		getStorageAtResult,
		getChainId,
	}: {
		readonly initialBlockPolling?: boolean
		readonly getCodeResult?: Uint8Array
		readonly getStorageAtResult?: bigint
		// Replaces EthereumClientService.getChainId, for example to count which services instance answered.
		readonly getChainId?: () => bigint
	} = {},
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
				if (property === 'getStorageAt' && getStorageAtResult !== undefined) return async () => getStorageAtResult
				if (property === 'getChainId' && getChainId !== undefined) return getChainId
				return Reflect.get(target, property, receiver)
			},
		},
	)
	const tokenPriceService = new TokenPriceService(ethereum, 60_000)
	return {
		ethereum,
		tokenPriceService,
		simulationServicesOwner: createTestSimulationServicesOwner({ ethereum, tokenPriceService }),
	}
}

export { addressString, createSafeTx, EthereumJsonRpcRequest, safeTxToTypedDataJson }

export function getWalletSwitchRequestId(messages: readonly PortMessage[], index = -1) {
	const id = messages.filter(message => message.method === 'request_signer_to_wallet_switchEthereumChain').at(index)?.walletSwitchRequestId
	if (typeof id !== 'string') throw new Error('Missing wallet switch request ID')
	return id
}

export function createTestSimulationServicesOwner(initial: { ethereum: EthereumClientService, tokenPriceService: TokenPriceService }, reset?: SimulationServicesOwner['reset']): SimulationServicesOwner {
	let current = initial
	return {
		getCurrent: () => current,
		reset: network => { current = reset === undefined ? current : reset(network); return current },
	}
}
