import { getChromeSiteMatchPatterns } from '../../app/ts/utils/chromeMatchPatterns.js'
import * as assert from 'assert'
import * as fs from 'node:fs'
import { describe, test } from 'bun:test'
import { createTestSimulationServicesOwner } from './backgroundEthAccountsTestHarness.js'
import type { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import type { TokenPriceService } from '../../app/ts/simulation/services/priceEstimator.js'
import { withSilencedConsole } from './consoleSilence.js'
import type { FixedContentScript } from '../../app/ts/background/contentScriptDefinition.js'

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
	readonly safeAppsHostOrigins?: unknown
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

function installBrowserMock({ afterStorageRead, emitStorageEvents = false, registerError, hostRegistrationError, updateError, executeScriptError, tabUrl = 'https://example.com/', hasVisibleTabUrl = true, tabUrlAfterStorageRead, registeredContentScriptIds = [], safeAppsCompatibilityMode = false, safeAppsHostOrigins, beforeRegisterContentScripts, beforeUpdateContentScripts }: BrowserMockOptions = {}) {
	const storageState: Record<string, unknown> = { safeAppsCompatibilityMode, ...(safeAppsHostOrigins === undefined ? {} : { safeAppsHostOrigins }) }
	const sentMessages: RuntimeMessage[] = []
	const executedScriptFiles: string[] = []
	const reloadedTabs: number[] = []
	const registeredContentScripts = new Map<string, RegisteredContentScript>(registeredContentScriptIds.map((id) => [id, { id }]))
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

// Each fixture owns a background service, including its queue and storage observer.
async function loadModules() {
	const registration = await import('../../app/ts/background/contentScriptRegistration.js')
	return {
		...registration,
		...await import('../../app/ts/background/manifestV2ContentScriptInjection.js'),
		updateRegistration: registration.createContentScriptRegistrationService().update,
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

		assert.deepEqual(getChromeSiteMatchPatterns([
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
			'http://example.com:80/*',
			'https://example.com:443/*',
			'http://localhost:3000/*',
			'https://localhost:3000/*',
			'http://127.0.0.1:8545/*',
			'https://127.0.0.1:8545/*',
			'http://[::1]:8545/*',
			'https://[::1]:8545/*',
			'https://secure.example:443/*',
			'https://localhost:4443/*',
		])
	})

	test('excludes a disabled site on its exact host and port, not on its subdomains or other ports', () => {
		// Each pattern names its port, because a pattern without one would match every port of the host, and its host has no *. prefix, which would match every subdomain.
		assert.deepEqual(getChromeSiteMatchPatterns(['example.com']), ['http://example.com:80/*', 'https://example.com:443/*'])
		assert.deepEqual(getChromeSiteMatchPatterns(['app.example.com:8080']), ['http://app.example.com:8080/*', 'https://app.example.com:8080/*'])
		// A URL never shows its scheme's default port, so these stored origins can only come from the other scheme's URL.
		assert.deepEqual(getChromeSiteMatchPatterns(['example.com:80']), ['https://example.com:80/*'])
		assert.deepEqual(getChromeSiteMatchPatterns(['example.com:443']), ['http://example.com:443/*'])
		assert.deepEqual(getChromeSiteMatchPatterns(['http://plain.example', 'https://secure.example:8443']), ['http://plain.example:80/*', 'https://secure.example:8443/*'])
	})

	test('excludes exactly the URLs that getHostWithPort gives the disabled origin', async () => {
		const { getHostWithPort } = await import('../../app/ts/utils/requests.js')
		// Chromium matches a pattern with a port against the URL's scheme, exact host and effective port.
		const isMatchedBy = (pattern: string, url: string) => {
			const { protocol, hostname, port } = new URL(url)
			const effectivePort = port === '' ? (protocol === 'https:' ? '443' : '80') : port
			return pattern === `${ protocol }//${ hostname }:${ effectivePort }/*`
		}
		const urls = ['http://example.com/', 'https://example.com/path', 'https://example.com:80/', 'http://example.com:443/', 'http://example.com:8080/', 'https://app.example.com/', 'http://[::1]:8545/']
		for (const disabledUrl of urls) {
			const excludeMatches = getChromeSiteMatchPatterns([getHostWithPort(disabledUrl)])
			for (const url of urls) {
				assert.equal(excludeMatches.some((pattern) => isMatchedBy(pattern, url)), getHostWithPort(url) === getHostWithPort(disabledUrl), `${ url } with ${ disabledUrl } disabled`)
			}
		}
		// getHostWithPort never produces these, so no page has them as its origin.
		assert.deepEqual(getChromeSiteMatchPatterns(['Example.com', 'example.com:']), [])
	})

	test('skips stored hosts with a * instead of turning them into wildcard or invalid patterns', () => {
		assert.deepEqual(getChromeSiteMatchPatterns([
			'*.example.com',
			'https://*.secure.example',
			'foo*bar.example',
			'%2A.encoded.example',
			'example.com',
		]), ['http://example.com:80/*', 'https://example.com:443/*'])
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

	test('propagates base provider registration failures before applying the Safe Apps host', async () => {
		installBrowserMock({ registerError: new Error('registration failed') })
		const { updateRegistration } = await loadModules()

		await assert.rejects(updateRegistration(), /registration failed/)
	})

	test('failed host rollback propagates and reconciles the base provider on retry', async () => {
		let failHostRegistration = true
		let failRollback = true
		const updatedScriptIds: string[][] = []
		installBrowserMock({
			safeAppsCompatibilityMode: true,
			safeAppsHostOrigins: ['https://rollback.example'],
			beforeRegisterContentScripts: async (scripts) => {
				if (failHostRegistration && scripts.some(({ id }) => id === 'safe-apps-host')) throw new Error('host failed')
			},
			beforeUpdateContentScripts: async (scripts) => {
				updatedScriptIds.push(scripts.map(({ id }) => id))
				if (failRollback) { failRollback = false; throw new Error('rollback failed') }
			},
		})
		const { updateRegistration } = await loadModules()
		await assert.rejects(updateRegistration(), { name: 'AggregateError', message: 'Safe Apps host registration and provider rollback failed.' })
		failHostRegistration = false
		await updateRegistration()
		assert.deepEqual(updatedScriptIds, [['inpage'], ['inpage2', 'inpage'], ['inpage']])
	})

	test('restoring previous settings repairs registrations after a failed host rollback', async () => {
		let failedProviderUpdates = 0
		const { getRegisteredContentScripts } = installBrowserMock({
			safeAppsCompatibilityMode: true,
			safeAppsHostOrigins: ['https://first.example'],
			beforeUpdateContentScripts: async (scripts) => {
				if (failedProviderUpdates > 0 && scripts.some(({ id }) => id === 'inpage')) {
					failedProviderUpdates--
					throw new Error('provider update failed')
				}
			},
		})
		const { updateRegistration } = await loadModules()
		await updateRegistration()
		failedProviderUpdates = 2
		await browser.storage.local.set({ safeAppsHostOrigins: ['https://second.example'] })
		await assert.rejects(updateRegistration(), { name: 'AggregateError', message: 'Safe Apps host registration and provider rollback failed.' })
		assert.equal(getRegisteredContentScripts().some(({ id }) => id === 'safe-apps-host'), false)
		await browser.storage.local.set({ safeAppsHostOrigins: ['https://first.example'] })
		await updateRegistration()
		assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'safe-apps-host')?.matches, ['https://first.example:443/*'])
		assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'inpage')?.excludeMatches, ['https://first.example:443/*'])
	})

	for (const origins of [['https://*.invalid.example'], ['not-an-origin']]) test(`invalid stored hosting origins are ignored without a registration failure: ${ origins[0] }`, async () => {
		const { getRegisteredContentScripts } = installBrowserMock({ safeAppsCompatibilityMode: true, safeAppsHostOrigins: origins, registeredContentScriptIds: ['safe-apps-host', 'inpage'] })
		const { updateRegistration, getLatestUnexpectedError } = await loadModules()
		assert.equal(await updateRegistration(), 'configuration-applied')
		assert.deepEqual(getRegisteredContentScripts().map(({ id }) => id).sort(), ['inpage', 'inpage2'])
		assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'inpage')?.excludeMatches, [])
		assert.equal(await getLatestUnexpectedError(), undefined)
	})

	test('a stored hosting selection that is not a list preserves base injection and reports a registration failure', async () => {
		const { getRegisteredContentScripts } = installBrowserMock({ safeAppsCompatibilityMode: true, safeAppsHostOrigins: 'not-a-list', registeredContentScriptIds: ['safe-apps-host', 'inpage'] })
		const { updateRegistration, getLatestUnexpectedError } = await loadModules()
		await withSilencedConsole(async () => { assert.equal(await updateRegistration(), 'hosting-failed') })
		assert.deepEqual(getRegisteredContentScripts().map(({ id }) => id).sort(), ['inpage', 'inpage2'])
		assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'inpage')?.excludeMatches, [])
		assert.equal((await getLatestUnexpectedError())?.data.code, 'safe_apps_host_registration_failed')
	})

	test('a rejected host registration restores base injection and a later queued update can succeed', async () => {
		const { getRegisteredContentScripts } = installBrowserMock({ safeAppsCompatibilityMode: true, safeAppsHostOrigins: ['https://app.example.com'], hostRegistrationError: new Error('Invalid host match pattern') })
		const { updateRegistration } = await loadModules()
		await withSilencedConsole(async () => { await updateRegistration() })
		assert.deepEqual(getRegisteredContentScripts().map(({ id }) => id).sort(), ['inpage', 'inpage2'])
		assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'inpage')?.excludeMatches, [])
		await browser.storage.local.set({ safeAppsCompatibilityMode: false })
		await updateRegistration()
	})

	test('recovery removes a host installed before a partially applied provider update fails', async () => {
		const { getRegisteredContentScripts } = installBrowserMock({ safeAppsCompatibilityMode: true, safeAppsHostOrigins: ['https://app.example.com'], registeredContentScriptIds: ['inpage'], beforeUpdateContentScripts: async (scripts) => {
			if (scripts.some(({ excludeMatches }) => excludeMatches?.includes('https://app.example.com:443/*'))) throw new Error('Hosted provider update rejected')
		} })
		const { updateRegistration } = await loadModules()
		await withSilencedConsole(async () => { await updateRegistration() })
		assert.deepEqual(getRegisteredContentScripts().map(({ id }) => id).sort(), ['inpage', 'inpage2'])
		assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'inpage')?.excludeMatches, [])
	})

	test('enable/disable awaits recovered registrations, coalesces the storage update, reloads and replies', async () => {
		const { getRegisteredContentScripts, getScriptingOperations, reloadedTabs, sentMessages, recordAccessRefresh } = installBrowserMock({ emitStorageEvents: true, safeAppsCompatibilityMode: true, safeAppsHostOrigins: 'not-a-list', registeredContentScriptIds: ['inpage', 'inpage2'] })
		const registration = await import('../../app/ts/background/contentScriptRegistration.js')
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
		try {
			await withSilencedConsole(async () => {
				registration.contentScriptRegistration.start()
				await registration.contentScriptRegistration.update()
				for (const interceptorDisabled of [true, false]) {
					const initialOperations = getScriptingOperations().length
					await disableInterceptor(services, connections, { method: 'popup_setDisableInterceptor', data: { website, interceptorDisabled } })
					const operations = getScriptingOperations().slice(initialOperations)
					assert.deepEqual(operations, ['update', 'reload', 'access-refresh'])
					assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'inpage')?.excludeMatches, interceptorDisabled ? ['http://disable-recovery.example:80/*', 'https://disable-recovery.example:443/*'] : [])
					assert.equal(sentMessages.at(-1)?.method, 'popup_setDisableInterceptorReply')
					assert.equal((await getLatestUnexpectedError())?.data.code, 'safe_apps_host_registration_failed')
				}
			})
		} finally { registration.contentScriptRegistration.stop() }
		assert.deepEqual(reloadedTabs, [42, 42])
	})

	test('enable/disable propagates unrecovered registration errors before reload or a success reply', async () => {
		const { reloadedTabs, sentMessages } = installBrowserMock({ registerError: new Error('Scripting unavailable') })
		const { disableInterceptorForPage } = await import('../../app/ts/background/popupMessageHandlers/websiteAccess.js')
		await assert.rejects(disableInterceptorForPage(new Map(), { websiteOrigin: 'unrecoverable.example', title: undefined, icon: undefined }, true), /Scripting unavailable/)
		assert.deepEqual(reloadedTabs, [])
		assert.equal(sentMessages.some(({ method }) => method === 'popup_setDisableInterceptorReply'), false)
	})

	test('an awaited website-access failure rejects its caller before reload while the storage listener reports independently', async () => {
		let failProviderUpdates = false
		const { reloadedTabs, sentMessages } = installBrowserMock({ emitStorageEvents: true, registeredContentScriptIds: ['inpage', 'inpage2'], beforeUpdateContentScripts: async () => {
			if (failProviderUpdates) throw new Error('Provider update rejected')
		} })
		const registration = await import('../../app/ts/background/contentScriptRegistration.js')
		const { disableInterceptorForPage } = await import('../../app/ts/background/popupMessageHandlers/websiteAccess.js')
		const isRegistrationFailureReport = ({ method, data }: RuntimeMessage) => method === 'popup_UnexpectedErrorOccured' && data?.code === 'content_script_registration_failed'
		try {
			registration.contentScriptRegistration.start()
			await registration.contentScriptRegistration.update()
			failProviderUpdates = true
			await withSilencedConsole(async () => {
				await assert.rejects(disableInterceptorForPage(new Map(), { websiteOrigin: 'awaited-failure.example', title: undefined, icon: undefined }, true), /Provider update rejected/)
				await new Promise((resolve) => setTimeout(resolve, 0))
			})
			assert.deepEqual(reloadedTabs, [])
			// The listener's own attempt for the same write is a separate diagnostic, not the popup's result.
			const reportsAfterWrite = sentMessages.filter(isRegistrationFailureReport).length
			assert.equal(reportsAfterWrite, 1)
			await withSilencedConsole(async () => {
				await browser.storage.local.set({ safeAppsCompatibilityMode: true })
				await new Promise((resolve) => setTimeout(resolve, 0))
			})
			assert.equal(sentMessages.filter(isRegistrationFailureReport).length, reportsAfterWrite + 1)
		} finally { registration.contentScriptRegistration.stop() }
	})

	test('storage changes trigger registration updates and report rejected ones', async () => {
		const { emitStorageChange, getScriptingOperations, sentMessages, getStorageListenerCount } = installBrowserMock({ hostRegistrationError: new Error('Host registration rejected'), safeAppsHostOrigins: ['https://app.example.com'] })
		const { createContentScriptRegistrationService } = await import('../../app/ts/background/contentScriptRegistration.js')
		const registration = createContentScriptRegistrationService()
		registration.start()
		registration.start()
		assert.equal(getStorageListenerCount(), 1)
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
		assert.equal(sentMessages.at(-1)?.data?.code, 'safe_apps_host_registration_failed')
		registration.stop()
		assert.equal(getStorageListenerCount(), 0)
		const stoppedOperations = getScriptingOperations().length
		await browser.storage.local.set({ safeAppsCompatibilityMode: false })
		emitStorageChange({ safeAppsCompatibilityMode: { newValue: false } }, 'local')
		await new Promise((resolve) => setTimeout(resolve, 0))
		assert.equal(getScriptingOperations().length, stoppedOperations)
		registration.start()
		await registration.update()
		assert.ok(getScriptingOperations().length > stoppedOperations)
		registration.stop()
	})

	test('registers missing scripts, updates existing definitions, and then prunes obsolete registrations', async () => {
		const { getRegisteredContentScripts, getScriptingOperations, getUnregisteredContentScriptIdBatches } = installBrowserMock({ registeredContentScriptIds: ['inpage', 'obsolete-inpage'] })
		const { updateRegistration } = await loadModules()

		await updateRegistration()

		assert.deepEqual(getRegisteredContentScripts().map(({ id }) => id).sort(), ['inpage', 'inpage2'])
		assert.equal(getRegisteredContentScripts().every(({ excludeMatches }) => excludeMatches?.length === 0), true)
		assert.deepEqual(getScriptingOperations(), ['register', 'update', 'unregister'])
		assert.deepEqual(getUnregisteredContentScriptIdBatches(), [['obsolete-inpage']])
	})

	test('registers the shared host before the provider only on selected origins', async () => {
		for (const enabled of [false, true]) {
			const { getRegisteredContentScripts } = installBrowserMock({ safeAppsCompatibilityMode: enabled, safeAppsHostOrigins: ['https://app.example.com', 'http://localhost:3000'] })
			const { updateRegistration } = await loadModules()
			await updateRegistration()
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

	test('host origin changes update the host overlay without updating the isolated base provider', async () => {
		const updatedScriptIds: string[][] = []
		installBrowserMock({
			safeAppsCompatibilityMode: true,
			safeAppsHostOrigins: ['https://first.example'],
			beforeUpdateContentScripts: async (scripts) => { updatedScriptIds.push(scripts.map(({ id }) => id)) },
		})
		const { updateRegistration } = await loadModules()
		await updateRegistration()
		const priorUpdates = updatedScriptIds.length
		await browser.storage.local.set({ safeAppsHostOrigins: ['https://second.example'] })
		await updateRegistration()
		assert.deepEqual(updatedScriptIds.slice(priorUpdates), [['safe-apps-host'], ['inpage']])
	})

	test('does not host Request Finance or any other site when compatibility is enabled without explicit origins', async () => {
		const { getRegisteredContentScripts } = installBrowserMock({ safeAppsCompatibilityMode: true })
		const { updateRegistration } = await loadModules()
		await updateRegistration()
		assert.deepEqual(getRegisteredContentScripts().map(({ id }) => id).sort(), ['inpage', 'inpage2'])
		assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'inpage')?.excludeMatches, [])
	})

	test('removes hosting on opt-out while retaining the normal provider', async () => {
		const { getRegisteredContentScripts } = installBrowserMock({ safeAppsCompatibilityMode: true, safeAppsHostOrigins: ['https://app.request.finance'] })
		const { updateRegistration } = await loadModules()
		await updateRegistration()
		assert.equal(getRegisteredContentScripts().some(({ id }) => id === 'safe-apps-host'), true)
		await browser.storage.local.set({ safeAppsHostOrigins: [] })
		await updateRegistration()
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
		const { updateRegistration } = await loadModules()
		const earlierUpdate = updateRegistration()
		await firstUpdateStarted
		await browser.storage.local.set({ safeAppsCompatibilityMode: true })
		const latestUpdate = updateRegistration()
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
		const { updateRegistration } = await loadModules()

		await assert.rejects(updateRegistration(), /update failed/)

		assert.deepEqual(getScriptingOperations(), ['update'])
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


test('explicit hosting retries coalesce the observed recovery and can retry again without changing settings', async () => {
	const origin = 'https://coalesced-retry.example'
	let hostAttempts = 0
	installBrowserMock({ safeAppsCompatibilityMode: true, safeAppsHostOrigins: [origin], beforeRegisterContentScripts: async (scripts) => {
		if (!scripts.some(({ id }) => id === 'safe-apps-host')) return
		hostAttempts++
		if (hostAttempts <= 2) throw new Error('Transient hosting failure')
	} })
	const { createContentScriptRegistrationService } = await loadModules()
	const service = createContentScriptRegistrationService()
	await withSilencedConsole(async () => {
		await service.update()
		assert.equal(hostAttempts, 1)
		assert.deepEqual(await Promise.all([service.ensureSafeAppsHostRegistered(origin), service.ensureSafeAppsHostRegistered(origin)]), [false, false])
		assert.equal(hostAttempts, 2)
		assert.equal(await service.ensureSafeAppsHostRegistered(origin), true)
		assert.equal(hostAttempts, 3)
	})
})

test('explicit hosting preparation repairs registrations removed after a cached successful update', async () => {
	const origin = 'https://restored.example'
	const { getRegisteredContentScripts, normalizeRegisteredContentScripts, removeRegisteredContentScript, changeRegisteredContentScriptWorld, getScriptingOperations } = installBrowserMock({ safeAppsCompatibilityMode: true, safeAppsHostOrigins: [origin] })
	const { createContentScriptRegistrationService } = await loadModules()
	const service = createContentScriptRegistrationService()
	assert.equal(await service.update(), 'configuration-applied')
	normalizeRegisteredContentScripts()
	const operationsBeforeCheck = getScriptingOperations()
	assert.equal(await service.ensureSafeAppsHostRegistered(origin), true)
	assert.deepEqual(getScriptingOperations(), operationsBeforeCheck)
	for (const id of ['safe-apps-host', 'inpage', 'inpage2']) {
		removeRegisteredContentScript(id)
		assert.equal(await service.ensureSafeAppsHostRegistered(origin), true)
		assert.deepEqual(getRegisteredContentScripts().map(({ id }) => id).sort(), ['inpage', 'inpage2', 'safe-apps-host'])
	}
	for (const [id, driftedWorld, expectedWorld] of [['inpage2', 'MAIN', 'ISOLATED'], ['inpage', 'ISOLATED', 'MAIN'], ['safe-apps-host', 'ISOLATED', 'MAIN']] as const) {
		changeRegisteredContentScriptWorld(id, driftedWorld)
		assert.equal(await service.ensureSafeAppsHostRegistered(origin), true)
		assert.equal(getRegisteredContentScripts().find((script) => script.id === id)?.world, expectedWorld)
	}
})

test('explicit registration update returns its hosting outcome and retries a cached failure', async () => {
	let hostAttempts = 0
	installBrowserMock({ safeAppsCompatibilityMode: true, safeAppsHostOrigins: ['https://retry.example'], beforeRegisterContentScripts: async (scripts) => {
		if (!scripts.some(({ id }) => id === 'safe-apps-host')) return
		hostAttempts++
		if (hostAttempts === 1) throw new Error('Transient host failure')
	} })
	const { createContentScriptRegistrationService } = await loadModules()
	const service = createContentScriptRegistrationService()
	await withSilencedConsole(async () => {
		assert.equal(await service.update(), 'hosting-failed')
		assert.equal(await service.update(), 'configuration-applied')
	})
	assert.equal(hostAttempts, 2)
	assert.equal(await service.ensureSafeAppsHostRegistered('https://retry.example'), true)
})


test('registration applies the same single snapshot it caches, then observes a subsequent configuration', async () => {
	let reads = 0
	const { getRegisteredContentScripts } = installBrowserMock({ safeAppsCompatibilityMode: true, safeAppsHostOrigins: ['https://before.example'], afterStorageRead: async (keys) => {
		if (!Array.isArray(keys) || !keys.includes('safeAppsHostOrigins')) return
		reads++
		if (reads === 1) await browser.storage.local.set({ safeAppsHostOrigins: ['https://after.example'] })
	} })
	const { updateRegistration } = await loadModules()
	await updateRegistration()
	assert.equal(reads, 1)
	assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'safe-apps-host')?.matches, ['https://before.example:443/*'])
	await updateRegistration()
	assert.equal(reads, 2)
	assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'safe-apps-host')?.matches, ['https://after.example:443/*'])
})

