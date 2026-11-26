import { registerNativeGnosisSafeAppsSession, getNativeGnosisSafeAppsSession } from '../../app/ts/background/nativeGnosisSafeAppsSessions.js'
import { getSiteReadRequestAccessContext } from '../../app/ts/background/siteReadRequestAdmission.js'
import { hasRequestAccessAddress, createRequestAccessContextResolver } from '../../app/ts/background/requestAccessContext.js'
import * as assert from 'assert'
import { spyOn, test } from 'bun:test'
import type { AddressBookEntry } from '../../app/ts/types/addressBookTypes.js'
import type { WebsiteTabConnections } from '../../app/ts/types/user-interface-types.js'
import { createGnosisSafeSessionCapabilitiesFeature, initializeGnosisSafeSessionCapabilities } from '../../app/ts/background/gnosisSafeSessionCapabilitiesCoordinator.js'
import { nativeGnosisSafeAppsHostUrl } from '../../app/ts/utils/nativeGnosisSafeAppsHost.js'
import { createPort, createDeferredValue, createEthereumWithGetBlockCounter, installBrowserMock, loadModules, noopPublishRpcConnectionStatus, waitForPortMessageCount } from './backgroundEthAccountsTestHarness.js'

const resolveRequestAccessContext = createRequestAccessContextResolver([{ method: 'site_rpc_request', resolve: getSiteReadRequestAccessContext }])

async function harness() {
	installBrowserMock({ manifestVersion: 3 })
	Object.assign(browser.runtime, { id: 'test-extension', getURL: (path: string) => new URL(path, 'moz-extension://test-extension/').href })
	const modules = await loadModules()
	const address = 0x6868686868686868686868686868686868686868n
	await modules.changeSimulationMode({ simulationMode: true, activeSimulationAddress: address })
	await modules.setUseSignersAddressAsActiveAddress(false)
	await modules.setGnosisSafeAppsCompatibilityMode(true)
	await modules.setSiteRpcInterceptionEnabled(true)
	await modules.updateUserAddressBookEntries(() => [{ type: 'safe', name: 'Simulated Gnosis Safe', address, chainId: 1n, entrySource: 'User', useAsActiveAddress: true }])
	const website = { websiteOrigin: 'app.aave.com', title: undefined, icon: undefined }
	await modules.updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address, access: true }] }])
	const connections: WebsiteTabConnections = new Map()
	const urls = new Map<number, string>()
	const tabReads: number[] = []
	Object.assign(browser, { webNavigation: { getFrame: async () => ({ parentFrameId: 0, url: 'https://app.aave.com/' }) } })
	const frame = spyOn(browser.webNavigation, 'getFrame').mockImplementation(async () => ({ parentFrameId: 0, url: 'https://app.aave.com/' }))
	const originalGet = browser.tabs.get
	const getTab = spyOn(browser.tabs, 'get').mockImplementation(async (tabId) => {
		tabReads.push(tabId)
		return { ...await originalGet(tabId), url: urls.get(tabId) }
	})
	const add = (tabId: number, frameId: number, sourceTabId?: number) => {
		const socket = { tabId, connectionName: BigInt(tabId * 100 + frameId) }
		const result = createPort(tabId, undefined, frameId, socket.connectionName)
		const url = nativeGnosisSafeAppsHostUrl('moz-extension://test-extension/', tabId, 'https://app.aave.com/', 3)
		Object.assign(result.port.sender ?? {}, { id: 'test-extension', url: frameId === 0 ? url : 'https://app.aave.com/' })
		Object.assign(result.port.sender?.tab ?? {}, { url })
		urls.set(tabId, url)
		const connection = { port: result.port, socket, websiteOrigin: website.websiteOrigin, requestOrigin: 'https://app.aave.com', approved: frameId === 0, wantsToConnect: false }
		Object.assign(connection, frameId === 0 ? { nativeGnosisSafeAppOrigin: 'https://app.aave.com' } : { nativeGnosisSafeAppsSigner: true, nativeGnosisSafeAppsHostPort: getNativeGnosisSafeAppsSession(connections, tabId)?.port })
		connections.set(tabId, { connections: { ...connections.get(tabId)?.connections, [modules.websiteSocketToString(socket)]: connection } })
		Object.assign(result.port, { onDisconnect: { addListener: () => undefined, removeListener: () => undefined } })
		if (frameId === 0) registerNativeGnosisSafeAppsSession(connections, tabId, result.port, 'https://app.aave.com')
		return { ...result, socket, connection }
	}
	const source = add(20, 0)
	const child = add(20, 7, 10)
	const unrelatedSource = add(30, 0)
	const unrelatedChild = add(30, 8, 30)
	const services = createEthereumWithGetBlockCounter({ count: 0 })
	const send = async (target: typeof child, method = 'site_rpc_request', params: unknown[] = [{ chainId: '0x1', request: { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] } }], websiteInput: typeof website | Promise<typeof website> = website) => {
		const requestId = target.messages.length + 100
		await modules.handleInterceptedRequest(target.port, website.websiteOrigin, websiteInput, services.simulationServicesOwner, target.socket, { interceptorRequest: true, interceptorInternalRequest: true, usingInterceptorWithoutSigner: true, uniqueRequestIdentifier: { requestId, requestSocket: target.socket }, method, params }, connections, noopPublishRpcConnectionStatus)
		return target.messages.find((message) => message.requestId === requestId)
	}
	return { ...modules, ethereum: services.ethereum, address, website, connections, urls, tabReads, source, child, unrelatedSource, unrelatedChild, send, restore: () => { getTab.mockRestore(); frame.mockRestore() } }
}

