import * as assert from 'assert'
import { test } from 'bun:test'
import { getNativeHostedSiteContext } from '../../app/ts/background/nativeHostedSiteContext.js'
import { getSettings } from '../../app/ts/background/settings.js'
import { websiteSocketToString } from '../../app/ts/background/backgroundUtils.js'
import type { AddressBookEntry } from '../../app/ts/types/addressBookTypes.js'
import type { WebsiteTabConnections } from '../../app/ts/types/user-interface-types.js'
import { nativeGnosisSafeAppsHostUrl } from '../../app/ts/utils/nativeGnosisSafeAppsHost.js'
import { createPort, installBrowserMock } from './backgroundEthAccountsTestHarness.js'
import { createGnosisSafeAddressBookEntry } from './confirmTransactionTestHarness.js'

async function harness() {
	installBrowserMock()
	const activeAddress = createGnosisSafeAddressBookEntry({ address: 0x1234n, chainId: 1n })
	const settings = { ...await getSettings(), simulationMode: true, activeSimulationAddress: activeAddress.address, useSignersAddressAsActiveAddress: false, websiteAccess: [{ website: { websiteOrigin: 'app.example', title: undefined, icon: undefined }, access: true, addressAccess: [{ address: activeAddress.address, access: true }] }] }
	const origin = 'https://app.example'
	const hostUrl = nativeGnosisSafeAppsHostUrl('moz-extension://test-extension/', 10, `${ origin }/swap`, 2)
	const sourceSocket = { tabId: 10, connectionName: 1n }
	const childSocket = { tabId: 20, connectionName: 2n }
	const sourcePort = createPort(10, undefined, 0, 1n).port
	const childPort = createPort(20, undefined, 7, 2n).port
	Object.assign(sourcePort.sender ?? {}, { id: 'test-extension', url: `${ origin }/swap` })
	Object.assign(sourcePort.sender?.tab ?? {}, { url: `${ origin }/swap` })
	Object.assign(childPort.sender ?? {}, { id: 'test-extension', url: `${ origin }/swap` })
	Object.assign(childPort.sender?.tab ?? {}, { url: hostUrl })
	const source = { port: sourcePort, socket: sourceSocket, websiteOrigin: 'app.example', requestOrigin: origin, approved: true, wantsToConnect: false }
	const child = { port: childPort, socket: childSocket, websiteOrigin: 'app.example', requestOrigin: origin, approved: false, wantsToConnect: false }
	const connections: WebsiteTabConnections = new Map([
		[10, { connections: { [websiteSocketToString(sourceSocket)]: source } }],
		[20, { connections: { [websiteSocketToString(childSocket)]: child } }],
	])
	const urls = new Map([[10, `${ origin }/swap`], [20, hostUrl]])
	let sourceEligible = true
	let sourceAddress: AddressBookEntry | undefined = activeAddress
	let duringSourceValidation = () => undefined
	const sourceValidations: typeof sourceSocket[] = []
	const dependencies: NonNullable<Parameters<typeof getNativeHostedSiteContext>[3]> = {
		extensionId: 'test-extension',
		hostUrls: ['moz-extension://test-extension/html/gnosisSafeAppsHost.html', 'moz-extension://test-extension/html3/gnosisSafeAppsHostV3.html'],
		getTab: async (tabId) => { const url = urls.get(tabId); return url === undefined ? undefined : { url } },
		getEligibleSourceAddress: async (_connections, socket) => {
			sourceValidations.push(socket)
			duringSourceValidation()
			return sourceEligible ? sourceAddress : undefined
		},
	}
	return { settings, activeAddress, origin, hostUrl, sourceSocket, childSocket, source, child, connections, urls, dependencies, sourceValidations,
		setSourceEligible: (value: boolean) => { sourceEligible = value },
		setSourceAddress: (value: AddressBookEntry | undefined) => { sourceAddress = value },
		duringSourceValidation: (action: () => void) => { duringSourceValidation = action },
		resolve: async () => await getNativeHostedSiteContext(connections, childSocket, settings, dependencies),
	}
}

