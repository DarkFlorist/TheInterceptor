import * as assert from 'node:assert'
import { test } from 'bun:test'
import { createPerTestRestorer } from '../harness/perTest.js'
import { withSilencedConsole } from './consoleSilence.js'

const { installBrowserMockForTest } = createPerTestRestorer()

test('settings and access getters share corruption repair and preserve valid access values', async () => {
	const mock = installBrowserMockForTest()
	const { getSettings } = await import('../../app/ts/background/settings.js')
	const { getWebsiteAccess } = await import('../../app/ts/background/websiteAccessStorage.js')
	for (const read of [async () => (await getSettings()).websiteAccess, getWebsiteAccess]) {
		await mock.browser.storage.local.set({ websiteAccess: 'corrupt' })
		assert.deepEqual(await withSilencedConsole(read), [])
		assert.deepEqual(await mock.browser.storage.local.get('websiteAccess'), { websiteAccess: [] })
		await mock.browser.storage.local.set({ websiteAccess: [{ website: { websiteOrigin: 'example.test', icon: 'https://unsafe.test/icon.png' }, interceptorDisabled: true }] })
		const entries = await read()
		assert.equal(entries[0]?.website.websiteOrigin, 'example.test')
		assert.equal(entries[0]?.interceptorDisabled, true)
		assert.equal(entries[0]?.website.icon, undefined)
	}
})

test('access storage serializes concurrent updates without losing either writer', async () => {
	installBrowserMockForTest()
	const { getWebsiteAccess, updateWebsiteAccess } = await import('../../app/ts/background/websiteAccessStorage.js')
	await Promise.all(['first.test', 'second.test'].map(async (websiteOrigin) => await updateWebsiteAccess((previous) => [
		...previous,
		{ website: { websiteOrigin }, access: true },
	])))
	assert.deepEqual((await getWebsiteAccess()).map((entry) => entry.website.websiteOrigin), ['first.test', 'second.test'])
})