test('stored hosting origins with a Chrome-encoded wildcard keep their valid origins in settings and registration', async () => {
	const { getRegisteredContentScripts, sentMessages } = installBrowserMock({ safeAppsCompatibilityMode: true, safeAppsHostOrigins: ['https://swap.cow.fi', 'https://%2A.cow.fi'] })
	await browser.storage.local.set({ metamaskCompatibilityMode: true, useTabsInsteadOfPopup: false })
	const { updateRegistration } = await loadModules()
	await updateRegistration()
	assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'safe-apps-host')?.matches, ['https://swap.cow.fi:443/*'])
	const { getSafeAppsHostOrigins, getMetamaskCompatibilityMode, getUseTabsInsteadOfPopup, getSafeAppsCompatibilityMode } = await import('../../app/ts/background/settings.js')
	assert.deepEqual(await getSafeAppsHostOrigins(), ['https://swap.cow.fi'])
	assert.deepEqual((await browser.storage.local.get('safeAppsHostOrigins')).safeAppsHostOrigins, ['https://swap.cow.fi', 'https://%2A.cow.fi'])
	assert.equal(await getSafeAppsCompatibilityMode(), true)
	assert.equal(await getMetamaskCompatibilityMode(), true)
	assert.equal(await getUseTabsInsteadOfPopup(), false)
	await updateRegistration()
	assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'safe-apps-host')?.matches, ['https://swap.cow.fi:443/*'])
	assert.deepEqual(sentMessages, [])
})

