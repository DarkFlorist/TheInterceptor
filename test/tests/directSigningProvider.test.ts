import { expect, test } from 'bun:test'
import { installBrowserMock, loadModules, createPort, createEthereumWithGetBlockCounter, noopPublishRpcConnectionStatus, confirmedSignerOwnership } from './backgroundEthAccountsTestHarness.js'
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


for (const scenario of [
	{ name: 'mismatched eth_sign account', rdns: 'io.metamask', ambiguous: false, account: 1n, connected: true, allowed: false },
	{ name: 'mismatched transaction sender', rdns: 'io.metamask', ambiguous: false, account: 1n, connected: true, allowed: false },
	{ name: 'matching identity', rdns: 'io.metamask', ambiguous: false, account: 1n, connected: true, allowed: true },
	{ name: 'different same-name provider', rdns: 'com.example.wallet', ambiguous: false, account: 1n, connected: true, allowed: false },
	{ name: 'ambiguous identity', rdns: 'io.metamask', ambiguous: true, account: 1n, connected: true, allowed: false },
	{ name: 'wrong selected account', rdns: 'io.metamask', ambiguous: false, account: 2n, connected: true, allowed: false },
	{ name: 'disconnected provider', rdns: 'io.metamask', ambiguous: false, account: 1n, connected: false, allowed: false },
]) {
	test(`no-RPC signing forwarding enforces the saved browser binding: ${ scenario.name }`, async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, updateWebsiteAccess, changeSimulationMode, updateTabState } = await loadModules()
		const address = 1n
		await saveAddressSigningWallet(address, { type: 'browser', address, signerName: 'MetaMask', providerId: 'eip6963:io.metamask', label: 'Saved wallet' }, undefined, 'Saved account')
		await browserStorageLocalSet({ selectedSigningAddress: address })
		await changeSimulationMode({ simulationMode: false, rpcNetwork: { name: 'Signer only', chainId: 1n, httpsRpc: undefined, currencyName: 'Ether?', currencyTicker: 'ETH?', primary: false, minimized: true } })
		const websiteOrigin = 'https://signer-only.example'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address, access: true }] }])
		const socket = { tabId: 1, connectionName: 0n }
		await updateTabState(socket.tabId, (previous) => ({ ...previous, signerName: 'MetaMask', signerConnected: scenario.connected, signerProvider: { rdns: scenario.rdns, ambiguous: scenario.ambiguous }, signerAccounts: [scenario.account], activeSigningAddress: scenario.account, signerChain: 1n }))
		const { port, messages } = createPort(socket.tabId)
		const connections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: { [websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true } } }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const signingRequest = scenario.name === 'mismatched eth_sign account'
			? { method: 'eth_sign', params: ['0x0000000000000000000000000000000000000002', '0x00'] }
			: { method: 'eth_sendTransaction', params: [{ from: scenario.name === 'mismatched transaction sender' ? '0x0000000000000000000000000000000000000002' : '0x0000000000000000000000000000000000000001', to: '0x0000000000000000000000000000000000000003', value: '0x0' }] }
		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, { interceptorRequest: true, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier: { requestId: 1, requestSocket: socket }, ...signingRequest }, connections, noopPublishRpcConnectionStatus)
		const reply = messages.find((message) => message.requestId === 1)
		if (scenario.allowed) expect(reply).toMatchObject({ type: 'forwardToSigner', expectedProviderId: 'eip6963:io.metamask' })
		else {
			expect(reply).toMatchObject({ type: 'result', error: { code: 4100 } })
			expect(messages.some((message) => message.type === 'forwardToSigner')).toBe(false)
		}
	})
}
