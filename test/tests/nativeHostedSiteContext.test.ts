import { registerNativeGnosisSafeAppsSession } from '../../app/ts/background/nativeGnosisSafeAppsSessions.js'
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
	installBrowserMock({ manifestVersion: 2 })
	Object.assign(browser.runtime, { id: 'test-extension', getURL: (path: string) => new URL(path, 'moz-extension://test-extension/').href })
	const activeAddress = createGnosisSafeAddressBookEntry({ address: 0x1234n, chainId: 1n })
	const settings = { ...await getSettings(), simulationMode: true, activeSimulationAddress: activeAddress.address, useSignersAddressAsActiveAddress: false, websiteAccess: [{ website: { websiteOrigin: 'app.example', title: undefined, icon: undefined }, access: true, addressAccess: [{ address: activeAddress.address, access: true }] }] }
	const origin = 'https://app.example'
	const hostUrl = nativeGnosisSafeAppsHostUrl('moz-extension://test-extension/', 20, `${ origin }/swap`, 2)
	const hostSocket = { tabId: 20, connectionName: 1n }
	const childSocket = { tabId: 20, connectionName: 2n }
	const hostPort = createPort(20, undefined, 0, 1n).port
	const childPort = createPort(20, undefined, 7, 2n).port
	Object.assign(hostPort.sender ?? {}, { id: 'test-extension', url: hostUrl })
	Object.assign(hostPort.sender?.tab ?? {}, { url: hostUrl })
	Object.assign(childPort.sender ?? {}, { id: 'test-extension', url: `${ origin }/swap` })
	Object.assign(childPort.sender?.tab ?? {}, { url: hostUrl })
	const host = { port: hostPort, socket: hostSocket, websiteOrigin: 'app.example', requestOrigin: origin, approved: true, wantsToConnect: false, nativeGnosisSafeAppOrigin: origin }
	const child = { port: childPort, socket: childSocket, websiteOrigin: 'app.example', requestOrigin: origin, approved: false, wantsToConnect: false, nativeGnosisSafeAppsSigner: true, nativeGnosisSafeAppsHostPort: hostPort }
	const connections: WebsiteTabConnections = new Map([
		[20, { connections: { [websiteSocketToString(hostSocket)]: host, [websiteSocketToString(childSocket)]: child } }],
	])
	Object.assign(childPort, { onDisconnect: { addListener: () => undefined, removeListener: () => undefined } })
	Object.assign(hostPort, { onDisconnect: { addListener: () => undefined, removeListener: () => undefined } })
	registerNativeGnosisSafeAppsSession(connections, 20, hostPort, origin)
	const urls = new Map([[20, hostUrl]])
	let hostEligible = true
	let hostAddress: AddressBookEntry | undefined = activeAddress
	let duringHostValidation = () => undefined
	const hostValidations: typeof hostSocket[] = []
	const dependencies: NonNullable<Parameters<typeof getNativeHostedSiteContext>[3]> = {
		getFrame: async () => ({ parentFrameId: 0, url: `${ origin }/swap` }),
		getTab: async (tabId) => { const url = urls.get(tabId); return url === undefined ? undefined : { url } },
		getEligibleHostAddress: async (_connections, socket) => {
			hostValidations.push(socket)
			duringHostValidation()
			return hostEligible ? hostAddress : undefined
		},
	}
	return { settings, activeAddress, origin, hostUrl, hostSocket, childSocket, host, child, connections, urls, dependencies, hostValidations,
		setHostEligible: (value: boolean) => { hostEligible = value },
		setHostAddress: (value: AddressBookEntry | undefined) => { hostAddress = value },
		duringHostValidation: (action: () => void) => { duringHostValidation = action },
		resolve: async () => await getNativeHostedSiteContext(connections, childSocket, settings, dependencies),
	}
}

