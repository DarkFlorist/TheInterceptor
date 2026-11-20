import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { withSilencedConsole } from './consoleSilence.js'
import { createPerTestRestorer } from '../harness/perTest.js'

const { installBrowserMockForTest } = createPerTestRestorer()

async function loadModules() {
	return {
		...await import('../../app/ts/background/storageVariables.js'),
		...await import('../../app/ts/utils/unexpectedErrorStorage.js'),
		...await import('../../app/ts/background/simulationModeHandlers.js'),
		...await import('../../app/ts/utils/errors.js'),
	}
}

describe('unexpected error security', () => {
	test('keep spoofed InterceptorError diagnostics out of popup state', async () => {
		const browserMock = installBrowserMockForTest()
		const { getLatestUnexpectedError, handleInterceptorError } = await loadModules()

		await withSilencedConsole(async () => await handleInterceptorError({ method: 'InterceptorError', params: ['phishing text'] }))

		const { latestUnexpectedError: storedLatestUnexpectedError } = browserMock.readStorage()
		assert.equal(storedLatestUnexpectedError, undefined)
		assert.equal(await getLatestUnexpectedError(), undefined)
		assert.equal(browserMock.calls.runtimeSendMessage.length, 0)
	})

	test('use generic popup copy for unknown thrown values', async () => {
		const browserMock = installBrowserMockForTest()
		const { getLatestUnexpectedError, reportUnexpectedError, GENERIC_UNEXPECTED_ERROR_MESSAGE } = await loadModules()

		await withSilencedConsole(async () => await reportUnexpectedError({ arbitrary: 'value' }))

		const latestUnexpectedError = await getLatestUnexpectedError()
		assert.notEqual(latestUnexpectedError, undefined)
		assert.equal(latestUnexpectedError?.data.message, GENERIC_UNEXPECTED_ERROR_MESSAGE)
		assert.equal(latestUnexpectedError?.data.source, 'internal')
		assert.equal(latestUnexpectedError?.data.code, 'unexpected_error')
		assert.equal(typeof latestUnexpectedError?.data.debugId, 'string')
		assert.equal(browserMock.calls.runtimeSendMessage.length, 1)
	})

	test('preserve trusted internal Error messages for popup display', async () => {
		installBrowserMockForTest()
		const { getLatestUnexpectedError, reportUnexpectedError } = await loadModules()

		await withSilencedConsole(async () => await reportUnexpectedError(new Error('Trusted extension failure')))

		const latestUnexpectedError = await getLatestUnexpectedError()
		assert.notEqual(latestUnexpectedError, undefined)
		assert.equal(latestUnexpectedError?.data.message, 'Trusted extension failure')
		assert.equal(latestUnexpectedError?.data.source, 'internal')
		assert.equal(latestUnexpectedError?.data.code, 'unexpected_error')
		assert.equal(typeof latestUnexpectedError?.data.debugId, 'string')
	})
})
