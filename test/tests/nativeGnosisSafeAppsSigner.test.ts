import * as assert from 'node:assert/strict'
import { spyOn, test } from 'bun:test'
import type { InterceptedRequestForward, SignerReply, SubscriptionReplyOrCallBack } from '../../app/ts/types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../../app/ts/types/user-interface-types.js'
import { NATIVE_GNOSIS_SAFE_APPS_SIGNER_CALLBACK, NATIVE_GNOSIS_SAFE_APPS_SIGNER_REPLY, parseNativeGnosisSafeAppsSignerRequest, type NativeGnosisSafeAppsSignerRequest } from '../../app/shared/ts/nativeGnosisSafeAppsSignerProtocol.js'
import { forwardNativeGnosisSafeAppsSignerRequest, isNativeGnosisSafeAppsSignerPort, takeNativeGnosisSafeAppsSignerReply } from '../../app/ts/background/nativeGnosisSafeAppsSigner.js'
import { createEthereumWithGetBlockCounter, createPort, installBrowserMock, loadModules } from './backgroundEthAccountsTestHarness.js'
import { nativeGnosisSafeAppsHostUrl } from '../../app/ts/utils/nativeGnosisSafeAppsHost.js'
import { browserStorageLocalSet, browserStorageLocalSet2 } from '../../app/ts/utils/storageUtils.js'
import { createGnosisSafeAddressBookEntry, fakeRpcNetwork, pendingTransaction, recipientAddress } from './confirmTransactionTestHarness.js'
import { registerNativeGnosisSafeAppsSession, registerNativeGnosisSafeAppsRole, getNativeGnosisSafeAppsSession } from '../../app/ts/background/nativeGnosisSafeAppsSessions.js'
import { ethAccountsReply, signerChainChanged, walletSwitchEthereumChainReply } from '../../app/ts/background/providerMessageHandlers.js'

function installDisconnectEvent(port: browser.runtime.Port) {
	const listeners = new Set<() => void>()
	Object.assign(port, { onDisconnect: { addListener: (listener: () => void) => { listeners.add(listener) }, removeListener: (listener: () => void) => { listeners.delete(listener) } } })
	return () => { for (const listener of listeners) listener() }
}

async function setup() {
	installBrowserMock()
	Object.assign(browser.runtime, { id: 'extension-id', getURL: (path: string) => `chrome-extension://extension-id/${ path }` })
	const modules = await loadModules()
	const origin = 'https://app.example'
	const websiteOrigin = 'app.example'
	await modules.updateWebsiteAccess(() => [{ website: { websiteOrigin, title: undefined, icon: undefined }, access: true }])
	const hostUrl = nativeGnosisSafeAppsHostUrl('chrome-extension://extension-id/', 7, `${ origin }/swap`, 3)
	Object.assign(browser.tabs, { get: async () => ({ id: 7, url: hostUrl }) })
	Object.assign(browser, { webNavigation: { getFrame: async () => ({ parentFrameId: 0, url: `${ origin }/swap` }) } })
	const hostSocket = { tabId: 7, connectionName: 1n }
	const signerSocket = { tabId: 7, connectionName: 2n }
	const { port: hostPort } = createPort(7, undefined, 0, 1n)
	const { port: signerPort } = createPort(7, undefined, 2, 2n)
	const disconnectHost = installDisconnectEvent(hostPort)
	Object.assign(hostPort.sender ?? {}, { id: 'extension-id', url: hostUrl })
	Object.assign(hostPort.sender?.tab ?? {}, { url: hostUrl })
	Object.assign(signerPort.sender ?? {}, { id: 'extension-id', url: `${ origin }/swap` })
	Object.assign(signerPort.sender?.tab ?? {}, { url: hostUrl })
	const host = { port: hostPort, socket: hostSocket, websiteOrigin, requestOrigin: origin, approved: true, wantsToConnect: true }
	const signer = { port: signerPort, socket: signerSocket, websiteOrigin, requestOrigin: origin, approved: true, wantsToConnect: true }
	const signerStateOwner = { confirmed: true, connectionName: 2n, generation: 1, providerGeneration: 1 }
	const connections: WebsiteTabConnections = new Map([[7, { signerStateOwner, connections: { [modules.websiteSocketToString(hostSocket)]: host, [modules.websiteSocketToString(signerSocket)]: signer } }]])
	registerNativeGnosisSafeAppsSession(connections, hostSocket.tabId, hostPort, origin)
	registerNativeGnosisSafeAppsRole(connections, hostPort, { kind: 'host' })
	const session = getNativeGnosisSafeAppsSession(connections, 7)
	if (session === undefined) throw new Error('Missing session')
	registerNativeGnosisSafeAppsRole(connections, signerPort, { kind: 'signer', session })
	const forward: Extract<InterceptedRequestForward, { readonly type: 'forwardToSigner' }> = { type: 'forwardToSigner', method: 'personal_sign', params: ['0x0102', 0x1111111111111111111111111111111111111111n], uniqueRequestIdentifier: { requestId: 55, requestSocket: hostSocket } }
	let payload: NativeGnosisSafeAppsSignerRequest | undefined
	const send = (port: browser.runtime.Port, message: SubscriptionReplyOrCallBack) => {
		assert.equal(port, signerPort)
		if (message.method === NATIVE_GNOSIS_SAFE_APPS_SIGNER_CALLBACK && 'result' in message) payload = parseNativeGnosisSafeAppsSignerRequest(message.result)
		return true
	}
	const dispatch = (nextForward = forward) => {
		assert.equal(forwardNativeGnosisSafeAppsSignerRequest(connections, nextForward, send), true)
		if (payload === undefined) throw new Error('Missing signer callback')
		return payload
	}
	const reply = (token: string): SignerReply['params'][0] => ({ success: true, signerProviderGeneration: 1, reply: '0xsigned', forwardRequest: { type: 'forwardToSigner', replyWithSignersReply: true, method: NATIVE_GNOSIS_SAFE_APPS_SIGNER_REPLY, params: { token }, requestId: 999 } })
	return { modules, origin, hostUrl, connections, host, signer, signerStateOwner, signerPort, forward, send, dispatch, reply, disconnectHost }
}

