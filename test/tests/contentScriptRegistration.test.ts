import * as assert from 'assert'
import { test } from 'bun:test'

type RuntimeMessage = {
	readonly method?: string
	readonly data?: { readonly message?: string, readonly code?: string }
}

type BrowserMockOptions = {
	readonly afterStorageRead?: (keys: unknown) => Promise<void>
	readonly emitStorageEvents?: boolean
	readonly registerError?: Error
	readonly hostRegistrationError?: Error
	readonly updateError?: Error
	readonly executeScriptError?: Error
	readonly tabUrl?: string
	readonly hasVisibleTabUrl?: boolean
	readonly tabUrlAfterStorageRead?: string
	readonly registeredContentScriptIds?: readonly string[]
	readonly safeAppsCompatibilityMode?: boolean
	readonly approvedOrigins?: unknown
	readonly beforeRegisterContentScripts?: (scripts: readonly RegisteredContentScript[]) => Promise<void>
	readonly beforeUpdateContentScripts?: (scripts: readonly RegisteredContentScript[]) => Promise<void>
}

type RegisteredContentScript = {
	readonly id: string
	readonly world?: 'MAIN' | 'ISOLATED'
	readonly excludeMatches?: readonly string[]
	readonly matches?: readonly string[]
	readonly allFrames?: boolean
	readonly matchOriginAsFallback?: boolean
	readonly js?: readonly string[]
}