test('native iframe HTTP context uses the approved host account without approving the child or replacing reply/signing identity', async () => {
	const h = await harness()
	const context = await h.resolve()
	assert.ok(context)
	const { isCurrent, ...authority } = context
	assert.deepEqual(authority, { hostSocket: h.hostSocket, origin: h.origin, activeAddress: h.activeAddress })
	assert.deepEqual(h.hostValidations, [h.hostSocket])
	assert.equal(await isCurrent(h.settings), true)
	assert.equal(h.child.approved, false)
	assert.equal(h.child.port.sender?.frameId, 7)
	assert.equal(h.host.port.sender?.frameId, 0)
	assert.equal(h.connections.get(20)?.signerStateOwner, undefined)
	assert.strictEqual(h.connections.get(20)?.connections[websiteSocketToString(h.childSocket)], h.child)
})

test('native iframe HTTP context rejects forged senders, host/host navigation and unapproved or mismatched host connections', async () => {
	const cases: ((h: Awaited<ReturnType<typeof harness>>) => void)[] = [
		(h) => { Object.assign(h.child.port.sender ?? {}, { id: 'another-extension' }) },
		(h) => { Object.assign(h.child.port.sender ?? {}, { frameId: 0 }) },
		(h) => { Object.assign(h.child.port.sender ?? {}, { url: 'https://attacker.example/' }) },
		(h) => { Object.assign(h.child.port.sender?.tab ?? {}, { id: 99 }) },
		(h) => { Object.assign(h.child.port.sender?.tab ?? {}, { url: 'moz-extension://test-extension/html/settingsView.html' }) },
		(h) => { h.urls.set(20, 'moz-extension://test-extension/html/settingsView.html') },
		(h) => { h.urls.set(20, nativeGnosisSafeAppsHostUrl('moz-extension://test-extension/', 20, 'https://attacker.example/', 2)) },
		(h) => { h.urls.set(20, 'moz-extension://test-extension/html/gnosisSafeAppsHost.html?hostTabId=10&appUrl=invalid'); Object.assign(h.child.port.sender?.tab ?? {}, { url: h.urls.get(20) }) },
		(h) => { h.connections.delete(20) },
		(h) => { h.urls.set(20, 'https://attacker.example/') },
		(h) => { h.child.nativeGnosisSafeAppsSigner = false },
		(h) => { registerNativeGnosisSafeAppsSession(h.connections, 20, h.child.port, h.origin) },
		(h) => { h.host.approved = false },
		(h) => { h.host.requestOrigin = 'https://attacker.example' },
		(h) => { Object.assign(h.host.port.sender ?? {}, { frameId: 8 }) },
		(h) => { h.connections.delete(20) },
		(h) => { h.connections.delete(20) },
	]
	for (const change of cases) {
		const h = await harness()
		change(h)
		assert.equal(await h.resolve(), undefined, change.toString())
	}
})

test('native iframe HTTP context revalidates host eligibility, selected account, chain and simulation mode for each read', async () => {
	const h = await harness()
	assert.ok(await h.resolve())
	h.setHostEligible(false)
	assert.equal(await h.resolve(), undefined, 'revoked host permissions must not reuse an earlier context')
	h.setHostEligible(true)
	h.setHostAddress(createGnosisSafeAddressBookEntry({ address: 0x9999n, chainId: 1n }))
	assert.equal(await h.resolve(), undefined)
	h.setHostAddress(createGnosisSafeAddressBookEntry({ address: h.activeAddress.address, chainId: 137n }))
	assert.equal(await h.resolve(), undefined)
	h.setHostAddress(h.activeAddress)
	assert.equal(await getNativeHostedSiteContext(h.connections, h.childSocket, { ...h.settings, simulationMode: false }, h.dependencies), undefined)
	assert.equal(await getNativeHostedSiteContext(h.connections, h.childSocket, { ...h.settings, activeSimulationAddress: 0x9999n }, h.dependencies), undefined)
	assert.equal(await getNativeHostedSiteContext(h.connections, h.childSocket, { ...h.settings, activeRpcNetwork: { ...h.settings.activeRpcNetwork, chainId: 137n } }, h.dependencies), undefined)
})