test('native host signing preserves host request identity and serializes wallet parameters for its verified child', async () => {
	const h = await setup()
	const callback = h.dispatch()
	assert.deepEqual(callback.request, { method: 'personal_sign', params: ['0x0102', '0x1111111111111111111111111111111111111111'] })
	const reply = await takeNativeGnosisSafeAppsSignerReply(h.connections, h.signerPort, h.reply(callback.token))
	assert.deepEqual(reply?.uniqueRequestIdentifier, h.forward.uniqueRequestIdentifier)
	assert.equal(reply?.forward.method, 'personal_sign')
	assert.equal(reply?.reply.success, true)
	assert.equal(await takeNativeGnosisSafeAppsSignerReply(h.connections, h.signerPort, h.reply(callback.token)), undefined)
})

async function setupPendingConfirmation() {
	const h = await setup()
	const safe = createGnosisSafeAddressBookEntry({ safeSignerAddresses: [recipientAddress], askForAddressAccess: true })
	const otherSafe = createGnosisSafeAddressBookEntry({ address: safe.address + 1n, safeSignerAddresses: [recipientAddress], askForAddressAccess: true })
	await h.modules.updateUserAddressBookEntries(() => [safe, otherSafe])
	await h.modules.updateTabState(h.host.socket.tabId, (previous) => ({ ...previous, signerConnected: true, signerName: 'MetaMask', signerAccounts: [recipientAddress], activeSigningAddress: recipientAddress }))
	await browserStorageLocalSet({ simulationMode: false, activeSigningSafeAddress: safe.address, activeRpcNetwork: fakeRpcNetwork })
	await h.modules.updateWebsiteAccess(() => [{ website: { websiteOrigin: h.host.websiteOrigin, title: undefined, icon: undefined }, access: true, addressAccess: [{ address: safe.address, access: true }, { address: otherSafe.address, access: true }] }])
	const pending = { ...pendingTransaction, uniqueRequestIdentifier: h.forward.uniqueRequestIdentifier, simulationMode: false, activeAddress: safe.address, approvalStatus: { status: 'WaitingForSigner' as const }, website: { websiteOrigin: h.host.websiteOrigin, title: undefined, icon: undefined } }
	await browserStorageLocalSet2({ pendingTransactionsAndMessages: [pending] })
	const forward: Extract<InterceptedRequestForward, { readonly type: 'forwardToSigner' }> = { ...h.forward, method: pending.originalRequestParameters.method, params: pending.originalRequestParameters.params }
	return { ...h, safe, otherSafe, pending, forward, dispatch: () => h.dispatch(forward) }
}