function installBrowserMock({ afterStorageRead, emitStorageEvents = false, registerError, hostRegistrationError, updateError, executeScriptError, tabUrl = 'https://example.com/', hasVisibleTabUrl = true, tabUrlAfterStorageRead, registeredContentScriptIds = [], safeAppsCompatibilityMode = false, approvedOrigins, beforeRegisterContentScripts, beforeUpdateContentScripts }: BrowserMockOptions = {}) {
	const storageState: Record<string, unknown> = { safeAppsCompatibilityMode, userAddressBookEntriesV3: typeof approvedOrigins === 'string' ? approvedOrigins : [], websiteAccess: [] }
	const sentMessages: RuntimeMessage[] = []
	const executedScriptFiles: string[] = []
	const reloadedTabs: number[] = []
	const defaultScriptFilesById = new Map<string, readonly string[]>([
		['inpage', ['/inpage/js/inpage.js']],
		['inpage2', ['/vendor/webextension-polyfill/dist/browser-polyfill.js', '/inpage/js/listenContentScript.js', '/inpage/js/listenContentScriptBootstrap.js']],
	])
	const registeredContentScripts = new Map<string, RegisteredContentScript>(registeredContentScriptIds.map((id) => [id, { id, js: defaultScriptFilesById.get(id) }]))
	let executeScriptCalls = 0
	const scriptingOperations: string[] = []
	const unregisteredContentScriptIdBatches: string[][] = []
	let currentTabUrl = tabUrl
	const storageListeners = new Set<(changes: Record<string, browser.storage.StorageChange>, area: string) => void>()
	let committedListener: ((details: browser.webNavigation._OnCommittedDetails) => unknown) | undefined
	const getStorageItems = (keys?: string | string[] | Record<string, unknown> | null) => {
		if (keys === undefined || keys === null) return { ...storageState }
		if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, storageState[key]]))
		if (typeof keys === 'string') return { [keys]: storageState[keys] }
		return Object.fromEntries(Object.entries(keys).map(([key, defaultValue]) => [key, key in storageState ? storageState[key] : defaultValue]))
	}

	Object.defineProperty(globalThis, 'browser', {
		configurable: true,
		writable: true,
		value: {
			runtime: {
				lastError: null,
				async sendMessage(message: RuntimeMessage) {
					sentMessages.push(message)
					return undefined
				},
				getManifest: () => ({ manifest_version: 3 }),
				onMessage: { addListener: () => undefined, removeListener: () => undefined },
				onConnect: { addListener: () => undefined, removeListener: () => undefined },
			},
			storage: {
				onChanged: { addListener: (listener: (changes: Record<string, browser.storage.StorageChange>, area: string) => void) => { storageListeners.add(listener) }, removeListener: (listener: (changes: Record<string, browser.storage.StorageChange>, area: string) => void) => { storageListeners.delete(listener) } },
				local: {
					async get(keys?: string | string[] | Record<string, unknown> | null) {
						const storageItems = getStorageItems(keys)
						await afterStorageRead?.(keys)
						currentTabUrl = tabUrlAfterStorageRead ?? currentTabUrl
						return storageItems
					},
					async set(items: Record<string, unknown>) {
						const changes = Object.fromEntries(Object.entries(items).filter(([key, value]) => JSON.stringify(storageState[key]) !== JSON.stringify(value)).map(([key, value]) => [key, { oldValue: storageState[key], newValue: value }]))
						Object.assign(storageState, items)
						if (emitStorageEvents) for (const listener of storageListeners) listener(changes, 'local')
					},
					async remove(keys: string | string[]) {
						for (const key of Array.isArray(keys) ? keys : [keys]) delete storageState[key]
					},
				},
			},
			scripting: {
				async unregisterContentScripts(filter?: { readonly ids?: readonly string[] }) {
					scriptingOperations.push('unregister')
					const ids = filter?.ids === undefined ? [...registeredContentScripts.keys()] : [...filter.ids]
					unregisteredContentScriptIdBatches.push(ids)
					for (const id of ids) registeredContentScripts.delete(id)
				},
				async getRegisteredContentScripts() { return [...registeredContentScripts.values()] },
				async registerContentScripts(scripts: readonly RegisteredContentScript[]) {
					scriptingOperations.push('register')
					await beforeRegisterContentScripts?.(scripts)
					if (registerError !== undefined) throw registerError
					if (hostRegistrationError !== undefined && scripts.some(({ id }) => id === 'safe-apps-host')) throw hostRegistrationError
					for (const script of scripts) registeredContentScripts.set(script.id, script)
				},
				async updateContentScripts(scripts: readonly RegisteredContentScript[]) {
					scriptingOperations.push('update')
					await beforeUpdateContentScripts?.(scripts)
					if (updateError !== undefined) throw updateError
					for (const script of scripts) registeredContentScripts.set(script.id, script)
				},
			},
			declarativeNetRequest: { getDynamicRules: async () => [], getSessionRules: async () => [], updateDynamicRules: async () => undefined, updateSessionRules: async () => undefined },
			tabs: {
				async reload(id: number) { scriptingOperations.push('reload'); reloadedTabs.push(id) },
				async query() { return [{ id: 42, url: currentTabUrl }] },
				async get() { return hasVisibleTabUrl ? { id: 42, url: currentTabUrl } : { id: 42 } },
				async update() { return undefined },
				async executeScript(_tabId: number, injection: { readonly file?: string }) {
					executeScriptCalls++
					if (injection.file !== undefined) executedScriptFiles.push(injection.file)
					if (executeScriptError !== undefined) throw executeScriptError
					return undefined
				},
				onUpdated: { addListener: () => undefined, removeListener: () => undefined },
				onRemoved: { addListener: () => undefined, removeListener: () => undefined },
			},
			windows: {
				async get() { return undefined },
				async update() { return undefined },
			},
			webNavigation: {
				onCommitted: {
					addListener(listener: (details: browser.webNavigation._OnCommittedDetails) => unknown) {
						committedListener = listener
					},
					removeListener: () => undefined,
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
		},
	})
	Object.defineProperty(globalThis, 'chrome', { configurable: true, writable: true, value: { runtime: { id: 'test-extension' } } })

	return {
		sentMessages,
		getStorageListenerCount: () => storageListeners.size,
		reloadedTabs,
		recordAccessRefresh: () => { scriptingOperations.push('access-refresh') },
		emitStorageChange(changes: Record<string, browser.storage.StorageChange>, area: string) { for (const listener of storageListeners) listener(changes, area) },
		getRegisteredContentScripts() { return [...registeredContentScripts.values()] },
		normalizeRegisteredContentScripts() {
			for (const [id, script] of registeredContentScripts) registeredContentScripts.set(id, {
				...script,
				js: script.js?.map((file) => file.replace(/^\//, '')),
				matches: script.matches?.map((pattern) => pattern === 'file://*/*' ? 'file:///*' : pattern),
				excludeMatches: script.excludeMatches?.map((pattern) => pattern === 'file://*/*' ? 'file:///*' : pattern),
			})
		},
		removeRegisteredContentScript(id: string) { registeredContentScripts.delete(id) },
		changeRegisteredContentScriptWorld(id: string, world: 'MAIN' | 'ISOLATED') {
			const script = registeredContentScripts.get(id)
			if (script === undefined) throw new Error(`Missing script ${ id }`)
			registeredContentScripts.set(id, { ...script, world })
		},
		getScriptingOperations() { return [...scriptingOperations] },
		getUnregisteredContentScriptIdBatches() { return unregisteredContentScriptIdBatches.map((ids) => [...ids]) },
		getExecuteScriptCalls() { return executeScriptCalls },
		getExecutedScriptFiles() { return [...executedScriptFiles] },
		getCommittedListener() {
			if (committedListener === undefined) throw new Error('webNavigation listener was not registered')
			return committedListener
		},
	}
}

// Each fixture owns a background service, including its queue and storage observer.
async function loadModules() {
	const registration = await import('../../app/ts/background/contentScriptRegistration.js')
	return {
		...registration,
		updateRegistration: registration.createContentScriptRegistrationService().update,
		...await import('../../app/ts/background/storageVariables.js'),
	}
}

test('base provider registration errors propagate to the configuration workflow', async () => {
	installBrowserMock({ registerError: new Error('registration failed') })
	const { updateRegistration } = await loadModules()
	await assert.rejects(updateRegistration(), /registration failed/)
})

test('native hosting removes persisted legacy host registrations and restores ordinary provider matching', async () => {
	const { getRegisteredContentScripts } = installBrowserMock({ safeAppsCompatibilityMode: true, approvedOrigins: ['https://app.example'], registeredContentScriptIds: ['inpage', 'inpage2', 'safe-apps-host'] })
	const { updateRegistration } = await loadModules()
	assert.equal(await updateRegistration(), 'configuration-applied')
	assert.deepEqual(getRegisteredContentScripts().map(({ id }) => id).sort(), ['inpage', 'inpage2'])
	assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'inpage')?.excludeMatches, [])
	assert.ok(getRegisteredContentScripts().every(({ js }) => !js?.some((file) => file.includes('gnosisSafeAppsHost'))))
})

test('compatibility mode replaces provider files without installing a page-world host', async () => {
	const { getRegisteredContentScripts, getUnregisteredContentScriptIdBatches } = installBrowserMock({ safeAppsCompatibilityMode: true, registeredContentScriptIds: ['inpage', 'inpage2'] })
	const { updateRegistration } = await loadModules()
	await updateRegistration()
	await browser.storage.local.set({ metamaskCompatibilityMode: true })
	await updateRegistration()
	assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'inpage')?.js, ['/inpage/js/inpage-metamask-compatibility.js'])
	assert.ok(getUnregisteredContentScriptIdBatches().some((ids) => ids.includes('inpage')))
	assert.equal(getRegisteredContentScripts().some(({ id }) => id === 'safe-apps-host'), false)
})