test('native iframe HTTP context uses the approved source account without approving the child or replacing reply/signing identity', async () => {
	const h = await harness()
	const context = await h.resolve()
	assert.ok(context)
	const { isCurrent, ...authority } = context
	assert.deepEqual(authority, { sourceSocket: h.sourceSocket, origin: h.origin, activeAddress: h.activeAddress })
	assert.deepEqual(h.sourceValidations, [h.sourceSocket])
	assert.equal(await isCurrent(h.settings), true)
	assert.equal(h.child.approved, false)
	assert.equal(h.child.port.sender?.frameId, 7)
	assert.equal(h.source.port.sender?.frameId, 0)
	assert.equal(h.connections.get(20)?.signerStateOwner, undefined)
	assert.strictEqual(h.connections.get(20)?.connections[websiteSocketToString(h.childSocket)], h.child)
})

test('native iframe HTTP context rejects forged senders, host/source navigation and unapproved or mismatched source connections', async () => {
	const cases: ((h: Awaited<ReturnType<typeof harness>>) => void)[] = [
		(h) => { Object.assign(h.child.port.sender ?? {}, { id: 'another-extension' }) },
		(h) => { Object.assign(h.child.port.sender ?? {}, { frameId: 0 }) },
		(h) => { Object.assign(h.child.port.sender ?? {}, { url: 'https://attacker.example/' }) },
		(h) => { Object.assign(h.child.port.sender?.tab ?? {}, { id: 99 }) },
		(h) => { Object.assign(h.child.port.sender?.tab ?? {}, { url: 'moz-extension://test-extension/html/settingsView.html' }) },
		(h) => { h.urls.set(20, 'moz-extension://test-extension/html/settingsView.html') },
		(h) => { h.urls.set(20, nativeGnosisSafeAppsHostUrl('moz-extension://test-extension/', 10, 'https://attacker.example/', 2)) },
		(h) => { h.urls.set(20, 'moz-extension://test-extension/html/gnosisSafeAppsHost.html?sourceTabId=10&appUrl=invalid'); Object.assign(h.child.port.sender?.tab ?? {}, { url: h.urls.get(20) }) },
		(h) => { h.urls.delete(10) },
		(h) => { h.urls.set(10, 'https://attacker.example/') },
		(h) => { h.source.approved = false },
		(h) => { h.source.requestOrigin = 'https://attacker.example' },
		(h) => { Object.assign(h.source.port.sender ?? {}, { frameId: 8 }) },
		(h) => { h.connections.delete(10) },
		(h) => { h.connections.delete(20) },
	]
	for (const change of cases) {
		const h = await harness()
		change(h)
		assert.equal(await h.resolve(), undefined, change.toString())
	}
})

test('native iframe HTTP context revalidates source eligibility, selected account, chain and simulation mode for each read', async () => {
	const h = await harness()
	assert.ok(await h.resolve())
	h.setSourceEligible(false)
	assert.equal(await h.resolve(), undefined, 'revoked source permissions must not reuse an earlier context')
	h.setSourceEligible(true)
	h.setSourceAddress(createGnosisSafeAddressBookEntry({ address: 0x9999n, chainId: 1n }))
	assert.equal(await h.resolve(), undefined)
	h.setSourceAddress(createGnosisSafeAddressBookEntry({ address: h.activeAddress.address, chainId: 137n }))
	assert.equal(await h.resolve(), undefined)
	h.setSourceAddress(h.activeAddress)
	assert.equal(await getNativeHostedSiteContext(h.connections, h.childSocket, { ...h.settings, simulationMode: false }, h.dependencies), undefined)
	assert.equal(await getNativeHostedSiteContext(h.connections, h.childSocket, { ...h.settings, activeSimulationAddress: 0x9999n }, h.dependencies), undefined)
	assert.equal(await getNativeHostedSiteContext(h.connections, h.childSocket, { ...h.settings, activeRpcNetwork: { ...h.settings.activeRpcNetwork, chainId: 137n } }, h.dependencies), undefined)
})

