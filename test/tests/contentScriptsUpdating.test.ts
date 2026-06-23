import * as assert from 'assert'
import { describe, test } from 'bun:test'

type RuntimeMessage = {
	readonly method?: string
	readonly data?: { readonly message?: string, readonly code?: string }
}

type BrowserMockOptions = {
	readonly registerError?: Error
	readonly executeScriptError?: Error
}

function installBrowserMock({ registerError, executeScriptError }: BrowserMockOptions = {}) {
	const storageState: Record<string, unknown> = {}
	const sentMessages: RuntimeMessage[] = []
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
					async get(keys?: string | string[] | Record<string, unknown> | null) { return getStorageItems(keys) },
					async set(items: Record<string, unknown>) { Object.assign(storageState, items) },
					async remove(keys: string | string[]) {
						for (const key of Array.isArray(keys) ? keys : [keys]) delete storageState[key]
					},
				},
			},
			scripting: {
				async unregisterContentScripts() { return undefined },
				async registerContentScripts() {
					if (registerError !== undefined) throw registerError
					return undefined
				},
			},
			tabs: {
				async query() { return [{ id: 42, url: 'https://example.com/' }] },
				async get() { return undefined },
				async update() { return undefined },
				async executeScript() {
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

describe('content script injection strategy errors', () => {
	test('records manifest v3 registration failures as unexpected errors', async () => {
		const { sentMessages } = installBrowserMock({ registerError: new Error('registration failed') })
		const { updateContentScriptInjectionStrategyManifestV3, getLatestUnexpectedError } = await loadModules()

		await updateContentScriptInjectionStrategyManifestV3()

		const latestUnexpectedError = await getLatestUnexpectedError()
		assert.equal(latestUnexpectedError?.data.message, 'registration failed')
		assert.equal(latestUnexpectedError?.data.code, 'content_script_registration_failed')
		assert.equal(sentMessages.at(-1)?.method, 'popup_UnexpectedErrorOccured')
	})

	test('keeps missing-tab manifest v2 injection failures ignored', async () => {
		const { getCommittedListener } = installBrowserMock({ executeScriptError: new Error('No tab with id: 42.') })
		const { updateContentScriptInjectionStrategyManifestV2, getLatestUnexpectedError } = await loadModules()

		await updateContentScriptInjectionStrategyManifestV2()
		await getCommittedListener()(committedDetails)

		assert.equal(await getLatestUnexpectedError(), undefined)
	})

	test('records unexpected manifest v2 injection failures', async () => {
		const { getCommittedListener } = installBrowserMock({ executeScriptError: new Error('executeScript failed') })
		const { updateContentScriptInjectionStrategyManifestV2, getLatestUnexpectedError } = await loadModules()

		await updateContentScriptInjectionStrategyManifestV2()
		await getCommittedListener()(committedDetails)

		const latestUnexpectedError = await getLatestUnexpectedError()
		assert.equal(latestUnexpectedError?.data.message, 'executeScript failed')
		assert.equal(latestUnexpectedError?.data.code, 'content_script_injection_failed')
	})
})
