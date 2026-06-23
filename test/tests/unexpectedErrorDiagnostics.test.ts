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
	const defaultSetStorage = async (items: Record<string, unknown>) => {
		Object.assign(storageState, items)
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
				set: defaultSetStorage,
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
			browserMock.storage.local.set = defaultSetStorage
		},
		setSendMessage(sendMessage: (message: RuntimeMessage) => Promise<unknown>) {
			browserMock.runtime.sendMessage = sendMessage
		},
		setStorageSet(set: (items: Record<string, unknown>) => Promise<void>) {
			browserMock.storage.local.set = set
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
		const { classifyCaughtError, createInterceptorInternalError, isExpectedInfrastructureError, isFailedToFetchError, isNewBlockAbort } = await modulesPromise

		assert.equal(isNewBlockAbort(new Error(NEW_BLOCK_ABORT)), true)
		assert.equal(isNewBlockAbort(NEW_BLOCK_ABORT), true)
		assert.equal(isNewBlockAbort({ message: NEW_BLOCK_ABORT }), true)
		assert.equal(isNewBlockAbort(new Error(`wrapped ${ NEW_BLOCK_ABORT }`)), false)
		assert.equal(isNewBlockAbort(new Error('different abort')), false)
		assert.equal(isNewBlockAbort(undefined), false)

		assert.equal(isFailedToFetchError(new Error('Failed to fetch')), true)
		assert.equal(isFailedToFetchError('NetworkError when attempting to fetch resource'), true)
		assert.equal(isFailedToFetchError(createInterceptorInternalError('Fetch request timed out.', 'fetch_timeout')), true)
		assert.equal(isFailedToFetchError(createInterceptorInternalError('Fetch request aborted.', 'fetch_aborted')), true)
		assert.equal(isFailedToFetchError(createInterceptorInternalError('Failed to fetch', 'fetch_transport_failed')), true)
		assert.equal(isFailedToFetchError({ message: 'Fetch request timed out.' }), false)
		assert.equal(isFailedToFetchError({ message: 'Fetch request aborted.' }), false)
		assert.equal(isFailedToFetchError('unrelated error'), false)

		assert.equal(classifyCaughtError(NEW_BLOCK_ABORT), 'newBlockAbort')
		assert.equal(classifyCaughtError(new Error('Failed to fetch')), 'failedToFetch')
		assert.equal(classifyCaughtError(new Error(`wrapped ${ NEW_BLOCK_ABORT }`)), 'unexpected')
		assert.equal(isExpectedInfrastructureError(NEW_BLOCK_ABORT), true)
		assert.equal(isExpectedInfrastructureError(new Error(`wrapped ${ NEW_BLOCK_ABORT }`)), false)
	})

	test('does not report new-block aborts as unexpected errors', async () => {
		browserMock.reset()
		const { createInterceptorInternalError, getInterceptorErrorDiagnostics, reportUnexpectedError, getLatestUnexpectedError } = await modulesPromise

		await reportUnexpectedError(NEW_BLOCK_ABORT)
		await reportUnexpectedError(new Error(NEW_BLOCK_ABORT))
		await reportUnexpectedError(createInterceptorInternalError('Fetch request timed out.', 'fetch_timeout'))

		assert.equal(await getLatestUnexpectedError(), undefined)
		assert.equal((await getInterceptorErrorDiagnostics()).length, 0)
		assert.equal(browserMock.sentMessages.length, 0)
	})

	test('reports explicit expected-infrastructure diagnostics when suppression is disabled', async () => {
		browserMock.reset()
		const { createInterceptorInternalError, getLatestUnexpectedError, reportUnexpectedError } = await modulesPromise

		await reportUnexpectedError(createInterceptorInternalError('Failed to fetch', 'fetch_transport_failed'), {
			source: 'popup',
			code: 'popup_message_listener_failed',
			suppressExpectedInfrastructure: false,
		})

		const latestUnexpectedError = await getLatestUnexpectedError()
		assert.equal(latestUnexpectedError?.data.message, 'Failed to fetch')
		assert.equal(latestUnexpectedError?.data.source, 'popup')
		assert.equal(latestUnexpectedError?.data.code, 'popup_message_listener_failed')
		assert.equal(browserMock.sentMessages.length, 1)
	})

	test('reports wrapped new-block aborts as unexpected development errors', async () => {
		browserMock.reset()
		const { reportUnexpectedError, getLatestUnexpectedError } = await modulesPromise

		await reportUnexpectedError(new Error(`Failed to refresh metadata: ${ NEW_BLOCK_ABORT }`))

		const latestUnexpectedError = await getLatestUnexpectedError()
		assert.equal(latestUnexpectedError?.data.message, `Failed to refresh metadata: ${ NEW_BLOCK_ABORT }`)
		assert.equal(latestUnexpectedError?.data.code, 'wrapped_new_block_abort')
		assert.equal(browserMock.sentMessages.length, 1)
	})

	test('records unexpected errors even when broadcasting the notification fails', async () => {
		browserMock.reset()
		browserMock.setSendMessage(async () => { throw new Error('broadcast failed') })
		const { reportUnexpectedError, getLatestUnexpectedError } = await modulesPromise

		await reportUnexpectedError(new Error('root failure'))

		const latestUnexpectedError = await getLatestUnexpectedError()
		assert.equal(latestUnexpectedError?.data.message, 'root failure')
		assert.equal(latestUnexpectedError?.data.code, 'unexpected_error')
		assert.equal(browserMock.sentMessages.length, 0)
	})

	test('broadcasts unexpected errors even when persistence fails', async () => {
		browserMock.reset()
		browserMock.setStorageSet(async () => { throw new Error('storage failed') })
		const { reportUnexpectedError, getLatestUnexpectedError } = await modulesPromise

		await reportUnexpectedError(new Error('root failure'))

		assert.equal(await getLatestUnexpectedError(), undefined)
		assert.equal(browserMock.sentMessages.length, 1)
		const [message] = browserMock.sentMessages
		assert.equal(message?.method, 'popup_UnexpectedErrorOccured')
		const data = message?.data
		if (typeof data !== 'object' || data === null || !('code' in data)) throw new Error('missing unexpected error data')
		assert.equal(data.code, 'unexpected_error_persist_failed')
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
		const { reportUnexpectedError, getLatestUnexpectedError, GENERIC_UNEXPECTED_ERROR_MESSAGE } = await modulesPromise
		const diagnosticsMessage = 'inpage: Request did not exist anymore\n\nphase: handle background reply\n\nrequestMethod: eth_accounts\n\nrequestId: 17\n\nthrown:\nError: Request did not exist anymore'

		await reportUnexpectedError({ method: 'InterceptorError', params: [diagnosticsMessage] })

		const latestUnexpectedError = await getLatestUnexpectedError()
		assert.equal(latestUnexpectedError?.data.message, GENERIC_UNEXPECTED_ERROR_MESSAGE)
		assert.equal(latestUnexpectedError?.data.source, 'internal')
		assert.equal(latestUnexpectedError?.data.code, 'unexpected_error')
		assert.equal(typeof latestUnexpectedError?.data.debugId, 'string')
		assert.equal(browserMock.sentMessages.length, 1)
	})

	test('keeps plain unexpected errors unchanged', async () => {
		browserMock.reset()
		const { getInterceptorErrorDiagnostics, reportUnexpectedError, getLatestUnexpectedError } = await modulesPromise

		await reportUnexpectedError(new Error('plain error'))

		const latestUnexpectedError = await getLatestUnexpectedError()
		assert.equal(latestUnexpectedError?.data.message, 'plain error')
		assert.equal(latestUnexpectedError?.data.source, 'internal')
		assert.equal(latestUnexpectedError?.data.code, 'unexpected_error')
		assert.equal(typeof latestUnexpectedError?.data.debugId, 'string')
		const diagnostics = await getInterceptorErrorDiagnostics()
		assert.equal(diagnostics.length, 1)
		const [diagnostic] = diagnostics
		assert.equal(diagnostic?.message, 'plain error')
		assert.equal(diagnostic?.cause, 'plain error')
		assert.equal(diagnostic?.category, 'unexpected')
		assert.equal(diagnostic?.severity, 'error')
		assert.equal(diagnostic?.userVisible, true)
		assert.equal(diagnostic?.source, 'internal')
		assert.equal(diagnostic?.code, 'unexpected_error')
		assert.equal(typeof diagnostic?.debugId, 'string')
	})

	test('uses metadata message without dropping the original error cause', async () => {
		browserMock.reset()
		const { getInterceptorErrorDiagnostics, reportUnexpectedError, getLatestUnexpectedError } = await modulesPromise

		await reportUnexpectedError(new Error('root failure'), {
			code: 'contextual_failure',
			displayMessage: 'Failed to refresh contextual data: root failure',
			details: { address: '0xabc' },
		})

		const latestUnexpectedError = await getLatestUnexpectedError()
		assert.equal(latestUnexpectedError?.data.message, 'Failed to refresh contextual data: root failure')
		assert.equal(latestUnexpectedError?.data.code, 'contextual_failure')
		const diagnostics = await getInterceptorErrorDiagnostics()
		assert.equal(diagnostics.length, 1)
		const [diagnostic] = diagnostics
		assert.equal(diagnostic?.message, 'Failed to refresh contextual data: root failure')
		assert.equal(diagnostic?.cause, 'root failure')
		assert.equal(diagnostic?.details, '{"address":"0xabc"}')
	})

	test('records local recovery diagnostics without notifying the popup', async () => {
		browserMock.reset()
		const { getInterceptorErrorDiagnostics, getLatestUnexpectedError, reportLocalRecovery } = await modulesPromise

		await reportLocalRecovery(new Error('decode failed'), {
			code: 'test_local_recovery',
			message: 'Continuing after a recovered test failure.',
			details: { tokenId: 1n },
		})

		assert.equal(await getLatestUnexpectedError(), undefined)
		assert.equal(browserMock.sentMessages.length, 0)
		const diagnostics = await getInterceptorErrorDiagnostics()
		assert.equal(diagnostics.length, 1)
		const [diagnostic] = diagnostics
		assert.equal(diagnostic?.message, 'Continuing after a recovered test failure.')
		assert.equal(diagnostic?.cause, 'decode failed')
		assert.equal(diagnostic?.category, 'local_recovery')
		assert.equal(diagnostic?.severity, 'warning')
		assert.equal(diagnostic?.userVisible, false)
		assert.equal(diagnostic?.code, 'test_local_recovery')
		assert.equal(diagnostic?.details, '{"tokenId":"1"}')
	})

	test('best-effort local recovery does not block on diagnostic persistence', async () => {
		browserMock.reset()
		let storageSetStarted = false
		let releaseStorageSet: (() => void) | undefined
		browserMock.setStorageSet(async () => {
			storageSetStarted = true
			await new Promise<void>((resolve) => {
				releaseStorageSet = resolve
			})
		})
		const { getLatestUnexpectedError, reportLocalRecoveryBestEffort } = await modulesPromise

		reportLocalRecoveryBestEffort(new Error('parse failed'), {
			code: 'test_best_effort_recovery',
			message: 'Continuing without waiting for diagnostic persistence.',
		})

		assert.equal(storageSetStarted, false)
		for (let index = 0; index < 10 && !storageSetStarted; index++) await Promise.resolve()
		assert.equal(storageSetStarted, true)
		releaseStorageSet?.()
		await Promise.resolve()
		assert.equal(await getLatestUnexpectedError(), undefined)
		assert.equal(browserMock.sentMessages.length, 0)
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
