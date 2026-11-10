import * as assert from 'assert'
import * as fs from 'node:fs'
import { describe, test } from 'bun:test'
import { withSilencedConsole } from './consoleSilence.js'

type RuntimeMessage = {
	readonly method?: string
	readonly data?: { readonly message?: string, readonly code?: string }
}

type BrowserMockOptions = {
	readonly manifestVersion?: 2 | 3
	readonly registerError?: Error
	readonly updateError?: Error
	readonly registeredContentScriptIds?: readonly string[]
	readonly websiteAccess?: readonly unknown[]
	readonly failingFirefoxRegistration?: number
}

type RegisteredContentScript = {
	readonly id: string
	readonly js?: readonly string[]
	readonly matches?: readonly string[]
	readonly excludeMatches?: readonly string[]
	readonly runAt?: string
	readonly world?: string
	readonly allFrames?: boolean
	readonly matchOriginAsFallback?: boolean
}

type FirefoxContentScriptOptions = {
	readonly js?: readonly { readonly file?: string }[]
	readonly matches: readonly string[]
	readonly excludeGlobs?: readonly string[]
	readonly runAt?: string
	readonly world?: string
	readonly allFrames?: boolean
	readonly matchOriginAsFallback?: boolean
}

function installBrowserMock({ manifestVersion = 3, registerError, updateError, registeredContentScriptIds = [], websiteAccess = [], failingFirefoxRegistration }: BrowserMockOptions = {}) {
	const storageState: Record<string, unknown> = { websiteAccess }
	const sentMessages: RuntimeMessage[] = []
	const registeredContentScripts = new Map<string, RegisteredContentScript>(registeredContentScriptIds.map((id) => [id, { id }]))
	const scriptingOperations: string[] = []
	const unregisteredContentScriptIdBatches: string[][] = []
	const activeFirefoxContentScripts = new Set<FirefoxContentScriptOptions>()
	const firefoxContentScriptOperations: string[] = []
	let firefoxContentScriptRegistrations = 0
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
					async get(keys?: string | string[] | Record<string, unknown> | null) { return getStorageItems(keys) },
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
			// Firefox's own content script API, which keeps a registration until it is unregistered or its background page unloads.
			...manifestVersion === 2 ? { contentScripts: {
				async register(options: FirefoxContentScriptOptions) {
					firefoxContentScriptRegistrations += 1
					const registration = firefoxContentScriptRegistrations
					firefoxContentScriptOperations.push(`register ${ registration }`)
					// A real registration takes a moment, which lets a concurrent update interleave unless updates are serialized.
					await new Promise((resolve) => setTimeout(resolve, 1))
					if (registration === failingFirefoxRegistration) throw new Error('contentScripts.register failed')
					activeFirefoxContentScripts.add(options)
					return {
						async unregister() {
							firefoxContentScriptOperations.push(`unregister ${ registration }`)
							activeFirefoxContentScripts.delete(options)
						},
					}
				},
			} } : {},
			tabs: {
				async query() { return [] },
				onUpdated: { addListener: () => undefined, removeListener: () => undefined },
				onRemoved: { addListener: () => undefined, removeListener: () => undefined },
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
		setWebsiteAccess(nextWebsiteAccess: readonly unknown[]) { storageState.websiteAccess = nextWebsiteAccess },
		getRegisteredContentScripts() { return [...registeredContentScripts.values()] },
		getScriptingOperations() { return [...scriptingOperations] },
		getUnregisteredContentScriptIdBatches() { return unregisteredContentScriptIdBatches.map((ids) => [...ids]) },
		getActiveFirefoxContentScripts() { return [...activeFirefoxContentScripts] },
		getFirefoxContentScriptOperations() { return [...firefoxContentScriptOperations] },
	}
}

function disabledWebsiteAccess(websiteOrigin: string) {
	return { website: { websiteOrigin, icon: undefined, title: undefined }, addressAccess: undefined, interceptorDisabled: true }
}

async function loadModules() {
	return {
		...await import('../../app/ts/utils/contentScriptsUpdating.js'),
		...await import('../../app/ts/background/storageVariables.js'),
	}
}

