import * as assert from 'assert'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { describe, test } from 'bun:test'
import type { InterceptorErrorDiagnostic } from '../../app/ts/types/errorDiagnostics.js'
import { installDateMock, installDomMock } from './domMock.js'
import { withSilencedConsole } from './consoleSilence.js'

const { NEW_BLOCK_ABORT } = await import('../../app/ts/utils/constants.js')
const { classifyCaughtError, createInterceptorInternalError, hasInterceptorInternalErrorCode, isExpectedInfrastructureError, shouldSuppressUnexpectedErrorReport } = await import('../../app/ts/utils/errors.js')
const { createSafeValidationError } = await import('../../app/ts/safe/safeErrors.js')

test('Safe failures use the shared internal error classification mechanism', () => {
	const error = createSafeValidationError('Select a Safe owner.', 'safe_signer_selection')

	assert.equal(hasInterceptorInternalErrorCode(error, 'safe_signer_selection'), true)
	assert.equal(hasInterceptorInternalErrorCode(error, 'safe_owner_validation'), false)
	assert.equal(hasInterceptorInternalErrorCode(new Error('Select a Safe owner.'), 'safe_signer_selection'), false)
	assert.equal(classifyCaughtError(error), 'handled')
	assert.equal(shouldSuppressUnexpectedErrorReport(error), true)
	assert.equal(isExpectedInfrastructureError(error), false)
})

test('shared error infrastructure stays independent from Safe error codes', async () => {
	const caughtErrorsSource = await Bun.file(new URL('../../app/ts/utils/caughtErrors.ts', import.meta.url)).text()
	const errorsSource = await Bun.file(new URL('../../app/ts/utils/errors.ts', import.meta.url)).text()

	assert.doesNotMatch(caughtErrorsSource, /safe_/u)
	assert.doesNotMatch(errorsSource, /safeValidation/u)
})

type RuntimeMessage = {
	method?: string
	type?: string
	data?: unknown
}

async function captureConsoleCalls<T>(run: () => Promise<T>) {
	const originalConsoleError = console.error
	const originalConsoleTrace = console.trace
	const originalConsoleWarn = console.warn
	const consoleErrors: unknown[][] = []
	const consoleTraces: unknown[][] = []
	const consoleWarns: unknown[][] = []
	console.error = (...args: unknown[]) => {
		consoleErrors.push(args)
	}
	console.trace = (...args: unknown[]) => {
		consoleTraces.push(args)
	}
	console.warn = (...args: unknown[]) => {
		consoleWarns.push(args)
	}
	try {
		return {
			result: await run(),
			consoleErrors,
			consoleTraces,
			consoleWarns,
		}
	} finally {
		console.error = originalConsoleError
		console.trace = originalConsoleTrace
		console.warn = originalConsoleWarn
	}
}

