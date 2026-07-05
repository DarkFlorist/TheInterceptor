import * as assert from 'assert'
import { describe, test } from 'bun:test'
import type { Settings } from '../../app/ts/types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../../app/ts/types/user-interface-types.js'
import type { InterceptedRequest, WebsiteSocket } from '../../app/ts/utils/requests.js'

type Listener = (id: number) => unknown

function installBrowserMock() {
	const storageState: Record<string, unknown> = {}
	const windowRemovedListeners: Listener[] = []
	const tabRemovedListeners: Listener[] = []
	const postedMessages: unknown[] = []
	let pendingAccessClearHook: (() => void) | undefined
	let pendingAccessReadHook: (() => void) | undefined

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
					const result = (() => {
						if (keys === undefined || keys === null) return { ...storageState }
						if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => key in storageState).map((key) => [key, storageState[key]]))
						if (typeof keys === 'string') return keys in storageState ? { [keys]: storageState[keys] } : {}
						return Object.fromEntries(Object.entries(keys).map(([key, defaultValue]) => [key, key in storageState ? storageState[key] : defaultValue]))
					})()
					if (Array.isArray(result.pendingInterceptorAccessRequests) && result.pendingInterceptorAccessRequests.length > 0 && pendingAccessReadHook !== undefined) {
						const hook = pendingAccessReadHook
						pendingAccessReadHook = undefined
						hook()
					}
					return result
				},
				async set(items: Record<string, unknown>) {
					Object.assign(storageState, items)
					if (Array.isArray(items.pendingInterceptorAccessRequests) && items.pendingInterceptorAccessRequests.length === 0 && pendingAccessClearHook !== undefined) {
						const hook = pendingAccessClearHook
						pendingAccessClearHook = undefined
						queueMicrotask(hook)
					}
				},
				async remove(keys: string | string[]) {
					for (const key of Array.isArray(keys) ? keys : [keys]) delete storageState[key]
				},
			},
		},
		tabs: {
			async query() { return [] },
			async get(tabId: number) { return { id: tabId, active: true } },
			async update() { return undefined },
			onUpdated: { addListener: (_listener: Listener) => undefined, removeListener: (_listener: Listener) => undefined },
			onRemoved: {
				addListener(listener: Listener) { tabRemovedListeners.push(listener) },
				removeListener(listener: Listener) {
					const index = tabRemovedListeners.indexOf(listener)
					if (index >= 0) tabRemovedListeners.splice(index, 1)
				},
			},
		},
		windows: {
			async create() { return { id: 1, focused: true } },
			async get(windowId: number) { return { id: windowId, focused: true } },
			async update() { return undefined },
			async remove() { return undefined },
			onRemoved: {
				addListener(listener: Listener) { windowRemovedListeners.push(listener) },
				removeListener(listener: Listener) {
					const index = windowRemovedListeners.indexOf(listener)
					if (index >= 0) windowRemovedListeners.splice(index, 1)
				},
			},
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
		postedMessages,
		onPendingAccessClear(hook: () => void) {
			pendingAccessClearHook = hook
		},
		onPendingAccessRead(hook: () => void) {
			pendingAccessReadHook = hook
		},
		closeAccessWindow() {
			const [listener] = windowRemovedListeners
			if (listener === undefined) throw new Error('Missing access window close listener')
			return listener(1)
		},
	}
}

async function loadModules() {
	return {
		...await import('../../app/ts/background/settings.js'),
		...await import('../../app/ts/background/storageVariables.js'),
		...await import('../../app/ts/background/backgroundUtils.js'),
		...await import('../../app/ts/background/windows/interceptorAccess.js'),
	}
}

