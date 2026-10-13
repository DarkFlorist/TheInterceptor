import * as assert from 'assert'
import { test } from 'bun:test'
import { installBrowserMock, loadModules } from './backgroundEthAccountsTestHarness.js'

for (const manifestVersion of [2, 3] as const) {
	test(`network blocking remains hostname scoped while provider grants stay origin scoped on MV${ manifestVersion }`, async () => {
		const mock = installBrowserMock({ manifestVersion })
		const m = await loadModules()
		const hostname = `blocked-mv${ manifestVersion }.example`
		const websiteOrigin = `https://${ hostname }`
		await m.updateWebsiteAccess(() => [{ website: { websiteOrigin, icon: undefined, title: undefined }, access: true, declarativeNetRequestBlockMode: 'block-all' }])
		const connections = new Map()
		await m.updateDeclarativeNetRequestBlocks(connections)
		for (const originUrl of [websiteOrigin, `http://${ hostname }`, `http://${ hostname }:8080`]) {
			assert.equal(await m.areWeBlocking(connections, 1, originUrl), true)
			assert.equal(m.hasAccess(await m.getWebsiteAccess(), originUrl), originUrl === websiteOrigin ? 'hasAccess' : 'askAccess')
			if (manifestVersion === 2) {
				const request = { requestId: '1', url: 'https://third-party.example/beacon', method: 'GET', frameId: 0, parentFrameId: -1, tabId: 1, type: 'xmlhttprequest' as const, timeStamp: 0, originUrl }
				assert.deepEqual(mock.runWebRequest(request), { cancel: true })
				assert.deepEqual(mock.runWebRequest({ ...request, type: 'main_frame' }), {})
				assert.deepEqual(mock.runWebRequest({ ...request, originUrl: 'https://unblocked.example' }), {})
				assert.deepEqual(mock.runWebRequest({ ...request, originUrl: websiteOrigin, url: `http://${ hostname }/same-host` }), {})
			}
		}
		assert.equal(await m.areWeBlocking(connections, 1, 'https://unblocked.example'), false)
		if (manifestVersion === 3) assert.deepEqual(mock.blockedDomains, [hostname])
		await m.updateWebsiteAccess(() => [])
		await m.updateDeclarativeNetRequestBlocks(connections)
		assert.equal(await m.areWeBlocking(connections, 1, websiteOrigin), false)
		assert.deepEqual(mock.blockedDomains, [])
	})
}