test('native host accepts a current pending confirmation only with its selected Gnosis Safe, reviewed chain and private address grant', async () => {
	const h = await setupPendingConfirmation()
	assert.equal((await h.modules.getPendingTransactionsAndMessages())[0]?.approvalStatus.status, 'WaitingForSigner')
	assert.equal((await h.modules.getActiveAddress(await h.modules.getSettings(), h.host.socket.tabId))?.address, h.safe.address)
	const callback = h.dispatch()
	const reply = await takeNativeGnosisSafeAppsSignerReply(h.connections, h.signerPort, h.reply(callback.token))
	assert.equal(reply?.reply.success, true)
	assert.deepEqual(reply?.uniqueRequestIdentifier, h.pending.uniqueRequestIdentifier)
})

const pendingInvalidations: readonly { readonly name: string, readonly invalidate: (h: Awaited<ReturnType<typeof setupPendingConfirmation>>) => Promise<void> }[] = [
	{ name: 'selected Gnosis Safe changes', invalidate: async (h) => { await browserStorageLocalSet({ activeSigningSafeAddress: h.otherSafe.address }) } },
	{ name: 'selected chain changes', invalidate: async (h) => {
		const chainId = fakeRpcNetwork.chainId + 1n
		// The same address remains a configured, approved Gnosis Safe on the new chain; only the reviewed chain distinguishes this reply.
		await h.modules.updateUserAddressBookEntries(() => [h.safe, { ...h.safe, chainId }])
		await browserStorageLocalSet({ activeRpcNetwork: { ...fakeRpcNetwork, chainId } })
		assert.equal((await h.modules.getActiveAddress(await h.modules.getSettings(), h.host.socket.tabId))?.address, h.safe.address)
	} },
	{ name: 'private address grant is revoked', invalidate: async (h) => { await h.modules.updateWebsiteAccess(() => [{ website: h.pending.website, access: true, addressAccess: [{ address: h.safe.address, access: false }] }]) } },
	{ name: 'private address grant is missing', invalidate: async (h) => { await h.modules.updateWebsiteAccess(() => [{ website: h.pending.website, access: true }]) } },
	{ name: 'simulation mode is enabled', invalidate: async (h) => { await browserStorageLocalSet({ simulationMode: true, independentActiveSimulationAddress: h.safe.address }) } },
	{ name: 'confirmation no longer waits for a signer', invalidate: async (h) => { await browserStorageLocalSet2({ pendingTransactionsAndMessages: [{ ...h.pending, approvalStatus: { status: 'WaitingForUser' } }] }) } },
]

for (const { name, invalidate } of pendingInvalidations) test(`native host refuses a pending signer result when ${ name }, despite an approved host and website`, async () => {
	const h = await setupPendingConfirmation()
	const callback = h.dispatch()
	await invalidate(h)
	assert.equal(h.host.approved, true)
	assert.equal(h.modules.hasAccess((await h.modules.getSettings()).websiteAccess, h.host.websiteOrigin), 'hasAccess')
	const reply = await takeNativeGnosisSafeAppsSignerReply(h.connections, h.signerPort, h.reply(callback.token))
	assert.equal(reply?.reply.success, false)
	assert.deepEqual(reply?.uniqueRequestIdentifier, h.pending.uniqueRequestIdentifier)
})

test('native signer callback tokens cannot be consumed by a different frame or guessed', async () => {
	const h = await setup()
	const callback = h.dispatch()
	const { port: other } = createPort(7, undefined, 3, 3n)
	assert.equal(await takeNativeGnosisSafeAppsSignerReply(h.connections, other, h.reply(callback.token)), undefined)
	assert.equal(await takeNativeGnosisSafeAppsSignerReply(h.connections, h.signerPort, h.reply('not-issued')), undefined)
	assert.equal((await takeNativeGnosisSafeAppsSignerReply(h.connections, h.signerPort, h.reply(callback.token)))?.reply.success, true)
})

test('ordinary child frames cannot own native-host signer callbacks even with persisted origin approval', async () => {
	const h = await setup()
	const ordinary = new Map(h.connections)
	h.connections = ordinary
	assert.equal(isNativeGnosisSafeAppsSignerPort(h.connections, h.signerPort), false)
	assert.equal(forwardNativeGnosisSafeAppsSignerRequest(h.connections, h.forward, h.send), false)
})

