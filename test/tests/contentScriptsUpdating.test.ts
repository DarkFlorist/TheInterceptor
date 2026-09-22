import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { withSilencedConsole } from './consoleSilence.js'

type RegisteredScript = { readonly id: string, readonly excludeMatches?: readonly string[] }
type FirefoxScript = Parameters<typeof browser.contentScripts.register>[0]

function installBrowserMock(options: { registerError?: Error, updateError?: Error, registeredContentScriptIds?: readonly string[] } = {}) {
	const storageState: Record<string, unknown> = {}
	const sentMessages: { method?: string }[] = []
	const registeredContentScripts = new Map<string, RegisteredScript>((options.registeredContentScriptIds ?? []).map((id) => [id, { id }]))
	const scriptingOperations: string[] = []
	const unregisteredContentScriptIdBatches: string[][] = []
	const firefoxScripts: FirefoxScript[] = []
	let firefoxUnregisterCalls = 0
	Object.defineProperty(globalThis, 'browser', { configurable: true, writable: true, value: {
		runtime: {
			lastError: undefined,
			sendMessage: async (message: { method?: string }) => { sentMessages.push(message) },
			getManifest: () => ({ manifest_version: 3 }),
			onMessage: { addListener: () => undefined, removeListener: () => undefined },
			onConnect: { addListener: () => undefined, removeListener: () => undefined },
		},
		storage: { local: {
			async get(keys?: string | string[] | Record<string, unknown>) {
				if (keys === undefined) return { ...storageState }
				if (typeof keys === 'string') return { [keys]: storageState[keys] }
				if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, storageState[key]]))
				return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, storageState[key] ?? fallback]))
			},
			async set(items: Record<string, unknown>) { Object.assign(storageState, items) },
			async remove(keys: string | string[]) { for (const key of Array.isArray(keys) ? keys : [keys]) delete storageState[key] },
		} },
		scripting: {
			async getRegisteredContentScripts() { return [...registeredContentScripts.values()] },
			async registerContentScripts(scripts: readonly RegisteredScript[]) {
				scriptingOperations.push('register')
				if (options.registerError !== undefined) throw options.registerError
				for (const script of scripts) registeredContentScripts.set(script.id, script)
			},
			async updateContentScripts(scripts: readonly RegisteredScript[]) {
				scriptingOperations.push('update')
				if (options.updateError !== undefined) throw options.updateError
				for (const script of scripts) registeredContentScripts.set(script.id, script)
			},
			async unregisterContentScripts(filter: { ids: string[] }) {
				scriptingOperations.push('unregister')
				unregisteredContentScriptIdBatches.push(filter.ids)
				for (const id of filter.ids) registeredContentScripts.delete(id)
			},
		},
		contentScripts: { async register(script: FirefoxScript) {
			if (script.excludeMatches?.length === 0) throw new Error('Firefox rejects empty exclusion lists')
			if (script.excludeGlobs?.length === 0) throw new Error('Firefox rejects empty glob lists')
			if (options.registerError !== undefined) throw options.registerError
			firefoxScripts.push(script)
			return { async unregister() { firefoxUnregisterCalls += 1 } }
		} },
	} })
	return {
		storageState, sentMessages, firefoxScripts,
		getFirefoxUnregisterCalls: () => firefoxUnregisterCalls,
		getRegisteredContentScripts: () => [...registeredContentScripts.values()],
		getScriptingOperations: () => scriptingOperations,
		getUnregisteredContentScriptIdBatches: () => unregisteredContentScriptIdBatches,
	}
}

async function loadModules() {
	return {
		...await import('../../app/ts/utils/contentScriptsUpdating.js'),
		...await import('../../app/ts/background/storageVariables.js'),
	}
}

describe('content script injection strategy', () => {
	test('scopes exclusions to explicit schemes and hosts without inheriting legacy grants', async () => {
		installBrowserMock()
		const { getManifestV3ExcludeMatches } = await loadModules()
		assert.deepEqual(getManifestV3ExcludeMatches([
			'', 'example.com', 'localhost:3000', 'https://secure.example', 'http://localhost:3000',
			'https://[::1]:8545', 'https://invalid.example/path', 'https://secure.example', 'file:///tmp/a.html',
			'http://localhost', 'https://[::1]',
		]), ['https://secure.example:443/*', 'http://localhost:3000/*', 'https://[::1]:8545/*', 'file:///tmp/a.html', 'http://localhost:80/*', 'https://[::1]:443/*'])
	})

	test('uses exact URL globs for Firefox default ports, custom ports, schemes and IPv6 hosts', async () => {
		installBrowserMock()
		const { getManifestV2ExcludeGlobs } = await loadModules()
		assert.deepEqual(getManifestV2ExcludeGlobs([
			'http://example.test', 'https://example.test', 'https://example.test:8443',
			'http://[::1]', 'http://[::1]:3000', 'example.test', 'https://example.test', 'file:///tmp/a.html',
		]), ['http://example.test/*', 'https://example.test/*', 'https://example.test:8443/*', 'http://[::1]/*', 'http://[::1]:3000/*', 'file:///tmp/a.html'])
	})

	test('registers the Firefox bridge at document start before injecting the provider', async () => {
		const { firefoxScripts, storageState, getFirefoxUnregisterCalls } = installBrowserMock()
		const { updateContentScriptInjectionStrategyManifestV2 } = await loadModules()
		await updateContentScriptInjectionStrategyManifestV2()
		assert.deepEqual(firefoxScripts[0], {
			matches: ['file://*/*', 'http://*/*', 'https://*/*'], allFrames: true, runAt: 'document_start',
			js: [{ file: '/vendor/webextension-polyfill/dist/browser-polyfill.js' }, { file: '/inpage/js/listenContentScript.js' }, { file: '/inpage/js/document_start.js' }],
		})
		storageState.websiteAccess = [{ website: { websiteOrigin: 'https://disabled.example' }, interceptorDisabled: true }]
		await updateContentScriptInjectionStrategyManifestV2()
		assert.equal(firefoxScripts[1]?.excludeMatches, undefined)
		assert.deepEqual(firefoxScripts[1]?.excludeGlobs, ['https://disabled.example/*'])
		assert.equal(getFirefoxUnregisterCalls(), 1)
	})

	test('reports Firefox registration failures without removing existing protection', async () => {
		const previous = installBrowserMock()
		const { updateContentScriptInjectionStrategyManifestV2, getLatestUnexpectedError } = await loadModules()
		await updateContentScriptInjectionStrategyManifestV2()
		installBrowserMock({ registerError: new Error('Firefox registration failed') })
		await withSilencedConsole(async () => await updateContentScriptInjectionStrategyManifestV2())
		assert.equal(previous.getFirefoxUnregisterCalls(), 0)
		assert.equal((await getLatestUnexpectedError())?.data.code, 'content_script_registration_failed')
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
