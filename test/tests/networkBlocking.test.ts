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

for (const manifestVersion of [2, 3] as const) {
	test(`unblocking one scheme of a hostname stops blocking requests from every scheme and port of it on MV${ manifestVersion }`, async () => {
		const mock = installBrowserMock({ manifestVersion })
		const m = await loadModules()
		const { createEthereumWithGetBlockCounter } = await import('./backgroundEthAccountsTestHarness.js')
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const hostname = `two-schemes-mv${ manifestVersion }.example`
		const httpsOrigin = `https://${ hostname }`
		const blockedRecord = (websiteOrigin: string) => ({ website: { websiteOrigin, icon: undefined, title: undefined }, access: true, declarativeNetRequestBlockMode: 'block-all' as const })
		const otherHostOrigin = `https://other-${ hostname }`
		await m.updateWebsiteAccess(() => [blockedRecord(httpsOrigin), blockedRecord(`http://${ hostname }`), blockedRecord(`http://${ hostname }:8080`), blockedRecord(otherHostOrigin)])
		const connections = new Map()
		await m.updateDeclarativeNetRequestBlocks(connections)
		assert.equal(await m.areWeBlocking(connections, 1, httpsOrigin), true)

		await m.blockOrAllowExternalRequests(simulationServicesOwner, connections, { method: 'popup_blockOrAllowExternalRequests', data: { website: { websiteOrigin: httpsOrigin, icon: undefined, title: undefined }, shouldBlock: false } })
		assert.deepEqual((await m.getWebsiteAccess()).map((access) => [access.website.websiteOrigin, access.declarativeNetRequestBlockMode]), [
			[httpsOrigin, 'disabled'],
			[`http://${ hostname }`, 'disabled'],
			[`http://${ hostname }:8080`, 'disabled'],
			[otherHostOrigin, 'block-all'],
		])
		for (const originUrl of [httpsOrigin, `http://${ hostname }`, `http://${ hostname }:8080`]) assert.equal(await m.areWeBlocking(connections, 1, originUrl), false)
		assert.equal(await m.areWeBlocking(connections, 1, otherHostOrigin), true)
		if (manifestVersion === 3) assert.deepEqual(mock.blockedDomains, [`other-${ hostname }`])
		else assert.deepEqual(mock.runWebRequest({ requestId: '1', url: 'https://third-party.example/beacon', method: 'GET', frameId: 0, parentFrameId: -1, tabId: 1, type: 'xmlhttprequest', timeStamp: 0, originUrl: `http://${ hostname }` }), {})

		await m.blockOrAllowExternalRequests(simulationServicesOwner, connections, { method: 'popup_blockOrAllowExternalRequests', data: { website: { websiteOrigin: `http://${ hostname }`, icon: undefined, title: undefined }, shouldBlock: true } })
		assert.ok((await m.getWebsiteAccess()).every((access) => access.declarativeNetRequestBlockMode === 'block-all'))
		assert.equal(await m.areWeBlocking(connections, 1, httpsOrigin), true)
	})
}

for (const manifestVersion of [2, 3] as const) {
	test(`bulk access saves apply a block toggle to every record of its hostname on MV${ manifestVersion }`, async () => {
		const mock = installBrowserMock({ manifestVersion })
		const m = await loadModules()
		const { createEthereumWithGetBlockCounter } = await import('./backgroundEthAccountsTestHarness.js')
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const hostname = `bulk-save-mv${ manifestVersion }.example`
		const httpsOrigin = `https://${ hostname }`
		const httpOrigin = `http://${ hostname }`
		const otherHostOrigin = `https://other-${ hostname }`
		const record = (websiteOrigin: string, declarativeNetRequestBlockMode: 'block-all' | 'disabled') => ({ website: { websiteOrigin, icon: undefined, title: undefined }, access: true, addressAccess: undefined, declarativeNetRequestBlockMode })
		const blockModes = async () => (await m.getWebsiteAccess()).map((access) => [access.website.websiteOrigin, access.declarativeNetRequestBlockMode, access.access])
		const save = async (data: { removed: boolean, oldEntry: ReturnType<typeof record> & { access: boolean }, newEntry: ReturnType<typeof record> & { access: boolean } }[]) => await m.changeInterceptorAccess(simulationServicesOwner, connections, { method: 'popup_changeInterceptorAccess', data })
		const isThirdPartyRequestFromHostBlocked = async () => {
			if (manifestVersion === 3) return mock.blockedDomains.includes(hostname)
			return 'cancel' in mock.runWebRequest({ requestId: '1', url: 'https://third-party.example/beacon', method: 'GET', frameId: 0, parentFrameId: -1, tabId: 1, type: 'xmlhttprequest', timeStamp: 0, originUrl: httpOrigin })
		}
		const connections = new Map()
		await m.updateWebsiteAccess(() => [record(httpsOrigin, 'block-all'), record(httpOrigin, 'block-all'), record(otherHostOrigin, 'block-all')])
		await m.updateDeclarativeNetRequestBlocks(connections)
		assert.equal(await isThirdPartyRequestFromHostBlocked(), true)

		// Unblocking only the https record unblocks the host, while an unrelated edit to its http record in the same save is kept without restoring its block.
		await save([
			{ removed: false, oldEntry: record(httpsOrigin, 'block-all'), newEntry: record(httpsOrigin, 'disabled') },
			{ removed: false, oldEntry: record(httpOrigin, 'block-all'), newEntry: { ...record(httpOrigin, 'block-all'), access: false } },
		])
		assert.deepEqual(await blockModes(), [[httpsOrigin, 'disabled', true], [httpOrigin, 'disabled', false], [otherHostOrigin, 'block-all', true]])
		assert.equal(await isThirdPartyRequestFromHostBlocked(), false)
		assert.equal(await m.areWeBlocking(connections, 1, otherHostOrigin), true)

		// Re-blocking only the http record blocks the host again.
		await save([{ removed: false, oldEntry: { ...record(httpOrigin, 'disabled'), access: false }, newEntry: { ...record(httpOrigin, 'block-all'), access: false } }])
		assert.deepEqual(await blockModes(), [[httpsOrigin, 'block-all', true], [httpOrigin, 'block-all', false], [otherHostOrigin, 'block-all', true]])
		assert.equal(await isThirdPartyRequestFromHostBlocked(), true)

		// Contradictory toggles for one hostname are rejected before anything is written.
		const beforeContradictorySave = await blockModes()
		await assert.rejects(save([
			{ removed: false, oldEntry: record(httpsOrigin, 'block-all'), newEntry: record(httpsOrigin, 'disabled') },
			{ removed: false, oldEntry: { ...record(httpOrigin, 'disabled'), access: false }, newEntry: { ...record(httpOrigin, 'block-all'), access: true } },
		]), /Cannot both block and allow external requests for bulk-save/)
		assert.deepEqual(await blockModes(), beforeContradictorySave)
		assert.equal(await isThirdPartyRequestFromHostBlocked(), true)
	})
}
