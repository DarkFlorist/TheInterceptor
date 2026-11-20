import * as assert from 'assert'
import * as fs from 'node:fs'
import { describe, test } from 'bun:test'
import { withSilencedConsole } from './consoleSilence.js'
import { getPageWorldScriptPaths } from '../../app/ts/utils/contentScriptInjectionArtifacts.js'
import type { WebsiteAccessArray } from '../../app/ts/types/websiteAccessTypes.js'
import { contentScriptDocumentMarkers, type ContentScriptWorld } from '../../app/ts/utils/contentScriptDocumentMarkers.js'

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
	readonly registeredContentScriptIds?: readonly string[]
	readonly registeredContentScripts?: readonly RegisteredContentScript[]
	readonly websiteAccess?: WebsiteAccessArray
	readonly storageGetErrorAfterSet?: Error
	readonly settingsReadError?: Error
	readonly storageGetWaits?: readonly (Promise<void> | undefined)[]
	readonly onStorageGet?: () => void
	readonly tabsQueryError?: Error
	readonly failingFirefoxRegistration?: number
	// Registrations whose first unregister call fails, as Firefox can when the extension context is shutting down.
	readonly failingFirefoxUnregistrations?: readonly number[]
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

// The registrations that would run in a new document at one moment: the scripting registrations (one per world) and Firefox's disabled-host registrations.
type RegistrationSnapshot = {
	readonly registered: readonly { readonly world: string | undefined, readonly excludeMatches: readonly string[] }[]
	readonly disabledHostRegistrations: readonly FirefoxContentScriptOptions[]
}

type FirefoxContentScriptOptions = {
	readonly js?: readonly { readonly file?: string, readonly code?: string }[]
	readonly matches: readonly string[]
	readonly runAt?: string
	readonly world?: string
	readonly allFrames?: boolean
	readonly matchOriginAsFallback?: boolean
}