test('reading recovered hosting origins never overwrites a newer replacement or removal', async () => {
	for (const newerSelection of [['https://new.example'], []]) {
		let writeNewerSelectionDuringRead = true
		const { getRegisteredContentScripts } = installBrowserMock({ safeAppsCompatibilityMode: true, safeAppsHostOrigins: ['https://swap.cow.fi', 'https://%2A.cow.fi'], afterStorageRead: async (keys) => {
			if (keys !== 'safeAppsHostOrigins' || !writeNewerSelectionDuringRead) return
			writeNewerSelectionDuringRead = false
			await setSafeAppsHostOrigins(newerSelection)
		} })
		const { updateRegistration } = await loadModules()
		const { getSafeAppsHostOrigins, setSafeAppsHostOrigins } = await import('../../app/ts/background/settings.js')
		// The read snapshot was taken before the newer write landed, so it still reports the recovered older selection.
		assert.deepEqual(await getSafeAppsHostOrigins(), ['https://swap.cow.fi'])
		assert.deepEqual((await browser.storage.local.get('safeAppsHostOrigins')).safeAppsHostOrigins, newerSelection)
		assert.deepEqual(await getSafeAppsHostOrigins(), newerSelection)
		await updateRegistration()
		assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'safe-apps-host')?.matches, newerSelection.length === 0 ? undefined : ['https://new.example:443/*'])
	}
})