describe('interceptor access close handling', () => {
	test('serializes dialog close cleanup with matching request creation', async () => {
		const browserMock = installBrowserMock()
		const { requestAccessFromUser, getPendingAccessRequests, websiteSocketToString } = await loadModules()
		const website = { websiteOrigin: 'https://example.test', icon: undefined, title: undefined }
		const socket: WebsiteSocket = { tabId: 1, connectionName: 0n }
		const port = { name: '0x0', sender: { tab: { id: socket.tabId } }, postMessage(message: unknown) { browserMock.postedMessages.push(message) } } as unknown as browser.runtime.Port
		const websiteTabConnections: WebsiteTabConnections = new Map([[socket.tabId, { connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin: website.websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const settings: Settings = {
			activeSimulationAddress: undefined,
			activeSigningAddress: undefined,
			openedPage: { page: 'Home' },
			useSignersAddressAsActiveAddress: false,
			websiteAccess: [],
			simulationMode: true,
			activeRpcNetwork: {
				name: 'Test RPC',
				chainId: 1n,
				httpsRpc: 'https://example.invalid',
				currencyName: 'Ether',
				currencyTicker: 'ETH',
				primary: true,
				minimized: true,
			},
		}
		const ethereum = {} as never
		const tokenPriceService = {} as never
		const resetSimulationServices = (() => undefined) as never

		await requestAccessFromUser(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, socket, website, undefined, undefined, settings, undefined, undefined)

		const request: InterceptedRequest = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 1, requestSocket: socket },
			method: 'eth_accounts',
		}
		let publishCalls = 0
		let concurrentRequest: Promise<void> | undefined
		browserMock.onPendingAccessClear(() => {
			concurrentRequest = requestAccessFromUser(
				ethereum,
				tokenPriceService,
				resetSimulationServices,
				websiteTabConnections,
				socket,
				website,
				request,
				undefined,
				settings,
				undefined,
				async () => {
					publishCalls += 1
				},
			)
		})

		await browserMock.closeAccessWindow()
		if (concurrentRequest === undefined) throw new Error('Concurrent access request was not started')
		await concurrentRequest

		const pendingRequests = await getPendingAccessRequests()
		assert.equal(publishCalls, 0)
		assert.equal(pendingRequests.length, 1)
		assert.equal(pendingRequests[0]?.request?.method, 'eth_accounts')
		await browserMock.closeAccessWindow()
	})

	test('serializes dialog close cleanup with popup resolution', async () => {
		const browserMock = installBrowserMock()
		const { requestAccessFromUser, resolveInterceptorAccess, websiteSocketToString } = await loadModules()
		const website = { websiteOrigin: 'https://example.test', icon: undefined, title: undefined }
		const socket: WebsiteSocket = { tabId: 1, connectionName: 0n }
		const port = { name: '0x0', sender: { tab: { id: socket.tabId } }, postMessage(message: unknown) { browserMock.postedMessages.push(message) } } as unknown as browser.runtime.Port
		const websiteTabConnections: WebsiteTabConnections = new Map([[socket.tabId, { connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin: website.websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const settings: Settings = {
			activeSimulationAddress: undefined,
			activeSigningAddress: undefined,
			openedPage: { page: 'Home' },
			useSignersAddressAsActiveAddress: false,
			websiteAccess: [],
			simulationMode: true,
			activeRpcNetwork: {
				name: 'Test RPC',
				chainId: 1n,
				httpsRpc: 'https://example.invalid',
				currencyName: 'Ether',
				currencyTicker: 'ETH',
				primary: true,
				minimized: true,
			},
		}
		const ethereum = {} as never
		const tokenPriceService = {} as never
		const resetSimulationServices = (() => undefined) as never
		const request: InterceptedRequest = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 1, requestSocket: socket },
			method: 'eth_accounts',
		}

		await requestAccessFromUser(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, socket, website, request, undefined, settings, undefined, async () => undefined)

		let closeAccessWindow: Promise<unknown> | undefined
		browserMock.onPendingAccessRead(() => {
			closeAccessWindow = Promise.resolve(browserMock.closeAccessWindow())
		})

		await resolveInterceptorAccess(
			ethereum,
			tokenPriceService,
			resetSimulationServices,
			websiteTabConnections,
			{ originalRequestAccessToAddress: undefined, requestAccessToAddress: undefined, accessRequestId: 'undefined || https://example.test', userReply: 'Approved' },
			async () => undefined,
		)
		if (closeAccessWindow === undefined) throw new Error('Concurrent access window close was not started')
		await closeAccessWindow

		const ethAccountsReplies = browserMock.postedMessages.filter((message): message is { requestId: number, method: string, error?: { code: number } } => {
			return typeof message === 'object' && message !== null && 'requestId' in message && 'method' in message && message.method === 'eth_accounts'
		})
		assert.equal(ethAccountsReplies.length, 1)
		assert.notEqual(ethAccountsReplies[0]?.error?.code, 4100)
	})
})
