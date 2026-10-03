import { secp256k1 } from '@noble/curves/secp256k1'
import { bytesFromHex, bytesToHex } from '../../app/ts/utils/ethereumBytes.js'
import { privateKeyToAccount } from '../../app/ts/utils/ethereumSigning.js'
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

const hardwareTypes: readonly ('ledger' | 'airgap')[] = ['ledger', 'airgap']
for (const type of hardwareTypes) {
	test(`${ type } rejects unsupported signing methods before parsing or browser forwarding`, async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, updateWebsiteAccess, changeSimulationMode } = await loadModules()
		const key = '0x0000000000000000000000000000000000000000000000000000000000000001'
		const address = BigInt(privateKeyToAccount(key).address)
		const account = { address, label: 'Saved hardware account', publicKey: bytesToHex(secp256k1.getPublicKey(bytesFromHex(key), type === 'airgap')), derivationPath: 'm/44\'/60\'/0\'/0/0' }
		await saveAddressSigningWallet(address, type === 'ledger' ? { ...account, type } : { ...account, type, sourceFingerprint: 0x11223344 }, undefined, 'Hardware')
		await browserStorageLocalSet({ selectedSigningAddress: address })
		await changeSimulationMode({ simulationMode: false })
		const websiteOrigin = 'https://hardware.example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address, access: true }] }])
		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connections = new Map([[socket.tabId, { connections: { [websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true } } }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		for (const [requestId, method] of ['eth_sign', 'eth_signTypedData_v3', 'eth_signFutureVariant', 'eth_sendRawTransaction', 'wallet_sendCalls'].entries()) {
			await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, { interceptorRequest: true, usingInterceptorWithoutSigner: true, uniqueRequestIdentifier: { requestId, requestSocket: socket }, method, params: [] }, connections, noopPublishRpcConnectionStatus)
			expect(messages.find((message) => message.requestId === requestId)).toMatchObject({ type: 'result', error: { code: 4200 } })
		}
		expect(messages.some((message) => message.type === 'forwardToSigner')).toBe(false)
	})
}

test('saved signing selection does not pin simulation to a disconnected browser account', async () => {
	installBrowserMock()
	const { getTabState } = await loadModules()
	await browserStorageLocalSet({ selectedSigningAddress: 1n, simulationMode: true, useSignersAddressAsActiveAddress: true })
	const previous = await getTabState(1)
	const transition = await getSigningAddressSelectionTransition(await getSettings(), previous, { ...previous, signerAccounts: [2n], activeSigningAddress: 2n })
	expect(transition.shouldActivate).toBe(true)
	expect(transition.signerAddress).toBe(2n)
})

test('corrupt selected signing address repairs storage and leaves background settings readable', async () => {
	installBrowserMock()
	await browser.storage.local.set({ selectedSigningAddress: 'invalid-address' })
	expect((await getSettings()).selectedSigningAddress).toBeUndefined()
	expect((await getSettings()).selectedSigningAddress).toBeUndefined()
})

for (const signerName of ['MetaMask', 'Rabby'] as const) test(`Safe policy rejects before browser forwarding admission (${ signerName })`, async () => {
	installBrowserMock()
	const { updateTabState, websiteSocketToString } = await loadModules()
	const { resolveSigningRequest } = await import('../../app/ts/background/signingRequestResolver.js')
	const { EthereumJsonRpcRequest } = await import('../../app/ts/types/JsonRpc-types.js')
	await saveAddressSigningWallet(1n, { type: 'browser', address: 1n, label: 'Safe owner', signerName: 'MetaMask', providerId: 'legacy:MetaMask' }, undefined, 'Owner')
	const settings = { ...await getSettings(), simulationMode: false, activeSigningSafeAddress: 2n, activeRpcNetwork: { name: 'Unsupported', chainId: 1n, httpsRpc: undefined, currencyName: 'Ether?', currencyTicker: 'ETH?', primary: false, minimized: true } } satisfies import('../../app/ts/types/interceptor-messages.js').Settings
	const socket = { tabId: 1, connectionName: 0n }
	await updateTabState(1, (tab) => ({ ...tab, signerConnected: true, signerName, signerAccounts: [] }))
	const { port, messages } = createPort(1)
	const connections = new Map([[1, { ...confirmedSignerOwnership(socket), connections: { [websiteSocketToString(socket)]: { port, socket, websiteOrigin: 'https://safe.example', approved: true, wantsToConnect: true } } }]])
	const request = { method: 'eth_sendTransaction', params: [{ from: '0x0000000000000000000000000000000000000002', to: '0x0000000000000000000000000000000000000001' }], interceptorRequest: true, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier: { requestId: 1, requestSocket: socket } }
	const admission = await resolveSigningRequest(connections, socket, request, EthereumJsonRpcRequest.parse(request), settings, 2n, 1n, true, false, undefined)
	expect(admission.admissionError).toBeUndefined()
	expect(admission.safePolicyReply).toMatchObject({ type: 'result', error: { message: 'Gnosis Safe transaction proposals require an Interceptor RPC connection for live Gnosis Safe validation.' } })
	expect(messages).toEqual([])
})