test('disabled compatibility leaves malformed hosting selections inert without reporting a recovery', async () => {
	const { getRegisteredContentScripts, getScriptingOperations, sentMessages } = installBrowserMock({ safeAppsCompatibilityMode: false, safeAppsHostOrigins: ['not-an-origin'] })
	const { updateRegistration } = await loadModules()
	await updateRegistration()
	const initialOperations = getScriptingOperations()
	await browser.storage.local.set({ safeAppsHostOrigins: ['still-not-an-origin'] })
	await updateRegistration()
	assert.deepEqual(getScriptingOperations(), initialOperations)
	assert.deepEqual(getRegisteredContentScripts().map(({ id }) => id).sort(), ['inpage', 'inpage2'])
	assert.deepEqual(sentMessages, [])
})

describe('Safe Apps host registration reconcile entry point', () => {
	const origin = 'https://hosted.example'
	const hostMatch = 'https://hosted.example:443/*'
	const hosted = { safeAppsCompatibilityMode: true, safeAppsHostOrigins: [origin] }
	const optedOut = { safeAppsCompatibilityMode: true, safeAppsHostOrigins: [] }
	const baseScripts: [FixedContentScript, FixedContentScript] = [
		{ id: 'inpage2', allFrames: true, matches: ['<all_urls>'], excludeMatches: [], js: ['/listener.js'], runAt: 'document_start', world: 'ISOLATED', matchOriginAsFallback: true },
		{ id: 'inpage', allFrames: true, matches: ['<all_urls>'], excludeMatches: [], js: ['/inpage.js'], runAt: 'document_start', world: 'MAIN', matchOriginAsFallback: true },
	]
	const changed = { baseScripts, configurationUnchanged: false, failedAttemptToRetry: undefined }
	const loadHostRegistration = async () => (await import('../../app/ts/background/safeAppsHostRegistration.js')).createSafeAppsHostRegistration()

	test('a requested base reconcile receives the planned host overlay and replaces the separate provider restore', async () => {
		for (const reconcileBaseOnOptOut of [true, false]) {
			const updatedScripts: RegisteredContentScript[][] = []
			const { getScriptingOperations, getRegisteredContentScripts } = installBrowserMock({ registeredContentScriptIds: ['inpage', 'inpage2'], beforeUpdateContentScripts: async (scripts) => { updatedScripts.push([...scripts]) } })
			const registration = await loadHostRegistration()
			const baseOverlays: (readonly string[] | undefined)[] = []
			const reconcileBase = async (hostScript: FixedContentScript | undefined) => { baseOverlays.push(hostScript?.matches) }
			assert.equal(await registration.reconcile({ ...changed, storedItems: hosted, reconcileBase }), 'configuration-applied')
			assert.deepEqual(baseOverlays, [[hostMatch]])
			assert.equal(registration.hasOrigin(origin), true)
			assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'inpage')?.excludeMatches, [hostMatch])
			const operationsBeforeOptOut = getScriptingOperations().length
			const updatesBeforeOptOut = updatedScripts.length
			assert.equal(await registration.reconcile({ ...changed, storedItems: optedOut, reconcileBase: reconcileBaseOnOptOut ? reconcileBase : undefined }), 'configuration-applied')
			assert.equal(registration.hasOrigin(origin), false)
			assert.equal(getRegisteredContentScripts().some(({ id }) => id === 'safe-apps-host'), false)
			// A base reconcile already rewrote the provider, so only the unreconciled path restores it explicitly.
			assert.deepEqual(baseOverlays, reconcileBaseOnOptOut ? [[hostMatch], undefined] : [[hostMatch]])
			assert.deepEqual(getScriptingOperations().slice(operationsBeforeOptOut), reconcileBaseOnOptOut ? ['unregister'] : ['unregister', 'update'])
			assert.deepEqual(updatedScripts.slice(updatesBeforeOptOut).map((scripts) => scripts.map(({ id, excludeMatches }) => ({ id, excludeMatches }))), reconcileBaseOnOptOut ? [] : [[{ id: 'inpage', excludeMatches: [] }]])
		}
	})

	test('an unchanged configuration is skipped unless the caller retries the failure it observed', async () => {
		let hostAttempts = 0
		const { getScriptingOperations } = installBrowserMock({ registeredContentScriptIds: ['inpage', 'inpage2'], beforeRegisterContentScripts: async (scripts) => {
			if (!scripts.some(({ id }) => id === 'safe-apps-host')) return
			hostAttempts++
			if (hostAttempts === 1) throw new Error('Transient host failure')
		} })
		const registration = await loadHostRegistration()
		await withSilencedConsole(async () => {
			assert.equal(registration.observedFailure(), undefined)
			assert.equal(await registration.reconcile({ ...changed, storedItems: hosted, reconcileBase: undefined }), 'hosting-failed')
			const observedFailure = registration.observedFailure()
			assert.notEqual(observedFailure, undefined)
			const operationsAfterFailure = getScriptingOperations()
			assert.equal(await registration.reconcile({ ...changed, storedItems: hosted, reconcileBase: undefined, configurationUnchanged: true }), 'hosting-failed')
			assert.deepEqual(getScriptingOperations(), operationsAfterFailure)
			assert.equal(await registration.reconcile({ ...changed, storedItems: hosted, reconcileBase: undefined, configurationUnchanged: true, failedAttemptToRetry: observedFailure }), 'configuration-applied')
			assert.equal(hostAttempts, 2)
			assert.equal(registration.observedFailure(), undefined)
			assert.equal(registration.hasOrigin(origin), true)
		})
	})

	test('a failed host install rolls the provider back, and a failed rollback or base reconcile forgets applied hosting', async () => {
		let failHost = false
		let failProviderRestore = false
		const { getRegisteredContentScripts } = installBrowserMock({
			registeredContentScriptIds: ['inpage', 'inpage2'],
			beforeRegisterContentScripts: async (scripts) => { if (failHost && scripts.some(({ id }) => id === 'safe-apps-host')) throw new Error('host failed') },
			beforeUpdateContentScripts: async (scripts) => {
				if (failHost && scripts.some(({ id }) => id === 'safe-apps-host')) throw new Error('host failed')
				if (failProviderRestore && scripts.some(({ id, excludeMatches }) => id === 'inpage' && excludeMatches?.length === 0)) throw new Error('rollback failed')
			},
		})
		const registration = await loadHostRegistration()
		failHost = true
		await withSilencedConsole(async () => { assert.equal(await registration.reconcile({ ...changed, storedItems: hosted, reconcileBase: undefined }), 'hosting-failed') })
		assert.equal(getRegisteredContentScripts().some(({ id }) => id === 'safe-apps-host'), false)
		assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'inpage')?.excludeMatches, [])
		assert.equal(registration.hasOrigin(origin), false)

		failHost = false
		assert.equal(await registration.reconcile({ ...changed, storedItems: hosted, reconcileBase: undefined }), 'configuration-applied')
		assert.equal(registration.hasOrigin(origin), true)
		failHost = true
		failProviderRestore = true
		await assert.rejects(registration.reconcile({ ...changed, storedItems: hosted, reconcileBase: undefined }), { name: 'AggregateError', message: 'Safe Apps host registration and provider rollback failed.' })
		assert.equal(registration.hasOrigin(origin), false)
		assert.equal(await registration.hasAppliedRegistrations(), false)

		failHost = false
		failProviderRestore = false
		assert.equal(await registration.reconcile({ ...changed, storedItems: hosted, reconcileBase: undefined }), 'configuration-applied')
		assert.equal(registration.hasOrigin(origin), true)
		await assert.rejects(registration.reconcile({ ...changed, storedItems: hosted, reconcileBase: async () => { throw new Error('base reconcile failed') } }), /base reconcile failed/)
		assert.equal(registration.hasOrigin(origin), false)
	})
})
