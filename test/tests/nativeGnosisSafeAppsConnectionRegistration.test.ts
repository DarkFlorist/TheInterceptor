import { NATIVE_GNOSIS_SAFE_APPS_SESSION_READY } from '../../app/ts/types/nativeGnosisSafeAppsHostContext.js'
import { getNativeGnosisSafeAppsSession, notifyNativeGnosisSafeAppsSessionConnections } from '../../app/ts/background/nativeGnosisSafeAppsSessions.js'
import type { WebsiteTabConnections } from '../../app/ts/types/user-interface-types.js'
import * as assert from 'node:assert/strict'
import { test } from 'bun:test'
import { createPort, installBrowserMock } from './backgroundEthAccountsTestHarness.js'
import { getNativeGnosisSafeAppsConnectionRegistration } from '../../app/ts/background/nativeGnosisSafeAppsConnectionRegistration.js'
import { nativeGnosisSafeAppsHostUrl } from '../../app/ts/utils/nativeGnosisSafeAppsHost.js'

function setup() {
	installBrowserMock({ manifestVersion: 3 })
	Object.assign(browser.runtime, { id: 'extension-id', getURL: (path: string) => `chrome-extension://extension-id/${ path }` })
	const hostUrl = nativeGnosisSafeAppsHostUrl('chrome-extension://extension-id/', 7, 'https://app.example:8443/swap', 3)
	Object.assign(browser.tabs, { get: async () => ({ id: 7, url: hostUrl }) })
	Object.assign(browser, { webNavigation: { getFrame: async () => ({ parentFrameId: 0, url: 'https://app.example:8443/swap#current' }) } })
	const makePort = (frameId: number, url: string) => {
		const { port } = createPort(7, undefined, frameId)
		const disconnected = new Set<() => void>()
		Object.assign(port, { onDisconnect: { addListener: (listener: () => void) => { disconnected.add(listener) }, removeListener: (listener: () => void) => { disconnected.delete(listener) } }, disconnect: () => { for (const listener of disconnected) listener() } })
		Object.assign(port.sender ?? {}, { id: 'extension-id', url })
		Object.assign(port.sender?.tab ?? {}, { url: hostUrl })
		return port
	}
	return { hostUrl, makePort }
}

test('host registration derives app permission identity without inheriting the original signer', async () => {
	const h = setup()
	const result = await getNativeGnosisSafeAppsConnectionRegistration(h.makePort(0, h.hostUrl), 7, new Map())
	assert.equal(result?.isSignerOwner, false)
	assert.deepEqual(result?.frameOrigins, { websiteOrigin: 'app.example:8443', requestOrigin: 'https://app.example:8443' })
	assert.equal(result?.properties.nativeGnosisSafeAppOrigin, 'https://app.example:8443')
})

test('only the real direct app child can claim native signer ownership, including same-origin SPA URLs', async () => {
	const h = setup()
	const child = h.makePort(3, 'https://app.example:8443/swap')
	const connections: WebsiteTabConnections = new Map()
	await getNativeGnosisSafeAppsConnectionRegistration(h.makePort(0, h.hostUrl), 7, connections)
	assert.equal((await getNativeGnosisSafeAppsConnectionRegistration(child, 7, connections))?.isSignerOwner, true)
	for (const frame of [{ parentFrameId: 9, url: 'https://app.example:8443/swap' }, { parentFrameId: 0, url: 'https://other.example/' }]) {
		Object.assign(browser.webNavigation, { getFrame: async () => frame })
		assert.equal(await getNativeGnosisSafeAppsConnectionRegistration(child, 7, new Map()), undefined)
	}
})

test('native registration rejects wrong host-tab bindings and navigation during discovery', async () => {
	const h = setup()
	const child = h.makePort(3, 'https://app.example:8443/swap')
	Object.assign(child.sender?.tab ?? {}, { id: 8 })
	assert.equal(await getNativeGnosisSafeAppsConnectionRegistration(child, 8, new Map()), undefined)
	Object.assign(child.sender?.tab ?? {}, { id: 7 })
	Object.assign(browser.tabs, { get: async () => ({ id: 7, url: 'https://other.example/' }) })
	assert.equal(await getNativeGnosisSafeAppsConnectionRegistration(child, 7, new Map()), undefined)
})

test('host requests wait for the new authenticated signer instead of inheriting the replaced page state', async () => {
	const h = setup()
	await browser.storage.local.set({ simulationMode: false })
	const host = h.makePort(0, h.hostUrl)
	const disconnected = new Set<() => void>()
	Object.assign(host, { onDisconnect: { addListener: (listener: () => void) => { disconnected.add(listener) }, removeListener: (listener: () => void) => { disconnected.delete(listener) } }, disconnect: () => { for (const listener of disconnected) listener() } })
	const connections: WebsiteTabConnections = new Map()
	const registration = await getNativeGnosisSafeAppsConnectionRegistration(host, 7, connections)
	let ready = false
	const waiting = registration?.beforeRequest?.().then(() => { ready = true })
	await Promise.resolve()
	assert.equal(ready, false)
	const child = h.makePort(3, 'https://app.example:8443/swap')
	const childRegistration = await getNativeGnosisSafeAppsConnectionRegistration(child, 7, connections)
	connections.set(7, { signerStateOwner: { confirmed: true, connectionName: 0n, generation: 1, providerGeneration: 1 }, connections: { '7-0x0': { port: child, socket: { tabId: 7, connectionName: 0n }, websiteOrigin: 'app.example:8443', approved: false, wantsToConnect: false, nativeGnosisSafeAppsSigner: true, nativeGnosisSafeAppsHostPort: host } } })
	childRegistration?.registered?.()
	await waiting
	assert.equal(ready, true)
	assert.equal(disconnected.size, 1)
})

