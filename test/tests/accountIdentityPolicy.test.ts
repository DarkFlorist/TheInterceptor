import * as assert from 'assert'
import { test } from 'bun:test'
import { clearSignerExecutionAuthorityForTab } from '../../app/ts/background/signerExecutionAuthority.js'
import { createDeferredSignal, authorizeLegacySignerSocket, confirmedSignerOwnership, createEthereumWithGetBlockCounter, noopPublishRpcConnectionStatus, createPort, installBrowserMock, loadModules, addressString } from './backgroundEthAccountsTestHarness.js'

test('website state preserves approved simulation accounts but hides wallet identities until reconciliation', async () => {
	installBrowserMock()
	const { getSettings, changeSimulationMode, setUseSignersAddressAsActiveAddress, updateWebsiteAccess, websiteSocketToString } = await loadModules()
	const account = 0x1111111111111111111111111111111111111111n
	await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account })
	await setUseSignersAddressAsActiveAddress(false)
	await updateWebsiteAccess(() => [{ website: { websiteOrigin: 'https://example.test' }, access: true, addressAccess: [{ address: account, access: true }] }])
	const { sendActiveAccountChangeToApprovedWebsitePorts, sendProviderConnectionEventsToPort, sendAccountsChangedToPort } = await import('../../app/ts/background/accessManagement.js')
	const settings = await getSettings()
	const socket = { tabId: 1, connectionName: 99n }
	const otherSocket = { tabId: 1, connectionName: 100n }
	const approved = createPort(1, undefined, 2, socket.connectionName)
	const unapproved = createPort(1, undefined, 3, otherSocket.connectionName)
	const connections = new Map([[1, { connections: {
		[websiteSocketToString(socket)]: { port: approved.port, socket, websiteOrigin: 'https://example.test', approved: true, wantsToConnect: true },
		[websiteSocketToString(otherSocket)]: { port: unapproved.port, socket: otherSocket, websiteOrigin: 'https://unapproved.test', approved: false, wantsToConnect: false },
	} }]])
	clearSignerExecutionAuthorityForTab(1)
	await sendActiveAccountChangeToApprovedWebsitePorts(connections, settings)
	assert.deepEqual(approved.messages.at(-1)?.result, [addressString(account)])
	assert.equal(unapproved.messages.length, 0)

	const walletSettings = { ...settings, simulationMode: false }
	await sendActiveAccountChangeToApprovedWebsitePorts(connections, walletSettings)
	assert.deepEqual(approved.messages.at(-1)?.result, [])
	sendProviderConnectionEventsToPort(connections, socket, walletSettings, [account])
	sendAccountsChangedToPort(connections, socket, [account], 12, walletSettings)
	assert.deepEqual(approved.messages.filter((message) => message.method === 'accountsChanged').slice(1).map((message) => message.result), [[], [], []])
	assert.equal(unapproved.messages.length, 0)

	authorizeLegacySignerSocket(socket)
	sendProviderConnectionEventsToPort(connections, socket, walletSettings, [account])
	assert.deepEqual(approved.messages.filter((message) => message.method === 'accountsChanged').at(-1)?.result, [addressString(account)])
})

