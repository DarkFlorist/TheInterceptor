// Shared, typed WebExtension `browser` mock for bun tests.
//
// Usage:
//   const browserMock = installBrowserMock({ storage: { local: { simulationMode: true } }, tabs: [{ id: 7, url: 'https://example.test' }] })
//   afterEach(browserMock.restore)                                       // or createPerTestBrowserMockInstaller from perTest.ts; `bun run test` isolates test files from each other
//   await appCodeUnderTest()                                             // app code reads the installed globalThis.browser and globalThis.chrome
//   assert.deepEqual(browserMock.calls.runtimeSendMessage, [...])        // every recorded call lives under browserMock.calls
//   browserMock.handlers.runtimeMessage = async (message) => reply       // choose replies for browser.runtime.sendMessage or browser.tabs.sendMessage
//   await browserMock.dispatchRuntimeMessage({ method: 'popup_x' })      // deliver a message to browser.runtime.onMessage listeners
//   browserMock.browser.storage.local.set = async () => { throw new Error('quota') }   // every API method is an own writable property
//
// Behaviour follows real browsers where tests depend on it:
// - storage.local and storage.session get() omit missing keys and accept null/undefined, a key, a key list or an object of defaults; values are
//   stored and returned as structured clones; set/remove/clear fire storage.onChanged and storage.<area>.onChanged synchronously before resolving.
// - tabs.get/update/remove and windows.get/update/remove reject unknown ids with Chrome's "No tab with id: N." and "No window with id: N." messages.
// - tabs.sendMessage rejects like Chrome when no content script answers, until handlers.tabMessage is replaced.
// - Ports posted through runtime.connect deliver messages and disconnects to the other end asynchronously, in a microtask.
import { replaceGlobal } from './globals.js'

type StorageItems = Record<string, unknown>
export type StorageAreaName = 'local' | 'session'
// The WebExtension API itself accepts null to read every item, so null is part of this type.
export type StorageKeys = null | undefined | string | readonly string[] | Readonly<StorageItems>
export type StorageChange = { readonly oldValue?: unknown, readonly newValue?: unknown }
export type StorageChanges = Record<string, StorageChange>

export type MockEvent<Args extends readonly unknown[], Result = void> = {
	addListener: (listener: (...args: Args) => Result) => void
	removeListener: (listener: (...args: Args) => Result) => void
	hasListener: (listener: (...args: Args) => Result) => boolean
	hasListeners: () => boolean
	// Calls the listeners registered at dispatch time, in registration order, and returns their results.
	dispatch: (...args: Args) => Result[]
}

export function createMockEvent<Args extends readonly unknown[], Result = void>(): MockEvent<Args, Result> {
	const listeners: ((...args: Args) => Result)[] = []
	return {
		addListener: (listener) => {
			if (!listeners.includes(listener)) listeners.push(listener)
		},
		removeListener: (listener) => {
			const index = listeners.indexOf(listener)
			if (index !== -1) listeners.splice(index, 1)
		},
		hasListener: (listener) => listeners.includes(listener),
		hasListeners: () => listeners.length > 0,
		dispatch: (...args) => [...listeners].map((listener) => listener(...args)),
	}
}

export type MockStorageArea = {
	get: (keys?: StorageKeys) => Promise<StorageItems>
	set: (items: Readonly<StorageItems>) => Promise<void>
	remove: (keys: string | readonly string[]) => Promise<void>
	clear: () => Promise<void>
	onChanged: MockEvent<[changes: StorageChanges]>
}

const isKeyList = (keys: string | readonly string[] | Readonly<StorageItems>): keys is readonly string[] => Array.isArray(keys)