test('native HTTP reads share the provider access gate while keeping the child unapproved', async () => {
	const h = await harness()
	const accessManagement = await import('../../app/ts/background/accessManagement.js')
	const verify = spyOn(accessManagement, 'verifyAccess')
	try {
		assert.equal((await h.send(h.child))?.result, '0x1')
		assert.ok(verify.mock.calls.some((args) => args[1] === h.source.socket && args[4]?.address === h.address && args[6]?.ignoreConnectionApproval === true), 'native reads use the shared access verifier on their verified source')
		assert.equal(h.child.connection.approved, false)
		assert.equal(h.connections.get(h.child.socket.tabId)?.signerStateOwner, undefined)
		assert.equal((await h.send(h.source, 'eth_chainId', []))?.result, '0x1')
		assert.equal((await h.send(h.source))?.result, '0x1')
		assert.equal(h.child.connection.approved, false)
		h.source.connection.approved = false
		assert.equal((await h.send(h.child))?.error?.code, 4100)
		assert.equal(h.child.connection.approved, false)
		h.source.connection.approved = true
		await h.updateWebsiteAccess(() => [{ website: h.website, access: true, addressAccess: [{ address: h.address, access: false }] }])
		assert.equal((await h.send(h.child))?.error?.code, 4100, 'cached source approval cannot bypass current address consent')
		assert.equal(h.child.connection.approved, false)
		assert.equal((await h.send(h.source, 'eth_accounts', []))?.result?.length, 0, 'public account identity also obeys revoked address consent')
	} finally { verify.mockRestore(); h.restore() }
})

test('native HTTP admission rejects signing mode, host navigation and forged host frames', async () => {
	for (const change of ['signing', 'navigation', 'sender']) {
		const h = await harness()
		try {
			if (change === 'signing') await h.changeSimulationMode({ simulationMode: false })
			if (change === 'navigation') h.urls.set(20, nativeGnosisSafeAppsHostUrl('moz-extension://test-extension/', 10, 'https://attacker.example/', 3))
			if (change === 'sender') Object.assign(h.child.port.sender ?? {}, { id: 'attacker-extension' })
			assert.equal((await h.send(h.child))?.error?.code, 4100)
			assert.equal(h.child.connection.approved, false)
		} finally { h.restore() }
	}
})