test('same-URL host reload rejects the previous child and its pending signer reply until a newly bound child owns the session', async () => {
	const h = await setup()
	const callback = h.dispatch()
	const replacementSocket = { tabId: 7, connectionName: 3n }
	const { port: replacement } = createPort(7, undefined, 0, replacementSocket.connectionName)
	installDisconnectEvent(replacement)
	Object.assign(replacement.sender ?? {}, { id: 'extension-id', url: h.hostUrl })
	Object.assign(replacement.sender?.tab ?? {}, { url: h.hostUrl })
	const tab = h.connections.get(7)
	if (tab === undefined) throw new Error('Missing session tab')
	tab.connections[h.modules.websiteSocketToString(replacementSocket)] = { ...h.host, socket: replacementSocket, port: replacement }
	registerNativeGnosisSafeAppsSession(h.connections, 7, replacement, h.origin)
	registerNativeGnosisSafeAppsRole(h.connections, replacement, { kind: 'host' })
	assert.equal(isNativeGnosisSafeAppsSignerPort(h.connections, h.signerPort), false)
	const forward = { ...h.forward, uniqueRequestIdentifier: { ...h.forward.uniqueRequestIdentifier, requestSocket: replacementSocket } }
	assert.equal(forwardNativeGnosisSafeAppsSignerRequest(h.connections, forward, h.send), false)
	assert.equal((await takeNativeGnosisSafeAppsSignerReply(h.connections, h.signerPort, h.reply(callback.token)))?.reply.success, false)
	// A delayed old-host disconnect must not clear the replacement registry entry.
	h.disconnectHost()
	const newChildSocket = { tabId: 7, connectionName: 4n }
	const { port: newChild } = createPort(7, undefined, 2, newChildSocket.connectionName)
	Object.assign(newChild.sender ?? {}, { id: 'extension-id', url: `${ h.origin }/swap` })
	Object.assign(newChild.sender?.tab ?? {}, { url: h.hostUrl })
	tab.connections[h.modules.websiteSocketToString(newChildSocket)] = { ...h.signer, socket: newChildSocket, port: newChild }
	const session = getNativeGnosisSafeAppsSession(h.connections, 7)
	if (session === undefined) throw new Error('Missing session')
	registerNativeGnosisSafeAppsRole(h.connections, newChild, { kind: 'signer', session })
	tab.signerStateOwner = { confirmed: true, connectionName: newChildSocket.connectionName, generation: 2, providerGeneration: 1 }
	assert.equal(isNativeGnosisSafeAppsSignerPort(h.connections, newChild), true)
	assert.equal(forwardNativeGnosisSafeAppsSignerRequest(h.connections, forward, (port) => { assert.equal(port, newChild); return true }), true)
})

test('late account and chain callbacks from a previous same-URL host child cannot mutate signer state or select RPC services', async () => {
	const h = await setup()
	const previousAccount = 0x1111111111111111111111111111111111111111n
	await h.modules.updateTabState(7, (previous) => ({ ...previous, signerAccounts: [previousAccount], activeSigningAddress: previousAccount, signerConnected: true, signerName: 'MetaMask' }))
	const before = await h.modules.getTabState(7)
	const previousOwner = { ...h.signerStateOwner }
	const { port: replacement } = createPort(7, undefined, 0, 3n)
	installDisconnectEvent(replacement)
	Object.assign(replacement.sender ?? {}, { id: 'extension-id', url: h.hostUrl })
	Object.assign(replacement.sender?.tab ?? {}, { url: h.hostUrl })
	registerNativeGnosisSafeAppsSession(h.connections, 7, replacement, h.origin)
	registerNativeGnosisSafeAppsRole(h.connections, replacement, { kind: 'host' })
	const rpcCalls = { count: 0 }
	const { simulationServicesOwner } = createEthereumWithGetBlockCounter(rpcCalls)
	const getCurrent = spyOn(simulationServicesOwner, 'getCurrent')
	try {
		await ethAccountsReply(simulationServicesOwner, h.connections, h.signerPort, {
			method: 'eth_accounts_reply', interceptorRequest: true, interceptorInternalRequest: true, usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 99, requestSocket: h.signer.socket },
			params: [{ type: 'success', accounts: ['0x2222222222222222222222222222222222222222'], requestAccounts: false, signerProviderGeneration: 1 }],
		}, 'hasAccess', previousAccount)
		await signerChainChanged(simulationServicesOwner, h.connections, h.signerPort, {
			method: 'signer_chainChanged', interceptorRequest: true, interceptorInternalRequest: true, usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 100, requestSocket: h.signer.socket }, params: ['0x89', 1],
		}, 'hasAccess', previousAccount)
		// Retired sessions are rejected before decoding any stale wallet-switch payload.
		await walletSwitchEthereumChainReply(simulationServicesOwner, h.connections, h.signerPort, {
			method: 'wallet_switchEthereumChain_reply', interceptorRequest: true, interceptorInternalRequest: true, usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 101, requestSocket: h.signer.socket }, params: [],
		}, 'hasAccess', previousAccount)
		assert.deepEqual(await h.modules.getTabState(7), before)
		assert.deepEqual(h.connections.get(7)?.signerStateOwner, previousOwner)
		assert.equal(getCurrent.mock.calls.length, 0)
		assert.equal(rpcCalls.count, 0)
	} finally { getCurrent.mockRestore() }
})