test('closing the host cancels startup readiness and releases its listener', async () => {
	const h = setup()
	await browser.storage.local.set({ simulationMode: false })
	const host = h.makePort(0, h.hostUrl)
	const disconnected = new Set<() => void>()
	Object.assign(host, { onDisconnect: { addListener: (listener: () => void) => { disconnected.add(listener) }, removeListener: (listener: () => void) => { disconnected.delete(listener) } }, disconnect: () => { for (const listener of disconnected) listener() } })
	const registration = await getNativeGnosisSafeAppsConnectionRegistration(host, 7, new Map())
	const waiting = registration?.beforeRequest?.()
	await new Promise((resolve) => setTimeout(resolve, 0))
	assert.equal(disconnected.size, 2, 'both the root session and its readiness waiter observe disconnection')
	for (const disconnect of disconnected) disconnect()
	await assert.rejects(waiting ?? Promise.resolve(), /Retry the connection/)
	assert.equal(disconnected.size, 0)
})

for (const version of [2, 3]) test(`MV${ version } declares the browser frame API used for native signer authentication`, async () => {
	const manifest = await Bun.file(`app/manifestV${ version }.json`).json()
	assert.ok(Array.isArray(manifest.permissions) && manifest.permissions.includes('webNavigation'))
})


test('independent simulation requests do not depend on an iframe wallet provider', async () => {
	const h = setup()
	await browser.storage.local.set({ simulationMode: true, useSignersAddressAsActiveAddress: false })
	const registration = await getNativeGnosisSafeAppsConnectionRegistration(h.makePort(0, h.hostUrl), 7, new Map())
	await registration?.beforeRequest?.()
})


test('invalid or legacy host launches fail closed instead of becoming extension-origin website connections', async () => {
	const h = setup()
	for (const url of [h.hostUrl.replace('hostTabId=7', 'hostTabId=8'), h.hostUrl.replace('hostTabId=7', 'sourceTabId=7'), h.hostUrl.replace('/html3/gnosisSafeAppsHostV3.html', '/html/gnosisSafeAppsHost.html')]) {
		await assert.rejects(getNativeGnosisSafeAppsConnectionRegistration(h.makePort(0, url), 7, new Map()), /Invalid app host session/)
	}
})


test('same-URL reload waits for its own signer session and ignores late cleanup from the replaced root', async () => {
	const h = setup()
	await browser.storage.local.set({ simulationMode: false })
	const connections: WebsiteTabConnections = new Map()
	const oldRoot = h.makePort(0, h.hostUrl)
	const oldDisconnects = new Set<() => void>()
	Object.assign(oldRoot, { onDisconnect: { addListener: (listener: () => void) => { oldDisconnects.add(listener) }, removeListener: (listener: () => void) => { oldDisconnects.delete(listener) } } })
	await getNativeGnosisSafeAppsConnectionRegistration(oldRoot, 7, connections)
	const child = h.makePort(3, 'https://app.example:8443/swap')
	const childSocket = { tabId: 7, connectionName: 0n }
	const childConnection = { port: child, socket: childSocket, websiteOrigin: 'app.example:8443', approved: true, wantsToConnect: true, nativeGnosisSafeAppsSigner: true, nativeGnosisSafeAppsHostPort: oldRoot }
	connections.set(7, { signerStateOwner: { confirmed: true, connectionName: 0n, generation: 1, providerGeneration: 1 }, connections: { '7-0x0': childConnection } })
	const root = h.makePort(0, h.hostUrl)
	const registration = await getNativeGnosisSafeAppsConnectionRegistration(root, 7, connections)
	let ready = false
	const waiting = registration?.beforeRequest?.().then(() => { ready = true })
	await new Promise((resolve) => setTimeout(resolve, 0))
	assert.equal(ready, false, 'old confirmed signer state is not authority for a new root with the same URL')
	for (const disconnect of oldDisconnects) disconnect()
	assert.equal(getNativeGnosisSafeAppsSession(connections, 7)?.port, root)
	childConnection.nativeGnosisSafeAppsHostPort = root
	notifyNativeGnosisSafeAppsSessionConnections(connections)
	await waiting
	assert.equal(ready, true)
})


test('only a registered current root acknowledges readiness before its iframe is loaded', async () => {
	const h = setup()
	const connections: WebsiteTabConnections = new Map()
	const old = h.makePort(0, h.hostUrl)
	const sent: unknown[] = []
	Object.assign(old, { postMessage: (message: unknown) => { sent.push(message) } })
	const registration = await getNativeGnosisSafeAppsConnectionRegistration(old, 7, connections)
	assert.deepEqual(sent, [], 'Authentication alone does not announce a registered request connection')
	registration?.registered?.()
	assert.deepEqual(sent, [{ type: NATIVE_GNOSIS_SAFE_APPS_SESSION_READY }])
	const current = h.makePort(0, h.hostUrl)
	await getNativeGnosisSafeAppsConnectionRegistration(current, 7, connections)
	registration?.registered?.()
	assert.equal(sent.length, 1, 'A delayed old-root registration cannot start a new iframe')
	assert.equal(getNativeGnosisSafeAppsSession(connections, 7)?.port, current)
})
