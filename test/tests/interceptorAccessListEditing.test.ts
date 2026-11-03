import * as assert from 'assert'
import { test } from 'bun:test'
import { type EditableAccess, type NetworkBlockDecisions, getAccessListSave, getShownNetworkBlockMode, mergeRefreshedWebsiteAccess, setNetworkBlockDecision } from '../../app/ts/components/pages/interceptorAccessListEditing.js'
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
const shownBlockModes = (editableAccessList: readonly EditableAccess[], decisions: NetworkBlockDecisions) => editableAccessList.map((editable) => [editable.websiteAccess.website.websiteOrigin, getShownNetworkBlockMode(editable, decisions)])

test('a block toggle applies to every row of its hostname, but not to other hosts or files', () => {
	const rows = mergeRefreshedWebsiteAccess(undefined, [record(httpsOrigin, 'block-all'), record(httpOrigin, 'block-all'), record(`http://${ hostname }:8080`, 'disabled'), record(otherHostOrigin, 'block-all'), record(fileOrigin, 'block-all')])
	const unblocked = setNetworkBlockDecision(new Map(), httpsOrigin, 'disabled')
	assert.deepEqual(shownBlockModes(rows, unblocked), [[httpsOrigin, 'disabled'], [httpOrigin, 'disabled'], [`http://${ hostname }:8080`, 'disabled'], [otherHostOrigin, 'block-all'], [fileOrigin, 'block-all']])
	const fileUnblocked = setNetworkBlockDecision(unblocked, fileOrigin, 'disabled')
	assert.deepEqual(shownBlockModes(rows, fileUnblocked), [[httpsOrigin, 'disabled'], [httpOrigin, 'disabled'], [`http://${ hostname }:8080`, 'disabled'], [otherHostOrigin, 'block-all'], [fileOrigin, 'disabled']])
})

