import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { confirmedSignerOwnership, createEthereumWithGetBlockCounter, createPort, installBrowserMock, loadModules, noopPublishRpcConnectionStatus } from './backgroundEthAccountsTestHarness.js'

async function setUpApprovedConnection() {
	installBrowserMock()
	const modules = await loadModules()
	const websiteOrigin = 'https://example.test'
	const website = { websiteOrigin, icon: undefined, title: undefined }
	const account = 0x7171717171717171717171717171717171717171n
	await modules.changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: account })
	await modules.setUseSignersAddressAsActiveAddress(false)
	await modules.updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])
	const socket = { tabId: 1, connectionName: 0n }
	await modules.updateTabState(socket.tabId, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: account }))
	const { port, messages } = createPort(socket.tabId)
	const connectionKey = modules.websiteSocketToString(socket)
	const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
		[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
	} }]])
	const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
	const isConnectionApproved = () => websiteTabConnections.get(socket.tabId)?.connections[connectionKey]?.approved
	const setAddressAccess = async (allowAccess: boolean) => await modules.allowOrPreventAddressAccessForWebsite(simulationServicesOwner, websiteTabConnections, {
		method: 'popup_allowOrPreventAddressAccessForWebsite',
		data: { website, address: account, allowAccess },
	})
	const sendDappRequest = async (requestId: number, method: string) => {
		const request = { interceptorRequest: true, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier: { requestId, requestSocket: socket }, method, params: [] }
		await modules.handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)
		return messages.filter((message) => message.requestId === requestId).at(-1)
	}
	return { messages, isConnectionApproved, setAddressAccess, sendDappRequest }
}

describe('allowOrPreventAddressAccessForWebsite', () => {
	test('de-approves an already approved connection when its active address is denied', async () => {
		const { messages, isConnectionApproved, setAddressAccess, sendDappRequest } = await setUpApprovedConnection()
		assert.equal(isConnectionApproved(), true)

		await setAddressAccess(false)

		assert.equal(isConnectionApproved(), false)
		assert.deepEqual(messages.filter((message) => message.method === 'accountsChanged').at(-1)?.result, [])
		assert.equal(messages.some((message) => message.method === 'disconnect'), true)
		assert.deepEqual((await sendDappRequest(1, 'eth_accounts'))?.result, [])
		assert.equal((await sendDappRequest(2, 'eth_blockNumber'))?.error?.code, 4100)
	})

	test('re-approves the connection when the denied active address is allowed again', async () => {
		const { isConnectionApproved, setAddressAccess, sendDappRequest } = await setUpApprovedConnection()

		await setAddressAccess(false)
		assert.equal(isConnectionApproved(), false)

		await setAddressAccess(true)
		assert.equal(isConnectionApproved(), true)
		assert.deepEqual((await sendDappRequest(1, 'eth_accounts'))?.result, ['0x7171717171717171717171717171717171717171'])
	})
})
