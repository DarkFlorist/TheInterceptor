import * as assert from 'assert'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { describe, test } from 'bun:test'
import { installDateMock, installDomMock } from './domMock.js'

type RuntimeMessage = {
	method?: string
	type?: string
	data?: unknown
}

function createBrowserMock() {
	const storageState: Record<string, unknown> = {}
	const sentMessages: RuntimeMessage[] = []
	const getStorageItems = (keys?: string | string[] | Record<string, unknown> | null) => {
		if (keys === undefined || keys === null) return { ...storageState }
		if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, storageState[key]]))
		if (typeof keys === 'string') return { [keys]: storageState[keys] }
		return Object.fromEntries(Object.entries(keys).map(([key, defaultValue]) => [key, key in storageState ? storageState[key] : defaultValue]))
	}

	const browserMock = {
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
				async set(items: Record<string, unknown>) {
					Object.assign(storageState, items)
				},
				async remove(keys: string | string[]) {
					for (const key of Array.isArray(keys) ? keys : [keys]) delete storageState[key]
				},
			},
		},
		tabs: {
			async query() { return [] },
			async get() { return undefined },
			async update() { return undefined },
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
	}

	Object.defineProperty(globalThis, 'browser', { value: browserMock, configurable: true, writable: true })
	Object.defineProperty(globalThis, 'chrome', { value: { runtime: { id: 'test-extension' } }, configurable: true, writable: true })

	return {
		sentMessages,
		reset() {
			for (const key of Object.keys(storageState)) delete storageState[key]
			sentMessages.length = 0
			browserMock.runtime.lastError = null
		},
	}
}

const browserMock = createBrowserMock()

async function loadModules() {
	return {
		...await import('../../app/ts/utils/errors.js'),
		...await import('../../app/ts/background/storageVariables.js'),
		...await import('../../app/ts/components/subcomponents/Error.js'),
	}
}

const modulesPromise = loadModules()

describe('unexpected error diagnostics', () => {
	test('keeps forwarded InterceptorError diagnostics out of the popup message', async () => {
		browserMock.reset()
		const { handleUnexpectedError, getLatestUnexpectedError, GENERIC_UNEXPECTED_ERROR_MESSAGE } = await modulesPromise
		const diagnosticsMessage = 'inpage: Request did not exist anymore\n\nphase: handle background reply\n\nrequestMethod: eth_accounts\n\nrequestId: 17\n\nthrown:\nError: Request did not exist anymore'

		await handleUnexpectedError({ method: 'InterceptorError', params: [diagnosticsMessage] })

		const latestUnexpectedError = await getLatestUnexpectedError()
		assert.equal(latestUnexpectedError?.data.message, GENERIC_UNEXPECTED_ERROR_MESSAGE)
		assert.equal(latestUnexpectedError?.data.source, 'internal')
		assert.equal(latestUnexpectedError?.data.code, 'unexpected_error')
		assert.equal(typeof latestUnexpectedError?.data.debugId, 'string')
		assert.equal(browserMock.sentMessages.length, 1)
	})

	test('keeps plain unexpected errors unchanged', async () => {
		browserMock.reset()
		const { handleUnexpectedError, getLatestUnexpectedError } = await modulesPromise

		await handleUnexpectedError(new Error('plain error'))

		const latestUnexpectedError = await getLatestUnexpectedError()
		assert.equal(latestUnexpectedError?.data.message, 'plain error')
		assert.equal(latestUnexpectedError?.data.source, 'internal')
		assert.equal(latestUnexpectedError?.data.code, 'unexpected_error')
		assert.equal(typeof latestUnexpectedError?.data.debugId, 'string')
	})

	test('renders forwarded diagnostics directly from the message string in the existing unexpected error popup', async () => {
		const { UnexpectedError } = await modulesPromise
		const dom = installDomMock()
		const clock = installDateMock('2024-01-01T00:00:10.000Z')
		const timestamp = new Date('2024-01-01T00:00:05.000Z')
		const diagnosticMessage = 'inpage: Request did not exist anymore\n\nphase: handle background reply\n\nrequestMethod: eth_accounts\n\nrequestId: 17'

		await act(() => {
			render(h(UnexpectedError, {
				close: () => undefined,
				error: {
					message: diagnosticMessage,
					timestamp,
				},
			}), dom.document.body)
		})
		assert.equal(dom.document.body.textContent?.includes('inpage: Request did not exist anymore'), true)
		assert.equal(dom.document.body.textContent?.includes('phase: handle background reply'), true)
		assert.equal(dom.document.body.textContent?.includes('requestMethod: eth_accounts'), true)

		await act(() => {
			render(h(UnexpectedError, {
				close: () => undefined,
				error: {
					message: 'Local render error',
					timestamp,
				},
			}), dom.document.body)
		})
		assert.equal(dom.document.body.textContent?.includes('Local render error'), true)

		clock.restore()
		dom.restore()
	})
})
