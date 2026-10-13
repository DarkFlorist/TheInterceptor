import * as assert from 'assert'
import { test } from 'bun:test'
import { getChromeFileInjector } from '../../app/ts/background/chromeScriptInjection.js'

const injection = { target: { tabId: 3, documentIds: ['doc-3'] }, world: 'MAIN', files: ['/inpage/js/prepareSafeAppBootstrap.js'] } satisfies Parameters<NonNullable<ReturnType<typeof getChromeFileInjector>>>[0]

test('Chrome file injector awaits native results, preserves its receiver and reports malformed results explicitly', async () => {
	const previousBrowser = Object.getOwnPropertyDescriptor(globalThis, 'browser')
	let result: unknown = [{ documentId: 'doc-3', result: { success: true } }]
	const scripting = { executeScript: async function (this: unknown, options: unknown) {
		assert.equal(this, scripting)
		assert.deepEqual(options, injection)
		return result
	} }
	Object.defineProperty(globalThis, 'browser', { configurable: true, value: { scripting } })
	try {
		const injectFiles = getChromeFileInjector()
		assert.ok(injectFiles)
		assert.deepEqual(await injectFiles(injection), result)
		for (const invalid of [undefined, {}, [undefined], [{ documentId: 42 }]]) {
			result = invalid
			await assert.rejects(injectFiles(injection), /Chrome script injection returned an invalid/)
		}
		result = [{}]
		assert.deepEqual(await injectFiles(injection), [{ result: undefined }])
		Object.defineProperty(globalThis, 'browser', { configurable: true, value: { scripting: {} } })
		assert.equal(getChromeFileInjector(), undefined)
	} finally {
		if (previousBrowser === undefined) Reflect.deleteProperty(globalThis, 'browser')
		else Object.defineProperty(globalThis, 'browser', previousBrowser)
	}
})