test('a partially changed registration rolls back to its previous complete configuration', async () => {
	let fail = false
	const { getRegisteredContentScripts } = installBrowserMock({ registeredContentScriptIds: ['inpage', 'inpage2'], beforeUpdateContentScripts: async () => { if (fail) throw new Error('update failed') } })
	const { updateRegistration } = await loadModules()
	await updateRegistration()
	const previous = getRegisteredContentScripts()
	await browser.storage.local.set({ websiteAccess: [{ website: { websiteOrigin: 'disabled.example' }, interceptorDisabled: true }] })
	fail = true
	await assert.rejects(updateRegistration(), /update failed/)
	assert.deepEqual(getRegisteredContentScripts(), previous)
	fail = false
	await updateRegistration()
	assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'inpage')?.excludeMatches, ['http://disabled.example:80/*', 'https://disabled.example:443/*'])
})

test('queued reconciliation uses its supplied configuration rather than later storage', async () => {
	const { getRegisteredContentScripts } = installBrowserMock()
	const { createContentScriptRegistrationService } = await loadModules()
	const service = createContentScriptRegistrationService()
	const first = { injectionSites: { interceptorDisabledSites: ['first.example'] }, pageWorldProvider: { metamaskCompatibilityMode: false } }
	const second = { injectionSites: { interceptorDisabledSites: ['second.example'] }, pageWorldProvider: { metamaskCompatibilityMode: true } }
	await Promise.all([service.reconcile(first), service.reconcile(second)])
	assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'inpage')?.excludeMatches, ['http://second.example:80/*', 'https://second.example:443/*'])
	assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'inpage')?.js, ['/inpage/js/inpage-metamask-compatibility.js'])
})

test('website access observation reconciles disabled sites without deriving Gnosis Safe hosting origins', async () => {
	const { getRegisteredContentScripts } = installBrowserMock({ emitStorageEvents: true, safeAppsCompatibilityMode: true })
	const { createContentScriptRegistrationService } = await loadModules()
	const service = createContentScriptRegistrationService()
	service.start()
	try {
		await service.update()
		await browser.storage.local.set({ websiteAccess: [{ website: { websiteOrigin: 'disabled.example' }, interceptorDisabled: true }] })
		await service.update()
		assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'inpage')?.excludeMatches, ['http://disabled.example:80/*', 'https://disabled.example:443/*'])
		assert.equal(getRegisteredContentScripts().some(({ id }) => id === 'safe-apps-host'), false)
	} finally { service.stop() }
})

test('provider registration leaves unrelated malformed Gnosis Safe address-book storage untouched', async () => {
	installBrowserMock({ safeAppsCompatibilityMode: true, approvedOrigins: 'not-a-list' })
	const { updateRegistration } = await loadModules()
	await updateRegistration()
	assert.equal((await browser.storage.local.get('userAddressBookEntriesV3')).userAddressBookEntriesV3, 'not-a-list')
})

test('MV2 provider injection does not register an emulated host', async () => {
	const { getScriptingOperations } = installBrowserMock({ safeAppsCompatibilityMode: true })
	browser.runtime.getManifest = () => ({ manifest_version: 2, name: 'test', version: '1.0.0' })
	const { updateRegistration } = await loadModules()
	assert.equal(await updateRegistration(), 'configuration-applied')
	assert.deepEqual(getScriptingOperations(), [])
})
