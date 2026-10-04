import * as assert from 'assert'
import * as fs from 'node:fs'
import { describe, test } from 'bun:test'
import { withSilencedConsole } from './consoleSilence.js'
import { getManifestV2IsolatedWorldInjections, getPageWorldScriptPaths } from '../../app/ts/config/contentScriptInjectionArtifacts.js'
import type { WebsiteAccessArray } from '../../app/ts/types/websiteAccessTypes.js'

type RuntimeMessage = {
	readonly method?: string
	readonly data?: { readonly message?: string, readonly code?: string }
}

type BrowserMockOptions = {
	readonly metamaskCompatibilityMode?: boolean
	readonly manifestVersion?: 2 | 3
	readonly registerError?: Error
	readonly registerErrors?: readonly (Error | undefined)[]
	readonly registerWait?: Promise<void>
	readonly onRegister?: () => void
	readonly updateError?: Error
	readonly executeScriptError?: Error
	readonly tabUrl?: string
	readonly hasVisibleTabUrl?: boolean
	readonly tabUrlAfterStorageRead?: string
	readonly registeredContentScriptIds?: readonly string[]
	readonly registeredContentScripts?: readonly RegisteredContentScript[]
	readonly websiteAccess?: WebsiteAccessArray
	readonly storageGetErrorAfterSet?: Error
	readonly settingsReadError?: Error
	readonly storageGetWaits?: readonly (Promise<void> | undefined)[]
	readonly onStorageGet?: () => void
	readonly tabsQueryError?: Error
}

type RegisteredContentScript = {
	readonly id: string
	readonly js?: readonly string[]
	readonly excludeMatches?: readonly string[]
}

