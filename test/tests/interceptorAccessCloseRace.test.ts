import * as assert from 'assert'
import { describe, test } from 'bun:test'
import type { Settings } from '../../app/ts/types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../../app/ts/types/user-interface-types.js'
import type { InterceptedRequest, WebsiteSocket } from '../../app/ts/utils/requests.js'

type Listener = (id: number) => unknown

// The background module is cached across tests. Preserve its registered listeners while routing them to each test's fresh browser mock.
const registeredWindowRemovedListeners = new Set<Listener>()
const registeredTabRemovedListeners = new Set<Listener>()
let activeWindowRemovedListeners: Listener[] = []
let activeTabRemovedListeners: Listener[] = []
let activeStorageState: Record<string, unknown> = {}
let activePendingAccessClearHook: (() => void) | undefined
let activePendingAccessReadHook: (() => void) | undefined

function installBrowserMock() {
	const storageState: Record<string, unknown> = {}
	activeStorageState = storageState
	activePendingAccessClearHook = undefined
	activePendingAccessReadHook = undefined
	const windowRemovedListeners = [...registeredWindowRemovedListeners]
	const tabRemovedListeners = [...registeredTabRemovedListeners]
	activeWindowRemovedListeners = windowRemovedListeners
	activeTabRemovedListeners = tabRemovedListeners
	const postedMessages: unknown[] = []

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
						if (keys === undefined || keys === null) return { ...activeStorageState }
						if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => key in activeStorageState).map((key) => [key, activeStorageState[key]]))
						if (typeof keys === 'string') return keys in activeStorageState ? { [keys]: activeStorageState[keys] } : {}
						return Object.fromEntries(Object.entries(keys).map(([key, defaultValue]) => [key, key in activeStorageState ? activeStorageState[key] : defaultValue]))
					})()
					if (Array.isArray(result.pendingInterceptorAccessRequests) && result.pendingInterceptorAccessRequests.length > 0 && activePendingAccessReadHook !== undefined) {
						const hook = activePendingAccessReadHook
						activePendingAccessReadHook = undefined
						hook()
					}
					return result
				},
				async set(items: Record<string, unknown>) {
					Object.assign(activeStorageState, items)
					if (Array.isArray(items.pendingInterceptorAccessRequests) && items.pendingInterceptorAccessRequests.length === 0 && activePendingAccessClearHook !== undefined) {
						const hook = activePendingAccessClearHook
						activePendingAccessClearHook = undefined
						hook()
					}
				},
				async remove(keys: string | string[]) {
					for (const key of Array.isArray(keys) ? keys : [keys]) delete activeStorageState[key]
				},
			},
		},
		tabs: {
			async query() { return [] },
			async get(tabId: number) { return { id: tabId, active: true, status: 'complete', favIconUrl: '' } },
			async update() { return undefined },
			onUpdated: { addListener: (_listener: Listener) => undefined, removeListener: (_listener: Listener) => undefined },
			onRemoved: {
				addListener(listener: Listener) {
					registeredTabRemovedListeners.add(listener)
					if (!activeTabRemovedListeners.includes(listener)) activeTabRemovedListeners.push(listener)
				},
				removeListener(listener: Listener) {
					registeredTabRemovedListeners.delete(listener)
					const index = activeTabRemovedListeners.indexOf(listener)
					if (index >= 0) activeTabRemovedListeners.splice(index, 1)
				},
			},
		},
		windows: {
			async create() { return { id: 1, focused: true } },
			async get(windowId: number) { return { id: windowId, focused: true } },
			async update() { return undefined },
			async remove() { return undefined },
			onRemoved: {
				addListener(listener: Listener) {
					registeredWindowRemovedListeners.add(listener)
					if (!activeWindowRemovedListeners.includes(listener)) activeWindowRemovedListeners.push(listener)
				},
				removeListener(listener: Listener) {
					registeredWindowRemovedListeners.delete(listener)
					const index = activeWindowRemovedListeners.indexOf(listener)
					if (index >= 0) activeWindowRemovedListeners.splice(index, 1)
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
			activePendingAccessClearHook = hook
		},
		onPendingAccessRead(hook: () => void) {
			activePendingAccessReadHook = hook
		},
		closeAccessWindow() {
			if (windowRemovedListeners.length === 0) throw new Error('Missing access window close listener')
			return Promise.all([...windowRemovedListeners].map(async (listener) => await listener(1)))
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
	test('does not emit pre-response connection events when eth_requestAccounts already has access', async () => {
		const browserMock = installBrowserMock()
		const { requestAccessFromUser, websiteSocketToString, changeSimulationMode, updateWebsiteAccess, getSettings } = await loadModules()
		const website = { websiteOrigin: 'https://example.test', icon: undefined, title: undefined }
		const account = 0xd8da6bf26964af9d7eed9e03e53415d37aa96045n
		const socket: WebsiteSocket = { tabId: 1, connectionName: 0n }
		const port = { name: '0x0', sender: { tab: { id: socket.tabId } }, postMessage(message: unknown) { browserMock.postedMessages.push(message) } } as unknown as browser.runtime.Port
		const websiteTabConnections: WebsiteTabConnections = new Map([[socket.tabId, { connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin: website.websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account, activeSigningAddress: undefined })
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])
		const request: InterceptedRequest = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 7, requestSocket: socket },
			method: 'eth_requestAccounts',
		}
		const ethereum = {} as never
		const tokenPriceService = {} as never
		const resetSimulationServices = (() => undefined) as never

		await requestAccessFromUser(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, socket, website, request, undefined, await getSettings(), account, async () => undefined)

		const postedMessages = browserMock.postedMessages as Array<{ method?: string, result?: unknown, requestId?: number }>
		assert.deepEqual(postedMessages.map((message) => message.method), ['accountsChanged', 'eth_accounts'])
		assert.deepEqual(postedMessages.map((message) => message.requestId), [7, 7])
		assert.deepEqual(postedMessages[0]?.result, ['0xd8da6bf26964af9d7eed9e03e53415d37aa96045'])
		assert.deepEqual(postedMessages[1]?.result, ['0xd8da6bf26964af9d7eed9e03e53415d37aa96045'])
	})

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

	test('prompts another connection after releasing the popup resolution semaphore', async () => {
		installBrowserMock()
		const {
			changeSimulationMode,
			getPendingAccessRequests,
			requestAccessFromUser,
			resolveInterceptorAccess,
			websiteSocketToString,
		} = await loadModules()
		const { getActiveAddressEntry } = await import('../../app/ts/background/metadataUtils.js')
		const account = 0x1234567890123456789012345678901234567890n
		const firstWebsite = { websiteOrigin: 'https://first.example.test', icon: undefined, title: undefined }
		const secondWebsite = { websiteOrigin: 'https://second.example.test', icon: undefined, title: undefined }
		const firstSocket: WebsiteSocket = { tabId: 1, connectionName: 1n }
		const secondSocket: WebsiteSocket = { tabId: 2, connectionName: 2n }
		const createPort = (tabId: number) => ({ name: '0x0', sender: { tab: { id: tabId } }, postMessage() { return undefined } }) as unknown as browser.runtime.Port
		const websiteTabConnections: WebsiteTabConnections = new Map([
			[firstSocket.tabId, { connections: {
				[websiteSocketToString(firstSocket)]: {
					port: createPort(firstSocket.tabId),
					socket: firstSocket,
					websiteOrigin: firstWebsite.websiteOrigin,
					approved: false,
					wantsToConnect: true,
				},
			} }],
			[secondSocket.tabId, { connections: {
				[websiteSocketToString(secondSocket)]: {
					port: createPort(secondSocket.tabId),
					socket: secondSocket,
					websiteOrigin: secondWebsite.websiteOrigin,
					approved: false,
					wantsToConnect: true,
				},
			} }],
		])
		const ethereum = {} as never
		const tokenPriceService = {} as never
		const resetSimulationServices = (() => undefined) as never
		const publishRpcConnectionStatus = async () => undefined
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account, activeSigningAddress: undefined })
		const activeAddress = await getActiveAddressEntry(account)
		const settings: Settings = {
			activeSimulationAddress: account,
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

		await requestAccessFromUser(
			ethereum,
			tokenPriceService,
			resetSimulationServices,
			websiteTabConnections,
			firstSocket,
			firstWebsite,
			undefined,
			activeAddress,
			settings,
			account,
			undefined,
		)
		const firstRequest = (await getPendingAccessRequests())[0]
		if (firstRequest === undefined) throw new Error('Missing first access request')

		await Promise.race([
			resolveInterceptorAccess(
				ethereum,
				tokenPriceService,
				resetSimulationServices,
				websiteTabConnections,
				{
					userReply: 'Approved',
					requestAccessToAddress: firstRequest.requestAccessToAddress?.address,
					originalRequestAccessToAddress: firstRequest.originalRequestAccessToAddress?.address,
					accessRequestId: firstRequest.accessRequestId,
				},
				publishRpcConnectionStatus,
			),
			new Promise((_, reject) => setTimeout(() => reject(new Error('Access approval did not resolve')), 250)),
		])

		const followUpRequest = (await getPendingAccessRequests()).find((request) => request.website.websiteOrigin === secondWebsite.websiteOrigin)
		if (followUpRequest === undefined) throw new Error('Missing follow-up access request')
		await resolveInterceptorAccess(
			ethereum,
			tokenPriceService,
			resetSimulationServices,
			websiteTabConnections,
			{
				userReply: 'Rejected',
				requestAccessToAddress: followUpRequest.requestAccessToAddress?.address,
				originalRequestAccessToAddress: followUpRequest.originalRequestAccessToAddress?.address,
				accessRequestId: followUpRequest.accessRequestId,
			},
			publishRpcConnectionStatus,
		)
	})
})
