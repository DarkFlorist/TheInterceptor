import * as assert from 'assert'
import * as fs from 'node:fs'
import { describe, test } from 'bun:test'
import { createTestSimulationServicesOwner } from './backgroundEthAccountsTestHarness.js'
import type { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import type { TokenPriceService } from '../../app/ts/simulation/services/priceEstimator.js'
import { withSilencedConsole } from './consoleSilence.js'

type RuntimeMessage = {
	readonly method?: string
	readonly data?: { readonly message?: string, readonly code?: string }
}

type BrowserMockOptions = {
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
	readonly safeAppsHostOrigins?: readonly string[]
	readonly beforeUpdateContentScripts?: (scripts: readonly RegisteredContentScript[]) => Promise<void>
}

type RegisteredContentScript = {
	readonly id: string
	readonly excludeMatches?: readonly string[]
	readonly matches?: readonly string[]
	readonly allFrames?: boolean
	readonly matchOriginAsFallback?: boolean
	readonly js?: readonly string[]
}

function installBrowserMock({ emitStorageEvents = false, registerError, hostRegistrationError, updateError, executeScriptError, tabUrl = 'https://example.com/', hasVisibleTabUrl = true, tabUrlAfterStorageRead, registeredContentScriptIds = [], safeAppsCompatibilityMode = false, safeAppsHostOrigins, beforeUpdateContentScripts }: BrowserMockOptions = {}) {
	const storageState: Record<string, unknown> = { safeAppsCompatibilityMode, ...(safeAppsHostOrigins === undefined ? {} : { safeAppsHostOrigins }) }
	const sentMessages: RuntimeMessage[] = []
	const executedScriptFiles: string[] = []
	const reloadedTabs: number[] = []
	const registeredContentScripts = new Map(registeredContentScriptIds.map((id) => [id, { id }]))
	let executeScriptCalls = 0
	const scriptingOperations: string[] = []
	const unregisteredContentScriptIdBatches: string[][] = []
	let currentTabUrl = tabUrl
	let storageListener: ((changes: Record<string, browser.storage.StorageChange>, area: string) => void) | undefined
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
				onChanged: { addListener: (listener: typeof storageListener) => { storageListener = listener } },
				local: {
					async get(keys?: string | string[] | Record<string, unknown> | null) {
						const storageItems = getStorageItems(keys)
						currentTabUrl = tabUrlAfterStorageRead ?? currentTabUrl
						return storageItems
					},
					async set(items: Record<string, unknown>) {
						const changes = Object.fromEntries(Object.entries(items).filter(([key, value]) => JSON.stringify(storageState[key]) !== JSON.stringify(value)).map(([key, value]) => [key, { oldValue: storageState[key], newValue: value }]))
						Object.assign(storageState, items)
						if (emitStorageEvents) storageListener?.(changes, 'local')
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
		reloadedTabs,
		recordAccessRefresh: () => { scriptingOperations.push('access-refresh') },
		emitStorageChange(changes: Record<string, browser.storage.StorageChange>, area: string) { storageListener?.(changes, area) },
		getRegisteredContentScripts() { return [...registeredContentScripts.values()] },
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
	const registration = await import('../../app/ts/utils/contentScriptsUpdating.js')
	return {
		...registration,
		updateContentScriptInjectionStrategyManifestV3: registration.createContentScriptRegistrationUpdater(),
		...await import('../../app/ts/background/storageVariables.js'),
	}
}

function getManifestV2WebAccessibleResources() {
	const manifest: unknown = JSON.parse(fs.readFileSync('app/manifestV2.json', 'utf8'))
	if (typeof manifest !== 'object' || manifest === null || !('web_accessible_resources' in manifest)) throw new Error('Manifest V2 must declare web-accessible resources')
	const resources = manifest.web_accessible_resources
	if (!Array.isArray(resources) || !resources.every((resource) => typeof resource === 'string')) throw new Error('Manifest V2 web-accessible resources must be strings')
	return resources
}

describe('content script injection strategy', () => {
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

	test('exposes every manifest v2 injected file to Firefox', async () => {
		const { getCommittedListener, getExecutedScriptFiles } = installBrowserMock()
		const { updateContentScriptInjectionStrategyManifestV2 } = await loadModules()

		await updateContentScriptInjectionStrategyManifestV2()
		await getCommittedListener()(committedDetails)

		const injectedFiles = [
			'/vendor/webextension-polyfill/dist/browser-polyfill.js',
			'/inpage/js/listenContentScript.js',
			'/inpage/js/document_start.js',
		]
		assert.deepEqual(getExecutedScriptFiles(), injectedFiles)
		assert.deepEqual(getManifestV2WebAccessibleResources(), [
			...injectedFiles.map((file) => file.slice(1)),
			'inpage/js/inpage.js',
		])
	})

	test('propagates manifest v3 registration failures when base-provider recovery also fails', async () => {
		installBrowserMock({ registerError: new Error('registration failed') })
		const { updateContentScriptInjectionStrategyManifestV3 } = await loadModules()

		await assert.rejects(updateContentScriptInjectionStrategyManifestV3(), { name: 'AggregateError', message: 'Content script registration and base-provider recovery failed.' })
	})

	for (const origins of [['https://*.invalid.example'], ['not-an-origin']]) test(`invalid stored hosting configuration preserves base injection: ${ origins[0] }`, async () => {
		const { getRegisteredContentScripts } = installBrowserMock({ safeAppsCompatibilityMode: true, safeAppsHostOrigins: origins, registeredContentScriptIds: ['safe-apps-host', 'inpage'] })
		const { updateContentScriptInjectionStrategyManifestV3 } = await loadModules()
		await withSilencedConsole(async () => assert.equal(await updateContentScriptInjectionStrategyManifestV3(), 'base-provider-recovered'))
		assert.deepEqual(getRegisteredContentScripts().map(({ id }) => id).sort(), ['inpage', 'inpage2'])
		assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'inpage')?.excludeMatches, [])
	})

	test('a rejected host registration restores base injection and a later queued update can succeed', async () => {
		const { getRegisteredContentScripts } = installBrowserMock({ safeAppsCompatibilityMode: true, safeAppsHostOrigins: ['https://app.example.com'], hostRegistrationError: new Error('Invalid host match pattern') })
		const { updateContentScriptInjectionStrategyManifestV3 } = await loadModules()
		await withSilencedConsole(async () => assert.equal(await updateContentScriptInjectionStrategyManifestV3(), 'base-provider-recovered'))
		assert.deepEqual(getRegisteredContentScripts().map(({ id }) => id).sort(), ['inpage', 'inpage2'])
		assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'inpage')?.excludeMatches, [])
		await browser.storage.local.set({ safeAppsCompatibilityMode: false })
		await updateContentScriptInjectionStrategyManifestV3()
	})

	test('recovery removes a host installed before a partially applied provider update fails', async () => {
		const { getRegisteredContentScripts } = installBrowserMock({ safeAppsCompatibilityMode: true, safeAppsHostOrigins: ['https://app.example.com'], registeredContentScriptIds: ['inpage'], beforeUpdateContentScripts: async (scripts) => {
			if (scripts.some(({ excludeMatches }) => excludeMatches?.includes('https://app.example.com:443/*'))) throw new Error('Hosted provider update rejected')
		} })
		const { updateContentScriptInjectionStrategyManifestV3 } = await loadModules()
		await withSilencedConsole(async () => assert.equal(await updateContentScriptInjectionStrategyManifestV3(), 'base-provider-recovered'))
		assert.deepEqual(getRegisteredContentScripts().map(({ id }) => id).sort(), ['inpage', 'inpage2'])
		assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'inpage')?.excludeMatches, [])
	})

	test('enable/disable awaits recovered registrations, coalesces the storage update, reloads and replies', async () => {
		const { getRegisteredContentScripts, getScriptingOperations, reloadedTabs, sentMessages, recordAccessRefresh } = installBrowserMock({ emitStorageEvents: true, safeAppsCompatibilityMode: true, safeAppsHostOrigins: ['not-an-origin'] })
		const registration = await import('../../app/ts/utils/contentScriptsUpdating.js')
		const { disableInterceptor } = await import('../../app/ts/background/popupMessageHandlers/websiteAccess.js')
		const { getLatestUnexpectedError } = await import('../../app/ts/background/storageVariables.js')
		const { EthereumClientService: EthereumClient } = await import('../../app/ts/simulation/services/EthereumClientService.js')
		const { TokenPriceService: TokenPriceClient } = await import('../../app/ts/simulation/services/priceEstimator.js')
		const ethereum: EthereumClientService = Object.create(EthereumClient.prototype)
		const tokenPriceService: TokenPriceService = Object.create(TokenPriceClient.prototype)
		const services = createTestSimulationServicesOwner({ ethereum, tokenPriceService })
		const connections = Object.assign(new Map(), { lifecycle: { accessReconciled: recordAccessRefresh } })
		const website = { websiteOrigin: 'disable-recovery.example', title: undefined, icon: undefined }
		await browser.storage.local.set({ currentTabId: 42 })
		await withSilencedConsole(async () => {
			registration.startContentScriptRegistrationUpdates()
			await registration.updateContentScriptInjectionStrategyManifestV3()
			for (const interceptorDisabled of [true, false]) {
				const initialOperations = getScriptingOperations().length
				await disableInterceptor(services, connections, { method: 'popup_setDisableInterceptor', data: { website, interceptorDisabled } })
				const operations = getScriptingOperations().slice(initialOperations)
				assert.deepEqual(operations, ['update', 'reload', 'access-refresh'])
				assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'inpage')?.excludeMatches, interceptorDisabled ? ['*://*.disable-recovery.example/*'] : [])
				assert.equal(sentMessages.at(-1)?.method, 'popup_setDisableInterceptorReply')
				assert.equal((await getLatestUnexpectedError())?.data.code, 'content_script_registration_failed')
			}
		})
		assert.deepEqual(reloadedTabs, [42, 42])
	})

	test('enable/disable propagates unrecovered registration errors before reload or a success reply', async () => {
		const { reloadedTabs, sentMessages } = installBrowserMock({ registerError: new Error('Scripting unavailable') })
		const { disableInterceptorForPage } = await import('../../app/ts/background/popupMessageHandlers/websiteAccess.js')
		await assert.rejects(disableInterceptorForPage(new Map(), { websiteOrigin: 'unrecoverable.example', title: undefined, icon: undefined }, true), /base-provider recovery failed/)
		assert.deepEqual(reloadedTabs, [])
		assert.equal(sentMessages.some(({ method }) => method === 'popup_setDisableInterceptorReply'), false)
	})

	test('storage is the single settings trigger and reports rejected registration updates', async () => {
		const { emitStorageChange, getScriptingOperations, sentMessages } = installBrowserMock({ hostRegistrationError: new Error('Host registration rejected'), safeAppsHostOrigins: ['https://app.example.com'] })
		const { startContentScriptRegistrationUpdates } = await import('../../app/ts/utils/contentScriptsUpdating.js')
		startContentScriptRegistrationUpdates()
		await new Promise((resolve) => setTimeout(resolve, 0))
		const initialOperations = getScriptingOperations().length
		emitStorageChange({ safeAppsCompatibilityMode: { newValue: true } }, 'sync')
		emitStorageChange({ unrelatedSetting: { newValue: true } }, 'local')
		await new Promise((resolve) => setTimeout(resolve, 0))
		assert.equal(getScriptingOperations().length, initialOperations)
		await browser.storage.local.set({ safeAppsCompatibilityMode: true })
		await withSilencedConsole(async () => {
			emitStorageChange({ safeAppsCompatibilityMode: { newValue: true } }, 'local')
			await new Promise((resolve) => setTimeout(resolve, 0))
		})
		assert.equal(sentMessages.at(-1)?.method, 'popup_UnexpectedErrorOccured')
		assert.equal(sentMessages.at(-1)?.data?.code, 'content_script_registration_failed')
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

	test('registers the shared host before the provider only on selected origins', async () => {
		for (const enabled of [false, true]) {
			const { getRegisteredContentScripts } = installBrowserMock({ safeAppsCompatibilityMode: enabled, safeAppsHostOrigins: ['https://app.example.com', 'http://localhost:3000'] })
			const { updateContentScriptInjectionStrategyManifestV3 } = await loadModules()
			await updateContentScriptInjectionStrategyManifestV3()
			const scripts = getRegisteredContentScripts()
			const inpage = scripts.find(({ id }) => id === 'inpage')
			const host = scripts.find(({ id }) => id === 'safe-apps-host')
			assert.deepEqual(inpage?.js, ['/inpage/js/inpage.js'])
			assert.deepEqual(inpage?.excludeMatches, enabled ? ['https://app.example.com:443/*', 'http://localhost:3000/*'] : [])
			assert.deepEqual(host?.matches, enabled ? ['https://app.example.com:443/*', 'http://localhost:3000/*'] : undefined)
			assert.deepEqual(host?.js, enabled ? ['/inpage/js/safeAppsHostBootstrap.js', '/inpage/js/inpage.js'] : undefined)
			assert.equal(host?.matchOriginAsFallback, enabled ? true : undefined)
		}
	})

	test('does not host Request Finance or any other site when compatibility is enabled without explicit origins', async () => {
		const { getRegisteredContentScripts } = installBrowserMock({ safeAppsCompatibilityMode: true })
		const { updateContentScriptInjectionStrategyManifestV3 } = await loadModules()
		await updateContentScriptInjectionStrategyManifestV3()
		assert.deepEqual(getRegisteredContentScripts().map(({ id }) => id).sort(), ['inpage', 'inpage2'])
		assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'inpage')?.excludeMatches, [])
	})

	test('removes hosting on opt-out while retaining the normal provider', async () => {
		const { getRegisteredContentScripts } = installBrowserMock({ safeAppsCompatibilityMode: true, safeAppsHostOrigins: ['https://app.request.finance'] })
		const { updateContentScriptInjectionStrategyManifestV3 } = await loadModules()
		await updateContentScriptInjectionStrategyManifestV3()
		assert.equal(getRegisteredContentScripts().some(({ id }) => id === 'safe-apps-host'), true)
		await browser.storage.local.set({ safeAppsHostOrigins: [] })
		await updateContentScriptInjectionStrategyManifestV3()
		assert.deepEqual(getRegisteredContentScripts().map(({ id }) => id).sort(), ['inpage', 'inpage2'])
		assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'inpage')?.excludeMatches, [])
	})

	test('applies the latest Safe Apps setting after an earlier content script update finishes', async () => {
		let releaseFirstUpdate: (() => void) | undefined
		let notifyFirstUpdateStarted: (() => void) | undefined
		const firstUpdateStarted = new Promise<void>((resolve) => { notifyFirstUpdateStarted = resolve })
		const firstUpdateBlocked = new Promise<void>((resolve) => { releaseFirstUpdate = resolve })
		let updateCount = 0
		const { getRegisteredContentScripts } = installBrowserMock({
			registeredContentScriptIds: ['inpage', 'inpage2'],
			safeAppsHostOrigins: ['https://app.request.finance'],
			beforeUpdateContentScripts: async () => {
				updateCount += 1
				if (updateCount !== 1) return
				notifyFirstUpdateStarted?.()
				await firstUpdateBlocked
			},
		})
		const { updateContentScriptInjectionStrategyManifestV3 } = await loadModules()
		const earlierUpdate = updateContentScriptInjectionStrategyManifestV3()
		await firstUpdateStarted
		await browser.storage.local.set({ safeAppsCompatibilityMode: true })
		const latestUpdate = updateContentScriptInjectionStrategyManifestV3()
		releaseFirstUpdate?.()
		await Promise.all([earlierUpdate, latestUpdate])
		const host = getRegisteredContentScripts().find(({ id }) => id === 'safe-apps-host')
		assert.deepEqual(host?.js, ['/inpage/js/safeAppsHostBootstrap.js', '/inpage/js/inpage.js'])
		assert.equal(updateCount, 2)
	})

	test('keeps existing and obsolete manifest v3 content scripts registered when an update fails', async () => {
		const { getRegisteredContentScripts, getScriptingOperations, getUnregisteredContentScriptIdBatches } = installBrowserMock({
			registeredContentScriptIds: ['inpage', 'inpage2', 'obsolete-inpage'],
			updateError: new Error('update failed'),
		})
		const { updateContentScriptInjectionStrategyManifestV3 } = await loadModules()

		await assert.rejects(updateContentScriptInjectionStrategyManifestV3(), /base-provider recovery failed/)

		assert.deepEqual(getScriptingOperations(), ['update', 'update'])
		assert.deepEqual(getUnregisteredContentScriptIdBatches(), [])
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