test('ordinary current signer account callbacks remain independent of native host session replacement', async () => {
	const h = await setup()
	const socket = { tabId: 7, connectionName: 8n }
	const { port } = createPort(7, undefined, 0, socket.connectionName)
	const tab = h.connections.get(7)
	if (tab === undefined) throw new Error('Missing test tab')
	tab.connections[h.modules.websiteSocketToString(socket)] = { port, socket, websiteOrigin: h.host.websiteOrigin, requestOrigin: h.origin, approved: true, wantsToConnect: true }
	tab.signerStateOwner = { confirmed: true, connectionName: socket.connectionName, generation: 2, providerGeneration: 1 }
	const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
	await ethAccountsReply(simulationServicesOwner, h.connections, port, {
		method: 'eth_accounts_reply', interceptorRequest: true, interceptorInternalRequest: true, usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier: { requestId: 100, requestSocket: socket },
		params: [{ type: 'success', accounts: ['0x2222222222222222222222222222222222222222'], requestAccounts: false, signerProviderGeneration: 1 }],
	}, 'hasAccess', undefined)
	assert.deepEqual((await h.modules.getTabState(7)).signerAccounts, [0x2222222222222222222222222222222222222222n])
})

test('native signer replies revalidate wallet generation, live host navigation and app permission', async () => {
	for (const invalidate of [
		async (h: Awaited<ReturnType<typeof setup>>) => { h.signerStateOwner.generation++ },
		async (_h: Awaited<ReturnType<typeof setup>>) => { Object.assign(browser.tabs, { get: async () => ({ id: 7, url: 'https://elsewhere.example' }) }) },
		async (h: Awaited<ReturnType<typeof setup>>) => { await h.modules.updateWebsiteAccess(() => [{ website: { websiteOrigin: h.host.websiteOrigin, title: undefined, icon: undefined }, access: false }]) },
		async (h: Awaited<ReturnType<typeof setup>>) => { h.host.approved = false },
		async (_h: Awaited<ReturnType<typeof setup>>) => { Object.assign(browser.webNavigation, { getFrame: async () => ({ parentFrameId: 4, url: 'https://app.example/swap' }) }) },
	]) {
		const h = await setup()
		const callback = h.dispatch()
		await invalidate(h)
		const reply = await takeNativeGnosisSafeAppsSignerReply(h.connections, h.signerPort, h.reply(callback.token))
		assert.equal(reply?.reply.success, false)
		assert.deepEqual(reply?.uniqueRequestIdentifier, h.forward.uniqueRequestIdentifier)
	}
})

test('queued startup announcements never expose an obsolete wallet generation to native host metadata', async () => {
	const h = await setup()
	const { connectedToSigner } = await import('../../app/ts/background/nativeGnosisSafeAppsProviderAdapter.js')
	const { runSignerStateOperation, getConfirmedSignerStateToken, waitForConfirmedSignerStateToken } = await import('../../app/ts/background/signerStateOwnership.js')
	const services = createEthereumWithGetBlockCounter({ count: 0 }, { initialBlockPolling: false })
	let release = () => { throw new Error('Missing queue release') }
	const gate = new Promise<void>((resolve) => { release = resolve })
	const held = runSignerStateOperation(h.connections, 7, async () => { await gate })
	const announce = (generation: number, name: 'Brave' | 'MetaMask') => connectedToSigner(services.simulationServicesOwner, h.connections, h.signerPort, { method: 'connected_to_signer', params: [true, name, generation], uniqueRequestIdentifier: { requestSocket: h.signer.socket, requestId: generation }, interceptorRequest: true, usingInterceptorWithoutSigner: false }, 'hasAccess', undefined)
	const brave = announce(2, 'Brave')
	const intermediate = runSignerStateOperation(h.connections, 7, async () => getConfirmedSignerStateToken(h.connections, 7))
	const metamask = announce(4, 'MetaMask')
	const status = announce(5, 'MetaMask')
	assert.equal(getConfirmedSignerStateToken(h.connections, 7), undefined, 'pending newer announcements immediately retire the previous token')
	const ready = waitForConfirmedSignerStateToken(h.connections, 7)
	release()
	await Promise.all([held, brave, metamask, status])
	assert.equal(await intermediate, undefined, 'the superseded Brave confirmation must not wake host requests')
	assert.equal((await ready)?.signerProviderGeneration, 5)
	assert.equal((await h.modules.getTabState(7)).signerName, 'MetaMask')
})