for (const childOrigin of ['https://example.test', 'https://child.test']) test(`wallet-less ${ childOrigin } frames cannot read cached wallet identity`, async () => {
	installBrowserMock()
	const { handleInterceptedRequest, changeSimulationMode, setUseSignersAddressAsActiveAddress, updateWebsiteAccess, updateTabState, websiteSocketToString } = await loadModules()
	const account = 0x1111111111111111111111111111111111111111n
	await changeSimulationMode({ simulationMode: false, activeSigningAddress: account })
	await setUseSignersAddressAsActiveAddress(false)
	await updateWebsiteAccess(() => [...new Set(['https://example.test', childOrigin])].map((websiteOrigin) => ({ website: { websiteOrigin }, access: true, addressAccess: [{ address: account, access: true }] })))
	await updateTabState(1, (previous) => ({ ...previous, signerAccounts: [account], activeSigningAddress: account }))
	const owner = { tabId: 1, connectionName: 0n }
	const child = { tabId: 1, connectionName: 91n }
	const top = createPort(1)
	const frame = createPort(1, undefined, 2, child.connectionName)
	const connections = new Map([[1, { ...confirmedSignerOwnership(owner), connections: {
		[websiteSocketToString(owner)]: { port: top.port, socket: owner, websiteOrigin: 'https://example.test', approved: true, wantsToConnect: true },
		[websiteSocketToString(child)]: { port: frame.port, socket: child, websiteOrigin: childOrigin, approved: true, wantsToConnect: true },
	} }]])
	const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
	for (const [requestId, method] of ['eth_accounts', 'wallet_getPermissions', 'wallet_getCapabilities'].entries()) {
		await handleInterceptedRequest(frame.port, childOrigin, { websiteOrigin: childOrigin }, simulationServicesOwner, child, {
			interceptorRequest: true, usingInterceptorWithoutSigner: true, method, params: [], uniqueRequestIdentifier: { requestId, requestSocket: child },
		}, connections, noopPublishRpcConnectionStatus)
		assert.equal(frame.messages.at(-1)?.error?.code, 4100, method)
		assert.equal(frame.messages.at(-1)?.result, undefined, method)
	}
})

for (const method of ['eth_accounts', 'wallet_getPermissions', 'wallet_getCapabilities', 'eth_requestAccounts', 'wallet_requestPermissions']) {
	for (const pauseAtSettingsRead of [3, 4]) test(`${ method } preserves wallet provenance when settings change at read ${ pauseAtSettingsRead }`, async () => {
		installBrowserMock()
		const { handleInterceptedRequest, changeSimulationMode, setUseSignersAddressAsActiveAddress, updateWebsiteAccess, updateTabState, websiteSocketToString } = await loadModules()
		const account = 0x1111111111111111111111111111111111111111n
		await changeSimulationMode({ simulationMode: false, activeSigningAddress: account })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website: { websiteOrigin: 'https://example.test' }, access: true, addressAccess: [{ address: account, access: true }] }])
		await updateTabState(1, (previous) => ({ ...previous, signerAccounts: [account], activeSigningAddress: account }))
		const socket = { tabId: 1, connectionName: 0n }
		const frame = createPort(1)
		const connections = new Map([[1, { ...confirmedSignerOwnership(socket), connections: {
			[websiteSocketToString(socket)]: { port: frame.port, socket, websiteOrigin: 'https://example.test', approved: true, wantsToConnect: true },
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const paused = createDeferredSignal()
		const release = createDeferredSignal()
		const originalGet = browser.storage.local.get
		let settingsReads = 0
		browser.storage.local.get = async (keys) => {
			if (Array.isArray(keys) && keys.includes('simulationMode') && ++settingsReads === pauseAtSettingsRead) {
				paused.resolve()
				await release.promise
			}
			return originalGet(keys)
		}
		try {
			const pending = handleInterceptedRequest(frame.port, 'https://example.test', { websiteOrigin: 'https://example.test' }, simulationServicesOwner, socket, {
				interceptorRequest: true, usingInterceptorWithoutSigner: false, method, params: method === 'wallet_requestPermissions' ? [{ eth_accounts: {} }] : method === 'wallet_getCapabilities' ? [addressString(account)] : [], uniqueRequestIdentifier: { requestId: 10, requestSocket: socket },
			}, connections, noopPublishRpcConnectionStatus)
			await paused.promise
			const messagesBeforeDelivery = frame.messages.length
			clearSignerExecutionAuthorityForTab(1)
			await changeSimulationMode({ simulationMode: true, activeSimulationAddress: 0x2222222222222222222222222222222222222222n })
			release.resolve()
			await pending
			assert.equal(frame.messages.at(-1)?.error?.code, 4100)
			assert.equal(frame.messages.at(-1)?.result, undefined)
			assert.equal(frame.messages.slice(messagesBeforeDelivery).some((message) => message.method === 'accountsChanged'), false)
		} finally {
			release.resolve()
			browser.storage.local.get = originalGet
		}
	})
}
