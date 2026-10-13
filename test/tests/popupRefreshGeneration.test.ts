import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { flushMicrotasks } from '../harness/async.js'
import { createPerTestBrowserMockInstaller } from '../harness/perTest.js'

const installBrowserMock = createPerTestBrowserMockInstaller()

describe('popup refresh generation persistence', () => {
	test('keeps in-memory generation above persisted restart value', async () => {
		const previousGeneration = 10_000_000_000_000
		const browserMock = installBrowserMock({ storage: { local: { popupRefreshGeneration: previousGeneration } } })

		const { initializePopupRefreshGeneration, bumpPopupRefreshGeneration, getPopupRefreshGeneration } = await import('../../app/ts/background/popupRefreshGeneration.js')
		await initializePopupRefreshGeneration()
		const afterInitialize = getPopupRefreshGeneration()
		assert.equal(afterInitialize >= previousGeneration, true)

		const afterBump = bumpPopupRefreshGeneration()
		assert.equal(afterBump > previousGeneration, true)
		await flushMicrotasks()
		assert.equal(new Map(Object.entries(browserMock.readStorage())).get('popupRefreshGeneration'), afterBump)
	})
})
