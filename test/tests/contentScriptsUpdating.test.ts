import * as assert from 'assert'
import * as fs from 'node:fs'
import { describe, test } from 'bun:test'
import { withSilencedConsole } from './consoleSilence.js'

type RuntimeMessage = {
	readonly method?: string
	readonly data?: { readonly message?: string, readonly code?: string }
}

type BrowserMockOptions = {
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
	readonly excludeMatches?: readonly string[]
}

function installBrowserMock({ registerError, updateError, executeScriptError, tabUrl = 'https://example.com/', hasVisibleTabUrl = true, tabUrlAfterStorageRead, registeredContentScriptIds = [] }: BrowserMockOptions = {}) {
	const storageState: Record<string, unknown> = {}
	const sentMessages: RuntimeMessage[] = []
	const executedScriptFiles: string[] = []
	const registeredContentScripts = new Map(registeredContentScriptIds.map((id) => [id, { id }]))
	let executeScriptCalls = 0
	const scriptingOperations: string[] = []
	const firefoxRegistrations: browser.contentScripts.RegisteredContentScriptOptions[] = []
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
				getManifest: () => ({ manifest_version: 3 }),
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
			contentScripts: {
				async register(options: browser.contentScripts.RegisteredContentScriptOptions) {
					scriptingOperations.push('register-firefox')
					if (registerError !== undefined) throw registerError
					firefoxRegistrations.push(options)
					return { async unregister() { scriptingOperations.push('unregister-firefox') } }
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
		firefoxRegistrations,
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

async function loadModules() {
	return {
		...await import('../../app/ts/utils/contentScriptsUpdating.js'),
		...await import('../../app/ts/background/storageVariables.js'),
		...await import('../../app/ts/background/settings.js'),
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
		const { getContentScriptExcludeMatches } = await loadModules()

		assert.deepEqual(getContentScriptExcludeMatches([
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

	test('registers Firefox scripts before navigation and replaces exclusions without an injection gap', async () => {
		const { firefoxRegistrations, getScriptingOperations, getExecutedScriptFiles } = installBrowserMock()
		const { updateContentScriptInjectionStrategyManifestV2, updateWebsiteAccess } = await loadModules()
		await updateContentScriptInjectionStrategyManifestV2()
		assert.equal(firefoxRegistrations[0]?.runAt, 'document_start')
		assert.equal(firefoxRegistrations[0]?.allFrames, true)
		assert.deepEqual(firefoxRegistrations[0]?.js?.map((script) => script.file), [
			'/vendor/webextension-polyfill/dist/browser-polyfill.js', '/inpage/js/listenContentScript.js', '/inpage/js/document_start.js',
		])
		await updateWebsiteAccess(() => [{ website: { websiteOrigin: 'example.com' }, interceptorDisabled: true }, { website: { websiteOrigin: 'localhost:3000' }, interceptorDisabled: true }])
		await updateContentScriptInjectionStrategyManifestV2()
		assert.deepEqual(firefoxRegistrations[1]?.excludeGlobs, ['*://example.com/*', '*://*.example.com/*', 'http://localhost:3000/*', 'https://localhost:3000/*'])
		assert.deepEqual(getScriptingOperations().slice(-2), ['register-firefox', 'unregister-firefox'])
		assert.deepEqual(getExecutedScriptFiles(), [], 'Firefox must never fall back to late executeScript injection')
		assert.deepEqual(getManifestV2WebAccessibleResources(), [
			'vendor/webextension-polyfill/dist/browser-polyfill.js', 'inpage/js/listenContentScript.js', 'inpage/js/document_start.js', 'inpage/js/inpage.js',
		])
	})

	test('reports Firefox registration failure, preserves the previous registration, and permits retry', async () => {
		const { getScriptingOperations, sentMessages } = installBrowserMock()
		const { updateContentScriptInjectionStrategyManifestV2, getLatestUnexpectedError } = await loadModules()
		await updateContentScriptInjectionStrategyManifestV2()
		const register = browser.contentScripts.register
		browser.contentScripts.register = async () => { throw new Error('Firefox registration failed') }
		await withSilencedConsole(async () => await updateContentScriptInjectionStrategyManifestV2())
		assert.deepEqual(getScriptingOperations(), ['register-firefox'])
		const error = await getLatestUnexpectedError()
		assert.equal(error?.data.message, 'Firefox registration failed')
		assert.equal(error?.data.code, 'content_script_registration_failed')
		assert.equal(sentMessages.at(-1)?.method, 'popup_UnexpectedErrorOccured')
		browser.contentScripts.register = register
		await updateContentScriptInjectionStrategyManifestV2()
		assert.deepEqual(getScriptingOperations().slice(-2), ['register-firefox', 'unregister-firefox'])
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

})
