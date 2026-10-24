// The test left here resolves an access prompt through the website-access API that the background access rework replaces; it moves to backgroundProviderMethodRouting.test.ts with that change, which deletes this file.
import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { createTestSimulationServicesOwner, confirmedSignerOwnership, createEthereumWithGetBlockCounter, createPort, installBrowserMock, loadModules, noopPublishRpcConnectionStatus } from './backgroundEthAccountsTestHarness.js'

describe('background eth_accounts', () => {
	test('resolves an access prompt with the services installed after it opened', async () => {
		installBrowserMock()
		const { requestAccessFromUser, resolveInterceptorAccess, getPendingAccessRequests, getSettings, websiteSocketToString, changeSimulationMode, setUseSignersAddressAsActiveAddress } = await loadModules()
		const { getActiveAddressEntryForChain } = await import('../../app/ts/background/metadataUtils.js')
		const website = { websiteOrigin: 'https://access-reset.example', icon: undefined, title: undefined }
		const account = 1n
		await setUseSignersAddressAsActiveAddress(false)
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account })
		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(1)
		const connections = new Map([[1, { ...confirmedSignerOwnership(socket), connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin: website.websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const original = createEthereumWithGetBlockCounter({ count: 0 })
		const installed = createEthereumWithGetBlockCounter({ count: 0 })
		let oldReads = 0
		let newReads = 0
		original.ethereum.getChainId = () => { oldReads++; return 1n }
		installed.ethereum.getChainId = () => { newReads++; return 1n }
		const owner = createTestSimulationServicesOwner(original, () => installed)
		const address = await getActiveAddressEntryForChain(account, 1n)
		await requestAccessFromUser(owner, connections, socket, website, {
			interceptorRequest: true, usingInterceptorWithoutSigner: true,
			uniqueRequestIdentifier: { requestId: 992, requestSocket: socket }, method: 'eth_chainId', params: [],
		}, address, await getSettings(), address, noopPublishRpcConnectionStatus)
		const pending = (await getPendingAccessRequests())[0]
		assert.ok(pending !== undefined)
		owner.reset(installed.ethereum.getRpcEntry())
		await resolveInterceptorAccess(owner, connections, { userReply: 'Approved', requestAccessToAddress: account, originalRequestAccessToAddress: account, accessRequestId: pending.accessRequestId }, noopPublishRpcConnectionStatus)
		assert.equal(oldReads, 0)
		assert.ok(newReads > 0)
		assert.equal(messages.find(message => message.requestId === 992)?.result, '0x1')
		assert.equal((await getPendingAccessRequests()).length, 0)
	})

})