function installBrowserMock({ metamaskCompatibilityMode, manifestVersion = 3, registerError, registerErrors, registerWait, onRegister, updateError, registeredContentScriptIds = [], registeredContentScripts: initialRegisteredContentScripts, websiteAccess, storageGetErrorAfterSet, settingsReadError, storageGetWaits, onStorageGet, tabsQueryError, failingFirefoxRegistration, failingFirefoxUnregistrations = [] }: BrowserMockOptions = {}) {
	const storageState: Record<string, unknown> = {
		...(metamaskCompatibilityMode === undefined ? {} : { metamaskCompatibilityMode }),
		...(websiteAccess === undefined ? {} : { websiteAccess }),
	}
	const sentMessages: RuntimeMessage[] = []
	const reloadedTabs: number[] = []
	const defaultScriptFilesById = new Map<string, readonly string[]>([
		['inpage', ['/inpage/js/inpage.js']],
		['inpage2', ['/vendor/webextension-polyfill/dist/browser-polyfill.js', '/inpage/js/listenContentScript.js', '/inpage/js/listenContentScriptBootstrap.js']],
	])
	const registeredContentScripts = new Map((initialRegisteredContentScripts ?? registeredContentScriptIds.map((id) => ({ id, js: defaultScriptFilesById.get(id) }))).map((registration) => [registration.id, registration]))
	const scriptingOperations: string[] = []
	const unregisteredContentScriptIdBatches: string[][] = []
	const pendingRegisterErrors = [...registerErrors ?? (registerError === undefined ? [] : [registerError])]
	let failNextStorageGet = false
	let storageGetCalls = 0
	const pendingStorageGetWaits = [...storageGetWaits ?? []]
	const activeFirefoxContentScripts = new Set<FirefoxContentScriptOptions>()
	const firefoxContentScriptOperations: string[] = []
	// The scripts that would run in a new document after each registration change, so a test can check every moment of an update.
	const registrationSnapshots: RegistrationSnapshot[] = []
	const recordRegistrationSnapshot = () => {
		registrationSnapshots.push({
			registered: [...registeredContentScripts.values()].map(({ world, excludeMatches }) => ({ world, excludeMatches: [...excludeMatches ?? []] })),
			disabledHostRegistrations: [...activeFirefoxContentScripts],
		})
	}
	let firefoxContentScriptRegistrations = 0
	const pendingFirefoxUnregistrationFailures = new Set(failingFirefoxUnregistrations)
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
					recordRegistrationSnapshot()
				},
				async getRegisteredContentScripts() { return [...registeredContentScripts.values()] },
				async registerContentScripts(scripts: readonly RegisteredContentScript[]) {
					scriptingOperations.push('register')
					onRegister?.()
					await registerWait
					const nextRegisterError = pendingRegisterErrors.shift()
					if (nextRegisterError !== undefined) throw nextRegisterError
					for (const script of scripts) registeredContentScripts.set(script.id, script)
					recordRegistrationSnapshot()
				},
				async updateContentScripts(scripts: readonly RegisteredContentScript[]) {
					scriptingOperations.push('update')
					if (updateError !== undefined) throw updateError
					for (const script of scripts) registeredContentScripts.set(script.id, script)
					recordRegistrationSnapshot()
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
					recordRegistrationSnapshot()
					return {
						async unregister() {
							firefoxContentScriptOperations.push(`unregister ${ registration }`)
							if (pendingFirefoxUnregistrationFailures.delete(registration)) throw new Error(`contentScripts unregister ${ registration } failed`)
							activeFirefoxContentScripts.delete(options)
							recordRegistrationSnapshot()
						},
					}
				},
			} } : {},
			tabs: {
				async query() {
					if (tabsQueryError !== undefined) throw tabsQueryError
					return [{ id: 42, url: 'https://example.com/' }]
				},
				async get() { return { id: 42, url: 'https://example.com/' } },
				async update() { return undefined },
				async reload(tabId: number) { reloadedTabs.push(tabId) },
				onUpdated: { addListener: () => undefined, removeListener: () => undefined },
				onRemoved: { addListener: () => undefined, removeListener: () => undefined },
			},
			windows: {
				async get() { return undefined },
				async update() { return undefined },
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
		getReloadedTabs() { return [...reloadedTabs] },
		setWebsiteAccess(nextWebsiteAccess: WebsiteAccessArray) { storageState.websiteAccess = nextWebsiteAccess },
		setStoredMetamaskCompatibilityMode(nextMetamaskCompatibilityMode: boolean) { storageState.metamaskCompatibilityMode = nextMetamaskCompatibilityMode },
		getActiveFirefoxContentScripts() { return [...activeFirefoxContentScripts] },
		getFirefoxContentScriptOperations() { return [...firefoxContentScriptOperations] },
		getRegistrationSnapshots() { return [...registrationSnapshots] },
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

// Firefox matches a pattern against the URL's scheme and host, ignoring its port and credentials.
function matchesFirefoxPattern(pattern: string, url: string) {
	const { protocol, hostname } = new URL(url)
	return pattern === `${ protocol }//${ hostname }/*`
}

function getOrders<T>(items: readonly T[]): T[][] {
	if (items.length <= 1) return [[...items]]
	return items.flatMap((item, index) => getOrders([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]))
}

// The real once-per-document guard of each world's script: the leading statements of inpage.ts and listenContentScriptBootstrap.ts, run against a fake global that returns whether this copy runs.
const guardedScriptSources = { MAIN: 'app/inpage/ts/inpage.ts', ISOLATED: 'app/inpage/ts/listenContentScriptBootstrap.ts' } as const
function getDocumentGuard(world: ContentScriptWorld) {
	const guardStatements = fs.readFileSync(guardedScriptSources[world], 'utf8').split('\n').filter((line) => line.startsWith('const interceptor') || line.startsWith('const isFirstInterceptor'))
	const resultName = guardStatements.at(-1)?.match(/^const (\w+)/)?.[1]
	if (guardStatements.length !== 2 || resultName === undefined) throw new Error(`Could not find the document guard of ${ guardedScriptSources[world] }`)
	return (documentGlobal: object): boolean => new Function(contentScriptDocumentMarkers[world].global, `${ guardStatements.join('\n') }\nreturn ${ resultName }`)(documentGlobal)
}

// Runs a new document's world against the registrations of a snapshot, in every order Firefox could run them in; one registration's scripts run back to back. Each disabled-host registration runs its origin check before its guarded script. Returns the distinct counts of the world's script that ran.
function getScriptCountsInFirefoxDocument(snapshot: RegistrationSnapshot, url: string, world: ContentScriptWorld = 'MAIN') {
	const runsGuardedScript = getDocumentGuard(world)
	const matchingRegistrations: (readonly string[])[] = []
	for (const registration of snapshot.registered) {
		if ((registration.world ?? 'ISOLATED') === world && !registration.excludeMatches.some((pattern) => matchesFirefoxPattern(pattern, url))) matchingRegistrations.push([])
	}
	for (const registration of snapshot.disabledHostRegistrations) {
		if (registration.world === world && registration.matches.some((pattern) => matchesFirefoxPattern(pattern, url))) matchingRegistrations.push((registration.js ?? []).flatMap(({ code }) => code === undefined ? [] : [code]))
	}
	const scriptCounts = new Set<number>()
	for (const order of getOrders(matchingRegistrations)) {
		const documentGlobal = { origin: new URL(url).origin }
		let scripts = 0
		for (const codes of order) {
			for (const code of codes) new Function('window', 'globalThis', code)(documentGlobal, documentGlobal)
			if (runsGuardedScript(documentGlobal)) scripts += 1
		}
		scriptCounts.add(scripts)
	}
	return [...scriptCounts].sort()
}

function disabledWebsiteAccessEntry(websiteOrigin: string): WebsiteAccessArray[number] {
	return { website: { websiteOrigin, title: undefined, icon: undefined }, addressAccess: [], access: false, interceptorDisabled: true, declarativeNetRequestBlockMode: 'disabled' }
}

// Each call gets its own owner of Firefox's disabled-host registrations, so tests never share them.
async function loadModules() {
	const modules = {
		...await import('../../app/ts/utils/contentScriptsUpdating.js'),
		...await import('../../app/ts/background/contentScriptInjectionStrategy.js'),
		...await import('../../app/ts/background/contentScriptInjectionConfigurationLoader.js'),
		...await import('../../app/ts/background/storageVariables.js'),
	}
	const firefoxContentScriptRegistrations = modules.createFirefoxContentScriptRegistrations()
	return {
		...modules,
		updateContentScriptInjectionStrategy: async () => await modules.updateContentScriptInjectionStrategy(await modules.getContentScriptInjectionConfiguration(), firefoxContentScriptRegistrations),
	}
}

function readManifest(manifestPath: string) {
	const manifest: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
	if (typeof manifest !== 'object' || manifest === null) throw new Error(`${ manifestPath } must be an object`)
	return manifest
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

	test('compatibility setting changes refresh the current manifest strategy and reload connected tabs only when the mode changes', async () => {
		for (const manifestVersion of [2, 3] as const) {
			const { getRegisteredContentScripts, getReloadedTabs, getScriptingOperations } = installBrowserMock({ manifestVersion })
			const { setMetamaskCompatibilityMode } = await import('../../app/ts/background/metamaskCompatibilityMode.js')
			await setMetamaskCompatibilityMode(new Map([[42, { connections: {} }]]), true)

			assert.deepEqual(getReloadedTabs(), [42])
			assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'inpage')?.js, ['/inpage/js/inpage-metamask-compatibility.js'], `manifest v${ manifestVersion }`)

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

	test('compatibility setting changes update registration before best-effort reload target lookup', async () => {
		const tabLookupError = new Error('active tab lookup failed')
		const { getRegisteredContentScripts, getReloadedTabs, getScriptingOperations, getStorageState } = installBrowserMock({
			metamaskCompatibilityMode: false,
			registeredContentScriptIds: ['inpage', 'inpage2'],
			tabsQueryError: tabLookupError,
		})
		const { setMetamaskCompatibilityMode } = await import('../../app/ts/background/metamaskCompatibilityMode.js')

		await withSilencedConsole(async () => await setMetamaskCompatibilityMode(new Map([[42, { connections: {} }]]), true))

		assert.equal(getStorageState().metamaskCompatibilityMode, true)
		assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'inpage')?.js, ['/inpage/js/inpage-metamask-compatibility.js'])
		assert.deepEqual(getScriptingOperations(), ['unregister', 'register', 'update'])
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

	test('settings import remains saved when its best-effort registration refresh fails', async () => {
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
		const { updateAllContentScriptConfigurationAfterSettingsImport } = await import('../../app/ts/background/contentScriptInjectionStrategy.js')
		const { persistMetamaskCompatibilityMode } = await import('../../app/ts/background/settings.js')
		const { setMetamaskCompatibilityMode } = await import('../../app/ts/background/metamaskCompatibilityMode.js')

		await withSilencedConsole(async () => {
			const settingsImport = updateAllContentScriptConfigurationAfterSettingsImport(
				new Map(),
				async () => await persistMetamaskCompatibilityMode(true),
			)
			await registrationStarted.promise
			const queuedCompatibilityUpdate = setMetamaskCompatibilityMode(new Map(), true)
			releaseRegistration.resolve()
			await settingsImport
			await queuedCompatibilityUpdate
		})

		assert.equal(getStorageState().metamaskCompatibilityMode, true)
		assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'inpage')?.js, ['/inpage/js/inpage.js'])
	})

	test('queued disabled-site update reconciles registration after a best-effort import refresh failure', async () => {
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
		const { updateAllContentScriptConfigurationAfterSettingsImport } = await import('../../app/ts/background/contentScriptInjectionStrategy.js')
		const { persistMetamaskCompatibilityMode } = await import('../../app/ts/background/settings.js')
		const { tryUpdateWebsiteAccessAndContentScriptInjectionStrategy } = await import('../../app/ts/background/websiteAccessUpdating.js')

		await withSilencedConsole(async () => {
			const settingsImport = updateAllContentScriptConfigurationAfterSettingsImport(
				new Map(),
				async () => await persistMetamaskCompatibilityMode(true),
			)
			await registrationStarted.promise
			const queuedWebsiteAccessUpdate = tryUpdateWebsiteAccessAndContentScriptInjectionStrategy(new Map(), () => disabledWebsiteAccess)
			releaseRegistration.resolve()
			await settingsImport
			await queuedWebsiteAccessUpdate
		})

		assert.deepEqual(getStorageState().websiteAccess, disabledWebsiteAccess)
		assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'inpage')?.excludeMatches, ['http://disabled.test:80/*', 'https://disabled.test:443/*'])
	})

	test('website access changes use the shared injection refresh and connected-tab reload coordinator', async () => {
		const { getRegisteredContentScripts, getReloadedTabs, getScriptingOperations } = installBrowserMock({
			registeredContentScriptIds: ['inpage', 'inpage2'],
			websiteAccess: disabledWebsiteAccess,
		})
		const { tryUpdateWebsiteAccessAndContentScriptInjectionStrategy } = await import('../../app/ts/background/websiteAccessUpdating.js')

		await tryUpdateWebsiteAccessAndContentScriptInjectionStrategy(new Map([[42, { connections: {} }]]), () => [])

		assert.deepEqual(getScriptingOperations(), ['update'])
		assert.equal(getRegisteredContentScripts().every(({ excludeMatches }) => excludeMatches?.length === 0), true)
		assert.deepEqual(getReloadedTabs(), [42])
	})

	test('website access changes roll back and skip connected-tab reload when manifest v3 registration refresh fails', async () => {
		const registrationError = new Error('website access registration refresh failed')
		const { getReloadedTabs, getStorageState } = installBrowserMock({
			registeredContentScriptIds: ['inpage', 'inpage2'],
			updateError: registrationError,
			websiteAccess: disabledWebsiteAccess,
		})
		const { tryUpdateWebsiteAccessAndContentScriptInjectionStrategy } = await import('../../app/ts/background/websiteAccessUpdating.js')
		const { getLatestUnexpectedError } = await loadModules()

		await withSilencedConsole(async () => await tryUpdateWebsiteAccessAndContentScriptInjectionStrategy(new Map([[42, { connections: {} }]]), () => []))

		assert.deepEqual(getReloadedTabs(), [])
		assert.deepEqual(getStorageState().websiteAccess, disabledWebsiteAccess)
		assert.equal((await getLatestUnexpectedError())?.data.message, registrationError.message)
		assert.equal((await getLatestUnexpectedError())?.data.code, 'website_access_content_script_refresh_failed')
	})

	test('a website access update whose own storage write fails returns the failure unreported', async () => {
		installBrowserMock({ registeredContentScriptIds: ['inpage', 'inpage2'], websiteAccess: disabledWebsiteAccess })
		const { tryUpdateContentScriptInjectionSitesAndReloadTabsIfChanged } = await import('../../app/ts/background/contentScriptInjectionStrategy.js')
		const { getInterceptorErrorDiagnostics } = await loadModules()
		const storageWriteError = new Error('website access could not be stored')

		assert.deepEqual(await tryUpdateContentScriptInjectionSitesAndReloadTabsIfChanged(new Map(), () => [], async () => { throw storageWriteError }), { status: 'failed', storage: 'not-written', reload: 'not-needed', error: storageWriteError })

		assert.deepEqual(await getInterceptorErrorDiagnostics(), [])
	})

	test('website access rollback restores every transaction field while preserving concurrent metadata', async () => {
		const registrationError = new Error('delayed website access registration refresh failed')
		const previousWebsiteAccess: WebsiteAccessArray = [{
			website: { websiteOrigin: 'rollback.test', title: 'Before transaction', icon: undefined },
			addressAccess: [],
			access: true,
			interceptorDisabled: true,
			declarativeNetRequestBlockMode: 'disabled',
		}]
		const { getStorageState } = installBrowserMock({ websiteAccess: previousWebsiteAccess })
		const { updateWebsiteAccess } = await import('../../app/ts/background/settings.js')
		const { tryWebsiteAccessRollback } = await import('../../app/ts/background/settingsTransactions.js')

		await withSilencedConsole(async () => {
			assert.deepEqual(await tryWebsiteAccessRollback(
				(entries) => entries.map((entry) => ({
					...entry,
					website: { ...entry.website, title: 'Transaction title' },
					addressAccess: [{ address: 0x2222222222222222222222222222222222222222n, access: false }],
					access: false,
					interceptorDisabled: false,
					declarativeNetRequestBlockMode: 'block-all',
				})),
				async () => {
					await updateWebsiteAccess((entries) => entries.map((entry) => ({ ...entry, website: { ...entry.website, title: 'Concurrent title' } })))
					throw registrationError
				},
			), { status: 'failed', storage: 'rolled-back', error: registrationError })
		})

		assert.deepEqual(getStorageState().websiteAccess, [{ ...previousWebsiteAccess[0], website: { ...previousWebsiteAccess[0]?.website, title: 'Concurrent title' } }])
	})

	test('website access rollback strips the fields of an entry it created that a concurrent writer kept editing', async () => {
		const registrationError = new Error('registration failed after creating an entry')
		const { getStorageState } = installBrowserMock({ websiteAccess: [] })
		const { updateWebsiteAccess } = await import('../../app/ts/background/settings.js')
		const { tryWebsiteAccessRollback } = await import('../../app/ts/background/settingsTransactions.js')

		await withSilencedConsole(async () => {
			assert.deepEqual(await tryWebsiteAccessRollback(
				() => [{
					website: { websiteOrigin: 'created.test', title: 'Transaction title', icon: undefined },
					addressAccess: [{ address: 0x2222222222222222222222222222222222222222n, access: true }],
					access: true,
					interceptorDisabled: true,
					declarativeNetRequestBlockMode: 'block-all',
				}],
				async () => {
					await updateWebsiteAccess((entries) => entries.map((entry) => ({ ...entry, website: { ...entry.website, title: 'Concurrent title' } })))
					throw registrationError
				},
			), { status: 'failed', storage: 'rolled-back', error: registrationError })
		})

		// Browser storage is JSON, so fields rolled back to undefined are absent once persisted.
		assert.deepStrictEqual(JSON.parse(JSON.stringify(getStorageState().websiteAccess)), [{ website: { websiteOrigin: 'created.test', title: 'Concurrent title' } }])
	})

	test('website access rollback snapshots after an already-running ordinary update', async () => {
		const ordinaryUpdateStarted = createDeferred()
		const releaseOrdinaryUpdate = createDeferred()
		const previousWebsiteAccess: WebsiteAccessArray = [{
			website: { websiteOrigin: 'queued-before.test', title: 'Before updates', icon: undefined },
			addressAccess: [],
			access: true,
			interceptorDisabled: false,
			declarativeNetRequestBlockMode: 'disabled',
		}]
		const { getStorageState } = installBrowserMock({
			websiteAccess: previousWebsiteAccess,
			storageGetWaits: [releaseOrdinaryUpdate.promise],
			onStorageGet: () => ordinaryUpdateStarted.resolve(),
		})
		const { updateWebsiteAccess } = await import('../../app/ts/background/settings.js')
		const { tryWebsiteAccessRollback } = await import('../../app/ts/background/settingsTransactions.js')
		const registrationError = new Error('registration failed after queued update')

		const ordinaryUpdate = updateWebsiteAccess((entries) => entries.map((entry) => ({ ...entry, website: { ...entry.website, title: 'Ordinary update' }, access: false })))
		await ordinaryUpdateStarted.promise
		const failedTransaction = tryWebsiteAccessRollback(
			(entries) => entries.map((entry) => ({ ...entry, interceptorDisabled: true })),
			async () => { throw registrationError },
		)
		releaseOrdinaryUpdate.resolve()
		await ordinaryUpdate
		await withSilencedConsole(async () => assert.deepEqual(await failedTransaction, { status: 'failed', storage: 'rolled-back', error: registrationError }))

		assert.deepEqual(getStorageState().websiteAccess, [{ ...previousWebsiteAccess[0], website: { ...previousWebsiteAccess[0]?.website, title: 'Ordinary update' }, access: false }])
	})

	test('disabling the Interceptor preserves stored website metadata', async () => {
		const storedWebsiteAccess: WebsiteAccessArray = [{
			...disabledWebsiteAccess[0],
			website: { websiteOrigin: 'disabled.test', title: 'Stored website title', icon: 'data:image/png;base64,c3RvcmVk' },
			interceptorDisabled: false,
		}]
		const { getStorageState } = installBrowserMock({ registeredContentScriptIds: ['inpage', 'inpage2'], websiteAccess: storedWebsiteAccess })
		const { tryUpdateWebsiteAccessAndContentScriptInjectionStrategy } = await import('../../app/ts/background/websiteAccessUpdating.js')
		const { withInterceptorDisabledForWebsite } = await import('../../app/ts/background/websiteAccessMutations.js')

		const outcome = await tryUpdateWebsiteAccessAndContentScriptInjectionStrategy(new Map(), withInterceptorDisabledForWebsite({ websiteOrigin: 'disabled.test', title: undefined, icon: undefined }, true))
		assert.equal(outcome.status, 'completed')

		assert.deepEqual(getStorageState().websiteAccess, [{ ...storedWebsiteAccess[0], interceptorDisabled: true }])
	})

	test('exposes every manifest v3 main-world script to Chromium', () => {
		const webAccessibleResources = getManifestV3WebAccessibleResources()
		for (const metamaskCompatibilityMode of [false, true]) {
			for (const scriptPath of getPageWorldScriptPaths(metamaskCompatibilityMode)) assert.equal(webAccessibleResources.includes(scriptPath), true)
		}
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

	test('registers the page-world provider artifact for the active MetaMask compatibility mode', async () => {
		for (const metamaskCompatibilityMode of [false, true]) {
			const { getRegisteredContentScripts } = installBrowserMock({ metamaskCompatibilityMode })
			const { updateContentScriptInjectionStrategy } = await loadModules()

			await updateContentScriptInjectionStrategy()

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
		const { updateContentScriptInjectionStrategy } = await loadModules()

		await updateContentScriptInjectionStrategy()

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
		const { updateContentScriptInjectionStrategy, getLatestUnexpectedError } = await loadModules()

		await withSilencedConsole(async () => await assert.rejects(updateContentScriptInjectionStrategy(), registrationError))

		assert.deepEqual(getScriptingOperations(), ['unregister', 'register', 'unregister', 'register'])
		assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'inpage'), previousMainWorldRegistration)
		assert.deepEqual(getReloadedTabs(), [])
		assert.equal(await getLatestUnexpectedError(), undefined)
		assert.equal(sentMessages.some(({ method }) => method === 'popup_UnexpectedErrorOccured'), false)
	})

	test('startup refresh records manifest v3 registration failures as unexpected errors', async () => {
		const { sentMessages } = installBrowserMock({ registerError: new Error('registration failed') })
		const { refreshContentScriptInjectionStrategy, getLatestUnexpectedError } = await loadModules()

		await withSilencedConsole(async () => await refreshContentScriptInjectionStrategy())

		const latestUnexpectedError = await getLatestUnexpectedError()
		assert.equal(latestUnexpectedError?.data.message, 'registration failed')
		assert.equal(latestUnexpectedError?.data.code, 'content_script_registration_failed')
		assert.equal(sentMessages.at(-1)?.method, 'popup_UnexpectedErrorOccured')
	})

	test('one manifest v3 registration failure is reported exactly once on every refresh path', async () => {
		const refreshPaths = [
			{ code: 'content_script_registration_failed', run: async () => await (await import('../../app/ts/background/contentScriptInjectionStrategy.js')).refreshContentScriptInjectionStrategy() },
			{ code: 'website_access_content_script_refresh_failed', run: async () => await (await import('../../app/ts/background/websiteAccessUpdating.js')).tryUpdateWebsiteAccessAndContentScriptInjectionStrategy(new Map(), () => disabledWebsiteAccess) },
			{ code: 'page_world_provider_bootstrap_refresh_failed', run: async () => await (await import('../../app/ts/background/metamaskCompatibilityMode.js')).setMetamaskCompatibilityMode(new Map(), true) },
			{ code: 'settings_import_content_script_refresh_failed', run: async () => {
				const { updateAllContentScriptConfigurationAfterSettingsImport } = await import('../../app/ts/background/contentScriptInjectionStrategy.js')
				const { persistMetamaskCompatibilityMode } = await import('../../app/ts/background/settings.js')
				await updateAllContentScriptConfigurationAfterSettingsImport(new Map(), async () => await persistMetamaskCompatibilityMode(true))
			} },
		]
		for (const refreshPath of refreshPaths) {
			const registrationError = new Error(`registration failed on the ${ refreshPath.code } path`)
			const { sentMessages } = installBrowserMock({ metamaskCompatibilityMode: false, websiteAccess: [], registerError: registrationError })
			const { getInterceptorErrorDiagnostics } = await loadModules()

			await withSilencedConsole(refreshPath.run)

			const unexpectedErrorPopups = sentMessages.filter(({ method }) => method === 'popup_UnexpectedErrorOccured')
			assert.deepEqual(unexpectedErrorPopups.map(({ data }) => data?.code), [refreshPath.code])
			assert.deepEqual((await getInterceptorErrorDiagnostics()).map(({ code }) => code), [refreshPath.code])
		}
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

	test('restores existing and obsolete manifest v3 content scripts when an update fails', async () => {
		const { getRegisteredContentScripts, getScriptingOperations, getUnregisteredContentScriptIdBatches } = installBrowserMock({
			registeredContentScriptIds: ['inpage', 'inpage2', 'obsolete-inpage'],
			updateError: new Error('update failed'),
		})
		const { updateContentScriptInjectionStrategy } = await loadModules()

		await withSilencedConsole(async () => await assert.rejects(updateContentScriptInjectionStrategy(), /update failed/))

		assert.deepEqual(getScriptingOperations(), ['update', 'unregister', 'register'])
		assert.deepEqual(getUnregisteredContentScriptIdBatches(), [['inpage', 'inpage2', 'obsolete-inpage']])
		assert.deepEqual(getRegisteredContentScripts().map(({ id }) => id).sort(), ['inpage', 'inpage2', 'obsolete-inpage'])
	})

	test('website transactions return their storage phase rather than inferring it from refresh callbacks', async () => {
		const { getStorageState } = installBrowserMock({ websiteAccess: disabledWebsiteAccess })
		const { tryWebsiteAccessRollback } = await import('../../app/ts/background/settingsTransactions.js')
		const refreshError = new Error('Registration failed after commit')
		const rolledBack = await tryWebsiteAccessRollback(() => [], async () => { throw refreshError })
		assert.deepEqual(rolledBack, { status: 'failed', storage: 'rolled-back', error: refreshError })
		assert.deepEqual(getStorageState().websiteAccess, disabledWebsiteAccess)
		const committed = await tryWebsiteAccessRollback(() => [], async () => undefined)
		assert.deepEqual(committed, { status: 'completed', storage: 'written', websiteAccess: [] })
	})

	test('the configuration API returns an initial write failure with its storage phase', async () => {
		installBrowserMock({ websiteAccess: disabledWebsiteAccess })
		const { tryUpdateContentScriptInjectionSitesAndReloadTabsIfChanged } = await import('../../app/ts/background/contentScriptInjectionStrategy.js')
		const { tryWebsiteAccessRollback } = await import('../../app/ts/background/settingsTransactions.js')
		const writeError = new Error('Cannot commit website access')
		const originalSet = browser.storage.local.set
		browser.storage.local.set = async () => { throw writeError }
		try {
			assert.deepEqual(await tryUpdateContentScriptInjectionSitesAndReloadTabsIfChanged(new Map(), () => [], tryWebsiteAccessRollback), { status: 'failed', storage: 'not-written', reload: 'not-needed', error: writeError })
		} finally {
			browser.storage.local.set = originalSet
		}
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

	test('excludes a disabled origin in Firefox by its whole host and registers that host again with its exact disabled origins', async () => {
		installBrowserMock()
		const { getContentScriptExcludeMatches, getFirefoxContentScriptExclusions } = await loadModules()

		assert.deepEqual(getFirefoxContentScriptExclusions(getContentScriptExcludeMatches(['', 'example.com', 'localhost:3000', 'localhost:8080', 'https://secure.example:8443', 'example.com:80', '[::1]:8545'])), {
			excludeMatches: ['file:///*', 'http://example.com/*', 'https://example.com/*', 'http://localhost/*', 'https://localhost/*', 'https://secure.example/*', 'http://[::1]/*', 'https://[::1]/*'],
			disabledHosts: [
				{ matches: ['http://example.com/*', 'https://example.com/*'], disabledOrigins: ['http://example.com', 'https://example.com', 'https://example.com:80'] },
				{ matches: ['http://localhost/*', 'https://localhost/*'], disabledOrigins: ['http://localhost:3000', 'https://localhost:3000', 'http://localhost:8080', 'https://localhost:8080'] },
				{ matches: ['https://secure.example/*'], disabledOrigins: ['https://secure.example:8443'] },
				{ matches: ['http://[::1]/*', 'https://[::1]/*'], disabledOrigins: ['http://[::1]:8545', 'https://[::1]:8545'] },
			],
		})
		assert.deepEqual(getFirefoxContentScriptExclusions([]), { excludeMatches: [], disabledHosts: [] })
	})

	test('marks exactly the disabled origins and opaque origins in the disabled-origin check, without claiming the document', async () => {
		installBrowserMock()
		const { getDisabledOriginCheckCode } = await loadModules()
		const markers = contentScriptDocumentMarkers.MAIN
		const code = getDisabledOriginCheckCode(['http://localhost:3000', 'https://localhost:3000'], markers)
		const isMarked = (origin: string) => {
			const fakeWindow = { origin }
			new Function('window', code)(fakeWindow)
			assert.equal(Reflect.has(fakeWindow, Symbol.for(markers.claimedKey)), false, origin)
			return Reflect.has(fakeWindow, Symbol.for(markers.disabledOriginKey))
		}

		assert.equal(isMarked('http://localhost:3000'), true)
		assert.equal(isMarked('https://localhost:3000'), true)
		assert.equal(isMarked('null'), true)
		assert.equal(isMarked('http://localhost:8545'), false)
		assert.equal(isMarked('http://localhost'), false)
		assert.equal(isMarked('http://localhost:30000'), false)
	})

	test('gives every Firefox document the provider once, except on the disabled origin, including credential, path and query lookalikes', async () => {
		installBrowserMock()
		const { getContentScriptExcludeMatches, getFirefoxContentScriptExclusions, getDisabledOriginCheckCode } = await loadModules()
		const { getHostWithPort } = await import('../../app/ts/utils/requests.js')
		const urls = [
			'http://localhost:3000/', 'http://localhost:8545/', 'http://localhost/', 'https://localhost:3000/',
			'http://user@localhost:3000/', 'http://user:password@localhost:3000/page', 'http://user@localhost:8545/',
			'http://localhost:8545/x/@localhost:3000/', 'http://localhost:8545/?next=@localhost:3000/', 'http://localhost:8545/#@localhost:3000/',
			'https://example.com/path', 'https://example.com:8443/', 'http://example.com/', 'https://app.example.com/',
		]
		for (const disabledUrl of urls) {
			const { excludeMatches, disabledHosts } = getFirefoxContentScriptExclusions(getContentScriptExcludeMatches([getHostWithPort(disabledUrl)]))
			for (const world of ['MAIN', 'ISOLATED'] as const) {
				const snapshot: RegistrationSnapshot = {
					registered: [{ world, excludeMatches }],
					disabledHostRegistrations: disabledHosts.map(({ matches, disabledOrigins }) => ({ matches, world, js: [{ code: getDisabledOriginCheckCode(disabledOrigins, contentScriptDocumentMarkers[world]) }, { file: 'guarded script' }] })),
				}
				for (const url of urls) {
					assert.deepEqual(getScriptCountsInFirefoxDocument(snapshot, url, world), [getHostWithPort(url) === getHostWithPort(disabledUrl) ? 0 : 1], `${ world } on ${ url } with ${ disabledUrl } disabled`)
				}
			}
		}
	})

	test('keeps every Firefox page at one provider and one bridge at each step of disabling and re-enabling a site', async () => {
		const { getRegistrationSnapshots, setWebsiteAccess } = installBrowserMock({ manifestVersion: 2 })
		const { updateContentScriptInjectionStrategy } = await loadModules()
		const otherOriginUrls = ['http://localhost:8545/', 'http://localhost/', 'https://example.com/']
		const toggledUrl = 'http://localhost:3000/'
		const worlds = ['MAIN', 'ISOLATED'] as const
		const assertSettledCounts = (expectedToggledCount: number) => {
			const settled = getRegistrationSnapshots().at(-1)
			if (settled === undefined) throw new Error('no registration was made')
			for (const world of worlds) {
				for (const url of otherOriginUrls) assert.deepEqual(getScriptCountsInFirefoxDocument(settled, url, world), [1], `${ world } on ${ url }`)
				assert.deepEqual(getScriptCountsInFirefoxDocument(settled, toggledUrl, world), [expectedToggledCount], `${ world } on ${ toggledUrl }`)
			}
		}

		await updateContentScriptInjectionStrategy()
		assertSettledCounts(1)
		const stepsBefore = getRegistrationSnapshots().length
		for (const websiteAccess of [[disabledWebsiteAccessEntry('localhost:3000')], [disabledWebsiteAccessEntry('localhost:3000'), disabledWebsiteAccessEntry('localhost:8080')], [], [disabledWebsiteAccessEntry('localhost:3000')], []]) {
			setWebsiteAccess(websiteAccess)
			await updateContentScriptInjectionStrategy()
			assertSettledCounts(websiteAccess.length === 0 ? 1 : 0)
		}

		const transitionSnapshots = getRegistrationSnapshots().slice(stepsBefore)
		assert.equal(transitionSnapshots.length > 5, true)
		for (const [step, snapshot] of transitionSnapshots.entries()) {
			for (const world of worlds) {
				// The other origins keep exactly one script at every step, in every order Firefox could run the registrations in.
				for (const url of otherOriginUrls) assert.deepEqual(getScriptCountsInFirefoxDocument(snapshot, url, world), [1], `${ world } on ${ url } at step ${ step }`)
				// The origin being toggled behaves as before or after the change, the same in every order, and gets its script as soon as the general registration matches it again, even while a stale disabled-host registration is still there.
				const toggledCounts = getScriptCountsInFirefoxDocument(snapshot, toggledUrl, world)
				const generalRegistrationMatches = snapshot.registered.some((registration) => (registration.world ?? 'ISOLATED') === world && !registration.excludeMatches.some((pattern) => matchesFirefoxPattern(pattern, toggledUrl)))
				assert.deepEqual(toggledCounts, generalRegistrationMatches ? [1] : [0], `${ world } on ${ toggledUrl } at step ${ step }`)
			}
		}
	})

	test('a stale disabled-host registration never suppresses the general registration once a site is enabled again', async () => {
		installBrowserMock()
		const { getDisabledOriginCheckCode } = await loadModules()
		const toggledUrl = 'http://localhost:3000/'
		const hostMatches = ['http://localhost/*', 'https://localhost/*']
		for (const world of ['MAIN', 'ISOLATED'] as const) {
			const disabledHostRegistration: FirefoxContentScriptOptions = { matches: hostMatches, world, js: [{ code: getDisabledOriginCheckCode(['http://localhost:3000'], contentScriptDocumentMarkers[world]) }, { file: 'guarded script' }] }
			// Both registrations match while a site is enabled again (the general registration matches the host before the host's registration is removed) and while it is disabled (the host's registration is added before the general one stops matching the host); the origin has exactly one script in every order.
			assert.deepEqual(getScriptCountsInFirefoxDocument({ registered: [{ world, excludeMatches: [] }], disabledHostRegistrations: [disabledHostRegistration] }, toggledUrl, world), [1], `${ world } while both match`)
			assert.deepEqual(getScriptCountsInFirefoxDocument({ registered: [{ world, excludeMatches: hostMatches }], disabledHostRegistrations: [disabledHostRegistration] }, toggledUrl, world), [0], `${ world } once disabled`)
		}
	})

	test('gives a re-enabled Firefox origin its provider and bridge even when the stale disabled-host registration cannot be removed', async () => {
		const { getRegistrationSnapshots, getActiveFirefoxContentScripts, setWebsiteAccess } = installBrowserMock({ manifestVersion: 2, websiteAccess: [disabledWebsiteAccessEntry('localhost:3000')], failingFirefoxUnregistrations: [1, 2] })
		const { updateContentScriptInjectionStrategy } = await loadModules()

		await updateContentScriptInjectionStrategy()
		setWebsiteAccess([])
		await withSilencedConsole(async () => await updateContentScriptInjectionStrategy())

		assert.equal(getActiveFirefoxContentScripts().length, 2)
		const settled = getRegistrationSnapshots().at(-1)
		if (settled === undefined) throw new Error('no registration was made')
		for (const world of ['MAIN', 'ISOLATED'] as const) assert.deepEqual(getScriptCountsInFirefoxDocument(settled, 'http://localhost:3000/', world), [1], world)
	})

	test('registers a disabled Firefox host until the site is enabled again', async () => {
		const { getRegisteredContentScripts, getActiveFirefoxContentScripts, setWebsiteAccess } = installBrowserMock({ manifestVersion: 2, websiteAccess: [disabledWebsiteAccessEntry('localhost:3000')] })
		const { updateContentScriptInjectionStrategy } = await loadModules()

		await updateContentScriptInjectionStrategy()

		assert.deepEqual(getRegisteredContentScripts().map(({ excludeMatches }) => excludeMatches), [['http://localhost/*', 'https://localhost/*'], ['http://localhost/*', 'https://localhost/*']])
		const disabledHostContentScripts = getActiveFirefoxContentScripts()
		assert.deepEqual(disabledHostContentScripts.map(({ js, world, runAt, allFrames, matchOriginAsFallback, matches }) => ({ files: js?.flatMap(({ file }) => file === undefined ? [] : [file]), firstIsCode: js?.[0]?.code !== undefined, world, runAt, allFrames, matchOriginAsFallback, matches })), [
			{ files: ['/vendor/webextension-polyfill/dist/browser-polyfill.js', '/inpage/js/listenContentScript.js', '/inpage/js/listenContentScriptBootstrap.js'], firstIsCode: true, world: 'ISOLATED', runAt: 'document_start', allFrames: true, matchOriginAsFallback: true, matches: ['http://localhost/*', 'https://localhost/*'] },
			{ files: ['/inpage/js/inpage.js'], firstIsCode: true, world: 'MAIN', runAt: 'document_start', allFrames: true, matchOriginAsFallback: true, matches: ['http://localhost/*', 'https://localhost/*'] },
		])
		assert.equal(disabledHostContentScripts[0]?.js?.[0]?.code?.includes(`Reflect.defineProperty(globalThis, Symbol.for(${ JSON.stringify(contentScriptDocumentMarkers.ISOLATED.disabledOriginKey) })`), true)
		assert.equal(disabledHostContentScripts[1]?.js?.[0]?.code?.includes(`Reflect.defineProperty(window, Symbol.for(${ JSON.stringify(contentScriptDocumentMarkers.MAIN.disabledOriginKey) })`), true)

		setWebsiteAccess([])
		await updateContentScriptInjectionStrategy()

		assert.deepEqual(getRegisteredContentScripts().map(({ excludeMatches }) => excludeMatches), [[], []])
		assert.deepEqual(getActiveFirefoxContentScripts(), [])
	})

	test('keeps an unchanged disabled Firefox host registered while another host changes', async () => {
		const { getFirefoxContentScriptOperations, setWebsiteAccess } = installBrowserMock({ manifestVersion: 2, websiteAccess: [disabledWebsiteAccessEntry('localhost:3000')] })
		const { updateContentScriptInjectionStrategy } = await loadModules()

		await updateContentScriptInjectionStrategy()
		setWebsiteAccess([disabledWebsiteAccessEntry('localhost:3000'), disabledWebsiteAccessEntry('example.com')])
		await updateContentScriptInjectionStrategy()
		setWebsiteAccess([disabledWebsiteAccessEntry('example.com')])
		await updateContentScriptInjectionStrategy()

		assert.deepEqual(getFirefoxContentScriptOperations(), ['register 1', 'register 2', 'register 3', 'register 4', 'unregister 1', 'unregister 2'])
	})

	test('serializes concurrent Firefox updates so a disabled host keeps one set of scripts', async () => {
		const { getActiveFirefoxContentScripts, getFirefoxContentScriptOperations, setWebsiteAccess } = installBrowserMock({ manifestVersion: 2, websiteAccess: [disabledWebsiteAccessEntry('localhost:3000')] })
		const { refreshContentScriptInjectionStrategy } = await loadModules()

		await Promise.all([refreshContentScriptInjectionStrategy(), refreshContentScriptInjectionStrategy()])

		assert.equal(getActiveFirefoxContentScripts().length, 2)
		assert.deepEqual(getFirefoxContentScriptOperations(), ['register 1', 'register 2'])
		// The strategy module owns the one background registration owner, which keeps this host registered, so enabling the site again leaves no registrations for later tests.
		setWebsiteAccess([])
		await refreshContentScriptInjectionStrategy()
		assert.deepEqual(getActiveFirefoxContentScripts(), [])
	})

	test('still excludes a disabled Firefox host whose own registration failed, and registers it on the next update', async () => {
		const { getRegisteredContentScripts, getActiveFirefoxContentScripts, getFirefoxContentScriptOperations } = installBrowserMock({ manifestVersion: 2, websiteAccess: [disabledWebsiteAccessEntry('localhost:3000')], failingFirefoxRegistration: 2 })
		const { updateContentScriptInjectionStrategy } = await loadModules()

		await assert.rejects(updateContentScriptInjectionStrategy(), /contentScripts\.register failed/)

		assert.deepEqual(getRegisteredContentScripts().map(({ excludeMatches }) => excludeMatches), [['http://localhost/*', 'https://localhost/*'], ['http://localhost/*', 'https://localhost/*']])
		assert.deepEqual(getActiveFirefoxContentScripts(), [])
		await updateContentScriptInjectionStrategy()

		assert.equal(getActiveFirefoxContentScripts().length, 2)
		assert.deepEqual(getFirefoxContentScriptOperations(), ['register 1', 'register 2', 'unregister 1', 'register 3', 'register 4'])
	})

	test('registers a disabled Firefox host again with the other provider before retiring it when compatibility mode changes', async () => {
		const { getRegisteredContentScripts, getActiveFirefoxContentScripts, getFirefoxContentScriptOperations, setStoredMetamaskCompatibilityMode } = installBrowserMock({ manifestVersion: 2, metamaskCompatibilityMode: false, websiteAccess: [disabledWebsiteAccessEntry('localhost:3000')] })
		const { updateContentScriptInjectionStrategy } = await loadModules()

		await updateContentScriptInjectionStrategy()
		setStoredMetamaskCompatibilityMode(true)
		await updateContentScriptInjectionStrategy()

		assert.deepEqual(getFirefoxContentScriptOperations(), ['register 1', 'register 2', 'register 3', 'register 4', 'unregister 1', 'unregister 2'])
		assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'inpage')?.js, ['/inpage/js/inpage-metamask-compatibility.js'])
		const disabledHostProvider = getActiveFirefoxContentScripts().find(({ world }) => world === 'MAIN')
		assert.deepEqual(disabledHostProvider?.js?.flatMap(({ file }) => file === undefined ? [] : [file]), ['/inpage/js/inpage-metamask-compatibility.js'])
	})

	test('keeps only the previous disabled Firefox hosts registered when the registered scripts roll back', async () => {
		const { getRegisteredContentScripts, getActiveFirefoxContentScripts, getFirefoxContentScriptOperations, setWebsiteAccess } = installBrowserMock({ manifestVersion: 2, websiteAccess: [disabledWebsiteAccessEntry('localhost:3000')], updateError: new Error('update failed') })
		const { updateContentScriptInjectionStrategy } = await loadModules()

		await updateContentScriptInjectionStrategy()
		setWebsiteAccess([disabledWebsiteAccessEntry('example.com')])
		await withSilencedConsole(async () => await assert.rejects(updateContentScriptInjectionStrategy(), /update failed/))

		// The restored registrations still exclude localhost and not example.com, so localhost keeps its own registration and the one added for example.com during the attempt is removed again.
		assert.deepEqual(getRegisteredContentScripts().map(({ excludeMatches }) => excludeMatches), [['http://localhost/*', 'https://localhost/*'], ['http://localhost/*', 'https://localhost/*']])
		assert.deepEqual(getFirefoxContentScriptOperations(), ['register 1', 'register 2', 'register 3', 'register 4', 'unregister 3', 'unregister 4'])
		assert.deepEqual(getActiveFirefoxContentScripts().flatMap(({ matches }) => matches), ['http://localhost/*', 'https://localhost/*', 'http://localhost/*', 'https://localhost/*'])
	})

	test('keeps only the previous compatibility mode\'s disabled Firefox host registrations when a mode change rolls back', async () => {
		const { getRegisteredContentScripts, getActiveFirefoxContentScripts, getFirefoxContentScriptOperations, setStoredMetamaskCompatibilityMode } = installBrowserMock({ manifestVersion: 2, metamaskCompatibilityMode: false, websiteAccess: [disabledWebsiteAccessEntry('localhost:3000')], registerErrors: [undefined, new Error('registration failed')] })
		const { updateContentScriptInjectionStrategy } = await loadModules()

		await updateContentScriptInjectionStrategy()
		setStoredMetamaskCompatibilityMode(true)
		await withSilencedConsole(async () => await assert.rejects(updateContentScriptInjectionStrategy(), /registration failed/))

		assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'inpage')?.js, ['/inpage/js/inpage.js'])
		assert.deepEqual(getFirefoxContentScriptOperations(), ['register 1', 'register 2', 'register 3', 'register 4', 'unregister 3', 'unregister 4'])
		const disabledHostProviders = getActiveFirefoxContentScripts().filter(({ world }) => world === 'MAIN')
		assert.deepEqual(disabledHostProviders.map(({ js }) => js?.flatMap(({ file }) => file === undefined ? [] : [file])), [['/inpage/js/inpage.js']])
		assert.equal(getActiveFirefoxContentScripts().length, 2)
	})

	test('keeps a half-registered Firefox host pending removal when its cleanup fails, and removes it on the next update', async () => {
		const { getActiveFirefoxContentScripts, getFirefoxContentScriptOperations } = installBrowserMock({ manifestVersion: 2, websiteAccess: [disabledWebsiteAccessEntry('localhost:3000')], failingFirefoxRegistration: 2, failingFirefoxUnregistrations: [1] })
		const { updateContentScriptInjectionStrategy, getLatestUnexpectedError } = await loadModules()

		// The registration error is the one the caller sees; the failed cleanup is reported on its own.
		await withSilencedConsole(async () => await assert.rejects(updateContentScriptInjectionStrategy(), /contentScripts\.register failed/))
		assert.equal((await getLatestUnexpectedError())?.data.code, 'content_script_registration_cleanup_failed')
		assert.equal(getActiveFirefoxContentScripts().length, 1)

		await updateContentScriptInjectionStrategy()

		assert.deepEqual(getFirefoxContentScriptOperations(), ['register 1', 'register 2', 'unregister 1', 'unregister 1', 'register 3', 'register 4'])
		assert.deepEqual(getActiveFirefoxContentScripts().map(({ world }) => world), ['ISOLATED', 'MAIN'])
	})

	test('keeps a Firefox host registration pending removal when a rollback cannot remove it, and removes it on the next update', async () => {
		const { getRegisteredContentScripts, getActiveFirefoxContentScripts, getFirefoxContentScriptOperations, setStoredMetamaskCompatibilityMode } = installBrowserMock({ manifestVersion: 2, metamaskCompatibilityMode: false, websiteAccess: [disabledWebsiteAccessEntry('localhost:3000')], registerErrors: [undefined, new Error('registration failed')], failingFirefoxUnregistrations: [3] })
		const { updateContentScriptInjectionStrategy, getLatestUnexpectedError } = await loadModules()

		await updateContentScriptInjectionStrategy()
		setStoredMetamaskCompatibilityMode(true)
		await withSilencedConsole(async () => await assert.rejects(updateContentScriptInjectionStrategy(), /registration failed/))
		assert.equal((await getLatestUnexpectedError())?.data.code, 'content_script_registration_rollback_failed')
		assert.equal(getActiveFirefoxContentScripts().length, 3)

		await updateContentScriptInjectionStrategy()

		assert.deepEqual(getFirefoxContentScriptOperations(), ['register 1', 'register 2', 'register 3', 'register 4', 'unregister 3', 'unregister 4', 'unregister 3', 'register 5', 'register 6', 'unregister 1', 'unregister 2'])
		assert.deepEqual(getRegisteredContentScripts().find(({ id }) => id === 'inpage')?.js, ['/inpage/js/inpage-metamask-compatibility.js'])
		const disabledHostProviders = getActiveFirefoxContentScripts().filter(({ world }) => world === 'MAIN')
		assert.deepEqual(disabledHostProviders.map(({ js }) => js?.flatMap(({ file }) => file === undefined ? [] : [file])), [['/inpage/js/inpage-metamask-compatibility.js']])
		assert.equal(getActiveFirefoxContentScripts().length, 2)
	})

	test('registers a disabled Firefox host completely again after an earlier removal of it failed half way', async () => {
		const { getActiveFirefoxContentScripts, getFirefoxContentScriptOperations, setWebsiteAccess } = installBrowserMock({ manifestVersion: 2, websiteAccess: [disabledWebsiteAccessEntry('localhost:3000')], failingFirefoxUnregistrations: [2] })
		const { updateContentScriptInjectionStrategy, getLatestUnexpectedError } = await loadModules()

		await updateContentScriptInjectionStrategy()
		setWebsiteAccess([])
		await withSilencedConsole(async () => await updateContentScriptInjectionStrategy())
		assert.equal((await getLatestUnexpectedError())?.data.code, 'content_script_registration_cleanup_failed')
		setWebsiteAccess([disabledWebsiteAccessEntry('localhost:3000')])
		await updateContentScriptInjectionStrategy()

		// The half-removed host is not taken for a complete registration: its leftover script is removed and both of its scripts are registered again.
		assert.deepEqual(getFirefoxContentScriptOperations(), ['register 1', 'register 2', 'unregister 1', 'unregister 2', 'unregister 2', 'register 3', 'register 4'])
		assert.deepEqual(getActiveFirefoxContentScripts().map(({ world }) => world), ['ISOLATED', 'MAIN'])
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