function createMockStorageArea(initialItems: Readonly<StorageItems>, notifyGlobalListeners: (changes: StorageChanges) => void) {
	const items = new Map<string, unknown>(Object.entries(structuredClone(initialItems)))
	const onChanged = createMockEvent<[changes: StorageChanges]>()
	const notify = (changes: StorageChanges) => {
		if (Object.keys(changes).length === 0) return
		onChanged.dispatch(changes)
		notifyGlobalListeners(changes)
	}
	const readStoredEntry = (key: string): [string, unknown][] => items.has(key) ? [[key, items.get(key)]] : []
	const readItems = (keys: StorageKeys): StorageItems => {
		if (keys === undefined || keys === null) return Object.fromEntries(items)
		if (typeof keys === 'string') return Object.fromEntries(readStoredEntry(keys))
		if (isKeyList(keys)) return Object.fromEntries(keys.flatMap(readStoredEntry))
		// Defaults fill in missing keys; an undefined default cannot be serialized by the browser, so the key stays absent.
		return Object.fromEntries(Object.entries(keys).flatMap(([key, defaultValue]): [string, unknown][] => {
			if (items.has(key)) return readStoredEntry(key)
			return defaultValue === undefined ? [] : [[key, defaultValue]]
		}))
	}
	const removeItems = (keys: readonly string[]) => {
		const changes: StorageChanges = {}
		for (const key of keys) {
			if (!items.has(key)) continue
			changes[key] = { oldValue: items.get(key) }
			items.delete(key)
		}
		notify(changes)
	}
	const area: MockStorageArea = {
		get: async (keys) => structuredClone(readItems(keys)),
		set: async (newItems) => {
			const clonedItems = structuredClone(newItems)
			const changes: StorageChanges = {}
			for (const [key, newValue] of Object.entries(clonedItems)) {
				changes[key] = items.has(key) ? { oldValue: items.get(key), newValue } : { newValue }
				items.set(key, newValue)
			}
			notify(structuredClone(changes))
		},
		remove: async (keys) => { removeItems(typeof keys === 'string' ? [keys] : keys) },
		clear: async () => { removeItems([...items.keys()]) },
		onChanged,
	}
	return { area, readAllItems: () => structuredClone(Object.fromEntries(items)) }
}

export type MockPort = {
	readonly port: browser.runtime.Port
	// Messages this end posted with port.postMessage.
	readonly postedMessages: unknown[]
	// Delivers a message to this end's onMessage listeners, as if the other end had posted it.
	readonly receiveMessage: (message: unknown) => void
	// Fires this end's onDisconnect listeners, as if the other end had disconnected.
	readonly disconnectFromOtherEnd: () => void
	readonly isDisconnected: () => boolean
}

export type MockPortOptions = {
	readonly name?: string
	readonly sender?: browser.runtime.MessageSender
	readonly onPostMessage?: (message: unknown) => void
	readonly onDisconnect?: () => void
}

// A port end whose postMessage throws after either end disconnects, like Chrome's "Attempting to use a disconnected port object".
export function createMockPort({ name = '', sender, onPostMessage, onDisconnect }: MockPortOptions = {}): MockPort {
	const postedMessages: unknown[] = []
	const onMessageEvent = createMockEvent<[message: unknown]>()
	const onDisconnectEvent = createMockEvent<[port: browser.runtime.Port]>()
	let disconnected = false
	const port: browser.runtime.Port = {
		name,
		sender,
		postMessage: (message: unknown) => {
			if (disconnected) throw new Error('Attempting to use a disconnected port object')
			postedMessages.push(message)
			onPostMessage?.(message)
		},
		disconnect: () => {
			if (disconnected) return
			disconnected = true
			onDisconnect?.()
		},
		onMessage: onMessageEvent,
		onDisconnect: onDisconnectEvent,
	}
	return {
		port,
		postedMessages,
		receiveMessage: (message) => {
			if (!disconnected) onMessageEvent.dispatch(message)
		},
		disconnectFromOtherEnd: () => {
			if (disconnected) return
			disconnected = true
			onDisconnectEvent.dispatch(port)
		},
		isDisconnected: () => disconnected,
	}
}

export type MockPortPair = {
	// The end returned by runtime.connect, used by content scripts and pages.
	readonly connector: MockPort
	// The end passed to runtime.onConnect listeners, used by the background script.
	readonly receiver: MockPort
}

