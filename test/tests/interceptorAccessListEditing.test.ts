import * as assert from 'assert'
import { test } from 'bun:test'
import { createEditableAccess, getAccessListSave, setEditableNetworkBlockMode } from '../../app/ts/components/pages/interceptorAccessListEditing.js'
import type { WebsiteAccess, WebsiteAccessArray } from '../../app/ts/types/websiteAccessTypes.js'
import { installBrowserMock, loadModules } from './backgroundEthAccountsTestHarness.js'

const hostname = 'access-list-editor.example'
const httpsOrigin = `https://${ hostname }`
const httpOrigin = `http://${ hostname }`
const otherHostOrigin = `https://other-${ hostname }`
const fileOrigin = 'file:///tmp/wallet.html'
const record = (websiteOrigin: string, declarativeNetRequestBlockMode: 'block-all' | 'disabled', access = true): WebsiteAccess => ({ website: { websiteOrigin, icon: undefined, title: undefined }, access, addressAccess: [{ address: 0x1234n, access: true }], declarativeNetRequestBlockMode })
// What a row of the editor shows, so the saved baseline and a reload from storage can be compared.
const shownRows = (websiteAccess: WebsiteAccessArray) => websiteAccess.map((access) => [access.website.websiteOrigin, access.access, access.interceptorDisabled, access.declarativeNetRequestBlockMode, (access.addressAccess ?? []).map((entry) => [entry.address, entry.access])])
const shownBlockModes = (editableAccessList: readonly { readonly websiteAccess: WebsiteAccess, readonly declarativeNetRequestBlockMode: string | undefined }[]) => editableAccessList.map((editable) => [editable.websiteAccess.website.websiteOrigin, editable.declarativeNetRequestBlockMode])

test('toggling the block setting on one row sets every row of that hostname, but not other hosts or files', () => {
	const stored = [record(httpsOrigin, 'block-all'), record(httpOrigin, 'block-all'), record(`http://${ hostname }:8080`, 'disabled'), record(otherHostOrigin, 'block-all'), record(fileOrigin, 'block-all')]
	const unblocked = setEditableNetworkBlockMode(stored.map(createEditableAccess), 0, 'disabled')
	assert.deepEqual(shownBlockModes(unblocked), [[httpsOrigin, 'disabled'], [httpOrigin, 'disabled'], [`http://${ hostname }:8080`, 'disabled'], [otherHostOrigin, 'block-all'], [fileOrigin, 'block-all']])
	const fileUnblocked = setEditableNetworkBlockMode(unblocked, 4, 'disabled')
	assert.deepEqual(shownBlockModes(fileUnblocked), [[httpsOrigin, 'disabled'], [httpOrigin, 'disabled'], [`http://${ hostname }:8080`, 'disabled'], [otherHostOrigin, 'block-all'], [fileOrigin, 'disabled']])
})

for (const manifestVersion of [2, 3] as const) {
	test(`an access-list save stores the hostname-wide block setting the editor shows on MV${ manifestVersion }`, async () => {
		const mock = installBrowserMock({ manifestVersion })
		const m = await loadModules()
		const { getNetworkBlockDecisions } = await import('../../app/ts/background/popupMessageHandlers/websiteAccess.js')
		const { createEthereumWithGetBlockCounter } = await import('./backgroundEthAccountsTestHarness.js')
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const connections = new Map()
		const isThirdPartyRequestFromHostBlocked = () => {
			if (manifestVersion === 3) return mock.blockedDomains.includes(hostname)
			return 'cancel' in mock.runWebRequest({ requestId: '1', url: 'https://third-party.example/beacon', method: 'GET', frameId: 0, parentFrameId: -1, tabId: 1, type: 'xmlhttprequest', timeStamp: 0, originUrl: httpOrigin })
		}
		const saveFromEditor = async (editableAccessList: Parameters<typeof getAccessListSave>[0]) => {
			const { message, savedWebsiteAccess } = getAccessListSave(editableAccessList)
			// The editor never submits toggles that the background would reject as contradictory.
			getNetworkBlockDecisions(message.data)
			await m.changeInterceptorAccess(simulationServicesOwner, connections, message)
			// Reopening the editor after the save shows what was stored, which is the baseline the editor kept.
			assert.deepEqual(shownRows(await m.getWebsiteAccess()), shownRows(savedWebsiteAccess))
			return message
		}
		await m.updateWebsiteAccess(() => [record(httpsOrigin, 'block-all'), record(httpOrigin, 'block-all'), record(otherHostOrigin, 'block-all')])
		await m.updateDeclarativeNetRequestBlocks(connections)
		assert.equal(isThirdPartyRequestFromHostBlocked(), true)

		// Unblocking the https row shows the http row unblocked too, and the save carries one consistent toggle per row.
		const unblocked = setEditableNetworkBlockMode((await m.getWebsiteAccess()).map(createEditableAccess), 0, 'disabled')
		assert.deepEqual(shownBlockModes(unblocked), [[httpsOrigin, 'disabled'], [httpOrigin, 'disabled'], [otherHostOrigin, 'block-all']])
		const unblockMessage = await saveFromEditor(unblocked)
		assert.deepEqual(unblockMessage.data.map((edit) => [edit.newEntry.website.websiteOrigin, edit.oldEntry.declarativeNetRequestBlockMode, edit.newEntry.declarativeNetRequestBlockMode]), [[httpsOrigin, 'block-all', 'disabled'], [httpOrigin, 'block-all', 'disabled']])
		assert.equal(isThirdPartyRequestFromHostBlocked(), false)
		assert.equal(await m.areWeBlocking(connections, 1, otherHostOrigin), true)

		// The save the background used to reject: with https blocked and http not, the user unticks https, ticks http and revokes another site in one save. The rows stay in step, so the save carries no contradictory toggles.
		await m.updateWebsiteAccess(() => [record(httpsOrigin, 'block-all'), record(httpOrigin, 'disabled'), record(otherHostOrigin, 'block-all')])
		const swapped = setEditableNetworkBlockMode(setEditableNetworkBlockMode((await m.getWebsiteAccess()).map(createEditableAccess), 0, 'disabled'), 1, 'block-all')
		const swappedAndRevoked = swapped.map((editable) => editable.websiteAccess.website.websiteOrigin === otherHostOrigin ? { ...editable, removed: true } : editable)
		assert.deepEqual(shownBlockModes(swappedAndRevoked), [[httpsOrigin, 'block-all'], [httpOrigin, 'block-all'], [otherHostOrigin, 'block-all']])
		await saveFromEditor(swappedAndRevoked)
		assert.deepEqual(shownRows(await m.getWebsiteAccess()).map(([websiteOrigin, , , blockMode]) => [websiteOrigin, blockMode]), [[httpsOrigin, 'block-all'], [httpOrigin, 'block-all']])
		assert.equal(isThirdPartyRequestFromHostBlocked(), true)
	})
}