test('native dispatch normalizes every signing method and acknowledges only consumed private tokens', async () => {
	const core = await import('../../app/ts/background/providerMessageHandlers.js')
	const adapter = await import('../../app/ts/background/nativeGnosisSafeAppsProviderAdapter.js')
	const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
	const apply = spyOn(core, 'applySignerReply').mockResolvedValue({ type: 'doNotReply' })
	const native = await import('../../app/ts/background/nativeGnosisSafeAppsSigner.js')
	const take = spyOn(native, 'takeNativeGnosisSafeAppsSignerReply')
	try {
		for (const method of ['personal_sign', 'eth_signTypedData', 'eth_signTypedData_v1', 'eth_signTypedData_v2', 'eth_signTypedData_v3', 'eth_signTypedData_v4', 'eth_sendRawTransaction', 'eth_sendTransaction'] as const) {
			const h = await setup()
			const forward = { ...h.forward, method }
			const callback = h.dispatch()
			take.mockResolvedValueOnce({ uniqueRequestIdentifier: forward.uniqueRequestIdentifier, forward, reply: h.reply(callback.token) })
			const request = { method: 'signer_reply' as const, params: [h.reply(callback.token)], uniqueRequestIdentifier: { requestId: 99, requestSocket: h.signer.socket }, interceptorRequest: true as const, usingInterceptorWithoutSigner: false }
			assert.deepEqual(await adapter.signerReply(simulationServicesOwner, h.connections, h.signerPort, request, 'hasAccess', undefined), { type: 'result', method: 'signer_reply', result: '0x' })
			assert.equal(apply.mock.calls.at(-1)?.[4]?.params.forwardRequest.method, method)
			assert.deepEqual(apply.mock.calls.at(-1)?.[4]?.uniqueRequestIdentifier, forward.uniqueRequestIdentifier)
			const calls = apply.mock.calls.length
			take.mockResolvedValueOnce(undefined)
			assert.deepEqual(await adapter.signerReply(simulationServicesOwner, h.connections, h.signerPort, request, 'hasAccess', undefined), { type: 'doNotReply' })
			assert.equal(apply.mock.calls.length, calls)
			const stale = h.dispatch()
			take.mockResolvedValueOnce({ uniqueRequestIdentifier: forward.uniqueRequestIdentifier, forward, reply: { ...h.reply(stale.token), success: false, error: { code: 4900, message: 'Signer connection changed' } } })
			await adapter.signerReply(simulationServicesOwner, h.connections, h.signerPort, { ...request, params: [h.reply(stale.token)] }, 'hasAccess', undefined)
			assert.equal(apply.mock.calls.at(-1)?.[4]?.params.success, false)
		}
	} finally { take.mockRestore(); apply.mockRestore() }
})

test('correlation context cannot authorize a replaced delivery port for any signing method', async () => {
	const { applySignerReply } = await import('../../app/ts/background/providerMessageHandlers.js')
	const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
	for (const method of ['personal_sign', 'eth_signTypedData', 'eth_signTypedData_v1', 'eth_signTypedData_v2', 'eth_signTypedData_v3', 'eth_signTypedData_v4', 'eth_sendRawTransaction', 'eth_sendTransaction'] as const) {
		const h = await setup()
		const callback = h.dispatch()
		const reply = h.reply(callback.token)
		const params = { ...reply, forwardRequest: { ...h.forward, method, requestId: 1 } }
		const request = { method: 'signer_reply' as const, params: [reply], uniqueRequestIdentifier: { requestId: 99, requestSocket: h.signer.socket }, interceptorRequest: true as const, usingInterceptorWithoutSigner: false }
		// Replace the registry entirely so identical metadata cannot authenticate the old port.
		h.connections.set(h.signer.socket.tabId, { connections: {} })
		assert.deepEqual(await applySignerReply(simulationServicesOwner, h.connections, h.signerPort, request, { uniqueRequestIdentifier: h.forward.uniqueRequestIdentifier, params }), { type: 'doNotReply' })
	}
})
