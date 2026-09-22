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
	const dispatch = createWebsiteRequestDispatcher()
	const refuse = async () => { throw new Error('Unexpected request capacity rejection') }
	const requests = Array.from({ length: 40 }, (_, index) => {
		const accountRequest = { ...request, uniqueRequestIdentifier: { requestId: index + 1, requestSocket: socket } }
		return dispatch(accountRequest, async () => await m.handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, accountRequest, connections, noopPublishRpcConnectionStatus), refuse)
	})
	await waitForPortMessageCount(messages, 'request_signer_to_eth_requestAccounts', 1, 1000)
	const reply = { ...request, interceptorInternalRequest: true as const, method: 'eth_accounts_reply', uniqueRequestIdentifier: { requestId: 41, requestSocket: socket }, params: [{ type: 'success', accounts: ['0x1111111111111111111111111111111111111111'], requestAccounts: true, signerProviderGeneration: 1 }] }
	await dispatch(reply, async () => await m.handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, reply, connections, noopPublishRpcConnectionStatus), refuse)
	await Promise.all(requests)
	assert.equal(messages.filter((message) => message.method === 'eth_accounts' && message.requestId !== undefined).length, 40)
})

test('limits page work per connection and releases capacity on rejection', async () => {
	const dispatch = createWebsiteRequestDispatcher(1)
	const otherConnection = createWebsiteRequestDispatcher(1)
	let release: () => void = () => undefined
	const pending = dispatch(request, async () => await new Promise<void>((resolve) => { release = resolve }), async () => { throw new Error('Unexpected refusal') })
	assert.equal(await dispatch(request, async () => 'ran', async () => 'busy'), 'busy')
	assert.equal(await otherConnection(request, async () => 'ran', async () => 'busy'), 'ran')
	assert.equal(await dispatch({ ...request, method: 'eth_accounts_reply' }, async () => 'ran', async () => 'busy'), 'busy')
	assert.equal(await dispatch({ ...request, interceptorInternalRequest: true, method: 'eth_sendTransaction' }, async () => 'ran', async () => 'busy'), 'busy')
	release()
	await pending
	await assert.rejects(dispatch(request, async () => { throw new Error('handler failed') }, async () => undefined), /handler failed/)
	assert.equal(await dispatch(request, async () => 'ran', async () => 'busy'), 'ran')
})