// Two linked port ends: messages and disconnects from one end reach the other end in a microtask.
export function createMockPortPair({ name = '', sender }: { readonly name?: string, readonly sender?: browser.runtime.MessageSender } = {}): MockPortPair {
	const ends: { connector?: MockPort, receiver?: MockPort } = {}
	const connector = createMockPort({
		name,
		onPostMessage: (message) => { queueMicrotask(() => { ends.receiver?.receiveMessage(message) }) },
		onDisconnect: () => { queueMicrotask(() => { ends.receiver?.disconnectFromOtherEnd() }) },
	})
	const receiver = createMockPort({
		name,
		sender,
		onPostMessage: (message) => { queueMicrotask(() => { ends.connector?.receiveMessage(message) }) },
		onDisconnect: () => { queueMicrotask(() => { ends.connector?.disconnectFromOtherEnd() }) },
	})
	ends.connector = connector
	ends.receiver = receiver
	return { connector, receiver }
}

export type MockTab = browser.tabs.Tab & { readonly id: number }
export type MockTabSeed = Partial<browser.tabs.Tab> & { readonly id: number }
export type MockWindow = browser.windows.Window & { readonly id: number }
export type MockWindowSeed = Partial<browser.windows.Window> & { readonly id: number }

const createTab = (seed: MockTabSeed, index: number): MockTab => ({ index, windowId: 1, active: false, highlighted: false, pinned: false, incognito: false, status: 'complete', ...seed })
const createWindow = (seed: MockWindowSeed): MockWindow => ({ focused: false, incognito: false, alwaysOnTop: false, type: 'normal', ...seed })

type RuntimeMessageSender = browser.runtime.MessageSender
type SendResponse = (response?: unknown) => void

type ActionApiName = 'action' | 'browserAction'
export type ActionCall =
	| { readonly api: ActionApiName, readonly method: 'setIcon', readonly details: browser.action._SetIconDetails }
	| { readonly api: ActionApiName, readonly method: 'setTitle', readonly details: browser.action._SetTitleDetails }
	| { readonly api: ActionApiName, readonly method: 'setBadgeText', readonly details: browser.action._SetBadgeTextDetails }
	| { readonly api: ActionApiName, readonly method: 'setBadgeBackgroundColor', readonly details: browser.action._SetBadgeBackgroundColorDetails }

export type BrowserMockCalls = {
	readonly runtimeSendMessage: unknown[]
	readonly tabsSendMessage: { readonly tabId: number, readonly message: unknown }[]
	readonly tabsCreate: browser.tabs._CreateCreateProperties[]
	readonly tabsUpdate: { readonly tabId: number, readonly updateProperties: browser.tabs._UpdateUpdateProperties }[]
	readonly tabsRemove: number[]
	readonly tabsReload: number[]
	readonly tabsExecuteScript: { readonly tabId: number | undefined, readonly details: browser.extensionTypes.InjectDetails }[]
	readonly windowsCreate: browser.windows._CreateCreateData[]
	readonly windowsUpdate: { readonly windowId: number, readonly updateInfo: browser.windows._UpdateUpdateInfo }[]
	readonly windowsRemove: number[]
	readonly action: ActionCall[]
	readonly declarativeNetRequestUpdates: { readonly scope: 'dynamic' | 'session', readonly options: browser.declarativeNetRequest._UpdateDynamicRulesOptions }[]
}

export type BrowserMockHandlers = {
	// Produces the reply for browser.runtime.sendMessage; the default resolves undefined, like a message that no listener answered.
	runtimeMessage: (message: unknown) => unknown
	// Produces the reply for browser.tabs.sendMessage; the default rejects like Chrome when the tab has no listening content script.
	tabMessage: (tabId: number, message: unknown) => unknown
}

export type BrowserMockOptions = {
	readonly manifestVersion?: 2 | 3
	readonly extensionId?: string
	readonly storage?: { readonly local?: Readonly<StorageItems>, readonly session?: Readonly<StorageItems> }
	readonly tabs?: readonly MockTabSeed[]
	// Defaults to one focused normal window with id 1, which seeded tabs belong to unless they set windowId.
	readonly windows?: readonly MockWindowSeed[]
	readonly handlers?: Partial<BrowserMockHandlers>
	// Also installs globalThis.chrome = { runtime: { id } }, which most existing tests provide; defaults to true.
	readonly installChrome?: boolean
	// Lowest ids that tabs.create and windows.create hand out (default 1; created ids always exceed the seeded ones). Browsers never reuse ids, so tests whose app modules keep a tab or window id from an earlier test's mock can start each mock at a fresh range.
	readonly firstCreatedIds?: { readonly tab?: number, readonly window?: number }
}

