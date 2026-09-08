import * as assert from 'assert'
import * as fs from 'node:fs'
import { describe, test } from 'bun:test'
import { withSilencedConsole } from './consoleSilence.js'
import { getManifestV2IsolatedWorldInjections, getPageWorldScriptPaths } from '../../app/ts/config/contentScriptInjectionArtifacts.js'

type RuntimeMessage = {
	readonly method?: string
	readonly data?: { readonly message?: string, readonly code?: string }
}

type BrowserMockOptions = {
	readonly metamaskCompatibilityMode?: boolean
	readonly manifestVersion?: 2 | 3
	readonly registerError?: Error
	readonly updateError?: Error
	readonly executeScriptError?: Error
	readonly tabUrl?: string
	readonly hasVisibleTabUrl?: boolean
	readonly tabUrlAfterStorageRead?: string
	readonly registeredContentScriptIds?: readonly string[]
}

type RegisteredContentScript = {
	readonly id: string
	readonly js?: readonly string[]
	readonly excludeMatches?: readonly string[]
}

function installBrowserMock({ metamaskCompatibilityMode, manifestVersion = 3, registerError, updateError, executeScriptError, tabUrl = 'https://example.com/', hasVisibleTabUrl = true, tabUrlAfterStorageRead, registeredContentScriptIds = [] }: BrowserMockOptions = {}) {
	const storageState: Record<string, unknown> = {
		...(metamaskCompatibilityMode === undefined ? {} : { metamaskCompatibilityMode }),
	}
	const sentMessages: RuntimeMessage[] = []
	const executedScriptFiles: string[] = []
	const executedScriptCode: string[] = []
	const reloadedTabs: number[] = []
	const registeredContentScripts = new Map(registeredContentScriptIds.map((id) => [id, { id }]))
	let executeScriptCalls = 0
	const scriptingOperations: string[] = []
	const unregisteredContentScriptIdBatches: string[][] = []
	let currentTabUrl = tabUrl
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
						const storageItems = getStorageItems(keys)
						currentTabUrl = tabUrlAfterStorageRead ?? currentTabUrl
						return storageItems
					},
					async set(items: Record<string, unknown>) { Object.assign(storageState, items) },
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
					for (const script of scripts) registeredContentScripts.set(script.id, script)
				},
				async updateContentScripts(scripts: readonly RegisteredContentScript[]) {
					scriptingOperations.push('update')
					if (updateError !== undefined) throw updateError
					for (const script of scripts) registeredContentScripts.set(script.id, script)
				},
			},
			tabs: {
				async query() { return [{ id: 42, url: currentTabUrl }] },
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
	return {
		...await import('../../app/ts/utils/contentScriptsUpdating.js'),
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

	test('compatibility setting changes refresh the current manifest strategy and reload connected tabs', async () => {
		for (const manifestVersion of [2, 3] as const) {
			const { getCommittedListener, getRegisteredContentScripts, getReloadedTabs } = installBrowserMock({ manifestVersion })
			const { setMetamaskCompatibilityMode } = await import('../../app/ts/background/metamaskCompatibilityMode.js')
			await setMetamaskCompatibilityMode(new Map([[42, { connections: {} }]]), true)

			assert.deepEqual(getReloadedTabs(), [42])
			if (manifestVersion === 2) assert.equal(typeof getCommittedListener(), 'function')
			else assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'inpage')?.js, ['/inpage/js/metamaskCompatibilityMode.js', '/inpage/js/inpage.js'])
		}
	})

	test('exposes every manifest v3 main-world script to Chromium', () => {
		const webAccessibleResources = getManifestV3WebAccessibleResources()
		for (const scriptPath of getPageWorldScriptPaths(true)) assert.equal(webAccessibleResources.includes(scriptPath), true)
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
		const configuredPageWorldScripts = getPageWorldScriptPaths(true)
		assert.deepEqual(getManifestV2WebAccessibleResources().sort(), [...new Set([...configuredInjectedFiles, ...configuredPageWorldScripts])].sort())
	})

	test('registers the main-world compatibility prelude only when MetaMask compatibility mode is active', async () => {
		for (const metamaskCompatibilityMode of [false, true]) {
			const { getRegisteredContentScripts } = installBrowserMock({ metamaskCompatibilityMode })
			const { updateContentScriptInjectionStrategyManifestV3 } = await loadModules()

			await updateContentScriptInjectionStrategyManifestV3()

			const mainWorldRegistration = getRegisteredContentScripts().find((registration) => registration.id === 'inpage')
			assert.deepEqual(mainWorldRegistration?.js, [
				...(metamaskCompatibilityMode ? ['/inpage/js/metamaskCompatibilityMode.js'] : []),
				'/inpage/js/inpage.js',
			])
		}
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

	test('records manifest v3 registration failures as unexpected errors', async () => {
		const { sentMessages } = installBrowserMock({ registerError: new Error('registration failed') })
		const { updateContentScriptInjectionStrategyManifestV3, getLatestUnexpectedError } = await loadModules()

		await withSilencedConsole(async () => await updateContentScriptInjectionStrategyManifestV3())

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

	test('keeps existing and obsolete manifest v3 content scripts registered when an update fails', async () => {
		const { getRegisteredContentScripts, getScriptingOperations, getUnregisteredContentScriptIdBatches } = installBrowserMock({
			registeredContentScriptIds: ['inpage', 'inpage2', 'obsolete-inpage'],
			updateError: new Error('update failed'),
		})
		const { updateContentScriptInjectionStrategyManifestV3 } = await loadModules()

		await withSilencedConsole(async () => await updateContentScriptInjectionStrategyManifestV3())

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