for (const manifestVersion of [2, 3] as const) {
	async function createEditorHarness() {
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
		const store = async (websiteAccess: WebsiteAccessArray) => {
			await m.updateWebsiteAccess(() => websiteAccess)
			await m.updateDeclarativeNetRequestBlocks(connections)
		}
		// A settings refresh hands the editor the stored list, as the popup does while the editor is open.
		const refresh = async (rows: readonly EditableAccess[] | undefined) => mergeRefreshedWebsiteAccess(rows, await m.getWebsiteAccess())
		const saveFromEditor = async (rows: readonly EditableAccess[], decisions: NetworkBlockDecisions) => {
			const { message, savedWebsiteAccess } = getAccessListSave(rows, decisions)
			// The editor never submits toggles that the background would reject as contradictory.
			getNetworkBlockDecisions(message.data)
			await m.changeInterceptorAccess(simulationServicesOwner, connections, message)
			// The list the editor keeps after the save, and the editor reopened from storage, show the same rows.
			assert.deepEqual(shownRows(await m.getWebsiteAccess()), shownRows(savedWebsiteAccess))
			const reopened = mergeRefreshedWebsiteAccess(undefined, await m.getWebsiteAccess())
			assert.deepEqual(shownBlockModes(reopened, new Map()), shownBlockModes(mergeRefreshedWebsiteAccess(undefined, savedWebsiteAccess), new Map()))
			return message
		}
		return { m, store, refresh, saveFromEditor, isThirdPartyRequestFromHostBlocked, connections }
	}

	test(`an access-list save stores the hostname-wide block setting the editor shows on MV${ manifestVersion }`, async () => {
		const { m, store, refresh, saveFromEditor, isThirdPartyRequestFromHostBlocked, connections } = await createEditorHarness()
		await store([record(httpsOrigin, 'block-all'), record(httpOrigin, 'block-all'), record(otherHostOrigin, 'block-all')])
		assert.equal(isThirdPartyRequestFromHostBlocked(), true)

		// Unblocking the https row shows the http row unblocked too, and the save carries one consistent toggle per row.
		const rows = await refresh(undefined)
		const decisions = setNetworkBlockDecision(new Map(), httpsOrigin, 'disabled')
		assert.deepEqual(shownBlockModes(rows, decisions), [[httpsOrigin, 'disabled'], [httpOrigin, 'disabled'], [otherHostOrigin, 'block-all']])
		const message = await saveFromEditor(rows, decisions)
		assert.deepEqual(message.data.map((edit) => [edit.newEntry.website.websiteOrigin, edit.oldEntry.declarativeNetRequestBlockMode, edit.newEntry.declarativeNetRequestBlockMode]), [[httpsOrigin, 'block-all', 'disabled'], [httpOrigin, 'block-all', 'disabled']])
		assert.equal(isThirdPartyRequestFromHostBlocked(), false)
		assert.equal(await m.areWeBlocking(connections, 1, otherHostOrigin), true)
	})

	test(`toggling both scheme rows of a hostname in one save while revoking another site is not contradictory on MV${ manifestVersion }`, async () => {
		const { m, store, refresh, saveFromEditor, isThirdPartyRequestFromHostBlocked } = await createEditorHarness()
		// With https blocked and http not, the user unticks https, ticks http and revokes another site in one save.
		await store([record(httpsOrigin, 'block-all'), record(httpOrigin, 'disabled'), record(otherHostOrigin, 'block-all')])
		const rows = (await refresh(undefined)).map((editable) => editable.websiteAccess.website.websiteOrigin === otherHostOrigin ? { ...editable, removed: true } : editable)
		const decisions = setNetworkBlockDecision(setNetworkBlockDecision(new Map(), httpsOrigin, 'disabled'), httpOrigin, 'block-all')
		assert.deepEqual(shownBlockModes(rows, decisions), [[httpsOrigin, 'block-all'], [httpOrigin, 'block-all'], [otherHostOrigin, 'block-all']])
		await saveFromEditor(rows, decisions)
		assert.deepEqual(shownRows(await m.getWebsiteAccess()).map(([websiteOrigin, , , blockMode]) => [websiteOrigin, blockMode]), [[httpsOrigin, 'block-all'], [httpOrigin, 'block-all']])
		assert.equal(isThirdPartyRequestFromHostBlocked(), true)
	})

	test(`a settings refresh that reverses a hostname's stored block modes leaves untouched rows following storage on MV${ manifestVersion }`, async () => {
		const { m, store, refresh, saveFromEditor, isThirdPartyRequestFromHostBlocked } = await createEditorHarness()
		await store([record(httpsOrigin, 'block-all'), record(httpOrigin, 'disabled'), record(otherHostOrigin, 'block-all')])
		const opened = await refresh(undefined)
		await store([record(httpsOrigin, 'disabled'), record(httpOrigin, 'block-all'), record(otherHostOrigin, 'block-all')])
		const refreshed = await refresh(opened)
		assert.deepEqual(shownBlockModes(refreshed, new Map()), [[httpsOrigin, 'disabled'], [httpOrigin, 'block-all'], [otherHostOrigin, 'block-all']])
		// An unrelated edit makes the save go through without any block toggle.
		const rows = refreshed.map((editable) => editable.websiteAccess.website.websiteOrigin === otherHostOrigin ? { ...editable, access: false } : editable)
		const message = await saveFromEditor(rows, new Map())
		assert.deepEqual(message.data.map((edit) => edit.newEntry.website.websiteOrigin), [otherHostOrigin])
		assert.deepEqual(shownRows(await m.getWebsiteAccess()).map(([websiteOrigin, access, , blockMode]) => [websiteOrigin, access, blockMode]), [[httpsOrigin, true, 'disabled'], [httpOrigin, true, 'block-all'], [otherHostOrigin, false, 'block-all']])
		assert.equal(isThirdPartyRequestFromHostBlocked(), true)
	})

	test(`a row added by a settings refresh follows the user's block toggle for its hostname on MV${ manifestVersion }`, async () => {
		const { m, store, refresh, saveFromEditor, isThirdPartyRequestFromHostBlocked } = await createEditorHarness()
		await store([record(httpsOrigin, 'disabled'), record(otherHostOrigin, 'disabled')])
		const opened = await refresh(undefined)
		const decisions = setNetworkBlockDecision(new Map(), httpsOrigin, 'block-all')
		await store([record(httpsOrigin, 'disabled'), record(otherHostOrigin, 'disabled'), record(httpOrigin, 'disabled')])
		const refreshed = await refresh(opened)
		assert.deepEqual(shownBlockModes(refreshed, decisions), [[httpsOrigin, 'block-all'], [otherHostOrigin, 'disabled'], [httpOrigin, 'block-all']])
		await saveFromEditor(refreshed, decisions)
		assert.deepEqual(shownRows(await m.getWebsiteAccess()).map(([websiteOrigin, , , blockMode]) => [websiteOrigin, blockMode]), [[httpsOrigin, 'block-all'], [otherHostOrigin, 'disabled'], [httpOrigin, 'block-all']])
		assert.equal(isThirdPartyRequestFromHostBlocked(), true)
	})
}