test('native iframe HTTP context discards a connection replaced during asynchronous source validation', async () => {
	for (const tabId of [10, 20]) {
		const h = await harness()
		h.duringSourceValidation(() => { h.connections.delete(tabId) })
		assert.equal(await h.resolve(), undefined)
	}
})

test('native context validates live browser bindings and approval after asynchronous source eligibility', async () => {
	const transitions: ((h: Awaited<ReturnType<typeof harness>>) => void)[] = [
		(h) => { h.source.approved = false },
		(h) => { h.urls.set(10, 'https://attacker.example/') },
		(h) => { h.urls.set(20, 'moz-extension://test-extension/html/settingsView.html') },
	]
	for (const transition of transitions) {
		const h = await harness()
		h.duringSourceValidation(() => { transition(h) })
		assert.equal(await h.resolve(), undefined, transition.toString())
		assert.equal(h.sourceValidations.length, 1, 'initial context selects the source account once')
	}
})

test('captured native authority fails closed on revocation, navigation and source replacement without selecting another source', async () => {
	const transitions: ((h: Awaited<ReturnType<typeof harness>>) => void)[] = [
		(h) => { h.source.approved = false },
		(h) => { h.setSourceEligible(false) },
		(h) => { h.setSourceAddress(createGnosisSafeAddressBookEntry({ address: 0x9999n, chainId: 1n })) },
		(h) => { h.urls.set(10, 'https://attacker.example/') },
		(h) => { h.urls.set(20, 'moz-extension://test-extension/html/settingsView.html') },
		(h) => { const tab = h.connections.get(10); assert.ok(tab); tab.connections[websiteSocketToString(h.sourceSocket)] = { ...h.source } },
	]
	for (const transition of transitions) {
		const h = await harness()
		const context = await h.resolve()
		assert.ok(context)
		transition(h)
		assert.equal(await context.isCurrent(h.settings), false, transition.toString())
		assert.strictEqual(context.sourceSocket, h.sourceSocket)
		assert.equal(h.sourceValidations.every((socket) => socket === h.sourceSocket), true)
	}
})

test('captured native authority requires its original simulation chain and selected Safe', async () => {
	const h = await harness()
	const context = await h.resolve()
	assert.ok(context)
	for (const settings of [
		{ ...h.settings, simulationMode: false },
		{ ...h.settings, activeSimulationAddress: 0x9999n },
		{ ...h.settings, activeRpcNetwork: { ...h.settings.activeRpcNetwork, chainId: 137n } },
	]) assert.equal(await context.isCurrent(settings), false)
	assert.equal(h.sourceValidations.length, 1, 'an incompatible selection fails before another account lookup')
})

test('captured native authority also discards revocation and navigation during asynchronous revalidation', async () => {
	for (const target of ['approval', 'source', 'host']) {
		const h = await harness()
		const context = await h.resolve()
		assert.ok(context)
		h.duringSourceValidation(() => {
			if (target === 'approval') h.source.approved = false
			else h.urls.set(target === 'source' ? 10 : 20, 'https://attacker.example/')
		})
		assert.equal(await context.isCurrent(h.settings), false, target)
	}
})

test('native iframe HTTP context propagates unexpected browser failures', async () => {
	const h = await harness()
	await assert.rejects(getNativeHostedSiteContext(h.connections, h.childSocket, h.settings, { ...h.dependencies, getTab: async () => { throw new Error('Unexpected browser failure') } }), /Unexpected browser failure/)
})


test('native iframe authority rechecks stored address consent even while the source connection remains approved', async () => {
	const h = await harness()
	const context = await h.resolve()
	assert.ok(context)
	const revoked = { ...h.settings, websiteAccess: [] }
	assert.equal(h.source.approved, true)
	assert.equal(await context.isCurrent(revoked), false)
	assert.equal(await getNativeHostedSiteContext(h.connections, h.childSocket, revoked, h.dependencies), undefined)
})