const noReceiverError = () => new Error('Could not establish connection. Receiving end does not exist.')

export function createBrowserMock(options: BrowserMockOptions = {}) {
	const extensionId = options.extensionId ?? 'interceptor-test-extension'
	const manifestVersion = options.manifestVersion ?? 3
	const handlers: BrowserMockHandlers = {
		runtimeMessage: () => undefined,
		tabMessage: () => { throw noReceiverError() },
		...options.handlers,
	}
	const calls: BrowserMockCalls = {
		runtimeSendMessage: [],
		tabsSendMessage: [],
		tabsCreate: [],
		tabsUpdate: [],
		tabsRemove: [],
		tabsReload: [],
		tabsExecuteScript: [],
		windowsCreate: [],
		windowsUpdate: [],
		windowsRemove: [],
		action: [],
		declarativeNetRequestUpdates: [],
	}
	const connections: MockPortPair[] = []

	const storageOnChanged = createMockEvent<[changes: StorageChanges, areaName: StorageAreaName]>()
	const localStorage = createMockStorageArea(options.storage?.local ?? {}, (changes) => { storageOnChanged.dispatch(changes, 'local') })
	const sessionStorage = createMockStorageArea(options.storage?.session ?? {}, (changes) => { storageOnChanged.dispatch(changes, 'session') })

	const windows = new Map<number, MockWindow>((options.windows ?? [{ id: 1, focused: true }]).map((seed) => [seed.id, createWindow(seed)]))
	const tabs = new Map<number, MockTab>((options.tabs ?? []).map((seed, index) => [seed.id, createTab(seed, index)]))
	// Like a browser, ids are never handed out twice: each counter only grows, so a removed tab or window id cannot come back for a later create.
	const createIdAllocator = (seededIds: Iterable<number>, firstCreatedId = 1) => {
		let lastId = Math.max(firstCreatedId - 1, ...seededIds)
		return () => {
			lastId += 1
			return lastId
		}
	}
	const nextTabId = createIdAllocator(tabs.keys(), options.firstCreatedIds?.tab)
	const nextWindowId = createIdAllocator(windows.keys(), options.firstCreatedIds?.window)
	const getTab = (tabId: number) => {
		const tab = tabs.get(tabId)
		if (tab === undefined) throw new Error(`No tab with id: ${ tabId }.`)
		return tab
	}
	const getWindow = (windowId: number) => {
		const mockWindow = windows.get(windowId)
		if (mockWindow === undefined) throw new Error(`No window with id: ${ windowId }.`)
		return mockWindow
	}
	const getFocusedWindow = () => [...windows.values()].find((mockWindow) => mockWindow.focused) ?? [...windows.values()][0]
	const setTab = (tab: MockTab) => {
		if (tab.active) {
			for (const otherTab of tabs.values()) {
				if (otherTab.id !== tab.id && otherTab.windowId === tab.windowId && otherTab.active) tabs.set(otherTab.id, { ...otherTab, active: false })
			}
		}
		tabs.set(tab.id, tab)
	}
	const setWindow = (mockWindow: MockWindow) => {
		if (mockWindow.focused) {
			for (const otherWindow of windows.values()) {
				if (otherWindow.id !== mockWindow.id && otherWindow.focused) windows.set(otherWindow.id, { ...otherWindow, focused: false })
			}
		}
		windows.set(mockWindow.id, mockWindow)
	}
	const tabsOnRemoved = createMockEvent<[tabId: number, removeInfo: browser.tabs._OnRemovedRemoveInfo]>()
	const tabsOnUpdated = createMockEvent<[tabId: number, changeInfo: browser.tabs._OnUpdatedChangeInfo, tab: browser.tabs.Tab]>()
	const windowsOnRemoved = createMockEvent<[windowId: number]>()
	const removeTab = (tabId: number, isWindowClosing: boolean) => {
		const tab = getTab(tabId)
		tabs.delete(tabId)
		tabsOnRemoved.dispatch(tabId, { windowId: tab.windowId ?? 1, isWindowClosing })
	}

	const runtimeOnMessage = createMockEvent<[message: unknown, sender: RuntimeMessageSender, sendResponse: SendResponse], unknown>()
	const runtimeOnConnect = createMockEvent<[port: browser.runtime.Port]>()
	const dynamicRules = new Map<number, browser.declarativeNetRequest.Rule>()
	const sessionRules = new Map<number, browser.declarativeNetRequest.Rule>()
	const updateRules = (rules: Map<number, browser.declarativeNetRequest.Rule>, scope: 'dynamic' | 'session', updateOptions: browser.declarativeNetRequest._UpdateDynamicRulesOptions) => {
		calls.declarativeNetRequestUpdates.push({ scope, options: updateOptions })
		for (const ruleId of updateOptions.removeRuleIds ?? []) rules.delete(ruleId)
		for (const rule of updateOptions.addRules ?? []) {
			if (rules.has(rule.id)) throw new Error(`Rule with id ${ rule.id } does not have a unique ID.`)
			rules.set(rule.id, rule)
		}
	}
	const registeredContentScripts = new Map<string, browser.scripting.RegisteredContentScript>()
	const selectContentScriptIds = (filter: browser.scripting.ContentScriptFilter | undefined) => filter?.ids ?? [...registeredContentScripts.keys()]
	const createActionApi = (api: ActionApiName) => ({
		// Chrome's MV3 action methods also accept a callback, which app/ts/background/backgroundUtils.ts passes to work around a Chromium bug.
		setIcon: async (details: browser.action._SetIconDetails, callback?: () => void) => {
			calls.action.push({ api, method: 'setIcon', details })
			callback?.()
		},
		setTitle: async (details: browser.action._SetTitleDetails, callback?: () => void) => {
			calls.action.push({ api, method: 'setTitle', details })
			callback?.()
		},
		setBadgeText: async (details: browser.action._SetBadgeTextDetails, callback?: () => void) => {
			calls.action.push({ api, method: 'setBadgeText', details })
			callback?.()
		},
		setBadgeBackgroundColor: async (details: browser.action._SetBadgeBackgroundColorDetails, callback?: () => void) => {
			calls.action.push({ api, method: 'setBadgeBackgroundColor', details })
			callback?.()
		},
	})

	let runtimeLastError: browser.runtime._LastError | undefined
	const browserApi = {
		runtime: {
			id: extensionId,
			get lastError() { return runtimeLastError },
			set lastError(lastError: browser.runtime._LastError | undefined) { runtimeLastError = lastError },
			getManifest: () => ({ manifest_version: manifestVersion }),
			getURL: (path: string) => `chrome-extension://${ extensionId }/${ path.replace(/^\//, '') }`,
			sendMessage: async (message: unknown) => {
				calls.runtimeSendMessage.push(message)
				return await handlers.runtimeMessage(message)
			},
			connect: (connectInfo: browser.runtime._ConnectConnectInfo = {}) => {
				const pair = createMockPortPair({ name: connectInfo.name ?? '', sender: { id: extensionId } })
				connections.push(pair)
				queueMicrotask(() => { runtimeOnConnect.dispatch(pair.receiver.port) })
				return pair.connector.port
			},
			onMessage: runtimeOnMessage,
			onConnect: runtimeOnConnect,
		},
		storage: {
			local: localStorage.area,
			session: sessionStorage.area,
			onChanged: storageOnChanged,
		},
		tabs: {
			// The mock has no per-caller window, so currentWindow and lastFocusedWindow both mean the focused window.
			query: async (queryInfo: browser.tabs._QueryQueryInfo = {}) => [...tabs.values()].filter((tab) => (queryInfo.active === undefined || tab.active === queryInfo.active)
				&& (queryInfo.windowId === undefined || tab.windowId === queryInfo.windowId)
				&& (queryInfo.lastFocusedWindow === undefined || (tab.windowId === getFocusedWindow()?.id) === queryInfo.lastFocusedWindow)
				&& (queryInfo.currentWindow === undefined || (tab.windowId === getFocusedWindow()?.id) === queryInfo.currentWindow)
				&& (queryInfo.status === undefined || tab.status === queryInfo.status)
				&& (typeof queryInfo.url !== 'string' || tab.url === queryInfo.url)),
			get: async (tabId: number) => getTab(tabId),
			create: async (createProperties: browser.tabs._CreateCreateProperties) => {
				calls.tabsCreate.push(createProperties)
				const tab = createTab({ id: nextTabId(), url: createProperties.url, active: createProperties.active ?? true, windowId: createProperties.windowId ?? getFocusedWindow()?.id }, tabs.size)
				setTab(tab)
				return tab
			},
			update: async (tabId: number, updateProperties: browser.tabs._UpdateUpdateProperties) => {
				calls.tabsUpdate.push({ tabId, updateProperties })
				const previousTab = getTab(tabId)
				const tab: MockTab = {
					...previousTab,
					url: updateProperties.url ?? previousTab.url,
					active: updateProperties.active ?? previousTab.active,
					highlighted: updateProperties.highlighted ?? previousTab.highlighted,
					pinned: updateProperties.pinned ?? previousTab.pinned,
				}
				setTab(tab)
				if (tab.url !== previousTab.url) tabsOnUpdated.dispatch(tabId, { url: tab.url }, tab)
				return tab
			},
			remove: async (tabIds: number | readonly number[]) => {
				for (const tabId of typeof tabIds === 'number' ? [tabIds] : tabIds) {
					calls.tabsRemove.push(tabId)
					removeTab(tabId, false)
				}
			},
			reload: async (tabId: number) => {
				calls.tabsReload.push(tabId)
				getTab(tabId)
			},
			sendMessage: async (tabId: number, message: unknown) => {
				calls.tabsSendMessage.push({ tabId, message })
				return await handlers.tabMessage(tabId, message)
			},
			executeScript: async (tabId: number | undefined, details: browser.extensionTypes.InjectDetails) => {
				calls.tabsExecuteScript.push({ tabId, details })
				return []
			},
			onRemoved: tabsOnRemoved,
			onUpdated: tabsOnUpdated,
		},
		windows: {
			get: async (windowId: number) => getWindow(windowId),
			getAll: async () => [...windows.values()],
			getCurrent: async () => {
				const focusedWindow = getFocusedWindow()
				if (focusedWindow === undefined) throw new Error('No current window')
				return focusedWindow
			},
			create: async (createData: browser.windows._CreateCreateData = {}) => {
				calls.windowsCreate.push(createData)
				const createdWindow = createWindow({ id: nextWindowId(), focused: createData.focused ?? true, type: createData.type === 'popup' ? 'popup' : 'normal' })
				setWindow(createdWindow)
				const urls = typeof createData.url === 'string' ? [createData.url] : createData.url ?? []
				const createdTabs = urls.map((url, index) => createTab({ id: nextTabId(), url, active: index === 0, windowId: createdWindow.id }, tabs.size + index))
				for (const tab of createdTabs) setTab(tab)
				return { ...createdWindow, tabs: createdTabs }
			},
			update: async (windowId: number, updateInfo: browser.windows._UpdateUpdateInfo) => {
				calls.windowsUpdate.push({ windowId, updateInfo })
				const previousWindow = getWindow(windowId)
				const updatedWindow: MockWindow = { ...previousWindow, focused: updateInfo.focused ?? previousWindow.focused }
				setWindow(updatedWindow)
				return updatedWindow
			},
			remove: async (windowId: number) => {
				calls.windowsRemove.push(windowId)
				getWindow(windowId)
				for (const tab of [...tabs.values()].filter((tab) => tab.windowId === windowId)) removeTab(tab.id, true)
				windows.delete(windowId)
				windowsOnRemoved.dispatch(windowId)
			},
			onRemoved: windowsOnRemoved,
		},
		action: createActionApi('action'),
		browserAction: createActionApi('browserAction'),
		declarativeNetRequest: {
			getDynamicRules: async () => [...dynamicRules.values()],
			getSessionRules: async () => [...sessionRules.values()],
			updateDynamicRules: async (updateOptions: browser.declarativeNetRequest._UpdateDynamicRulesOptions) => { updateRules(dynamicRules, 'dynamic', updateOptions) },
			updateSessionRules: async (updateOptions: browser.declarativeNetRequest._UpdateSessionRulesOptions) => { updateRules(sessionRules, 'session', updateOptions) },
		},
		scripting: {
			registerContentScripts: async (scripts: readonly browser.scripting.RegisteredContentScript[]) => {
				const duplicate = scripts.find((script) => registeredContentScripts.has(script.id))
				if (duplicate !== undefined) throw new Error(`Duplicate script ID '${ duplicate.id }'`)
				for (const script of scripts) registeredContentScripts.set(script.id, script)
			},
			getRegisteredContentScripts: async (filter?: browser.scripting.ContentScriptFilter) => selectContentScriptIds(filter).flatMap((id) => registeredContentScripts.get(id) ?? []),
			updateContentScripts: async (scripts: readonly browser.scripting._UpdateContentScriptsScripts[]) => {
				for (const script of scripts) {
					const registeredScript = registeredContentScripts.get(script.id)
					if (registeredScript === undefined) throw new Error(`Content script with ID '${ script.id }' does not exist.`)
					registeredContentScripts.set(script.id, { ...registeredScript, ...script })
				}
			},
			unregisterContentScripts: async (filter?: browser.scripting.ContentScriptFilter) => {
				for (const id of selectContentScriptIds(filter)) registeredContentScripts.delete(id)
			},
		},
		webNavigation: {
			onCommitted: createMockEvent<[details: browser.webNavigation._OnCommittedDetails]>(),
		},
		webRequest: {
			onBeforeRequest: createMockEvent<[details: browser.webRequest._OnBeforeRequestDetails], unknown>(),
		},
	}

	// Delivers a message to runtime.onMessage listeners like the browser: a listener answers by returning a promise, or by returning true and calling sendResponse later.
	const dispatchRuntimeMessage = async (message: unknown, sender: RuntimeMessageSender = { id: extensionId }): Promise<unknown> => {
		const response = Promise.withResolvers<unknown>()
		let responded = false
		const sendResponse: SendResponse = (value) => {
			if (responded) return
			responded = true
			response.resolve(value)
		}
		const listenerResults = runtimeOnMessage.dispatch(message, sender, sendResponse)
		const promisedResponses = listenerResults.filter((result) => result instanceof Promise)
		if (responded || promisedResponses.length > 0 || listenerResults.includes(true)) return await Promise.race([response.promise, ...promisedResponses])
		return undefined
	}

	return {
		browser: browserApi,
		chrome: { runtime: { id: extensionId } },
		handlers,
		calls,
		connections,
		readStorage: (area: StorageAreaName = 'local') => area === 'local' ? localStorage.readAllItems() : sessionStorage.readAllItems(),
		getTab: (tabId: number) => tabs.get(tabId),
		getWindow: (windowId: number) => windows.get(windowId),
		getRegisteredContentScripts: () => [...registeredContentScripts.values()],
		dispatchRuntimeMessage,
	}
}

export type BrowserMock = ReturnType<typeof createBrowserMock> & { readonly restore: () => void }

// Installs a new mock as globalThis.browser (and globalThis.chrome unless installChrome is false); restore() puts the previous globals back.
export function installBrowserMock(options: BrowserMockOptions = {}): BrowserMock {
	const browserMock = createBrowserMock(options)
	const restoreBrowser = replaceGlobal('browser', browserMock.browser)
	const restoreChrome = options.installChrome === false ? () => undefined : replaceGlobal('chrome', browserMock.chrome)
	return {
		...browserMock,
		restore: () => {
			restoreChrome()
			restoreBrowser()
		},
	}
}