test('source lifecycle refreshes only its native children and preserves revocation, reapproval and cleanup', async () => {
	const h = await harness()
	const feature = createGnosisSafeSessionCapabilitiesFeature(h.connections)
	try {
		feature.sdk.setEnabled(true)
		feature.site.setEnabled(true)
		for (const target of [h.source, h.child, h.unrelatedSource, h.unrelatedChild]) await waitForPortMessageCount(target.messages, 'site_behavior', 1)
		const unrelatedCount = h.unrelatedChild.messages.length
		const unrelatedSourceCount = h.unrelatedSource.messages.length
		assert.ok(h.child.messages.find((message) => message.method === 'site_behavior')?.result?.rpcInterception)
		for (const event of ['signerConnected', 'signerAccountsChanged', 'disconnect', 'approve', 'remove']) {
			h.tabReads.length = 0
			const count = h.child.messages.filter((message) => message.method === 'site_behavior').length
			if (event === 'signerConnected') feature.lifecycle.signerConnected?.(h.source.socket, false)
			if (event === 'signerAccountsChanged') feature.lifecycle.signerAccountsChanged?.(h.source.socket)
			if (event === 'disconnect') { h.source.connection.approved = false; feature.lifecycle.approvalChanged?.(h.source.socket, false) }
			if (event === 'approve') { h.source.connection.approved = true; feature.lifecycle.approvalChanged?.(h.source.socket, true) }
			if (event === 'remove') { delete h.connections.get(h.source.socket.tabId)?.connections[h.websiteSocketToString(h.source.socket)]; feature.lifecycle.connectionRemoved?.(h.source.socket) }
			await waitForPortMessageCount(h.child.messages, 'site_behavior', count + 1)
			assert.equal(h.unrelatedChild.messages.length, unrelatedCount, event)
			assert.equal(h.unrelatedSource.messages.length, unrelatedSourceCount, event)
			assert.equal(h.tabReads.includes(40) || h.tabReads.includes(30), false, 'unrelated native children are not revalidated')
			const published = h.child.messages.filter((message) => message.method === 'site_behavior').at(-1)?.result?.rpcInterception
			assert.equal(published !== undefined, !['disconnect', 'remove'].includes(event), event)
		}
		const childCount = h.child.messages.length
		h.connections.delete(h.child.socket.tabId)
		feature.lifecycle.connectionRemoved?.(h.child.socket)
		h.tabReads.length = 0
		feature.lifecycle.signerAccountsChanged?.(h.source.socket)
		await new Promise((resolve) => setTimeout(resolve, 0))
		assert.equal(h.child.messages.length, childCount, 'removed children are dropped from the index')
		assert.deepEqual(h.tabReads, [], 'removed children are no longer looked up in the browser')
		h.tabReads.length = 0
		feature.dispose()
		feature.lifecycle.signerAccountsChanged?.(h.unrelatedSource.socket)
		await new Promise((resolve) => setTimeout(resolve, 0))
		assert.deepEqual(h.tabReads, [], 'disabled coordinator retains no child refreshes')
	} finally { feature.dispose(); h.restore() }
})


test('global access reconciliation refreshes every native source while read admission still checks chain and selected Safe', async () => {
	const h = await harness()
	const feature = createGnosisSafeSessionCapabilitiesFeature(h.connections)
	try {
		assert.equal((await h.send(h.child, 'site_rpc_request', [{ chainId: '0x89', request: { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] } }]))?.error?.code, -32602)
		feature.sdk.setEnabled(true)
		feature.site.setEnabled(true)
		for (const target of [h.child, h.unrelatedChild]) await waitForPortMessageCount(target.messages, 'site_behavior', 1)
		const counts = [h.child, h.unrelatedChild].map((target) => target.messages.filter((message) => message.method === 'site_behavior').length)
		await h.updateWebsiteAccess(() => [{ website: h.website, access: false }])
		feature.lifecycle.accessReconciled?.()
		for (const [index, target] of [h.child, h.unrelatedChild].entries()) {
			await waitForPortMessageCount(target.messages, 'site_behavior', (counts[index] ?? 0) + 1)
			assert.equal(target.messages.filter((message) => message.method === 'site_behavior').at(-1)?.result?.rpcInterception, undefined)
			assert.equal((await h.send(target))?.error?.code, 4100)
		}
		await h.changeSimulationMode({ simulationMode: true, activeSimulationAddress: undefined })
		assert.equal((await h.send(h.child))?.error?.code, 4100)
	} finally { feature.dispose(); h.restore() }
})


test('a newly ready native child is indexed before its source disconnects', async () => {
	const h = await harness()
	const childTab = h.connections.get(h.child.socket.tabId)
	assert.ok(childTab)
	h.connections.delete(h.child.socket.tabId)
	const feature = createGnosisSafeSessionCapabilitiesFeature(h.connections)
	try {
		feature.sdk.setEnabled(true)
		feature.site.setEnabled(true)
		await waitForPortMessageCount(h.unrelatedChild.messages, 'site_behavior', 1)
		h.connections.set(h.child.socket.tabId, childTab)
		feature.lifecycle.connectionReady?.(h.child.socket)
		await waitForPortMessageCount(h.child.messages, 'site_behavior', 1)
		assert.ok(h.child.messages.find((message) => message.method === 'site_behavior')?.result?.rpcInterception)
		const unrelatedCount = h.unrelatedChild.messages.length
		h.source.connection.approved = false
		feature.lifecycle.approvalChanged?.(h.source.socket, false)
		await waitForPortMessageCount(h.child.messages, 'site_behavior', 2)
		assert.equal(h.child.messages.filter((message) => message.method === 'site_behavior').at(-1)?.result?.rpcInterception, undefined)
		assert.equal(h.unrelatedChild.messages.length, unrelatedCount)
	} finally { feature.dispose(); h.restore() }
})