function readManifest(manifestPath: string) {
	const manifest: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
	if (typeof manifest !== 'object' || manifest === null) throw new Error(`${ manifestPath } must be an object`)
	return manifest
}

describe('content script injection strategy', () => {
	test('creates valid exclusions without admitting malformed stored origins', async () => {
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

	test('excludes a disabled site on its exact host and port, not on its subdomains or other ports', async () => {
		installBrowserMock()
		const { getContentScriptExcludeMatches } = await loadModules()

		// Each pattern names its port, because a pattern without one would match every port of the host, and its host has no *. prefix, which would match every subdomain.
		assert.deepEqual(getContentScriptExcludeMatches(['example.com']), ['http://example.com:80/*', 'https://example.com:443/*'])
		assert.deepEqual(getContentScriptExcludeMatches(['app.example.com:8080']), ['http://app.example.com:8080/*', 'https://app.example.com:8080/*'])
		// A URL never shows its scheme's default port, so these stored origins can only come from the other scheme's URL.
		assert.deepEqual(getContentScriptExcludeMatches(['example.com:80']), ['https://example.com:80/*'])
		assert.deepEqual(getContentScriptExcludeMatches(['example.com:443']), ['http://example.com:443/*'])
		assert.deepEqual(getContentScriptExcludeMatches(['http://plain.example', 'https://secure.example:8443']), ['http://plain.example:80/*', 'https://secure.example:8443/*'])
	})

	test('excludes exactly the URLs that getHostWithPort gives the disabled origin', async () => {
		installBrowserMock()
		const { getContentScriptExcludeMatches } = await loadModules()
		const { getHostWithPort } = await import('../../app/ts/utils/requests.js')
		// Chromium matches a pattern with a port against the URL's scheme, exact host and effective port.
		const isMatchedBy = (pattern: string, url: string) => {
			const { protocol, hostname, port } = new URL(url)
			const effectivePort = port === '' ? (protocol === 'https:' ? '443' : '80') : port
			return pattern === `${ protocol }//${ hostname }:${ effectivePort }/*`
		}
		const urls = ['http://example.com/', 'https://example.com/path', 'https://example.com:80/', 'http://example.com:443/', 'http://example.com:8080/', 'https://app.example.com/', 'http://[::1]:8545/']
		for (const disabledUrl of urls) {
			const excludeMatches = getContentScriptExcludeMatches([getHostWithPort(disabledUrl)])
			for (const url of urls) {
				assert.equal(excludeMatches.some((pattern) => isMatchedBy(pattern, url)), getHostWithPort(url) === getHostWithPort(disabledUrl), `${ url } with ${ disabledUrl } disabled`)
			}
		}
		// getHostWithPort never produces these, so no page has them as its origin.
		assert.deepEqual(getContentScriptExcludeMatches(['Example.com', 'example.com:']), [])
	})

	test('skips stored hosts with a * instead of turning them into wildcard or invalid patterns', async () => {
		installBrowserMock()
		const { getContentScriptExcludeMatches } = await loadModules()

		assert.deepEqual(getContentScriptExcludeMatches([
			'*.example.com',
			'https://*.secure.example',
			'foo*bar.example',
			'%2A.encoded.example',
			'example.com',
		]), ['http://example.com:80/*', 'https://example.com:443/*'])
	})

	test('records registration failures as unexpected errors', async () => {
		const { sentMessages } = installBrowserMock({ registerError: new Error('registration failed') })
		const { updateContentScriptInjectionStrategy, getLatestUnexpectedError } = await loadModules()

		await withSilencedConsole(async () => await updateContentScriptInjectionStrategy())

		const latestUnexpectedError = await getLatestUnexpectedError()
		assert.equal(latestUnexpectedError?.data.message, 'registration failed')
		assert.equal(latestUnexpectedError?.data.code, 'content_script_registration_failed')
		assert.equal(sentMessages.at(-1)?.method, 'popup_UnexpectedErrorOccured')
	})

	test('registers missing scripts, updates existing definitions, and then prunes obsolete registrations', async () => {
		const { getRegisteredContentScripts, getScriptingOperations, getUnregisteredContentScriptIdBatches } = installBrowserMock({ registeredContentScriptIds: ['inpage', 'obsolete-inpage'] })
		const { updateContentScriptInjectionStrategy } = await loadModules()

		await updateContentScriptInjectionStrategy()

		assert.deepEqual(getRegisteredContentScripts().map(({ id }) => id).sort(), ['inpage', 'inpage2'])
		assert.equal(getRegisteredContentScripts().every(({ excludeMatches }) => excludeMatches?.length === 0), true)
		assert.deepEqual(getScriptingOperations(), ['register', 'update', 'unregister'])
		assert.deepEqual(getUnregisteredContentScriptIdBatches(), [['obsolete-inpage']])
	})

	test('keeps existing and obsolete content scripts registered when an update fails', async () => {
		const { getRegisteredContentScripts, getScriptingOperations, getUnregisteredContentScriptIdBatches } = installBrowserMock({
			registeredContentScriptIds: ['inpage', 'inpage2', 'obsolete-inpage'],
			updateError: new Error('update failed'),
		})
		const { updateContentScriptInjectionStrategy } = await loadModules()

		await withSilencedConsole(async () => await updateContentScriptInjectionStrategy())

		assert.deepEqual(getScriptingOperations(), ['update'])
		assert.deepEqual(getUnregisteredContentScriptIdBatches(), [])
		assert.deepEqual(getRegisteredContentScripts().map(({ id }) => id).sort(), ['inpage', 'inpage2', 'obsolete-inpage'])
	})

	test('registers the Firefox provider in the MAIN world at document_start, as in Chrome', async () => {
		for (const manifestVersion of [2, 3] as const) {
			const { getRegisteredContentScripts, getActiveFirefoxContentScripts } = installBrowserMock({ manifestVersion })
			const { updateContentScriptInjectionStrategy } = await loadModules()

			await updateContentScriptInjectionStrategy()

			const registeredContentScripts = getRegisteredContentScripts()
			const provider = registeredContentScripts.find(({ id }) => id === 'inpage')
			const bridge = registeredContentScripts.find(({ id }) => id === 'inpage2')
			assert.deepEqual(provider?.js, ['/inpage/js/inpage.js'], `manifest v${ manifestVersion }`)
			assert.equal(provider?.world, 'MAIN', `manifest v${ manifestVersion }`)
			assert.equal(provider?.runAt, 'document_start', `manifest v${ manifestVersion }`)
			assert.deepEqual(bridge?.js, ['/vendor/webextension-polyfill/dist/browser-polyfill.js', '/inpage/js/listenContentScript.js', '/inpage/js/listenContentScriptBootstrap.js'], `manifest v${ manifestVersion }`)
			assert.equal(bridge?.world, 'ISOLATED', `manifest v${ manifestVersion }`)
			assert.equal(bridge?.runAt, 'document_start', `manifest v${ manifestVersion }`)
			assert.deepEqual(registeredContentScripts.map(({ excludeMatches }) => excludeMatches), [[], []], `manifest v${ manifestVersion }`)
			// Without a disabled site there is no host whose other origins need their own registration.
			assert.deepEqual(getActiveFirefoxContentScripts(), [], `manifest v${ manifestVersion }`)
		}
	})

	test('excludes a disabled origin in Firefox by its whole host and gives the other origins on that host exact-origin globs', async () => {
		installBrowserMock()
		const { getContentScriptExcludeMatches, getFirefoxContentScriptExclusions } = await loadModules()

		assert.deepEqual(getFirefoxContentScriptExclusions(getContentScriptExcludeMatches(['', 'example.com', 'localhost:3000', 'https://secure.example:8443', 'example.com:80', '[::1]:8545'])), {
			excludeMatches: ['file:///*', 'http://example.com/*', 'https://example.com/*', 'http://localhost/*', 'https://localhost/*', 'https://secure.example/*', 'http://[::1]/*', 'https://[::1]/*'],
			otherOriginMatches: ['http://example.com/*', 'https://example.com/*', 'http://localhost/*', 'https://localhost/*', 'https://secure.example/*', 'http://[::1]/*', 'https://[::1]/*'],
			otherOriginExcludeGlobs: [
				'http://example.com/*', 'http://*@example.com/*',
				'https://example.com/*', 'https://*@example.com/*',
				'http://localhost:3000/*', 'http://*@localhost:3000/*',
				'https://localhost:3000/*', 'https://*@localhost:3000/*',
				'https://secure.example:8443/*', 'https://*@secure.example:8443/*',
				'https://example.com:80/*', 'https://*@example.com:80/*',
				'http://[::1]:8545/*', 'http://*@[::1]:8545/*',
				'https://[::1]:8545/*', 'https://*@[::1]:8545/*',
			],
		})
		assert.deepEqual(getFirefoxContentScriptExclusions([]), { excludeMatches: [], otherOriginMatches: [], otherOriginExcludeGlobs: [] })
	})

	test('keeps exactly the disabled origin without the provider in Firefox, which ignores ports in match patterns', async () => {
		// Firefox matches a URL glob against the whole URL and a match pattern against the URL's scheme and host only.
		const globToRegExp = (glob: string) => new RegExp(`^${ glob.split('*').map((part) => part.replace(/[.?+^${}()|[\]\\/]/g, '\\$&')).join('.*') }$`)
		const isMatchedByFirefoxPattern = (pattern: string, url: string) => {
			const { protocol, hostname } = new URL(url)
			return pattern === `${ protocol }//${ hostname }/*`
		}
		installBrowserMock()
		const { getContentScriptExcludeMatches, getFirefoxContentScriptExclusions } = await loadModules()
		const { getHostWithPort } = await import('../../app/ts/utils/requests.js')
		const urls = ['http://localhost:3000/', 'http://localhost:8545/', 'http://localhost/', 'https://localhost:3000/', 'http://user@localhost:3000/', 'https://example.com/path', 'https://example.com:8443/', 'http://example.com/', 'https://app.example.com/']
		for (const disabledUrl of urls) {
			const { excludeMatches, otherOriginMatches, otherOriginExcludeGlobs } = getFirefoxContentScriptExclusions(getContentScriptExcludeMatches([getHostWithPort(disabledUrl)]))
			for (const url of urls) {
				const injectedByRegisteredScripts = !excludeMatches.some((pattern) => isMatchedByFirefoxPattern(pattern, url))
				const injectedForOtherOrigin = otherOriginMatches.some((pattern) => isMatchedByFirefoxPattern(pattern, url)) && !otherOriginExcludeGlobs.some((glob) => globToRegExp(glob).test(url))
				assert.equal(injectedByRegisteredScripts && injectedForOtherOrigin, false, `${ url } is injected twice with ${ disabledUrl } disabled`)
				assert.equal(injectedByRegisteredScripts || injectedForOtherOrigin, getHostWithPort(url) !== getHostWithPort(disabledUrl), `${ url } with ${ disabledUrl } disabled`)
			}
		}
	})

	test('registers the other origins of a disabled Firefox host until the site is enabled again', async () => {
		const { getRegisteredContentScripts, getActiveFirefoxContentScripts, setWebsiteAccess } = installBrowserMock({ manifestVersion: 2, websiteAccess: [disabledWebsiteAccess('localhost:3000')] })
		const { updateContentScriptInjectionStrategy } = await loadModules()

		await updateContentScriptInjectionStrategy()

		assert.deepEqual(getRegisteredContentScripts().map(({ excludeMatches }) => excludeMatches), [['http://localhost/*', 'https://localhost/*'], ['http://localhost/*', 'https://localhost/*']])
		const otherOriginContentScripts = getActiveFirefoxContentScripts()
		assert.deepEqual(otherOriginContentScripts.map(({ js, world, runAt, allFrames, matchOriginAsFallback }) => ({ js: js?.map(({ file }) => file), world, runAt, allFrames, matchOriginAsFallback })), [
			{ js: ['/vendor/webextension-polyfill/dist/browser-polyfill.js', '/inpage/js/listenContentScript.js', '/inpage/js/listenContentScriptBootstrap.js'], world: 'ISOLATED', runAt: 'document_start', allFrames: true, matchOriginAsFallback: true },
			{ js: ['/inpage/js/inpage.js'], world: 'MAIN', runAt: 'document_start', allFrames: true, matchOriginAsFallback: true },
		])
		for (const contentScript of otherOriginContentScripts) {
			assert.deepEqual(contentScript.matches, ['http://localhost/*', 'https://localhost/*'])
			assert.deepEqual(contentScript.excludeGlobs, ['http://localhost:3000/*', 'http://*@localhost:3000/*', 'https://localhost:3000/*', 'https://*@localhost:3000/*'])
		}

		setWebsiteAccess([])
		await updateContentScriptInjectionStrategy()

		assert.deepEqual(getRegisteredContentScripts().map(({ excludeMatches }) => excludeMatches), [[], []])
		assert.deepEqual(getActiveFirefoxContentScripts(), [])
	})

	test('serializes concurrent Firefox updates so a disabled host keeps one set of other-origin scripts', async () => {
		const { getActiveFirefoxContentScripts, getFirefoxContentScriptOperations } = installBrowserMock({ manifestVersion: 2, websiteAccess: [disabledWebsiteAccess('localhost:3000')] })
		const { updateContentScriptInjectionStrategy } = await loadModules()

		await Promise.all([updateContentScriptInjectionStrategy(), updateContentScriptInjectionStrategy()])

		assert.equal(getActiveFirefoxContentScripts().length, 2)
		assert.deepEqual(getFirefoxContentScriptOperations(), ['register 1', 'register 2', 'unregister 1', 'unregister 2', 'register 3', 'register 4'])
	})

	test('unregisters a Firefox other-origin script on the next update after registering its pair failed', async () => {
		const { getActiveFirefoxContentScripts, getFirefoxContentScriptOperations, setWebsiteAccess } = installBrowserMock({ manifestVersion: 2, websiteAccess: [disabledWebsiteAccess('localhost:3000')], failingFirefoxRegistration: 2 })
		const { updateContentScriptInjectionStrategy, getLatestUnexpectedError } = await loadModules()

		await withSilencedConsole(async () => await updateContentScriptInjectionStrategy())

		assert.equal((await getLatestUnexpectedError())?.data.code, 'content_script_registration_failed')
		assert.equal(getActiveFirefoxContentScripts().length, 1)
		setWebsiteAccess([])
		await updateContentScriptInjectionStrategy()

		assert.deepEqual(getActiveFirefoxContentScripts(), [])
		assert.deepEqual(getFirefoxContentScriptOperations(), ['register 1', 'register 2', 'unregister 1'])
	})

	test('declares the Firefox permission and minimum version that MAIN-world registration needs', () => {
		const manifestV2 = readManifest('app/manifestV2.json')
		const manifestV3 = readManifest('app/manifestV3.json')
		const permissions = 'permissions' in manifestV2 && Array.isArray(manifestV2.permissions) ? manifestV2.permissions : []
		assert.equal(permissions.includes('scripting'), true)
		// The provider is no longer injected after a webNavigation event.
		assert.equal(permissions.includes('webNavigation'), false)
		const gecko = 'browser_specific_settings' in manifestV2 && typeof manifestV2.browser_specific_settings === 'object' && manifestV2.browser_specific_settings !== null && 'gecko' in manifestV2.browser_specific_settings ? manifestV2.browser_specific_settings.gecko : undefined
		// Firefox 128 added the MAIN world and matchOriginAsFallback to both scripting.registerContentScripts and contentScripts.register.
		assert.equal(typeof gecko === 'object' && gecko !== null && 'strict_min_version' in gecko ? gecko.strict_min_version : undefined, '128.0')
		const manifestV3Resources = 'web_accessible_resources' in manifestV3 && Array.isArray(manifestV3.web_accessible_resources) ? manifestV3.web_accessible_resources.flatMap((entry: unknown) => typeof entry === 'object' && entry !== null && 'resources' in entry && Array.isArray(entry.resources) ? entry.resources : []) : []
		assert.deepEqual('web_accessible_resources' in manifestV2 ? manifestV2.web_accessible_resources : undefined, manifestV3Resources)
	})
})
