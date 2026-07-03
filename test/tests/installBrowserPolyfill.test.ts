import * as assert from 'assert'
import { describe, test } from 'bun:test'

describe('installBrowserPolyfill', () => {
	test('installs the bundled polyfill onto globalThis.browser when only chrome is available', async () => {
		delete (globalThis as typeof globalThis & { browser?: typeof globalThis.browser }).browser
		;(globalThis as typeof globalThis & { chrome?: { runtime: { id: string } } }).chrome = { runtime: { id: 'test-extension' } }

		await import('../../app/ts/utils/installBrowserPolyfill.js')

		assert.notEqual(globalThis.browser, undefined)
		assert.equal(globalThis.browser.runtime.id, 'test-extension')
	})
})
