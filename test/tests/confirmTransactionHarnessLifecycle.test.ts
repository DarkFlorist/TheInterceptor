import * as assert from 'node:assert'
import { beforeEach, test } from 'bun:test'
import { answerTabMessages, browserMock, interceptStorageGet, interceptStorageSet, openBrowserTargets, resetConfirmTransactionTestState, useManifestVersion } from './confirmTransactionTestHarness.js'

beforeEach(resetConfirmTransactionTestState)

for (const { name, install } of [
	{ name: 'storage read', install: () => interceptStorageGet(async (_keys, read) => await read()) },
	{ name: 'storage write', install: () => interceptStorageSet(async (_items, write) => await write()) },
	{ name: 'manifest', install: () => useManifestVersion(2) },
	{ name: 'tab messages', install: () => answerTabMessages(() => undefined) },
]) {
	test(`refuses to replace the mock while a ${ name } override is installed`, () => {
		const original = browserMock.browser
		const restore = install()
		try {
			assert.throws(() => openBrowserTargets({}), /Restore browser overrides/)
			assert.equal(browserMock.browser, original)
		} finally { restore() }
		openBrowserTargets({})
		assert.notEqual(browserMock.browser, original)
	})
}

test('per-test reset restores outstanding overrides before replacing the mock', async () => {
	const restore = useManifestVersion(2)
	await resetConfirmTransactionTestState()
	const runtime = browserMock.browser.runtime
	const getManifest = runtime.getManifest
	restore()
	assert.equal(runtime.getManifest, getManifest)
	assert.equal(runtime.getManifest().manifest_version, 3)
	openBrowserTargets({})
})