test('native iframe HTTP context discards a connection replaced during asynchronous host validation', async () => {
	for (const tabId of [20]) {
		const h = await harness()
		h.duringHostValidation(() => { h.connections.delete(tabId) })
		assert.equal(await h.resolve(), undefined)
	}
})

test('native context validates live browser bindings and approval after asynchronous host eligibility', async () => {
	const transitions: ((h: Awaited<ReturnType<typeof harness>>) => void)[] = [
		(h) => { h.host.approved = false },
		(h) => { h.urls.set(20, 'https://attacker.example/') },
		(h) => { h.urls.set(20, 'moz-extension://test-extension/html/settingsView.html') },
	]
	for (const transition of transitions) {
		const h = await harness()
		h.duringHostValidation(() => { transition(h) })
		assert.equal(await h.resolve(), undefined, transition.toString())
		assert.equal(h.hostValidations.length, 1, 'initial context selects the host account once')
	}
})

test('captured native authority fails closed on revocation, navigation and host replacement without selecting another host', async () => {
	const transitions: ((h: Awaited<ReturnType<typeof harness>>) => void)[] = [
		(h) => { h.host.approved = false },
		(h) => { h.setHostEligible(false) },
		(h) => { h.setHostAddress(createGnosisSafeAddressBookEntry({ address: 0x9999n, chainId: 1n })) },
		(h) => { h.urls.set(20, 'https://attacker.example/') },
		(h) => { h.urls.set(20, 'moz-extension://test-extension/html/settingsView.html') },
		(h) => { const tab = h.connections.get(20); assert.ok(tab); tab.connections[websiteSocketToString(h.hostSocket)] = { ...h.host } },
	]
	for (const transition of transitions) {
		const h = await harness()
		const context = await h.resolve()
		assert.ok(context)
		transition(h)
		assert.equal(await context.isCurrent(h.settings), false, transition.toString())
		assert.strictEqual(context.hostSocket, h.hostSocket)
		assert.equal(h.hostValidations.every((socket) => socket === h.hostSocket), true)
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
	assert.equal(h.hostValidations.length, 1, 'an incompatible selection fails before another account lookup')
})

test('captured native authority also discards revocation and navigation during asynchronous revalidation', async () => {
	for (const target of ['approval', 'host', 'host']) {
		const h = await harness()
		const context = await h.resolve()
		assert.ok(context)
		h.duringHostValidation(() => {
			if (target === 'approval') h.host.approved = false
			else h.urls.set(20, 'https://attacker.example/')
		})
		assert.equal(await context.isCurrent(h.settings), false, target)
	}
})

test('native iframe HTTP context propagates unexpected browser failures', async () => {
	const h = await harness()
	await assert.rejects(getNativeHostedSiteContext(h.connections, h.childSocket, h.settings, { ...h.dependencies, getTab: async () => { throw new Error('Unexpected browser failure') } }), /Unexpected browser failure/)
})


test('native iframe authority rechecks stored address consent even while the host connection remains approved', async () => {
	const h = await harness()
	const context = await h.resolve()
	assert.ok(context)
	const revoked = { ...h.settings, websiteAccess: [] }
	assert.equal(h.host.approved, true)
	assert.equal(await context.isCurrent(revoked), false)
	assert.equal(await getNativeHostedSiteContext(h.connections, h.childSocket, revoked, h.dependencies), undefined)
})

 test('native HTTP authority revalidates the direct frame and document while allowing same-origin SPA navigation', async () => {
	const h = await harness()
	Object.assign(h.child.port.sender ?? {}, { documentId: 'original' })
	for (const frame of [
		{ parentFrameId: 0, url: `${ h.origin }/other#route`, documentId: 'original' },
		{ parentFrameId: 7, url: h.origin, documentId: 'original' },
		{ parentFrameId: 0, url: 'https://attacker.example', documentId: 'original' },
		{ parentFrameId: 0, url: h.origin, documentId: 'replacement' },
	]) {
		const context = await getNativeHostedSiteContext(h.connections, h.childSocket, h.settings, { ...h.dependencies, getFrame: async () => frame })
		assert.equal(context !== undefined, frame.url.endsWith('#route'))
	}
})
