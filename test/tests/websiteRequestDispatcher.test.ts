import * as assert from 'assert'
import { test } from 'bun:test'
import { createWebsiteRequestDispatcher } from '../../app/ts/background/websiteRequestDispatcher.js'
import { confirmedSignerOwnership, createEthereumWithGetBlockCounter, createPort, installBrowserMock, loadModules, noopPublishRpcConnectionStatus, waitForPortMessageCount } from './backgroundEthAccountsTestHarness.js'

const socket = { tabId: 1, connectionName: 0n }
const request = { interceptorRequest: true, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier: { requestId: 1, requestSocket: socket }, method: 'eth_requestAccounts' }

test('saturated page requests cannot block the signer reply that completes them', async () => {
	installBrowserMock()
	const m = await loadModules()
	await m.changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
	await m.setUseSignersAddressAsActiveAddress(false)
	const websiteOrigin = 'https://audit.example'
	const website = { websiteOrigin, icon: undefined, title: undefined }
	await m.updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: 0x1111111111111111111111111111111111111111n, access: true }] }])
	const { port, messages } = createPort(socket.tabId)
	const connections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
		[m.websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
	} }]])
	const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
	const dispatch = createWebsiteRequestDispatcher(m.isInternalProviderCallback, { maxPendingRequestsPerOrigin: 40 })
	const refuse = async () => { throw new Error('Unexpected request capacity rejection') }
	const requests = Array.from({ length: 40 }, (_, index) => {
		const accountRequest = { ...request, uniqueRequestIdentifier: { requestId: index + 1, requestSocket: socket } }
		return dispatch(websiteOrigin, accountRequest, async () => await m.handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, accountRequest, connections, noopPublishRpcConnectionStatus), refuse)
	})
	await waitForPortMessageCount(messages, 'request_signer_to_eth_requestAccounts', 1, 1000)
	const reply = { ...request, interceptorInternalRequest: true as const, method: 'eth_accounts_reply', uniqueRequestIdentifier: { requestId: 41, requestSocket: socket }, params: [{ type: 'success', accounts: ['0x1111111111111111111111111111111111111111'], requestAccounts: true, signerProviderGeneration: 1 }] }
	await dispatch(websiteOrigin, reply, async () => await m.handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, reply, connections, noopPublishRpcConnectionStatus), refuse)
	await Promise.all(requests)
	assert.equal(messages.filter((message) => message.method === 'eth_accounts' && message.requestId !== undefined).length, 40)
})

test('shares origin capacity across connections while preserving room for another origin', async () => {
	installBrowserMock()
	const m = await loadModules()
	const dispatch = createWebsiteRequestDispatcher(m.isInternalProviderCallback, { maxPendingRequests: 2, maxPendingRequestsPerOrigin: 1 })
	const origin = 'https://busy.example'
	let release: () => void = () => undefined
	const pending = dispatch(origin, request, async () => await new Promise<void>((resolve) => { release = resolve }), async () => { throw new Error('Unexpected refusal') })
	const otherFrame = { ...request, uniqueRequestIdentifier: { requestId: 2, requestSocket: { tabId: 2, connectionName: 2n } } }
	assert.equal(await dispatch(origin, otherFrame, async () => 'ran', async () => 'busy'), 'busy')
	assert.equal(await dispatch('https://other.example', otherFrame, async () => 'ran', async () => 'busy'), 'ran')
	assert.equal(await dispatch(origin, { ...request, method: 'eth_accounts_reply' }, async () => 'ran', async () => 'busy'), 'busy')
	assert.equal(await dispatch(origin, { ...request, interceptorInternalRequest: true, method: 'eth_sendTransaction' }, async () => 'ran', async () => 'busy'), 'busy')
	release()
	await pending
	await assert.rejects(dispatch(origin, request, async () => { throw new Error('handler failed') }, async () => undefined), /handler failed/)
	assert.equal(await dispatch(origin, request, async () => 'ran', async () => 'busy'), 'ran')
})

test('bounds aggregate work across many frames and origins while allowing completion callbacks', async () => {
	installBrowserMock()
	const m = await loadModules()
	const dispatch = createWebsiteRequestDispatcher(m.isInternalProviderCallback)
	const releases: (() => void)[] = []
	const pending: Promise<string>[] = []
	let running = 0
	let refused = 0
	for (let index = 0; index < 100; index += 1) {
		const origin = `https://site${ Math.floor(index / 30) }.example`
		const frameRequest = { ...request, uniqueRequestIdentifier: { requestId: index, requestSocket: { tabId: index, connectionName: BigInt(index) } } }
		pending.push(dispatch(origin, frameRequest, async () => {
			running += 1
			return await new Promise<string>((resolve) => { releases.push(() => resolve('completed')) })
		}, async () => { refused += 1; return 'busy' }))
	}
	assert.equal(running, 40)
	assert.equal(refused, 60)
	for (const method of ['eth_accounts_reply', 'signer_reply', 'signer_chainChanged', 'connected_to_signer', 'wallet_switchEthereumChain_reply']) {
		assert.equal(await dispatch('https://site0.example', { ...request, method, interceptorInternalRequest: true }, async () => 'callback', async () => 'busy'), 'callback')
		assert.equal(await dispatch('https://site0.example', { ...request, method }, async () => 'callback', async () => 'busy'), 'busy')
	}
	// This is an outgoing notification in the reply schema, not a registered incoming callback.
	assert.equal(await dispatch('https://site0.example', { ...request, method: 'signer_connection_status_changed', interceptorInternalRequest: true }, async () => 'callback', async () => 'busy'), 'busy')
	for (const release of releases) release()
	await Promise.all(pending)
	assert.equal(await dispatch('https://site0.example', request, async () => 'ran', async () => 'busy'), 'ran')
})