test('hosting revocation retracts native children while ordinary HTTP capability remains independently enabled', async () => {
	const h = await harness()
	const feature = createGnosisSafeSessionCapabilitiesFeature(h.connections)
	const dispose = await initializeGnosisSafeSessionCapabilities(feature)
	try {
		await waitForPortMessageCount(h.child.messages, 'site_behavior', 1)
		assert.ok(h.child.messages.filter((message) => message.method === 'site_behavior').at(-1)?.result?.rpcInterception)
		const childPublications = h.child.messages.filter((message) => message.method === 'site_behavior').length
		await h.setGnosisSafeAppsCompatibilityMode(false)
		assert.equal((await h.send(h.child))?.result, '0x1', 'SDK disabled leaves HTTP enabled')
		assert.equal(h.source.messages.filter((message) => message.method === 'safe_apps_compatibility').at(-1)?.result?.enabled, false)
		const publications = h.child.messages.filter((message) => message.method === 'site_behavior').length
		await h.setGnosisSafeAppsCompatibilityMode(true)
		assert.equal((await h.send(h.child))?.result, '0x1')
		assert.ok(h.child.messages.filter((message) => message.method === 'site_behavior').at(-1)?.result?.rpcInterception)
		assert.equal(h.child.connection.approved, false)
	} finally { dispose(); h.restore() }
})


test('effective access contexts use focused read admission and retain canonical ordinary account selection', async () => {
	const h = await harness()
	try {
		let ordinarySelections = 0
		const ordinaryAddress = async () => { ordinarySelections++; return undefined }
		const request = { interceptorRequest: true, usingInterceptorWithoutSigner: true, method: 'site_rpc_request', uniqueRequestIdentifier: { requestId: 1, requestSocket: h.child.socket }, params: [] }
		const settings = await h.getSettings()
		const native = await resolveRequestAccessContext(h.connections, h.child.socket, request, settings, h.website.websiteOrigin, ordinaryAddress)
		assert.equal(native.activeAddress?.address, h.address)
		assert.strictEqual(native.accessSocket, h.source.socket)
		assert.equal(native.requireAddressAccess, true)
		assert.equal(ordinarySelections, 0)
		assert.strictEqual(request.uniqueRequestIdentifier.requestSocket, h.child.socket, 'effective permission authority does not replace reply identity')
		h.source.connection.approved = false
		const denied = await resolveRequestAccessContext(h.connections, h.child.socket, request, settings, h.website.websiteOrigin, ordinaryAddress)
		assert.equal(denied.activeAddress, undefined)
		assert.equal(denied.requireAddressAccess, true)
		assert.equal(ordinarySelections, 0, 'failed native admission cannot fall back to a child account')
		const ordinary = await resolveRequestAccessContext(h.connections, h.child.socket, { ...request, method: 'eth_accounts' }, settings, h.website.websiteOrigin, ordinaryAddress)
		assert.strictEqual(ordinary.accessSocket, h.child.socket)
		assert.equal(ordinary.requireAddressAccess, false)
		assert.equal(ordinarySelections, 1, 'ordinary methods keep canonical address selection')
	} finally { h.restore() }
})

test('Gnosis Safe session capabilities exclude EOA simulation even when the compatibility setting is enabled', async () => {
	const h = await harness()
	const feature = createGnosisSafeSessionCapabilitiesFeature(h.connections)
	try {
		await h.updateUserAddressBookEntries(() => [{ type: 'contact', name: 'Ordinary account', address: h.address, chainId: 1n, entrySource: 'User', useAsActiveAddress: true }])
		feature.sdk.setEnabled(true)
		feature.site.setEnabled(true)
		for (const target of [h.source, h.child]) await waitForPortMessageCount(target.messages, 'site_behavior', 1)
		assert.equal(h.source.messages.filter((message) => message.method === 'site_behavior').at(-1)?.result?.rpcInterception, undefined)
		assert.equal(h.child.messages.filter((message) => message.method === 'site_behavior').at(-1)?.result?.rpcInterception, undefined)
		assert.equal((await h.send(h.child))?.error?.code, 4100)
		assert.equal((await h.send(h.source))?.error?.code, -32602)
	} finally { feature.dispose(); h.restore() }
})


test('native HTTP execution reuses one admitted authority and validates its captured proof', async () => {
	const h = await harness()
	const nativeOwner = await import('../../app/ts/background/nativeHostedSiteContext.js')
	const resolve = spyOn(nativeOwner, 'getNativeHostedSiteContext')
	try {
		assert.equal((await h.send(h.child))?.result, '0x1')
		assert.equal(resolve.mock.calls.length, 1, 'discovery and execution share one native authority instead of resolving it twice')
		const context = await resolve.mock.results[0]?.value
		assert.ok(context)
		assert.strictEqual(context.hostSocket, h.source.socket)
		assert.equal(h.child.connection.approved, false)
	} finally { resolve.mockRestore(); h.restore() }
})