function createBrowserMock() {
	const storageState: Record<string, unknown> = {}
	const sentMessages: RuntimeMessage[] = []
	let onMessageListener: ((message: unknown) => unknown) | undefined
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
			onMessage: { addListener(listener: (message: unknown) => unknown) { onMessageListener = listener }, removeListener: () => undefined },
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
			onMessageListener = undefined
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
		async writeStorage(items: Record<string, unknown>) {
			await defaultSetStorage(items)
		},
		emitRuntimeMessage(message: unknown) {
			onMessageListener?.(message)
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

const storageDiagnostic = (index: number, rawError: string): InterceptorErrorDiagnostic => ({
	timestamp: new Date(`2026-01-0${ index }T00:00:00.000Z`),
	source: 'test',
	code: `storage_${ index }`,
	category: 'unexpected',
	severity: 'error',
	message: `Storage diagnostic ${ index }`,
	cause: undefined,
	rawError,
	userVisible: true,
	debugId: `storage-${ index }`,
	details: undefined,
})

describe('unexpected error diagnostics', () => {
	test('preserves diagnostics stored before raw errors were recorded', async () => {
		browserMock.reset()
		const { appendInterceptorErrorDiagnostic, getInterceptorErrorDiagnostics } = await modulesPromise
		await browserMock.writeStorage({ interceptorErrorDiagnostics: [{
			timestamp: '0x6955b900',
			source: 'background',
			code: 'legacy_failure',
			category: 'unexpected',
			severity: 'error',
			message: 'Previously recorded failure',
			userVisible: true,
		}] })

		const legacy = await getInterceptorErrorDiagnostics()
		assert.equal(legacy.length, 1)
		assert.equal(legacy[0]?.message, 'Previously recorded failure')
		assert.equal(legacy[0]?.rawError, undefined)

		await appendInterceptorErrorDiagnostic(storageDiagnostic(2, 'new raw error'))
		assert.deepEqual((await getInterceptorErrorDiagnostics()).map((record) => record.code), ['legacy_failure', 'storage_2'])
	})

	test('preserves the latest unexpected error stored without raw details', async () => {
		browserMock.reset()
		const { getLatestUnexpectedError } = await modulesPromise
		await browserMock.writeStorage({ latestUnexpectedError: {
			method: 'popup_UnexpectedErrorOccured',
			data: {
				timestamp: '0x6955b900',
				message: 'Previously recorded popup failure',
				source: 'popup',
				code: 'legacy_popup_failure',
			},
		} })

		const latest = await getLatestUnexpectedError()
		assert.equal(latest?.data.message, 'Previously recorded popup failure')
		assert.equal(latest?.data.rawError, undefined)
	})

	test('returns and clears stored diagnostics for the management page', async () => {
		browserMock.reset()
		const { appendInterceptorErrorDiagnostic, getInterceptorErrorDiagnostics } = await import('../../app/ts/background/storageVariables.js')
		const { clearDiagnostics, requestDiagnostics } = await import('../../app/ts/background/popupMessageHandlers.js')
		await appendInterceptorErrorDiagnostic({
			timestamp: new Date('2026-01-01T00:00:00.000Z'),
			source: 'test',
			code: 'test_diagnostic',
			category: 'unexpected',
			severity: 'error',
			message: 'Test diagnostic',
			cause: 'root failure',
			userVisible: true,
			debugId: 'debug-1',
			details: undefined,
		})

		const requestReply = await requestDiagnostics()
		assert.equal(requestReply.method, 'popup_requestDiagnostics')
		assert.equal(requestReply.diagnostics.length, 1)
		assert.equal(requestReply.diagnostics[0]?.code, 'test_diagnostic')

		const clearReply = await clearDiagnostics()
		assert.deepEqual(clearReply, { method: 'popup_clearDiagnostics', diagnostics: [] })
		assert.deepEqual(await getInterceptorErrorDiagnostics(), [])
	})

	test('clearing diagnostics waits for an earlier append and removes its completed result', async () => {
		browserMock.reset()
		const { appendInterceptorErrorDiagnostic, getInterceptorErrorDiagnostics } = await import('../../app/ts/background/storageVariables.js')
		const { clearDiagnostics } = await import('../../app/ts/background/popupMessageHandlers.js')
		let releaseStorageWrite = () => undefined
		const storageWriteGate = new Promise<void>((resolve) => { releaseStorageWrite = resolve })
		let reportStorageWriteStarted = () => undefined
		const storageWriteStarted = new Promise<void>((resolve) => { reportStorageWriteStarted = resolve })
		browserMock.setStorageSet(async (items) => {
			reportStorageWriteStarted()
			await storageWriteGate
			await browserMock.writeStorage(items)
		})

		const appendPromise = appendInterceptorErrorDiagnostic({
			timestamp: new Date('2026-01-01T00:00:00.000Z'),
			source: 'test',
			code: 'concurrent_diagnostic',
			category: 'unexpected',
			severity: 'error',
			message: 'Concurrent diagnostic',
			cause: undefined,
			userVisible: false,
			debugId: undefined,
			details: undefined,
		})
		await storageWriteStarted
		let clearSettled = false
		const clearPromise = clearDiagnostics().then((reply) => {
			clearSettled = true
			return reply
		})
		await Promise.resolve()
		assert.equal(clearSettled, false)

		releaseStorageWrite()
		await appendPromise
		assert.deepEqual(await clearPromise, { method: 'popup_clearDiagnostics', diagnostics: [] })
		assert.deepEqual(await getInterceptorErrorDiagnostics(), [])
	})

	test('retains complete recent records within the diagnostic storage budget', async () => {
		browserMock.reset()
		const { appendInterceptorErrorDiagnostic, getInterceptorErrorDiagnostics } = await modulesPromise
		for (let index = 1; index <= 3; index++) await appendInterceptorErrorDiagnostic(storageDiagnostic(index, 'x'.repeat(220_000)))

		const diagnostics = await getInterceptorErrorDiagnostics()
		assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.code), ['storage_2', 'storage_3'])
		assert.equal(diagnostics[0]?.rawError?.length, 220_000)
		assert.equal(diagnostics[1]?.rawError?.length, 220_000)
	})

	test('shows a storage-budget record instead of writing one oversized raw error', async () => {
		browserMock.reset()
		const { appendInterceptorErrorDiagnostic, getInterceptorErrorDiagnostics } = await modulesPromise
		let largestWrite = 0
		browserMock.setStorageSet(async (items) => {
			largestWrite = Math.max(largestWrite, JSON.stringify(items).length)
			await browserMock.writeStorage(items)
		})

		await appendInterceptorErrorDiagnostic(storageDiagnostic(1, 'x'.repeat(600_000)))
		const [fallback] = await getInterceptorErrorDiagnostics()
		assert.equal(fallback?.code, 'storage_1')
		assert.match(fallback?.rawError ?? '', /diagnostic storage budget/u)
		assert.equal(largestWrite < 512_000, true)

		await appendInterceptorErrorDiagnostic(storageDiagnostic(2, 'next error'))
		assert.equal((await getInterceptorErrorDiagnostics()).at(-1)?.rawError, 'next error')
	})

	test('recovers from storage quota errors and marks an oversized raw record', async () => {
		browserMock.reset()
		const { appendInterceptorErrorDiagnostic, getInterceptorErrorDiagnostics } = await modulesPromise
		browserMock.setStorageSet(async (items) => {
			if (JSON.stringify(items).length > 1_500) throw new Error('QUOTA_BYTES quota exceeded')
			await browserMock.writeStorage(items)
		})
		for (let index = 1; index <= 3; index++) await appendInterceptorErrorDiagnostic(storageDiagnostic(index, 'x'.repeat(500)))
		assert.deepEqual((await getInterceptorErrorDiagnostics()).map((diagnostic) => diagnostic.code), ['storage_2', 'storage_3'])

		await appendInterceptorErrorDiagnostic(storageDiagnostic(4, 'x'.repeat(2_000)))
		const [fallback] = await getInterceptorErrorDiagnostics()
		assert.equal(fallback?.code, 'storage_4')
		assert.match(fallback?.message ?? '', /could not be stored/u)
		assert.match(fallback?.rawError ?? '', /storage quota/u)

		await appendInterceptorErrorDiagnostic(storageDiagnostic(5, 'next error'))
		assert.equal((await getInterceptorErrorDiagnostics()).at(-1)?.rawError, 'next error')
	})

	test('keeps recording after both fallback paths encounter a full storage quota', async () => {
		browserMock.reset()
		const { appendInterceptorErrorDiagnostic, getInterceptorErrorDiagnostics } = await modulesPromise
		let storageIsFull = true
		browserMock.setStorageSet(async (items) => {
			if (storageIsFull) throw new Error('QUOTA_BYTES quota exceeded')
			await browserMock.writeStorage(items)
		})

		assert.equal(await appendInterceptorErrorDiagnostic(storageDiagnostic(1, 'x'.repeat(600_000))), 'storage-full')
		assert.equal(await appendInterceptorErrorDiagnostic(storageDiagnostic(2, 'small error')), 'storage-full')
		assert.deepEqual(await getInterceptorErrorDiagnostics(), [])

		storageIsFull = false
		assert.equal(await appendInterceptorErrorDiagnostic(storageDiagnostic(3, 'recovered error')), 'stored')
		assert.equal((await getInterceptorErrorDiagnostics())[0]?.rawError, 'recovered error')
	})

	test('logs the raw diagnostic when storage is full without rejecting error reporting', async () => {
		browserMock.reset()
		browserMock.setStorageSet(async () => { throw new Error('QUOTA_BYTES quota exceeded') })
		const { reportUnexpectedError } = await modulesPromise
		const { consoleErrors } = await captureConsoleCalls(async () => await reportUnexpectedError(new Error('plain error')))
		const storageFailure = consoleErrors.find((args) => args[0] === 'Failed to persist interceptor error diagnostic because extension storage is full.')
		const loggedDiagnostic: unknown = storageFailure?.[1]
		assert.ok(typeof loggedDiagnostic === 'object' && loggedDiagnostic !== null && 'rawError' in loggedDiagnostic && typeof loggedDiagnostic.rawError === 'string')
		assert.match(loggedDiagnostic.rawError, /plain error/u)
	})

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
		assert.equal(isFailedToFetchError(createInterceptorInternalError('Fetch request timed out.', 'fetch_timeout', 'failedToFetch')), true)
		assert.equal(isFailedToFetchError(createInterceptorInternalError('Fetch request aborted.', 'fetch_aborted', 'failedToFetch')), true)
		assert.equal(isFailedToFetchError(createInterceptorInternalError('Failed to fetch', 'fetch_transport_failed', 'failedToFetch')), true)
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
		await reportUnexpectedError(createInterceptorInternalError('Fetch request timed out.', 'fetch_timeout', 'failedToFetch'))

		assert.equal(await getLatestUnexpectedError(), undefined)
		assert.equal((await getInterceptorErrorDiagnostics()).length, 0)
		assert.equal(browserMock.sentMessages.length, 0)
	})

	test('does not report handled Safe validation failures as unexpected errors', async () => {
		browserMock.reset()
		const { getInterceptorErrorDiagnostics, reportUnexpectedError, getLatestUnexpectedError } = await modulesPromise

		await reportUnexpectedError(createSafeValidationError('Select a current Safe owner.', 'safe_signer_selection'))

		assert.equal(await getLatestUnexpectedError(), undefined)
		assert.equal((await getInterceptorErrorDiagnostics()).length, 0)
		assert.equal(browserMock.sentMessages.length, 0)
	})

	test('records errors whose internal classification getters throw', async () => {
		browserMock.reset()
		const { getInterceptorErrorDiagnostics, reportUnexpectedError } = await modulesPromise
		const codeError = new Error('unreadable code')
		Object.defineProperty(codeError, 'interceptorErrorCode', { get: () => { throw new Error('code getter failed') } })
		const classificationError = new Error('unreadable classification')
		Object.defineProperty(classificationError, 'interceptorErrorCode', { value: 'classification_failure' })
		Object.defineProperty(classificationError, 'interceptorErrorClassification', { get: () => { throw new Error('classification getter failed') } })

		await withSilencedConsole(async () => {
			await reportUnexpectedError(codeError)
			await reportUnexpectedError(classificationError)
		})

		const diagnostics = await getInterceptorErrorDiagnostics()
		assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.message), ['unreadable code', 'unreadable classification'])
		assert.match(diagnostics[0]?.rawError ?? '', /Unreadable property: code getter failed/u)
		assert.match(diagnostics[1]?.rawError ?? '', /Unreadable property: classification getter failed/u)
		assert.match(diagnostics[0]?.rawError ?? '', /"stack":/u)
		assert.match(diagnostics[1]?.rawError ?? '', /"stack":/u)
	})

	test('reports explicit expected-infrastructure diagnostics when suppression is disabled', async () => {
		browserMock.reset()
		const { createInterceptorInternalError, getLatestUnexpectedError, reportUnexpectedError } = await modulesPromise

		await withSilencedConsole(async () => await reportUnexpectedError(createInterceptorInternalError('Failed to fetch', 'fetch_transport_failed', 'failedToFetch'), {
			source: 'popup',
			code: 'popup_message_listener_failed',
			suppressExpectedHandledErrors: false,
		}))

		const latestUnexpectedError = await getLatestUnexpectedError()
		assert.equal(latestUnexpectedError?.data.message, 'Failed to fetch')
		assert.equal(latestUnexpectedError?.data.source, 'popup')
		assert.equal(latestUnexpectedError?.data.code, 'popup_message_listener_failed')
		assert.equal(browserMock.sentMessages.length, 1)
	})

	test('reports wrapped new-block aborts as unexpected development errors', async () => {
		browserMock.reset()
		const { reportUnexpectedError, getLatestUnexpectedError } = await modulesPromise

		await withSilencedConsole(async () => await reportUnexpectedError(new Error(`Failed to refresh metadata: ${ NEW_BLOCK_ABORT }`)))

		const latestUnexpectedError = await getLatestUnexpectedError()
		assert.equal(latestUnexpectedError?.data.message, `Failed to refresh metadata: ${ NEW_BLOCK_ABORT }`)
		assert.equal(latestUnexpectedError?.data.code, 'wrapped_new_block_abort')
		assert.equal(browserMock.sentMessages.length, 1)
	})

	test('records unexpected errors even when broadcasting the notification fails', async () => {
		browserMock.reset()
		browserMock.setSendMessage(async () => { throw new Error('broadcast failed') })
		const { reportUnexpectedError, getLatestUnexpectedError } = await modulesPromise

		await withSilencedConsole(async () => await reportUnexpectedError(new Error('root failure')))

		const latestUnexpectedError = await getLatestUnexpectedError()
		assert.equal(latestUnexpectedError?.data.message, 'root failure')
		assert.equal(latestUnexpectedError?.data.code, 'unexpected_error')
		assert.equal(browserMock.sentMessages.length, 0)
	})

	test('broadcasts unexpected errors even when persistence fails', async () => {
		browserMock.reset()
		browserMock.setStorageSet(async () => { throw new Error('storage failed') })
		const { reportUnexpectedError, getLatestUnexpectedError } = await modulesPromise

		await withSilencedConsole(async () => await reportUnexpectedError(new Error('root failure')))

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

	test('keeps forwarded InterceptorError diagnostics out of the popup message while preserving them in Diagnostics', async () => {
		browserMock.reset()
		const { getInterceptorErrorDiagnostics, reportUnexpectedError, getLatestUnexpectedError, GENERIC_UNEXPECTED_ERROR_MESSAGE } = await modulesPromise
		const diagnosticsMessage = 'inpage: Request did not exist anymore\n\nphase: handle background reply\n\nrequestMethod: eth_accounts\n\nrequestId: 17\n\nthrown:\nError: Request did not exist anymore'

		await withSilencedConsole(async () => await reportUnexpectedError({ method: 'InterceptorError', params: [diagnosticsMessage] }))

		const latestUnexpectedError = await getLatestUnexpectedError()
		assert.equal(latestUnexpectedError?.data.message, GENERIC_UNEXPECTED_ERROR_MESSAGE)
		assert.equal(latestUnexpectedError?.data.source, 'internal')
		assert.equal(latestUnexpectedError?.data.code, 'unexpected_error')
		assert.equal(typeof latestUnexpectedError?.data.debugId, 'string')
		assert.equal(browserMock.sentMessages.length, 1)
		const diagnostics = await getInterceptorErrorDiagnostics()
		assert.equal(diagnostics[0]?.rawError, diagnosticsMessage)
	})

	test('preserves an unexpected error stack, cause, and custom data in Diagnostics', async () => {
		browserMock.reset()
		const { getInterceptorErrorDiagnostics, reportUnexpectedError, getLatestUnexpectedError } = await modulesPromise
		const error = Object.assign(new Error('plain error'), { cause: new Error('root failure'), code: 'E_RENDER', data: { requestId: 17 } })
		error.stack = 'Error: plain error\n    at render (app.js:12:3)'

		await withSilencedConsole(async () => await reportUnexpectedError(error))

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
		if (diagnostic?.rawError === undefined) throw new Error('missing raw error')
		const rawError = JSON.parse(diagnostic.rawError)
		assert.equal(rawError.stack, error.stack)
		assert.equal(rawError.cause.message, 'root failure')
		assert.equal(rawError.code, 'E_RENDER')
		assert.deepEqual(rawError.data, { requestId: 17 })
	})

	test('logs user-facing unexpected errors to the extension console with their diagnostic metadata and cause', async () => {
		browserMock.reset()
		const { reportUnexpectedError } = await modulesPromise

		const { consoleErrors, consoleTraces } = await captureConsoleCalls(async () => await reportUnexpectedError(new Error('plain error')))

		assert.equal(consoleErrors.some((args) =>
			typeof args[0] === 'string'
			&& args[0].startsWith('Unexpected Interceptor error: ')
			&& args[0].includes('code=unexpected_error')
			&& args[0].includes('source=internal')
			&& args[0].includes('debugId=')
			&& args[0].includes('cause=\"plain error\"')
		), true)
		assert.equal(consoleErrors.some((args) => args[0] instanceof Error && args[0].message === 'plain error'), true)
		assert.equal(consoleTraces.length, 0)
		assert.equal(browserMock.sentMessages.length, 1)
		assert.equal(browserMock.sentMessages[0]?.method, 'popup_UnexpectedErrorOccured')
	})

	test('still logs reporting pipeline failures to the extension console', async () => {
		browserMock.reset()
		browserMock.setStorageSet(async () => { throw new Error('storage failed') })
		const { reportUnexpectedError } = await modulesPromise

		const { consoleErrors, consoleTraces } = await captureConsoleCalls(async () => await reportUnexpectedError(new Error('plain error')))

		assert.equal(consoleTraces.length, 0)
		assert.equal(consoleErrors.some((args) => args.includes('Failed to persist interceptor error diagnostic.')), true)
		assert.equal(consoleErrors.some((args) => args.includes('Failed to persist unexpected error.')), true)
	})

	test('still logs popup broadcast failures to the extension console', async () => {
		browserMock.reset()
		browserMock.setSendMessage(async () => { throw new Error('broadcast failed') })
		const { reportUnexpectedError } = await modulesPromise

		const { consoleErrors, consoleTraces } = await captureConsoleCalls(async () => await reportUnexpectedError(new Error('plain error')))

		assert.equal(consoleTraces.length, 0)
		assert.equal(consoleErrors.some((args) => args.includes('Failed to broadcast unexpected error to open popup windows.')), true)
	})

	test('uses metadata message without dropping the original error cause', async () => {
		browserMock.reset()
		const { getInterceptorErrorDiagnostics, reportUnexpectedError, getLatestUnexpectedError } = await modulesPromise

		await withSilencedConsole(async () => await reportUnexpectedError(new Error('root failure'), {
			code: 'contextual_failure',
			displayMessage: 'Failed to refresh contextual data: root failure',
			details: { address: '0xabc' },
		}))

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

	test('preserves full diagnostic context beyond the previous length limit', async () => {
		browserMock.reset()
		const { getInterceptorErrorDiagnostics, reportUnexpectedError } = await modulesPromise
		const context = 'x'.repeat(2500)

		await withSilencedConsole(async () => await reportUnexpectedError(new Error('root failure'), { details: context }))

		const diagnostics = await getInterceptorErrorDiagnostics()
		assert.equal(diagnostics[0]?.details, context)
	})

	test('records deeply nested causes without letting diagnostic inspection fail', async () => {
		browserMock.reset()
		const { getInterceptorErrorDiagnostics, reportUnexpectedError } = await modulesPromise
		let error = new Error('root failure')
		for (let index = 0; index < 500; index++) error = Object.assign(new Error(`cause ${ index }`), { cause: error })

		await withSilencedConsole(async () => await reportUnexpectedError(error))

		const [diagnostic] = await getInterceptorErrorDiagnostics()
		assert.equal(diagnostic?.message, 'cause 499')
		assert.match(diagnostic?.rawError ?? '', /Maximum diagnostic depth reached/u)
	})

	test('marks oversized raw errors and details as truncated', async () => {
		browserMock.reset()
		const { getInterceptorErrorDiagnostics, reportUnexpectedError } = await modulesPromise
		const error = Object.assign(new Error('large error'), { data: 'x'.repeat(100_000) })

		await withSilencedConsole(async () => await reportUnexpectedError(error, { details: 'y'.repeat(100_000) }))

		const [diagnostic] = await getInterceptorErrorDiagnostics()
		assert.ok((diagnostic?.rawError?.length ?? 0) <= 64_000)
		assert.equal(diagnostic?.details?.length, 64_000)
		assert.match(diagnostic?.rawError ?? '', /\[Diagnostic value truncated\]/u)
		assert.match(diagnostic?.details ?? '', /\[Diagnostic text truncated\]$/u)
	})

	test('falls back to readable text when a value prevents inspection', async () => {
		const { stringifyDiagnosticDetails } = await import('../../app/ts/utils/diagnosticSerialization.js')
		const unreadable = new Proxy({}, { getPrototypeOf: () => { throw new Error('prototype inaccessible') } })
		assert.match(stringifyDiagnosticDetails(unreadable) ?? '', /Diagnostic inspection failed: prototype inaccessible/u)
	})

	test('bounds inspection of shared nested values before they expand', async () => {
		const { stringifyDiagnosticDetails } = await import('../../app/ts/utils/diagnosticSerialization.js')
		let leafReads = 0
		let branch: unknown = { get value() { leafReads += 1; return 'leaf' } }
		for (let depth = 0; depth < 8; depth++) branch = { first: branch, second: branch, third: branch, fourth: branch, fifth: branch }

		const diagnostic = stringifyDiagnosticDetails(branch)

		assert.ok(leafReads < 1_000)
		assert.match(diagnostic ?? '', /Diagnostic inspection limit reached|more properties omitted/u)
	})

	test('persists a report when the original error cannot be inspected for console details', async () => {
		browserMock.reset()
		const { getInterceptorErrorDiagnostics, reportUnexpectedError } = await modulesPromise
		const unreadable = new Proxy({}, { getPrototypeOf: () => { throw new Error('prototype inaccessible') } })

		await withSilencedConsole(async () => await reportUnexpectedError(unreadable))

		const [diagnostic] = await getInterceptorErrorDiagnostics()
		assert.match(diagnostic?.rawError ?? '', /Diagnostic inspection failed: prototype inaccessible/u)
		assert.equal(diagnostic?.code, 'unexpected_error')
	})

	test('preserves hidden and nested error fields when another field is unreadable', async () => {
		browserMock.reset()
		const { getInterceptorErrorDiagnostics, reportUnexpectedError } = await modulesPromise
		const error = new AggregateError([new Error('first failure')], 'batch failed')
		Object.defineProperty(error, 'hiddenCode', { value: 'E_BATCH' })
		Object.defineProperty(error, 'unreadable', { enumerable: true, get: () => { throw new Error('getter failed') } })
		Object.defineProperty(error, 'data', { value: { value: 'kept', toJSON: () => { throw new Error('toJSON failed') } } })

		await withSilencedConsole(async () => await reportUnexpectedError(error))

		const diagnostics = await getInterceptorErrorDiagnostics()
		if (diagnostics[0]?.rawError === undefined) throw new Error('missing raw error')
		const rawError = JSON.parse(diagnostics[0].rawError)
		assert.equal(rawError.message, 'batch failed')
		assert.match(rawError.stack, /AggregateError: batch failed/u)
		assert.equal(rawError.errors[0].message, 'first failure')
		assert.equal(rawError.hiddenCode, 'E_BATCH')
		assert.equal(rawError.unreadable, '[Unreadable property: getter failed]')
		assert.equal(rawError.data.value, 'kept')
		assert.equal(rawError.data.toJSON, '[Function toJSON]')
	})

	test('records a raw error even when its message getter throws', async () => {
		browserMock.reset()
		const { getInterceptorErrorDiagnostics, reportUnexpectedError, getLatestUnexpectedError, GENERIC_UNEXPECTED_ERROR_MESSAGE } = await modulesPromise
		const error = new Error('initial message')
		error.stack = 'Error: initial message\n    at render (app.js:12:3)'
		Object.defineProperty(error, 'message', { get: () => { throw new Error('message getter failed') } })

		await withSilencedConsole(async () => await reportUnexpectedError(error))

		const diagnostic = (await getInterceptorErrorDiagnostics())[0]
		if (diagnostic?.rawError === undefined) throw new Error('missing raw error')
		const rawError = JSON.parse(diagnostic.rawError)
		assert.equal(rawError.message, '[Unreadable property: message getter failed]')
		assert.equal(rawError.stack, error.stack)
		assert.equal((await getLatestUnexpectedError())?.data.message, GENERIC_UNEXPECTED_ERROR_MESSAGE)
	})

	test('keeps forwarded popup error message as diagnostic cause', async () => {
		browserMock.reset()
		const { getInterceptorErrorDiagnostics, getLatestUnexpectedError } = await modulesPromise
		const { reportUnexpectedErrorInWindow } = await import('../../app/ts/background/popupMessageHandlers.js')
		const timestamp = new Date('2026-06-23T00:00:00.000Z')

		await withSilencedConsole(async () => await reportUnexpectedErrorInWindow({
			method: 'popup_UnexpectedErrorOccured',
			data: {
				timestamp,
				message: 'Popup render failed',
				source: 'popup',
				code: 'render_error',
				debugId: 'popup-1234',
			},
		}))

		const latestUnexpectedError = await getLatestUnexpectedError()
		assert.equal(latestUnexpectedError?.data.message, 'Popup render failed')
		assert.equal(latestUnexpectedError?.data.source, 'popup')
		assert.equal(latestUnexpectedError?.data.code, 'render_error')
		assert.equal(latestUnexpectedError?.data.debugId, 'popup-1234')
		const diagnostics = await getInterceptorErrorDiagnostics()
		assert.equal(diagnostics.length, 1)
		const [diagnostic] = diagnostics
		assert.equal(diagnostic?.message, 'Popup render failed')
		assert.equal(diagnostic?.cause, 'Popup render failed')
		assert.equal(diagnostic?.source, 'popup')
		assert.equal(diagnostic?.code, 'render_error')
		assert.equal(diagnostic?.debugId, 'popup-1234')
	})

	test('forwards popup listener stack, cause, and custom fields into stored diagnostics', async () => {
		browserMock.reset()
		const { noReplyExpectingBrowserRuntimeOnMessageListener } = await import('../../app/ts/utils/browser.js')
		const { UnexpectedErrorOccured } = await import('../../app/ts/types/interceptor-reply-messages.js')
		const { reportUnexpectedErrorInWindow } = await import('../../app/ts/background/popupMessageHandlers.js')
		const { getInterceptorErrorDiagnostics } = await modulesPromise
		const error = Object.assign(new Error('Popup listener failed'), { cause: new Error('root failure'), code: 'E_POPUP' })
		error.stack = 'Error: Popup listener failed\n    at listener (popup.js:12:3)'
		noReplyExpectingBrowserRuntimeOnMessageListener(async () => { throw error })

		browserMock.emitRuntimeMessage({ method: 'test_message' })
		for (let index = 0; index < 10 && browserMock.sentMessages.length === 0; index++) await Promise.resolve()
		const forwarded = UnexpectedErrorOccured.parse(browserMock.sentMessages[0])
		await withSilencedConsole(async () => await reportUnexpectedErrorInWindow(forwarded))

		const diagnostic = (await getInterceptorErrorDiagnostics())[0]
		if (diagnostic?.rawError === undefined) throw new Error('missing forwarded raw error')
		const rawError = JSON.parse(diagnostic.rawError)
		assert.equal(rawError.stack, error.stack)
		assert.equal(rawError.cause.message, 'root failure')
		assert.equal(rawError.code, 'E_POPUP')
		assert.equal(diagnostic.cause, 'Popup listener failed')
	})

	test('logs the original popup error if forwarding its raw diagnostic fails', async () => {
		browserMock.reset()
		const { noReplyExpectingBrowserRuntimeOnMessageListener } = await import('../../app/ts/utils/browser.js')
		const error = new Error('Popup listener failed')
		browserMock.setSendMessage(async () => { throw new Error('transport failed') })
		noReplyExpectingBrowserRuntimeOnMessageListener(async () => { throw error })

		const { consoleErrors } = await captureConsoleCalls(async () => {
			browserMock.emitRuntimeMessage({ method: 'test_message' })
			for (let index = 0; index < 20; index++) await Promise.resolve()
		})
		assert.equal(consoleErrors.some((args) => args.includes(error)), true)
		assert.equal(consoleErrors.some((args) => args[0] === 'Failed to forward popup listener error:'), true)
	})

	test('records local recovery diagnostics without notifying the popup', async () => {
		browserMock.reset()
		const { getInterceptorErrorDiagnostics, getLatestUnexpectedError, reportLocalRecovery } = await modulesPromise

		await withSilencedConsole(async () => await reportLocalRecovery(new Error('decode failed'), {
			code: 'test_local_recovery',
			message: 'Continuing after a recovered test failure.',
			details: { tokenId: 1n },
		}))

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

	test('logs local recovery diagnostics as readable console strings', async () => {
		browserMock.reset()
		const { reportLocalRecovery } = await modulesPromise

		const { consoleWarns } = await captureConsoleCalls(async () => await reportLocalRecovery(new Error('decode failed'), {
			code: 'test_local_recovery_log',
			message: 'Continuing after a recovered test failure.',
			details: { tokenId: 1n },
		}))

		assert.equal(consoleWarns.length, 2)
		assert.equal(consoleWarns[0]?.length, 1)
		assert.equal(typeof consoleWarns[0]?.[0], 'string')
		assert.equal(String(consoleWarns[0]?.[0]).startsWith('Local Interceptor recovery: code=test_local_recovery_log'), true)
		assert.equal(String(consoleWarns[0]?.[0]).includes('[object Object]'), false)
		assert.equal(consoleWarns[1]?.[0], 'Local Interceptor recovery details: {"tokenId":"1"}')
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

		await withSilencedConsole(async () => {
			reportLocalRecoveryBestEffort(new Error('parse failed'), {
				code: 'test_best_effort_recovery',
				message: 'Continuing without waiting for diagnostic persistence.',
			})
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