function installBrowserMock({ metamaskCompatibilityMode, manifestVersion = 3, registerError, registerErrors, registerWait, onRegister, updateError, executeScriptError, tabUrl = 'https://example.com/', hasVisibleTabUrl = true, tabUrlAfterStorageRead, registeredContentScriptIds = [], registeredContentScripts: initialRegisteredContentScripts, websiteAccess, storageGetErrorAfterSet, settingsReadError, storageGetWaits, onStorageGet, tabsQueryError }: BrowserMockOptions = {}) {
	const storageState: Record<string, unknown> = {
		...(metamaskCompatibilityMode === undefined ? {} : { metamaskCompatibilityMode }),
		...(websiteAccess === undefined ? {} : { websiteAccess }),
	}
	const sentMessages: RuntimeMessage[] = []
	const executedScriptFiles: string[] = []
	const executedScriptCode: string[] = []
	const reloadedTabs: number[] = []
	const defaultScriptFilesById = new Map<string, readonly string[]>([
		['inpage', ['/inpage/js/inpage.js']],
		['inpage2', ['/vendor/webextension-polyfill/dist/browser-polyfill.js', '/inpage/js/listenContentScript.js', '/inpage/js/listenContentScriptBootstrap.js']],
	])
	const registeredContentScripts = new Map((initialRegisteredContentScripts ?? registeredContentScriptIds.map((id) => ({ id, js: defaultScriptFilesById.get(id) }))).map((registration) => [registration.id, registration]))
	let executeScriptCalls = 0
	const scriptingOperations: string[] = []
	const unregisteredContentScriptIdBatches: string[][] = []
	const pendingRegisterErrors = [...registerErrors ?? (registerError === undefined ? [] : [registerError])]
	let currentTabUrl = tabUrl
	let failNextStorageGet = false
	let storageGetCalls = 0
	const pendingStorageGetWaits = [...storageGetWaits ?? []]
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
				getManifest: () => ({ manifest_version: manifestVersion }),
				onMessage: { addListener: () => undefined, removeListener: () => undefined },
				onConnect: { addListener: () => undefined, removeListener: () => undefined },
			},
			storage: {
			local: {
				async get(keys?: string | string[] | Record<string, unknown> | null) {
					storageGetCalls++
					if (Array.isArray(keys) && keys.includes('websiteAccess') && settingsReadError !== undefined) throw settingsReadError
					if (failNextStorageGet && storageGetErrorAfterSet !== undefined) {
						failNextStorageGet = false
						throw storageGetErrorAfterSet
					}
					const storageItems = getStorageItems(keys)
					onStorageGet?.()
					await pendingStorageGetWaits.shift()
					currentTabUrl = tabUrlAfterStorageRead ?? currentTabUrl
						return storageItems
					},
				async set(items: Record<string, unknown>) {
					Object.assign(storageState, items)
					if ('metamaskCompatibilityMode' in items && !('websiteAccess' in items)) failNextStorageGet = true
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
					onRegister?.()
					await registerWait
					const nextRegisterError = pendingRegisterErrors.shift()
					if (nextRegisterError !== undefined) throw nextRegisterError
					for (const script of scripts) registeredContentScripts.set(script.id, script)
				},
				async updateContentScripts(scripts: readonly RegisteredContentScript[]) {
					scriptingOperations.push('update')
					if (updateError !== undefined) throw updateError
					for (const script of scripts) registeredContentScripts.set(script.id, script)
				},
			},
			tabs: {
				async query() {
					if (tabsQueryError !== undefined) throw tabsQueryError
					return [{ id: 42, url: currentTabUrl }]
				},
				async get() { return hasVisibleTabUrl ? { id: 42, url: currentTabUrl } : { id: 42 } },
				async update() { return undefined },
				async reload(tabId: number) { reloadedTabs.push(tabId) },
				async executeScript(_tabId: number, injection: { readonly code?: string, readonly file?: string }) {
					executeScriptCalls++
					if (injection.file !== undefined) executedScriptFiles.push(injection.file)
					if (injection.code !== undefined) executedScriptCode.push(injection.code)
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
		getStorageState() { return { ...storageState } },
		getStorageGetCalls() { return storageGetCalls },
		getRegisteredContentScripts() { return [...registeredContentScripts.values()] },
		getScriptingOperations() { return [...scriptingOperations] },
		getUnregisteredContentScriptIdBatches() { return unregisteredContentScriptIdBatches.map((ids) => [...ids]) },
		getExecuteScriptCalls() { return executeScriptCalls },
		getExecutedScriptCode() { return [...executedScriptCode] },
		getExecutedScriptFiles() { return [...executedScriptFiles] },
		getReloadedTabs() { return [...reloadedTabs] },
		getCommittedListener() {
			if (committedListener === undefined) throw new Error('webNavigation listener was not registered')
			return committedListener
		},
	}
}

function createDeferred() {
	let resolvePromise: (() => void) | undefined
	const promise = new Promise<void>((resolve) => { resolvePromise = resolve })
	return {
		promise,
		resolve() {
			if (resolvePromise === undefined) throw new Error('Deferred promise resolver was unavailable')
			resolvePromise()
		},
	}
}

const committedDetails: browser.webNavigation._OnCommittedDetails = {
	tabId: 42,
	url: 'https://example.com/',
	frameId: 0,
	parentFrameId: -1,
	processId: 1,
	timeStamp: 1,
	transitionQualifiers: [],
	transitionType: 'link',
}

async function loadModules() {
	const modules = {
		...await import('../../app/ts/utils/contentScriptsUpdating.js'),
		...await import('../../app/ts/background/contentScriptInjectionStrategy.js'),
		...await import('../../app/ts/background/contentScriptInjectionConfiguration.js'),
		...await import('../../app/ts/background/storageVariables.js'),
	}
	return {
		...modules,
		updateContentScriptInjectionStrategyManifestV3: async () => await modules.updateContentScriptInjectionStrategyManifestV3(await modules.getContentScriptInjectionConfiguration()),
		updateContentScriptInjectionStrategyManifestV2: async () => await modules.updateContentScriptInjectionStrategyManifestV2(modules.getContentScriptInjectionConfiguration),
	}
}

function getManifestV2WebAccessibleResources() {
	const manifest: unknown = JSON.parse(fs.readFileSync('app/manifestV2.json', 'utf8'))
	if (typeof manifest !== 'object' || manifest === null || !('web_accessible_resources' in manifest)) throw new Error('Manifest V2 must declare web-accessible resources')
	const resources = manifest.web_accessible_resources
	if (!Array.isArray(resources) || !resources.every((resource) => typeof resource === 'string')) throw new Error('Manifest V2 web-accessible resources must be strings')
	return resources
}

function getManifestV3WebAccessibleResources() {
	const manifest: unknown = JSON.parse(fs.readFileSync('app/manifestV3.json', 'utf8'))
	if (typeof manifest !== 'object' || manifest === null || !('web_accessible_resources' in manifest)) throw new Error('Manifest V3 must declare web-accessible resources')
	const resourceGroups = manifest.web_accessible_resources
	if (!Array.isArray(resourceGroups)) throw new Error('Manifest V3 web-accessible resources must be grouped')
	return resourceGroups.flatMap((resourceGroup) => {
		if (typeof resourceGroup !== 'object' || resourceGroup === null || !('resources' in resourceGroup) || !('matches' in resourceGroup)) throw new Error('Manifest V3 resource group must declare resources and matches')
		const resources = resourceGroup.resources
		const matches = resourceGroup.matches
		if (!Array.isArray(resources) || !resources.every((resource) => typeof resource === 'string')) throw new Error('Manifest V3 resources must be strings')
		if (!Array.isArray(matches) || !matches.every((match) => typeof match === 'string')) throw new Error('Manifest V3 matches must be strings')
		return matches.includes('<all_urls>') ? resources : []
	})
}

describe('content script injection strategy', () => {
	const disabledWebsiteAccess: WebsiteAccessArray = [{
		website: { websiteOrigin: 'disabled.test', title: 'Disabled website', icon: undefined },
		addressAccess: [],
		access: false,
		interceptorDisabled: true,
		declarativeNetRequestBlockMode: 'disabled',
	}]

	test('serializes malformed compatibility mode values as disabled MV2 bootstrap code', () => {
		const maliciousValue = 'true); globalThis.unexpectedCodeExecution = true; Reflect.set(globalThis, Symbol.for("ignored"), (true'
		const code = getManifestV2IsolatedWorldInjections(maliciousValue).find((injection) => 'code' in injection)?.code
		if (code === undefined) throw new Error('Missing MV2 compatibility mode bootstrap code')
		Function(code)()

		assert.equal(Reflect.get(globalThis, Symbol.for('TheInterceptor.metamaskCompatibilityMode')), false)
		assert.equal(Reflect.get(globalThis, 'unexpectedCodeExecution'), undefined)
		Reflect.deleteProperty(globalThis, Symbol.for('TheInterceptor.metamaskCompatibilityMode'))
	})

	test('creates valid manifest v3 exclusions without admitting malformed stored origins', async () => {
		installBrowserMock()
		const { getManifestV3ExcludeMatches } = await loadModules()

		assert.deepEqual(getManifestV3ExcludeMatches([
			'',
			'example.com',
			'localhost:3000',
			'127.0.0.1:8545',
			'[::1]:8545',
			'https://secure.example',
			'https://localhost:4443',
			'https://invalid.example/path',
		]), [
			'file:///*',
			'*://*.example.com/*',
			'http://localhost:3000/*',
			'https://localhost:3000/*',
			'http://127.0.0.1:8545/*',
			'https://127.0.0.1:8545/*',
			'http://[::1]:8545/*',
			'https://[::1]:8545/*',
			'https://*.secure.example/*',
			'https://localhost:4443/*',
		])
	})

	test('compatibility setting changes refresh the current manifest strategy and reload connected tabs only when the mode changes', async () => {
		for (const manifestVersion of [2, 3] as const) {
			const { getCommittedListener, getRegisteredContentScripts, getReloadedTabs, getScriptingOperations } = installBrowserMock({ manifestVersion })
			const { setMetamaskCompatibilityMode } = await import('../../app/ts/background/metamaskCompatibilityMode.js')
			await setMetamaskCompatibilityMode(new Map([[42, { connections: {} }]]), true)

			assert.deepEqual(getReloadedTabs(), [42])
			if (manifestVersion === 2) assert.equal(typeof getCommittedListener(), 'function')
			else assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'inpage')?.js, ['/inpage/js/inpage-metamask-compatibility.js'])

			const scriptingOperationsAfterChange = getScriptingOperations()
			await setMetamaskCompatibilityMode(new Map([[42, { connections: {} }]]), true)
			assert.deepEqual(getReloadedTabs(), [42])
			assert.deepEqual(getScriptingOperations(), scriptingOperationsAfterChange)
		}
	})

	test('compatibility setting changes remain saved when the best-effort manifest v3 bootstrap refresh fails', async () => {
		const registrationError = new Error('compatibility registration refresh failed')
		const { getRegisteredContentScripts, getReloadedTabs, getStorageState } = installBrowserMock({
			metamaskCompatibilityMode: false,
			registerErrors: [registrationError],
			registeredContentScriptIds: ['inpage', 'inpage2'],
		})
		const { setMetamaskCompatibilityMode } = await import('../../app/ts/background/metamaskCompatibilityMode.js')
		const { getLatestUnexpectedError } = await loadModules()

		await withSilencedConsole(async () => await setMetamaskCompatibilityMode(new Map([[42, { connections: {} }]]), true))

		assert.equal(getStorageState().metamaskCompatibilityMode, true)
		assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'inpage')?.js, ['/inpage/js/inpage.js'])
		assert.deepEqual(getReloadedTabs(), [])
		assert.equal((await getLatestUnexpectedError())?.data.code, 'page_world_provider_bootstrap_refresh_failed')
	})

	test('compatibility setting changes remain saved when the best-effort post-update configuration read fails', async () => {
		const configurationReadError = new Error('post-update configuration read failed')
		const { getReloadedTabs, getScriptingOperations, getStorageState } = installBrowserMock({
			metamaskCompatibilityMode: false,
			registeredContentScriptIds: ['inpage', 'inpage2'],
			storageGetErrorAfterSet: configurationReadError,
		})
		const { setMetamaskCompatibilityMode } = await import('../../app/ts/background/metamaskCompatibilityMode.js')

		await withSilencedConsole(async () => await setMetamaskCompatibilityMode(new Map([[42, { connections: {} }]]), true))

		assert.equal(getStorageState().metamaskCompatibilityMode, true)
		assert.deepEqual(getScriptingOperations(), [])
		assert.deepEqual(getReloadedTabs(), [])
	})

	test('compatibility setting changes do not require an unrelated settings read before saving', async () => {
		const settingsReadError = new Error('general settings unavailable')
		const { getStorageState } = installBrowserMock({
			metamaskCompatibilityMode: false,
			settingsReadError,
		})
		const { setMetamaskCompatibilityMode } = await import('../../app/ts/background/metamaskCompatibilityMode.js')
		const { getLatestUnexpectedError } = await loadModules()

		await withSilencedConsole(async () => await setMetamaskCompatibilityMode(new Map(), true))

		assert.equal(getStorageState().metamaskCompatibilityMode, true)
		assert.equal((await getLatestUnexpectedError())?.data.code, 'page_world_provider_bootstrap_refresh_failed')
	})

	test('compatibility setting changes remain saved when best-effort reload target lookup fails', async () => {
		const tabLookupError = new Error('active tab lookup failed')
		const { getRegisteredContentScripts, getReloadedTabs, getScriptingOperations, getStorageState } = installBrowserMock({
			metamaskCompatibilityMode: false,
			registeredContentScriptIds: ['inpage', 'inpage2'],
			tabsQueryError: tabLookupError,
		})
		const { setMetamaskCompatibilityMode } = await import('../../app/ts/background/metamaskCompatibilityMode.js')

		await withSilencedConsole(async () => await setMetamaskCompatibilityMode(new Map([[42, { connections: {} }]]), true))

		assert.equal(getStorageState().metamaskCompatibilityMode, true)
		assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'inpage')?.js, ['/inpage/js/inpage.js'])
		assert.deepEqual(getScriptingOperations(), [])
		assert.deepEqual(getReloadedTabs(), [])
	})

	test('failed best-effort compatibility refresh preserves its setting and a newer website access update', async () => {
		const registrationError = new Error('delayed compatibility registration refresh failed')
		const registrationStarted = createDeferred()
		const releaseRegistration = createDeferred()
		const websiteAccess: WebsiteAccessArray = [{
			website: { websiteOrigin: 'concurrent.test', title: 'Before refresh', icon: undefined },
			addressAccess: [],
			access: true,
			interceptorDisabled: false,
			declarativeNetRequestBlockMode: 'disabled',
		}]
		const { getStorageState } = installBrowserMock({
			metamaskCompatibilityMode: false,
			registerErrors: [registrationError],
			registerWait: releaseRegistration.promise,
			onRegister: () => registrationStarted.resolve(),
			registeredContentScriptIds: ['inpage', 'inpage2'],
			websiteAccess,
		})
		const { setMetamaskCompatibilityMode } = await import('../../app/ts/background/metamaskCompatibilityMode.js')
		const { updateWebsiteAccess } = await import('../../app/ts/background/settings.js')

		await withSilencedConsole(async () => {
			const compatibilityUpdate = setMetamaskCompatibilityMode(new Map(), true)
			await registrationStarted.promise
			const newerAccessUpdate = updateWebsiteAccess((previousWebsiteAccess) => previousWebsiteAccess.map((entry) => ({
				...entry,
				website: { ...entry.website, title: 'Updated while refresh was pending' },
				access: false,
			})))
			await newerAccessUpdate
			releaseRegistration.resolve()
			await compatibilityUpdate
		})

		assert.equal(getStorageState().metamaskCompatibilityMode, true)
		assert.deepEqual(getStorageState().websiteAccess, [{ ...websiteAccess[0], website: { ...websiteAccess[0]?.website, title: 'Updated while refresh was pending' }, access: false }])
	})

	test('serializes overlapping compatibility refreshes so storage and runtime agree', async () => {
		const registrationStarted = createDeferred()
		const releaseRegistration = createDeferred()
		const { getRegisteredContentScripts, getReloadedTabs, getStorageState } = installBrowserMock({
			metamaskCompatibilityMode: false,
			registerWait: releaseRegistration.promise,
			onRegister: () => registrationStarted.resolve(),
			registeredContentScriptIds: ['inpage', 'inpage2'],
		})
		const { setMetamaskCompatibilityMode } = await import('../../app/ts/background/metamaskCompatibilityMode.js')

		const enableCompatibility = setMetamaskCompatibilityMode(new Map([[42, { connections: {} }]]), true)
		await registrationStarted.promise
		const disableCompatibility = setMetamaskCompatibilityMode(new Map([[42, { connections: {} }]]), false)
		releaseRegistration.resolve()
		await Promise.all([enableCompatibility, disableCompatibility])

		assert.equal(getStorageState().metamaskCompatibilityMode, false)
		assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'inpage')?.js, ['/inpage/js/inpage.js'])
		assert.deepEqual(getReloadedTabs(), [42, 42])
	})

	test('serializes a delayed startup snapshot before a newer compatibility update', async () => {
		const releaseStartupReads = createDeferred()
		const startupReadsStarted = createDeferred()
		let storageGetCalls = 0
		const { getRegisteredContentScripts, getStorageState } = installBrowserMock({
			metamaskCompatibilityMode: false,
			registeredContentScriptIds: ['inpage', 'inpage2'],
			storageGetWaits: [releaseStartupReads.promise, releaseStartupReads.promise],
			onStorageGet: () => {
				storageGetCalls++
				if (storageGetCalls === 2) startupReadsStarted.resolve()
			},
		})
		const { refreshContentScriptInjectionStrategy } = await import('../../app/ts/background/contentScriptInjectionStrategy.js')
		const { setMetamaskCompatibilityMode } = await import('../../app/ts/background/metamaskCompatibilityMode.js')

		const startupRefresh = refreshContentScriptInjectionStrategy()
		await startupReadsStarted.promise
		const compatibilityUpdate = setMetamaskCompatibilityMode(new Map(), true)
		releaseStartupReads.resolve()
		await Promise.all([startupRefresh, compatibilityUpdate])

		assert.equal(getStorageState().metamaskCompatibilityMode, true)
		assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'inpage')?.js, ['/inpage/js/inpage-metamask-compatibility.js'])
	})

	test('failed settings import rollback completes before a queued compatibility update', async () => {
		const registrationError = new Error('delayed imported registration refresh failed')
		const registrationStarted = createDeferred()
		const releaseRegistration = createDeferred()
		const { getRegisteredContentScripts, getStorageState } = installBrowserMock({
			metamaskCompatibilityMode: false,
			registerErrors: [registrationError],
			registerWait: releaseRegistration.promise,
			onRegister: () => registrationStarted.resolve(),
			registeredContentScriptIds: ['inpage', 'inpage2'],
		})
		const { updateAllContentScriptConfigurationAndReloadTabsIfChanged } = await import('../../app/ts/background/contentScriptInjectionStrategy.js')
		const { persistMetamaskCompatibilityMode, withSettingsImportRollback } = await import('../../app/ts/background/settings.js')
		const { setMetamaskCompatibilityMode } = await import('../../app/ts/background/metamaskCompatibilityMode.js')

		await withSilencedConsole(async () => {
			const failedImport = updateAllContentScriptConfigurationAndReloadTabsIfChanged(
				new Map(),
				async () => await persistMetamaskCompatibilityMode(true),
				withSettingsImportRollback,
			)
			await registrationStarted.promise
			const queuedCompatibilityUpdate = setMetamaskCompatibilityMode(new Map(), true)
			releaseRegistration.resolve()
			await assert.rejects(failedImport, registrationError)
			await queuedCompatibilityUpdate
		})

		assert.equal(getStorageState().metamaskCompatibilityMode, true)
		assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'inpage')?.js, ['/inpage/js/inpage-metamask-compatibility.js'])
	})

	test('failed settings import rollback completes before a queued disabled-site update', async () => {
		const registrationError = new Error('delayed imported registration refresh failed')
		const registrationStarted = createDeferred()
		const releaseRegistration = createDeferred()
		const { getRegisteredContentScripts, getStorageState } = installBrowserMock({
			metamaskCompatibilityMode: false,
			registerErrors: [registrationError],
			registerWait: releaseRegistration.promise,
			onRegister: () => registrationStarted.resolve(),
			registeredContentScriptIds: ['inpage', 'inpage2'],
			websiteAccess: [],
		})
		const { updateAllContentScriptConfigurationAndReloadTabsIfChanged } = await import('../../app/ts/background/contentScriptInjectionStrategy.js')
		const { persistMetamaskCompatibilityMode, withSettingsImportRollback } = await import('../../app/ts/background/settings.js')
		const { updateWebsiteAccessAndContentScriptInjectionStrategy } = await import('../../app/ts/background/websiteAccessUpdating.js')

		await withSilencedConsole(async () => {
			const failedImport = updateAllContentScriptConfigurationAndReloadTabsIfChanged(
				new Map(),
				async () => await persistMetamaskCompatibilityMode(true),
				withSettingsImportRollback,
			)
			await registrationStarted.promise
			const queuedWebsiteAccessUpdate = updateWebsiteAccessAndContentScriptInjectionStrategy(new Map(), () => disabledWebsiteAccess)
			releaseRegistration.resolve()
			await assert.rejects(failedImport, registrationError)
			await queuedWebsiteAccessUpdate
		})

		assert.deepEqual(getStorageState().websiteAccess, disabledWebsiteAccess)
		assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'inpage')?.excludeMatches, ['*://*.disabled.test/*'])
	})

	test('website access changes use the shared injection refresh and connected-tab reload coordinator', async () => {
		const { getRegisteredContentScripts, getReloadedTabs, getScriptingOperations } = installBrowserMock({
			registeredContentScriptIds: ['inpage', 'inpage2'],
			websiteAccess: disabledWebsiteAccess,
		})
		const { updateWebsiteAccessAndContentScriptInjectionStrategy } = await import('../../app/ts/background/websiteAccessUpdating.js')

		await updateWebsiteAccessAndContentScriptInjectionStrategy(new Map([[42, { connections: {} }]]), () => [])

		assert.deepEqual(getScriptingOperations(), ['update'])
		assert.equal(getRegisteredContentScripts().every(({ excludeMatches }) => excludeMatches?.length === 0), true)
		assert.deepEqual(getReloadedTabs(), [42])
	})

	test('website access changes skip connected-tab reload when manifest v3 registration refresh fails', async () => {
		const registrationError = new Error('website access registration refresh failed')
		const { getReloadedTabs, getStorageState } = installBrowserMock({
			registeredContentScriptIds: ['inpage', 'inpage2'],
			updateError: registrationError,
			websiteAccess: disabledWebsiteAccess,
		})
		const { updateWebsiteAccessAndContentScriptInjectionStrategy } = await import('../../app/ts/background/websiteAccessUpdating.js')
		const { getLatestUnexpectedError } = await loadModules()

		await withSilencedConsole(async () => await assert.rejects(updateWebsiteAccessAndContentScriptInjectionStrategy(new Map([[42, { connections: {} }]]), () => []), registrationError))

		assert.deepEqual(getReloadedTabs(), [])
		assert.deepEqual(getStorageState().websiteAccess, disabledWebsiteAccess)
		assert.equal((await getLatestUnexpectedError())?.data.message, registrationError.message)
	})

	test('disabling the Interceptor preserves stored website metadata', async () => {
		const storedWebsiteAccess: WebsiteAccessArray = [{
			...disabledWebsiteAccess[0],
			website: { websiteOrigin: 'disabled.test', title: 'Stored website title', icon: 'data:image/png;base64,c3RvcmVk' },
			interceptorDisabled: false,
		}]
		const { getStorageState } = installBrowserMock({ registeredContentScriptIds: ['inpage', 'inpage2'], websiteAccess: storedWebsiteAccess })
		const { setInterceptorDisabledForWebsite } = await import('../../app/ts/background/accessManagement.js')

		await setInterceptorDisabledForWebsite(new Map(), { websiteOrigin: 'disabled.test', title: undefined, icon: undefined }, true)

		assert.deepEqual(getStorageState().websiteAccess, [{ ...storedWebsiteAccess[0], interceptorDisabled: true }])
	})

	test('exposes every manifest v3 main-world script to Chromium', () => {
		const webAccessibleResources = getManifestV3WebAccessibleResources()
		for (const metamaskCompatibilityMode of [false, true]) {
			for (const scriptPath of getPageWorldScriptPaths(metamaskCompatibilityMode)) assert.equal(webAccessibleResources.includes(scriptPath), true)
		}
	})

	test('exposes every manifest v2 injected file to Firefox', async () => {
		const { getCommittedListener, getExecutedScriptCode, getExecutedScriptFiles } = installBrowserMock()
		const { updateContentScriptInjectionStrategyManifestV2 } = await loadModules()

		await updateContentScriptInjectionStrategyManifestV2()
		await getCommittedListener()(committedDetails)

		const injectedFiles = [
			'/vendor/webextension-polyfill/dist/browser-polyfill.js',
			'/inpage/js/listenContentScript.js',
			'/inpage/js/document_start.js',
		]
		assert.deepEqual(getExecutedScriptFiles(), injectedFiles)
		assert.deepEqual(getExecutedScriptCode(), ['Reflect.set(globalThis, Symbol.for("TheInterceptor.metamaskCompatibilityMode"), false)'])
		const configuredInjectedFiles = getManifestV2IsolatedWorldInjections(true).flatMap((injection) => 'file' in injection ? [injection.file] : [])
		const configuredPageWorldScripts = [...getPageWorldScriptPaths(false), ...getPageWorldScriptPaths(true)]
		assert.deepEqual(getManifestV2WebAccessibleResources().sort(), [...new Set([...configuredInjectedFiles, ...configuredPageWorldScripts])].sort())
	})

	test('registers the page-world provider artifact for the active MetaMask compatibility mode', async () => {
		for (const metamaskCompatibilityMode of [false, true]) {
			const { getRegisteredContentScripts } = installBrowserMock({ metamaskCompatibilityMode })
			const { updateContentScriptInjectionStrategyManifestV3 } = await loadModules()

			await updateContentScriptInjectionStrategyManifestV3()

			const mainWorldRegistration = getRegisteredContentScripts().find((registration) => registration.id === 'inpage')
			assert.deepEqual(mainWorldRegistration?.js, [metamaskCompatibilityMode ? '/inpage/js/inpage-metamask-compatibility.js' : '/inpage/js/inpage.js'])
		}
	})

	test('replaces an existing main-world registration when compatibility mode changes its script files', async () => {
		const isolatedWorldScriptFiles = ['/vendor/webextension-polyfill/dist/browser-polyfill.js', '/inpage/js/listenContentScript.js', '/inpage/js/listenContentScriptBootstrap.js']
		const { getRegisteredContentScripts, getScriptingOperations, getUnregisteredContentScriptIdBatches } = installBrowserMock({
			metamaskCompatibilityMode: true,
			registeredContentScripts: [
				{ id: 'inpage', js: ['/inpage/js/inpage.js'] },
				{ id: 'inpage2', js: isolatedWorldScriptFiles },
			],
		})
		const { updateContentScriptInjectionStrategyManifestV3 } = await loadModules()

		await updateContentScriptInjectionStrategyManifestV3()

		assert.deepEqual(getUnregisteredContentScriptIdBatches(), [['inpage']])
		assert.deepEqual(getScriptingOperations(), ['unregister', 'register', 'update'])
		assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'inpage')?.js, ['/inpage/js/inpage-metamask-compatibility.js'])
	})

	test('restores the previous main-world registration and skips tab reload when replacement fails', async () => {
		const registrationError = new Error('replacement registration failed')
		const previousMainWorldRegistration = { id: 'inpage', js: ['/inpage/js/inpage.js'] }
		const { getRegisteredContentScripts, getReloadedTabs, getScriptingOperations, sentMessages } = installBrowserMock({
			metamaskCompatibilityMode: true,
			registerErrors: [registrationError],
			registeredContentScripts: [
				previousMainWorldRegistration,
				{ id: 'inpage2', js: ['/vendor/webextension-polyfill/dist/browser-polyfill.js', '/inpage/js/listenContentScript.js', '/inpage/js/listenContentScriptBootstrap.js'] },
			],
		})
		const { refreshContentScriptInjectionStrategyAndReloadConnectedTabs, getLatestUnexpectedError } = await loadModules()

		await withSilencedConsole(async () => await assert.rejects(refreshContentScriptInjectionStrategyAndReloadConnectedTabs(new Map()), registrationError))

		assert.deepEqual(getScriptingOperations(), ['unregister', 'register', 'unregister', 'register'])
		assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'inpage'), previousMainWorldRegistration)
		assert.deepEqual(getReloadedTabs(), [])
		assert.equal((await getLatestUnexpectedError())?.data.message, registrationError.message)
		assert.equal(sentMessages.at(-1)?.method, 'popup_UnexpectedErrorOccured')
	})

	test('injects the Firefox compatibility prelude only when MetaMask compatibility mode is active', async () => {
		for (const metamaskCompatibilityMode of [false, true]) {
			const { getCommittedListener, getExecutedScriptCode, getExecutedScriptFiles } = installBrowserMock({ metamaskCompatibilityMode })
			const { updateContentScriptInjectionStrategyManifestV2 } = await loadModules()

			await updateContentScriptInjectionStrategyManifestV2()
			await getCommittedListener()(committedDetails)

			assert.deepEqual(getExecutedScriptFiles(), [
				'/vendor/webextension-polyfill/dist/browser-polyfill.js',
				'/inpage/js/listenContentScript.js',
				'/inpage/js/document_start.js',
			])
			assert.deepEqual(getExecutedScriptCode(), [`Reflect.set(globalThis, Symbol.for("TheInterceptor.metamaskCompatibilityMode"), ${ metamaskCompatibilityMode })`])
		}
	})

	test('registers the Firefox lazy configuration reader without eagerly loading settings', async () => {
		const { getCommittedListener, getStorageGetCalls } = installBrowserMock({ manifestVersion: 2 })
		const { refreshContentScriptInjectionStrategy } = await loadModules()

		await refreshContentScriptInjectionStrategy()
		assert.equal(getStorageGetCalls(), 0)

		await getCommittedListener()(committedDetails)
		assert.equal(getStorageGetCalls() > 0, true)
	})

	test('records manifest v3 registration failures as unexpected errors', async () => {
		const { sentMessages } = installBrowserMock({ registerError: new Error('registration failed') })
		const { updateContentScriptInjectionStrategyManifestV3, getLatestUnexpectedError } = await loadModules()

		await withSilencedConsole(async () => await assert.rejects(updateContentScriptInjectionStrategyManifestV3(), /registration failed/))

		const latestUnexpectedError = await getLatestUnexpectedError()
		assert.equal(latestUnexpectedError?.data.message, 'registration failed')
		assert.equal(latestUnexpectedError?.data.code, 'content_script_registration_failed')
		assert.equal(sentMessages.at(-1)?.method, 'popup_UnexpectedErrorOccured')
	})

	test('registers missing scripts, updates existing definitions, and then prunes obsolete registrations', async () => {
		const { getRegisteredContentScripts, getScriptingOperations, getUnregisteredContentScriptIdBatches } = installBrowserMock({ registeredContentScriptIds: ['inpage', 'obsolete-inpage'] })
		const { updateContentScriptInjectionStrategyManifestV3 } = await loadModules()

		await updateContentScriptInjectionStrategyManifestV3()

		assert.deepEqual(getRegisteredContentScripts().map(({ id }) => id).sort(), ['inpage', 'inpage2'])
		assert.equal(getRegisteredContentScripts().every(({ excludeMatches }) => excludeMatches?.length === 0), true)
		assert.deepEqual(getScriptingOperations(), ['register', 'update', 'unregister'])
		assert.deepEqual(getUnregisteredContentScriptIdBatches(), [['obsolete-inpage']])
	})

	test('restores existing and obsolete manifest v3 content scripts when an update fails', async () => {
		const { getRegisteredContentScripts, getScriptingOperations, getUnregisteredContentScriptIdBatches } = installBrowserMock({
			registeredContentScriptIds: ['inpage', 'inpage2', 'obsolete-inpage'],
			updateError: new Error('update failed'),
		})
		const { updateContentScriptInjectionStrategyManifestV3 } = await loadModules()

		await withSilencedConsole(async () => await assert.rejects(updateContentScriptInjectionStrategyManifestV3(), /update failed/))

		assert.deepEqual(getScriptingOperations(), ['update', 'unregister', 'register'])
		assert.deepEqual(getUnregisteredContentScriptIdBatches(), [['inpage', 'inpage2', 'obsolete-inpage']])
		assert.deepEqual(getRegisteredContentScripts().map(({ id }) => id).sort(), ['inpage', 'inpage2', 'obsolete-inpage'])
	})

	test('keeps missing-tab manifest v2 injection failures ignored', async () => {
		const { getCommittedListener } = installBrowserMock({ executeScriptError: new Error('No tab with id: 42.') })
		const { updateContentScriptInjectionStrategyManifestV2, getLatestUnexpectedError } = await loadModules()

		await updateContentScriptInjectionStrategyManifestV2()
		await withSilencedConsole(async () => {
			await getCommittedListener()(committedDetails)
		})

		assert.equal(await getLatestUnexpectedError(), undefined)
	})

	test('keeps invalid-tab manifest v2 injection failures ignored', async () => {
		const { getCommittedListener } = installBrowserMock({ executeScriptError: new Error('Invalid tab ID: 42') })
		const { updateContentScriptInjectionStrategyManifestV2, getLatestUnexpectedError } = await loadModules()

		await updateContentScriptInjectionStrategyManifestV2()
		await withSilencedConsole(async () => {
			await getCommittedListener()(committedDetails)
		})

		assert.equal(await getLatestUnexpectedError(), undefined)
	})

	test('skips manifest v2 injection after navigation reaches another extension page', async () => {
		const { getCommittedListener, getExecuteScriptCalls } = installBrowserMock({
			tabUrl: 'chrome-extension://another-extension-id/home.html',
			executeScriptError: new Error('Cannot access a chrome-extension:// URL of different extension'),
		})
		const { updateContentScriptInjectionStrategyManifestV2, getInterceptorErrorDiagnostics, getLatestUnexpectedError } = await loadModules()

		await updateContentScriptInjectionStrategyManifestV2()
		await withSilencedConsole(async () => {
			await getCommittedListener()(committedDetails)
		})

		assert.equal(getExecuteScriptCalls(), 0)
		assert.equal(await getLatestUnexpectedError(), undefined)
		assert.deepEqual(await getInterceptorErrorDiagnostics(), [])
	})

	test('skips manifest v2 injection for extension galleries', async () => {
		for (const extensionGalleryUrl of [
			'https://chromewebstore.google.com/detail/an-extension-id',
			'https://chrome.google.com/webstore/category/extensions',
			'https://chrome.google.com/webstore?hl=en',
			'https://chrome.google.com/webstore#extensions',
		]) {
			const { getCommittedListener, getExecuteScriptCalls } = installBrowserMock({
				tabUrl: extensionGalleryUrl,
				executeScriptError: new Error('The extensions gallery cannot be scripted.'),
			})
			const { updateContentScriptInjectionStrategyManifestV2, getInterceptorErrorDiagnostics, getLatestUnexpectedError } = await loadModules()

			await updateContentScriptInjectionStrategyManifestV2()
			await withSilencedConsole(async () => {
				await getCommittedListener()({ ...committedDetails, url: extensionGalleryUrl })
			})

			assert.equal(getExecuteScriptCalls(), 0)
			assert.equal(await getLatestUnexpectedError(), undefined)
			assert.deepEqual(await getInterceptorErrorDiagnostics(), [])
		}
	})

	test('skips manifest v2 injection when the tab URL is unavailable', async () => {
		const { getCommittedListener, getExecuteScriptCalls } = installBrowserMock({
			hasVisibleTabUrl: false,
			executeScriptError: new Error('Cannot access a chrome-extension:// URL of different extension'),
		})
		const { updateContentScriptInjectionStrategyManifestV2, getInterceptorErrorDiagnostics, getLatestUnexpectedError } = await loadModules()

		await updateContentScriptInjectionStrategyManifestV2()
		await withSilencedConsole(async () => {
			await getCommittedListener()(committedDetails)
		})

		assert.equal(getExecuteScriptCalls(), 0)
		assert.equal(await getLatestUnexpectedError(), undefined)
		assert.deepEqual(await getInterceptorErrorDiagnostics(), [])
	})

	test('rechecks the current tab URL after loading manifest v2 settings', async () => {
		const { getCommittedListener, getExecuteScriptCalls } = installBrowserMock({
			tabUrlAfterStorageRead: 'chrome-extension://another-extension-id/home.html',
			executeScriptError: new Error('Cannot access a chrome-extension:// URL of different extension'),
		})
		const { updateContentScriptInjectionStrategyManifestV2, getInterceptorErrorDiagnostics, getLatestUnexpectedError } = await loadModules()

		await updateContentScriptInjectionStrategyManifestV2()
		await withSilencedConsole(async () => {
			await getCommittedListener()(committedDetails)
		})

		assert.equal(getExecuteScriptCalls(), 0)
		assert.equal(await getLatestUnexpectedError(), undefined)
		assert.deepEqual(await getInterceptorErrorDiagnostics(), [])
	})

	test('ignores a different extension target that appears after the final tab URL check', async () => {
		const { getCommittedListener, getExecuteScriptCalls } = installBrowserMock({
			executeScriptError: new Error('Cannot access a chrome-extension:// URL of different extension'),
		})
		const { updateContentScriptInjectionStrategyManifestV2, getInterceptorErrorDiagnostics, getLatestUnexpectedError } = await loadModules()

		await updateContentScriptInjectionStrategyManifestV2()
		await withSilencedConsole(async () => {
			await getCommittedListener()(committedDetails)
		})

		assert.equal(getExecuteScriptCalls(), 1)
		assert.equal(await getLatestUnexpectedError(), undefined)
		assert.deepEqual(await getInterceptorErrorDiagnostics(), [])
	})

	test('ignores an extension gallery target that appears after the final tab URL check', async () => {
		const { getCommittedListener, getExecuteScriptCalls } = installBrowserMock({
			executeScriptError: new Error('The extensions gallery cannot be scripted.'),
		})
		const { updateContentScriptInjectionStrategyManifestV2, getInterceptorErrorDiagnostics, getLatestUnexpectedError } = await loadModules()

		await updateContentScriptInjectionStrategyManifestV2()
		await withSilencedConsole(async () => {
			await getCommittedListener()(committedDetails)
		})

		assert.equal(getExecuteScriptCalls(), 1)
		assert.equal(await getLatestUnexpectedError(), undefined)
		assert.deepEqual(await getInterceptorErrorDiagnostics(), [])
	})

	test('records non-exact restricted-target errors as local recovery', async () => {
		for (const errorMessage of [
			'Unexpected executeScript failure: Cannot access a chrome-extension:// URL of different extension',
			'Cannot access a chrome-extension:// URL of different extension after navigation',
			'Unexpected executeScript failure: The extensions gallery cannot be scripted.',
			'The extensions gallery cannot be scripted. after navigation',
		]) {
			const { getCommittedListener } = installBrowserMock({ executeScriptError: new Error(errorMessage) })
			const { updateContentScriptInjectionStrategyManifestV2, getInterceptorErrorDiagnostics, getLatestUnexpectedError } = await loadModules()

			await updateContentScriptInjectionStrategyManifestV2()
			await withSilencedConsole(async () => {
				await getCommittedListener()(committedDetails)
			})

			for (let index = 0; index < 10 && (await getInterceptorErrorDiagnostics()).length === 0; index++) await Promise.resolve()
			assert.equal(await getLatestUnexpectedError(), undefined)
			const diagnostics = await getInterceptorErrorDiagnostics()
			assert.equal(diagnostics.length, 1)
			assert.equal(diagnostics[0]?.cause, errorMessage)
			assert.equal(diagnostics[0]?.code, 'manifest_v2_content_script_injection_failed')
		}
	})

	test('records manifest v2 injection failures as local recovery diagnostics', async () => {
		const { getCommittedListener } = installBrowserMock({ executeScriptError: new Error('executeScript failed') })
		const { updateContentScriptInjectionStrategyManifestV2, getInterceptorErrorDiagnostics, getLatestUnexpectedError } = await loadModules()

		await updateContentScriptInjectionStrategyManifestV2()
		await withSilencedConsole(async () => {
			await getCommittedListener()(committedDetails)
		})

		for (let index = 0; index < 10 && (await getInterceptorErrorDiagnostics()).length === 0; index++) await Promise.resolve()
		assert.equal(await getLatestUnexpectedError(), undefined)
		const diagnostics = await getInterceptorErrorDiagnostics()
		assert.equal(diagnostics.length, 1)
		assert.equal(diagnostics[0]?.message, 'Leaving this navigation without early injection.')
		assert.equal(diagnostics[0]?.cause, 'executeScript failed')
		assert.equal(diagnostics[0]?.code, 'manifest_v2_content_script_injection_failed')
		assert.equal(diagnostics[0]?.category, 'local_recovery')
	})
})