test('captured native authority fails closed when its source changes while website metadata is pending', async () => {
	for (const change of ['approval', 'permission', 'source-navigation', 'host-navigation', 'source-replacement', 'selected-address']) {
		const h = await harness()
		const accessManagement = await import('../../app/ts/background/accessManagement.js')
		const nativeOwner = await import('../../app/ts/background/nativeHostedSiteContext.js')
		const originalVerify = accessManagement.verifyAccess
		const admitted = createDeferredValue<void>()
		const website = createDeferredValue<typeof h.website>()
		const verify = spyOn(accessManagement, 'verifyAccess').mockImplementation((...args) => {
			const result = originalVerify(...args)
			if (args[1] === h.source.socket && result === 'hasAccess') admitted.resolve(undefined)
			return result
		})
		const resolve = spyOn(nativeOwner, 'getNativeHostedSiteContext')
		try {
			const pending = h.send(h.child, 'site_rpc_request', [{ chainId: '0x1', request: { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] } }], website.promise)
			await admitted.promise
			if (change === 'approval') h.source.connection.approved = false
			if (change === 'permission') await h.updateWebsiteAccess(() => [{ website: h.website, access: false }])
			if (change === 'source-navigation') h.urls.set(h.source.socket.tabId, 'https://attacker.example/')
			if (change === 'host-navigation') h.urls.set(h.child.socket.tabId, 'moz-extension://test-extension/html3/settingsViewV3.html')
			if (change === 'source-replacement') {
				const sourceTab = h.connections.get(h.source.socket.tabId)
				assert.ok(sourceTab)
				sourceTab.connections[h.websiteSocketToString(h.source.socket)] = { ...h.source.connection }
			}
			if (change === 'selected-address') await h.changeSimulationMode({ simulationMode: true, activeSimulationAddress: undefined })
			website.resolve(h.website)
			assert.equal((await pending)?.error?.code, 4100, change)
			assert.equal(resolve.mock.calls.length, 1, 'execution validates the captured proof without selecting a fresh source')
			assert.equal(h.child.connection.approved, false)
		} finally { website.resolve(h.website); verify.mockRestore(); resolve.mockRestore(); h.restore() }
	}
})

test('native capability publication resolves one context per child refresh', async () => {
	const h = await harness()
	const owner = await import('../../app/ts/background/nativeHostedSiteContext.js')
	const resolve = spyOn(owner, 'getNativeHostedSiteContext')
	const feature = createGnosisSafeSessionCapabilitiesFeature(h.connections)
	try {
		feature.sdk.setEnabled(true)
		feature.site.setEnabled(true)
		for (const target of [h.child, h.unrelatedChild]) await waitForPortMessageCount(target.messages, 'site_behavior', 1)
		assert.equal(resolve.mock.calls.filter((args) => args[1] === h.child.socket).length, 1)
		feature.lifecycle.signerAccountsChanged?.(h.source.socket)
		await waitForPortMessageCount(h.child.messages, 'site_behavior', 2)
		assert.equal(resolve.mock.calls.filter((args) => args[1] === h.child.socket).length, 2)
		assert.equal(resolve.mock.calls.filter((args) => args[1] === h.unrelatedChild.socket).length, 1, 'a source refresh leaves unrelated children alone')
	} finally { feature.dispose(); resolve.mockRestore(); h.restore() }
})

