import { expect, test } from 'bun:test'
import { installBrowserMock, loadModules, createPort, createEthereumWithGetBlockCounter, noopPublishRpcConnectionStatus } from './backgroundEthAccountsTestHarness.js'
import { browserStorageLocalSet } from '../../app/ts/utils/storageUtils.js'
import { saveAddressSigningWallet } from '../../app/ts/background/storageVariables.js'
import { getSigningAddressSelectionTransition } from '../../app/ts/background/signingAddressSelection.js'
import { getSettings } from '../../app/ts/background/settings.js'

// A manual address exercises the same account/permission path as a disconnected hardware binding.
test('an explicitly selected address exposes accounts without an installed browser wallet and blocks unbound signing', async () => {
	installBrowserMock()
	const { handleInterceptedRequest, websiteSocketToString, updateWebsiteAccess, changeSimulationMode } = await loadModules()
	const address = 0x1111111111111111111111111111111111111111n
	await saveAddressSigningWallet(address, undefined, undefined, 'Read-only account')
	await browserStorageLocalSet({ selectedSigningAddress: address })
	await changeSimulationMode({ simulationMode: false })
	const websiteOrigin = 'https://direct.example.test'
	const website = { websiteOrigin, icon: undefined, title: undefined }
	await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address, access: true }] }])
	const socket = { tabId: 1, connectionName: 0n }
	const { port, messages } = createPort(socket.tabId)
	const connections = new Map([[socket.tabId, { connections: { [websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true } } }]])
	const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
	await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, { interceptorRequest: true, usingInterceptorWithoutSigner: true, uniqueRequestIdentifier: { requestId: 1, requestSocket: socket }, method: 'eth_accounts', params: [] }, connections, noopPublishRpcConnectionStatus)
	expect(messages.find((message) => message.requestId === 1)).toMatchObject({ type: 'result', result: ['0x1111111111111111111111111111111111111111'] })
	await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, { interceptorRequest: true, usingInterceptorWithoutSigner: true, uniqueRequestIdentifier: { requestId: 2, requestSocket: socket }, method: 'personal_sign', params: ['0x00', '0x1111111111111111111111111111111111111111'] }, connections, noopPublishRpcConnectionStatus)
	expect(messages.find((message) => message.requestId === 2)).toMatchObject({ type: 'result', error: { code: 4100, message: 'No signing wallet for this address. Set up signing wallet or switch to simulation.' } })
	expect(messages.some((message) => message.type === 'forwardToSigner')).toBe(false)
	await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [] }])
	await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, { interceptorRequest: true, usingInterceptorWithoutSigner: true, uniqueRequestIdentifier: { requestId: 3, requestSocket: socket }, method: 'eth_accounts', params: [] }, connections, noopPublishRpcConnectionStatus)
	expect(messages.find((message) => message.requestId === 3)).toMatchObject({ type: 'result', result: [] })
})

test('browser account and disconnect callbacks cannot select another explicitly saved address', async () => {
	installBrowserMock()
	const { getTabState } = await loadModules()
	await browserStorageLocalSet({ selectedSigningAddress: 1n, simulationMode: false })
	const previous = await getTabState(1)
	for (const accounts of [[2n], []]) {
		const transition = await getSigningAddressSelectionTransition(await getSettings(), previous, { ...previous, signerAccounts: accounts, activeSigningAddress: accounts[0] })
		expect(transition.shouldActivate).toBe(false)
		expect((await getSettings()).selectedSigningAddress).toBe(1n)
	}
})
