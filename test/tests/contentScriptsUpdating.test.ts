import * as assert from 'assert'
import { describe, test } from 'bun:test'

type RegisteredScript = { readonly id: string, readonly excludeMatches?: readonly string[] }
type FirefoxScript = Parameters<typeof browser.contentScripts.register>[0]

function installBrowserMock(options: { registerError?: Error, updateError?: Error, unregisterFailures?: number, registeredContentScriptIds?: readonly string[], manifestVersion?: number } = {}) {
	const storageState: Record<string, unknown> = {}
	const sentMessages: { method?: string }[] = []
	const registeredContentScripts = new Map<string, RegisteredScript>((options.registeredContentScriptIds ?? []).map((id) => [id, { id }]))
	const scriptingOperations: string[] = []
	const unregisteredContentScriptIdBatches: string[][] = []
	const firefoxScripts: FirefoxScript[] = []
	const activeFirefoxScripts = new Set<FirefoxScript>()
	const firefoxOperations: string[] = []
	let firefoxUnregisterCalls = 0
	Object.defineProperty(globalThis, 'chrome', { configurable: true, writable: true, value: { runtime: { id: 'test-extension' } } })
	Object.defineProperty(globalThis, 'browser', { configurable: true, writable: true, value: {
		runtime: {
			id: 'test-extension',
			lastError: undefined,
			sendMessage: async (message: { method?: string }) => { sentMessages.push(message) },
			getManifest: () => ({ manifest_version: options.manifestVersion ?? 3 }),
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
		tabs: {
			query: async () => [],
			reload: async (tabId: number) => { firefoxOperations.push(`reload:${ tabId }`) },
		},
		windows: {},
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
			firefoxOperations.push('register')
			firefoxScripts.push(script)
			activeFirefoxScripts.add(script)
			return { async unregister() {
				firefoxUnregisterCalls += 1
				firefoxOperations.push('unregister')
				if ((options.unregisterFailures ?? 0) > 0) {
					options.unregisterFailures = (options.unregisterFailures ?? 0) - 1
					throw new Error('Temporary unregister failure')
				}
				activeFirefoxScripts.delete(script)
			} }
		} },
	} })
	return {
		storageState, sentMessages, firefoxScripts, firefoxOperations, activeFirefoxScripts,
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

	test('propagates Firefox registration failures without removing existing protection', async () => {
		const previous = installBrowserMock()
		const { updateContentScriptInjectionStrategyManifestV2 } = await loadModules()
		await updateContentScriptInjectionStrategyManifestV2()
		installBrowserMock({ registerError: new Error('Firefox registration failed') })
		await assert.rejects(updateContentScriptInjectionStrategyManifestV2(), /Firefox registration failed/)
		assert.equal(previous.getFirefoxUnregisterCalls(), 0)
	})

	test('Firefox website toggle refreshes exclusions before reloading on disable and re-enable', async () => {
		const { storageState, firefoxScripts, firefoxOperations } = installBrowserMock({ manifestVersion: 2 })
		const { updateContentScriptInjectionStrategyManifestV2 } = await loadModules()
		const { disableInterceptorForPage } = await import('../../app/ts/background/popupMessageHandlers/websiteAccess.js')
		const { saveCurrentTabId } = await import('../../app/ts/background/storageVariables.js')
		await saveCurrentTabId(7)
		await updateContentScriptInjectionStrategyManifestV2()
		firefoxOperations.length = 0
		const website = { websiteOrigin: 'https://toggle.example:8443', icon: undefined, title: undefined }
		await disableInterceptorForPage(new Map(), website, true)
		assert.deepEqual(firefoxScripts.at(-1)?.excludeGlobs, ['https://toggle.example:8443/*'])
		assert.deepEqual(firefoxOperations, ['register', 'unregister', 'reload:7'])
		assert.ok(JSON.stringify(storageState.websiteAccess).includes('"interceptorDisabled":true'))
		firefoxOperations.length = 0
		await disableInterceptorForPage(new Map(), website, false)
		assert.equal(firefoxScripts.at(-1)?.excludeGlobs, undefined)
		assert.deepEqual(firefoxOperations, ['register', 'unregister', 'reload:7'])
		assert.ok(JSON.stringify(storageState.websiteAccess).includes('"interceptorDisabled":false'))
	})

	for (const manifestVersion of [2, 3]) {
		test(`manifest v${ manifestVersion } reconciles replaced and removed disabled-site settings without refreshing for metadata changes`, async () => {
			const { firefoxScripts, getRegisteredContentScripts, getScriptingOperations } = installBrowserMock({ manifestVersion })
			const { updateWebsiteAccess } = await import('../../app/ts/background/settings.js')
			const website = { websiteOrigin: 'https://imported.example', icon: undefined, title: undefined }
			const entry = { website, addressAccess: [], interceptorDisabled: true }
			await updateWebsiteAccess(() => [entry])
			if (manifestVersion === 2) assert.deepEqual(firefoxScripts.at(-1)?.excludeGlobs, ['https://imported.example/*'])
			else assert.ok(getRegisteredContentScripts().every((script) => script.excludeMatches?.includes('https://imported.example:443/*')))
			const registrations = manifestVersion === 2 ? firefoxScripts.length : getScriptingOperations().length
			await updateWebsiteAccess(() => [{ ...entry, website: { ...website, title: 'New title' } }])
			assert.equal(manifestVersion === 2 ? firefoxScripts.length : getScriptingOperations().length, registrations)
			await updateWebsiteAccess(() => [])
			if (manifestVersion === 2) assert.equal(firefoxScripts.at(-1)?.excludeGlobs, undefined)
			else assert.ok(getRegisteredContentScripts().every((script) => script.excludeMatches?.length === 0))
		})
	}

	test('retries a failed exclusion refresh when the same website settings are requested again', async () => {
		const options: { manifestVersion: number, registerError?: Error } = { manifestVersion: 2, registerError: new Error('Temporary registration failure') }
		const { firefoxScripts } = installBrowserMock(options)
		const { updateWebsiteAccess } = await import('../../app/ts/background/settings.js')
		const website = { websiteOrigin: 'https://retry.example', icon: undefined, title: undefined }
		await assert.rejects(updateWebsiteAccess(() => [{ website, addressAccess: [], interceptorDisabled: true }]), /Temporary registration failure/)
		assert.equal(firefoxScripts.length, 0)
		options.registerError = undefined
		await updateWebsiteAccess((previous) => previous)
		assert.deepEqual(firefoxScripts.at(-1)?.excludeGlobs, ['https://retry.example/*'])
	})

	test('retries failed Firefox removal and leaves only the desired registration active', async () => {
		const options = { manifestVersion: 2, unregisterFailures: 0 }
		const { activeFirefoxScripts, firefoxOperations, getFirefoxUnregisterCalls } = installBrowserMock(options)
		const { updateContentScriptInjectionStrategyManifestV2 } = await loadModules()
		const { updateWebsiteAccess } = await import('../../app/ts/background/settings.js')
		await updateContentScriptInjectionStrategyManifestV2()
		options.unregisterFailures = 1
		const website = { websiteOrigin: 'https://cleanup.example', icon: undefined, title: undefined }
		await assert.rejects(updateWebsiteAccess(() => [{ website, addressAccess: [], interceptorDisabled: true }]), /Temporary unregister failure/)
		assert.equal(activeFirefoxScripts.size, 2)
		firefoxOperations.length = 0
		await updateWebsiteAccess((previous) => previous)
		assert.deepEqual(firefoxOperations, ['unregister', 'register', 'unregister'])
		assert.equal(getFirefoxUnregisterCalls(), 3)
		assert.equal(activeFirefoxScripts.size, 1)
		assert.deepEqual([...activeFirefoxScripts][0]?.excludeGlobs, ['https://cleanup.example/*'])
	})

	for (const manifestVersion of [2, 3]) {
		test(`manifest v${ manifestVersion } failed toggle does not reload or acknowledge success and can be retried`, async () => {
			const options: { manifestVersion: number, registerError?: Error } = { manifestVersion }
			const { firefoxOperations, sentMessages } = installBrowserMock(options)
			const { disableInterceptor, disableInterceptorForPage } = await import('../../app/ts/background/popupMessageHandlers/websiteAccess.js')
			const { saveCurrentTabId } = await import('../../app/ts/background/storageVariables.js')
			const { createEthereumWithGetBlockCounter } = await import('./backgroundEthAccountsTestHarness.js')
			const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
			await saveCurrentTabId(8)
			options.registerError = new Error('Temporary toggle registration failure')
			const website = { websiteOrigin: 'https://failed-toggle.example', icon: undefined, title: undefined }
			await assert.rejects(disableInterceptor(simulationServicesOwner, new Map(), {
				method: 'popup_setDisableInterceptor', data: { website, interceptorDisabled: true },
			}), /Temporary toggle registration failure/)
			assert.equal(firefoxOperations.some((operation) => operation.startsWith('reload:')), false)
			assert.equal(sentMessages.some(({ method }) => method === 'popup_setDisableInterceptorReply'), false)
			options.registerError = undefined
			await disableInterceptorForPage(new Map(), website, true)
			assert.equal(firefoxOperations.at(-1), 'reload:8')
			if (manifestVersion === 2) assert.ok(firefoxOperations.indexOf('register') < firefoxOperations.indexOf('reload:8'))
		})
	}

	test('propagates manifest v3 registration failures to the caller', async () => {
		installBrowserMock({ registerError: new Error('registration failed') })
		const { updateContentScriptInjectionStrategyManifestV3 } = await loadModules()
		await assert.rejects(updateContentScriptInjectionStrategyManifestV3(), /registration failed/)
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

		await assert.rejects(updateContentScriptInjectionStrategyManifestV3(), /update failed/)

		assert.deepEqual(getScriptingOperations(), ['update'])
		assert.deepEqual(getUnregisteredContentScriptIdBatches(), [])
		assert.deepEqual(getRegisteredContentScripts().map(({ id }) => id).sort(), ['inpage', 'inpage2', 'obsolete-inpage'])
	})

})