test('native publication tokens discard an earlier valid context after source and session invalidation', async () => {
	for (const change of ['approval', 'permission', 'source-navigation', 'host-navigation', 'mode', 'chain', 'selected-address', 'disabled']) {
		const h = await harness()
		const owner = await import('../../app/ts/background/nativeHostedSiteContext.js')
		const originalResolve = owner.getNativeHostedSiteContext
		const captured = createDeferredValue<void>()
		const release = createDeferredValue<void>()
		let pause = true
		const resolve = spyOn(owner, 'getNativeHostedSiteContext').mockImplementation(async (...args) => {
			const context = await originalResolve(...args)
			if (args[1] === h.child.socket && pause) {
				pause = false
				assert.ok(context)
				captured.resolve(undefined)
				await release.promise
			}
			return context
		})
		const feature = createGnosisSafeSessionCapabilitiesFeature(h.connections)
		try {
			feature.sdk.setEnabled(true)
			feature.site.setEnabled(true)
			await captured.promise
			if (change === 'approval') { h.source.connection.approved = false; feature.lifecycle.approvalChanged?.(h.source.socket, false) }
			if (change === 'permission') { await h.updateWebsiteAccess(() => [{ website: h.website, access: false }]); feature.lifecycle.accessReconciled?.() }
			if (change === 'source-navigation') { h.urls.set(20, 'https://attacker.example/'); feature.lifecycle.connectionRemoved?.(h.source.socket) }
			if (change === 'host-navigation') { h.urls.set(20, 'moz-extension://test-extension/html/settingsView.html'); feature.lifecycle.connectionReady?.(h.child.socket) }
			if (change === 'mode') { await h.changeSimulationMode({ simulationMode: false }); feature.lifecycle.accessReconciled?.() }
			if (change === 'chain') {
				await h.changeSimulationMode({ simulationMode: true, rpcNetwork: { ...(await h.getSettings()).activeRpcNetwork, chainId: 137n } })
				feature.lifecycle.accessReconciled?.()
			}
			if (change === 'selected-address') { await h.changeSimulationMode({ simulationMode: true, activeSimulationAddress: undefined }); feature.lifecycle.accessReconciled?.() }
			if (change === 'disabled') { feature.sdk.setEnabled(false); feature.site.setEnabled(false) }
			await waitForPortMessageCount(h.child.messages, 'site_behavior', 1)
			const publications = h.child.messages.filter((message) => message.method === 'site_behavior')
			assert.equal(publications.at(-1)?.result?.rpcInterception, undefined, change)
			release.resolve(undefined)
			await new Promise((done) => setTimeout(done, 0))
			assert.equal(h.child.messages.filter((message) => message.method === 'site_behavior').length, publications.length, `superseded ${ change } context must never publish`)
		} finally { release.resolve(undefined); feature.dispose(); resolve.mockRestore(); h.restore() }
	}
})


test('site admission owns complete token replies and leaves ordinary reads as shared RPC execution contexts', async () => {
	const h = await harness()
	const simulation = await import('../../app/ts/background/simulationUpdating.js')
	const metadata = await import('../../app/ts/background/metadataUtils.js')
	const { PASSTHROUGH_STATE } = await import('../../app/ts/types/visualizer-types.js')
	const { prepareSiteRpcRequest } = await import('../../app/ts/background/siteRpcInterception.js')
	const snapshot = spyOn(simulation, 'getUpdatedSimulationStackSnapshot').mockResolvedValue({ simulationInput: PASSTHROUGH_STATE, simulationState: PASSTHROUGH_STATE })
	const identify = spyOn(metadata, 'identifyAddress').mockImplementation(async (_ethereum, _abortController, address) => ({ type: 'ERC20', address, name: 'Ether', symbol: 'ETH', decimals: 18n, chainId: 1n, entrySource: 'Interceptor' }))
	try {
		const settings = await h.getSettings()
		const request = { method: 'site_rpc_request', interceptorRequest: true, usingInterceptorWithoutSigner: true, uniqueRequestIdentifier: { requestId: 1, requestSocket: h.child.socket }, params: [{ chainId: '0x1', request: { jsonrpc: '2.0', id: 7, method: 'eth_chainId', params: [] } }] }
		const context = await resolveRequestAccessContext(h.connections, h.child.socket, request, settings, h.website.websiteOrigin, async () => undefined)
		const address = context.activeAddress
		assert.ok(address)
		assert.ok(hasRequestAccessAddress(context))
		assert.ok(context.requireAddressAccess)
		assert.equal(await context.isCurrent(settings), true)
		const read = await prepareSiteRpcRequest(h.ethereum, h.connections, request, settings, context)
		assert.equal(read.kind, 'execute')
		if (read.kind !== 'execute') throw new Error('Expected admitted RPC execution')
		assert.equal(read.context.request.method, 'eth_chainId')
		assert.equal(snapshot.mock.calls.length, 0, 'ordinary read admission does not fetch a token snapshot')
		for (const method of ['interceptor_getSimulationTokens', 'interceptor_getSimulationTokenMetadata']) {
			const tokensRequest = { ...request, params: [{ chainId: '0x1', request: { method } }] }
			const admission = await prepareSiteRpcRequest(h.ethereum, h.connections, tokensRequest, settings, context)
			assert.equal(admission.kind, 'reply')
			if (admission.kind !== 'reply') throw new Error('Expected a complete token reply')
			assert.strictEqual(admission.reply.uniqueRequestIdentifier, request.uniqueRequestIdentifier)
			assert.equal(admission.reply.method, 'site_rpc_request')
			assert.deepEqual('result' in admission.reply ? admission.reply.result : undefined, method === 'interceptor_getSimulationTokens' ? [] : [{ address: BigInt('0x' + 'ee'.repeat(20)), name: 'Ether', symbol: 'ETH', decimals: 18n }])
		}
		assert.equal(snapshot.mock.calls.length, 2)
		assert.equal(identify.mock.calls.length, 1)
		snapshot.mockRejectedValueOnce(new Error('Token snapshot unavailable'))
		await assert.rejects(prepareSiteRpcRequest(h.ethereum, h.connections, { ...request, params: [{ chainId: '0x1', request: { method: 'interceptor_getSimulationTokens' } }] }, settings, context), /Token snapshot unavailable/)
	} finally { snapshot.mockRestore(); identify.mockRestore(); h.restore() }
})

