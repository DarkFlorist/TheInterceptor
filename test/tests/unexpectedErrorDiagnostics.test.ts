import * as assert from 'assert'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { describe, test } from 'bun:test'
import { installDateMock, installDomMock } from './domMock.js'

const { NEW_BLOCK_ABORT } = await import('../../app/ts/utils/constants.js')

type RuntimeMessage = {
	method?: string
	type?: string
	data?: unknown
}

function createBrowserMock() {
	const storageState: Record<string, unknown> = {}
	const sentMessages: RuntimeMessage[] = []
	const defaultSendMessage = async (message: RuntimeMessage) => {
		sentMessages.push(message)
		return undefined
	}
	const getStorageItems = (keys?: string | string[] | Record<string, unknown> | null) => {
		if (keys === undefined || keys === null) return { ...storageState }
		if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, storageState[key]]))
		if (typeof keys === 'string') return { [keys]: storageState[keys] }
		return Object.fromEntries(Object.entries(keys).map(([key, defaultValue]) => [key, key in storageState ? storageState[key] : defaultValue]))
	}

	const browserMock = {
		runtime: {
			lastError: null,
			sendMessage: defaultSendMessage,
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
			browserMock.runtime.sendMessage = defaultSendMessage
		},
		setSendMessage(sendMessage: (message: RuntimeMessage) => Promise<unknown>) {
			browserMock.runtime.sendMessage = sendMessage
		},
	}
}

const browserMock = createBrowserMock()

async function loadModules() {
	return {
		...await import('../../app/ts/utils/errors.js'),
		...await import('../../app/ts/utils/requests.js'),
		...await import('../../app/ts/background/storageVariables.js'),
		...await import('../../app/ts/components/subcomponents/Error.js'),
	}
}

const modulesPromise = loadModules()

describe('unexpected error diagnostics', () => {
	test('recognizes expected infrastructure errors from unknown thrown values', async () => {
		const { classifyCaughtError, isExpectedInfrastructureError, isFailedToFetchError, isNewBlockAbort } = await modulesPromise

		assert.equal(isNewBlockAbort(new Error(NEW_BLOCK_ABORT)), true)
		assert.equal(isNewBlockAbort(NEW_BLOCK_ABORT), true)
		assert.equal(isNewBlockAbort({ message: NEW_BLOCK_ABORT }), true)
		assert.equal(isNewBlockAbort(new Error(`wrapped ${ NEW_BLOCK_ABORT }`)), false)
		assert.equal(isNewBlockAbort(new Error('different abort')), false)
		assert.equal(isNewBlockAbort(undefined), false)

		assert.equal(isFailedToFetchError(new Error('Failed to fetch')), true)
		assert.equal(isFailedToFetchError('NetworkError when attempting to fetch resource'), true)
		assert.equal(isFailedToFetchError({ message: 'Fetch request timed out.' }), true)
		assert.equal(isFailedToFetchError({ message: 'Fetch request aborted.' }), true)
		assert.equal(isFailedToFetchError('unrelated error'), false)

		assert.equal(classifyCaughtError(NEW_BLOCK_ABORT), 'newBlockAbort')
		assert.equal(classifyCaughtError(new Error('Failed to fetch')), 'failedToFetch')
		assert.equal(classifyCaughtError(new Error(`wrapped ${ NEW_BLOCK_ABORT }`)), 'unexpected')
		assert.equal(isExpectedInfrastructureError(NEW_BLOCK_ABORT), true)
		assert.equal(isExpectedInfrastructureError(new Error(`wrapped ${ NEW_BLOCK_ABORT }`)), false)
	})

	test('does not report new-block aborts as unexpected errors', async () => {
		browserMock.reset()
		const { handleUnexpectedError, getLatestUnexpectedError } = await modulesPromise

		await handleUnexpectedError(NEW_BLOCK_ABORT)
		await handleUnexpectedError(new Error(NEW_BLOCK_ABORT))

		assert.equal(await getLatestUnexpectedError(), undefined)
		assert.equal(browserMock.sentMessages.length, 0)
	})

	test('reports wrapped new-block aborts as unexpected development errors', async () => {
		browserMock.reset()
		const { handleUnexpectedError, getLatestUnexpectedError } = await modulesPromise

		await handleUnexpectedError(new Error(`Failed to refresh metadata: ${ NEW_BLOCK_ABORT }`))

		const latestUnexpectedError = await getLatestUnexpectedError()
		assert.equal(latestUnexpectedError?.data.message, `Failed to refresh metadata: ${ NEW_BLOCK_ABORT }`)
		assert.equal(latestUnexpectedError?.data.code, 'wrapped_new_block_abort')
		assert.equal(browserMock.sentMessages.length, 1)
	})

	test('records unexpected errors even when broadcasting the notification fails', async () => {
		browserMock.reset()
		browserMock.setSendMessage(async () => { throw new Error('broadcast failed') })
		const { handleUnexpectedError, getLatestUnexpectedError } = await modulesPromise

		await handleUnexpectedError(new Error('root failure'))

		const latestUnexpectedError = await getLatestUnexpectedError()
		assert.equal(latestUnexpectedError?.data.message, 'root failure')
		assert.equal(latestUnexpectedError?.data.code, 'unexpected_error')
		assert.equal(browserMock.sentMessages.length, 0)
	})

	test('preserves caller abort reasons from fetch requests', async () => {
		const { fetchWithTimeout } = await modulesPromise
		const originalFetch = globalThis.fetch
		globalThis.fetch = async (_resource, init) => {
			const signal = init?.signal
			if (!(signal instanceof AbortSignal)) throw new Error('missing abort signal')
			await new Promise((_resolve, reject) => {
				signal.addEventListener('abort', () => reject(new DOMException('The user aborted a request.')), { once: true })
			})
			throw new Error('unreachable')
		}
		try {
			const requestAbortController = new AbortController()
			const requestPromise = fetchWithTimeout('https://example.invalid', undefined, 60_000, requestAbortController)
			requestAbortController.abort(NEW_BLOCK_ABORT)
			await assert.rejects(requestPromise, (error) => error === NEW_BLOCK_ABORT)
		} finally {
			globalThis.fetch = originalFetch
		}
	})

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
					source: 'inpage',
					code: 'forwarded',
					debugId: 'debug-1234',
				},
			}), dom.document.body)
		})
		assert.equal(dom.document.body.textContent?.includes('inpage: Request did not exist anymore'), true)
		assert.equal(dom.document.body.textContent?.includes('phase: handle background reply'), true)
		assert.equal(dom.document.body.textContent?.includes('requestMethod: eth_accounts'), true)
		assert.equal(dom.document.body.textContent?.includes('source: inpage'), true)
		assert.equal(dom.document.body.textContent?.includes('code: forwarded'), true)
		assert.equal(dom.document.body.textContent?.includes('debug: debug-1234'), true)

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