for (const scenario of [
	{ method: 'wallet_addEthereumChain', params: [{ chainId: '0x1', chainName: 'Test', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://rpc.example'] }], overlay: false, forwards: true },
	{ method: 'eth_getStorageAt', params: ['0x0000000000000000000000000000000000000001', '0x0', 'latest'], overlay: false, forwards: true },
	{ method: 'eth_getStorageAt', params: ['0x0000000000000000000000000000000000000001', '0x0', 'latest'], overlay: true, forwards: false },
	{ method: 'wallet_getCapabilities', params: ['0x0000000000000000000000000000000000000001'], overlay: false, forwards: true },
	{ method: 'wallet_getCapabilities', params: ['0x0000000000000000000000000000000000000002'], overlay: false, forwards: false },
	{ method: 'wallet_unknownMethod', params: [], overlay: false, forwards: true },
]) test(`admission owns pinned forwarding for ${ scenario.method } (forward=${ scenario.forwards })`, async () => {
	installBrowserMock()
	const { updateTabState } = await loadModules()
	const { resolveSigningRequest } = await import('../../app/ts/background/signingRequestResolver.js')
	const { EthereumJsonRpcRequest } = await import('../../app/ts/types/JsonRpc-types.js')
	await saveAddressSigningWallet(1n, { type: 'browser', address: 1n, label: 'Saved', signerName: 'MetaMask', providerId: 'eip6963:io.metamask' }, undefined, 'Saved')
	const settings = { ...await getSettings(), simulationMode: false }
	const socket = { tabId: 1, connectionName: 0n }
	const request = { method: scenario.method, params: scenario.params, interceptorRequest: true, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier: { requestId: 1, requestSocket: socket } }
	const parsed = EthereumJsonRpcRequest.safeParse(request)
	for (const rdns of ['io.metamask', 'com.other.wallet']) {
		await updateTabState(1, (tab) => ({ ...tab, signerConnected: true, signerName: 'MetaMask', signerProvider: { rdns, ambiguous: false }, signerAccounts: [1n] }))
		const result = await resolveSigningRequest(new Map(), socket, request, parsed.success ? parsed.value : undefined, settings, 1n, undefined, false, scenario.overlay, undefined)
		if (!scenario.forwards) {
			expect(result.forwardingReply).toBeUndefined()
			expect(result.admissionError).toBeUndefined()
		} else if (rdns === 'io.metamask') {
			expect(result.forwardingReply).toMatchObject({ type: 'forwardToSigner', method: scenario.method, expectedProviderId: 'eip6963:io.metamask' })
		} else {
			expect(result.forwardingReply).toBeUndefined()
			expect(result.admissionError).toMatchObject({ code: 4100 })
		}
	}
})

test('direct signing admission rejects a structurally valid persisted key/address mismatch', async () => {
	installBrowserMock()
	await loadModules()
	const { resolveSigningRequest } = await import('../../app/ts/background/signingRequestResolver.js')
	const privateKey = '0x0000000000000000000000000000000000000000000000000000000000000001'
	await browserStorageLocalSet({
		userAddressBookEntriesV3: [{ type: 'contact', address: 4n, name: 'Invalid identity', entrySource: 'User' }],
		signingWalletBindings: [{ wallet: { type: 'ledger', address: 4n, label: 'Invalid', publicKey: bytesToHex(secp256k1.getPublicKey(bytesFromHex(privateKey), false)), derivationPath: 'm/44\'/60\'/0\'/0/0' }, revision: crypto.randomUUID() }],
	})
	const socket = { tabId: 1, connectionName: 0n }
	const request = { method: 'personal_sign', params: ['0x01', '0x0000000000000000000000000000000000000004'], interceptorRequest: true, usingInterceptorWithoutSigner: true, uniqueRequestIdentifier: { requestId: 1, requestSocket: socket } }
	await expect(resolveSigningRequest(new Map(), socket, request, undefined, { ...await getSettings(), simulationMode: false }, 4n, undefined, false, false, undefined)).rejects.toThrow('public key')
})