test('SDK discovery and site HTTP capabilities own independent publication and retraction lifetimes', async () => {
	const h = await harness()
	const { createGnosisSafeAppsCompatibilityFeature } = await import('../../app/ts/background/gnosisSafeAppsCompatibilityCoordinator.js')
	const { createSiteBehaviorFeature } = await import('../../app/ts/background/siteBehaviorCoordinator.js')
	const sdk = createGnosisSafeAppsCompatibilityFeature(h.connections)
	const site = createSiteBehaviorFeature(h.connections)
	try {
		sdk.setEnabled(true)
		site.setEnabled(true)
		await waitForPortMessageCount(h.source.messages, 'safe_apps_compatibility', 1)
		await waitForPortMessageCount(h.child.messages, 'site_behavior', 1)
		assert.equal(h.child.messages.some((message) => message.method === 'safe_apps_compatibility'), false, 'native HTTP discovery does not synthesize a disabled SDK reply for the child')
		const initialSiteCount = h.child.messages.filter((message) => message.method === 'site_behavior').length
		sdk.dispose()
		assert.equal(h.child.messages.filter((message) => message.method === 'site_behavior').length, initialSiteCount, 'SDK disposal cannot retract the independent HTTP protocol')
		const sdkCount = h.source.messages.filter((message) => message.method === 'safe_apps_compatibility').length
		site.lifecycle.signerAccountsChanged?.(h.source.socket)
		await waitForPortMessageCount(h.child.messages, 'site_behavior', initialSiteCount + 1)
		assert.ok(h.child.messages.filter((message) => message.method === 'site_behavior').at(-1)?.result?.rpcInterception)
		assert.equal(h.source.messages.filter((message) => message.method === 'safe_apps_compatibility').length, sdkCount, 'site refresh cannot publish SDK discovery')
		site.dispose()
		assert.equal(h.child.messages.filter((message) => message.method === 'site_behavior').at(-1)?.result?.rpcInterception, undefined)
		assert.equal(h.source.messages.filter((message) => message.method === 'safe_apps_compatibility').length, sdkCount, 'site disposal cannot retract SDK discovery')
	} finally { sdk.dispose(); site.dispose(); h.restore() }
})

test('global reconciliation skips unrelated unapproved subframes without native tab reads or protocol publications', async () => {
	const h = await harness()
	const owner = await import('../../app/ts/background/nativeHostedSiteContext.js')
	const resolve = spyOn(owner, 'getNativeHostedSiteContext')
	const socket = { tabId: 60, connectionName: 60n }
	const ordinary = createPort(socket.tabId, undefined, 3, socket.connectionName)
	const connection = { port: ordinary.port, socket, websiteOrigin: h.website.websiteOrigin, requestOrigin: 'https://app.aave.com', approved: false, wantsToConnect: false }
	h.connections.set(socket.tabId, { connections: { [h.websiteSocketToString(socket)]: connection } })
	const feature = createGnosisSafeSessionCapabilitiesFeature(h.connections)
	try {
		feature.sdk.setEnabled(true)
		feature.site.setEnabled(true)
		await waitForPortMessageCount(h.child.messages, 'site_behavior', 1)
		h.tabReads.length = 0
		await feature.lifecycle.accessReconciled?.()
		await waitForPortMessageCount(h.child.messages, 'site_behavior', 2)
		await feature.lifecycle.connectionReady?.(socket)
		await new Promise((done) => setTimeout(done, 0))
		assert.equal(resolve.mock.calls.some((args) => args[1] === socket), false)
		assert.equal(h.tabReads.includes(socket.tabId), false)
		assert.deepEqual(ordinary.messages, [], 'an unrelated denied frame receives neither HTTP nor SDK capability traffic')
	} finally { feature.dispose(); resolve.mockRestore(); h.restore() }
})


for (const hosted of [false, true]) test(`SDK and HTTP admission share account, chain and approval checks for ${ hosted ? 'hosted' : 'ordinary' } reads`, async () => {
	const h = await harness()
	const { prepareSiteRpcRequest } = await import('../../app/ts/background/siteRpcInterception.js')
	const { isGnosisSafeAppsConnectionEligibleForAdmittedAddress } = await import('../../app/ts/background/gnosisSafeAppsConnectionEligibility.js')
	try {
		const target = hosted ? h.child : h.source
		const settings = await h.getSettings()
		const request = { method: 'site_rpc_request', interceptorRequest: true, usingInterceptorWithoutSigner: true, uniqueRequestIdentifier: { requestId: 1, requestSocket: target.socket }, params: [{ chainId: '0x1', request: { jsonrpc: '2.0', id: 7, method: 'eth_chainId', params: [] } }] }
		const context = await resolveRequestAccessContext(h.connections, target.socket, request, settings, h.website.websiteOrigin, async () => {
			const entries = await h.getUserAddressBookEntriesForChainIdMorePreciseFirst(1n)
			return entries.find((entry) => entry.address === h.address)
		})
		assert.ok(hasRequestAccessAddress(context))
		const entries: { readonly entry: AddressBookEntry, readonly accepted: boolean }[] = [
			{ entry: context.activeAddress, accepted: true },
			{ entry: { ...context.activeAddress, chainId: 137n }, accepted: false },
			{ entry: { ...context.activeAddress, address: 1n }, accepted: false },
			{ entry: { type: 'contact', address: h.address, name: 'Ordinary account', entrySource: 'User' }, accepted: false },
		]
		const refused = { kind: 'reply', reply: { type: 'result', method: 'site_rpc_request', uniqueRequestIdentifier: request.uniqueRequestIdentifier, error: { code: -32602, message: 'Site RPC interception is not enabled for this connection.' } } }
		for (const { entry, accepted } of entries) {
			assert.equal(isGnosisSafeAppsConnectionEligibleForAdmittedAddress(h.connections, context.accessSocket, settings, { activeAddress: entry, safeSigningMode: false }), accepted)
			const admission = prepareSiteRpcRequest(h.ethereum, h.connections, request, settings, { ...context, activeAddress: entry })
			if (accepted) assert.equal((await admission).kind, 'execute')
			else assert.deepEqual(await admission, refused)
		}
		h.source.connection.approved = false
		assert.equal(isGnosisSafeAppsConnectionEligibleForAdmittedAddress(h.connections, context.accessSocket, settings, { activeAddress: context.activeAddress, safeSigningMode: false }), false)
		assert.deepEqual(await prepareSiteRpcRequest(h.ethereum, h.connections, request, settings, context), refused, 'an earlier admitted context cannot bypass current source approval')
	} finally { h.restore() }
})

for (const hosting of [false, true]) for (const reads of [false, true]) test(`real capability publication respects independent hosting=${ hosting }, HTTP reads=${ reads } preferences`, async () => {
	const h = await harness()
	await h.setGnosisSafeAppsCompatibilityMode(hosting)
	await h.setSiteRpcInterceptionEnabled(reads)
	const feature = createGnosisSafeSessionCapabilitiesFeature(h.connections)
	const dispose = await initializeGnosisSafeSessionCapabilities(feature)
	try {
		if (hosting) await waitForPortMessageCount(h.source.messages, 'safe_apps_compatibility', 1)
		if (reads) for (const target of [h.source, h.child]) await waitForPortMessageCount(target.messages, 'site_behavior', 1)
		assert.equal(h.source.messages.some((message) => message.method === 'safe_apps_compatibility' && message.result?.enabled === true), hosting)
		assert.equal(h.source.messages.some((message) => message.method === 'site_behavior' && message.result?.rpcInterception !== undefined), reads, 'approved top-level reads are independent of SDK hosting')
		assert.equal(h.child.messages.some((message) => message.method === 'site_behavior' && message.result?.rpcInterception !== undefined), reads, 'native iframe HTTP preference is independent of SDK discovery')
	} finally { dispose(); h.restore() }
})


test('known-disabled HTTP publication releases native startup reads without publishing a premature startup decision', async () => {
	const h = await harness()
	const feature = createGnosisSafeSessionCapabilitiesFeature(h.connections)
	try {
		await feature.site.lifecycle.connectionReady?.(h.child.socket)
		assert.equal(h.child.messages.filter((message) => message.method === 'site_behavior').length, 0, 'an unresolved preference must keep startup reads waiting')
		feature.site.setEnabled(false)
		await waitForPortMessageCount(h.child.messages, 'site_behavior', 1)
		assert.equal(h.child.messages.find((message) => message.method === 'site_behavior')?.result?.rpcInterception, undefined)
		await feature.site.lifecycle.connectionReady?.(h.child.socket)
		await waitForPortMessageCount(h.child.messages, 'site_behavior', 2)
		assert.equal(h.tabReads.length, 0, 'disabled publication does not resolve a privileged native source')
	} finally { feature.dispose(); h.restore() }
})
