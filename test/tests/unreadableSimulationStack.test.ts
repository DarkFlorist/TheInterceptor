import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { addressString, confirmedSignerOwnership, createEthereumWithGetBlockCounter, createPort, createTestSimulationServicesOwner, installBrowserMock, loadModules, noopPublishRpcConnectionStatus } from './backgroundEthAccountsTestHarness.js'

const account = 0x4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4cn
const websiteOrigin = 'https://unreadable-stack.example'
const website = { websiteOrigin, icon: undefined, title: undefined }
const websiteSocket = { tabId: 1, connectionName: 0n }

// Like an IndexedDB failure of the simulation stack: storage.local keeps working, so everything but the stack can still be read.
function failSimulationStackReads() {
	const readStorage = browser.storage.local.get
	browser.storage.local.get = async (keys) => {
		if (Array.isArray(keys) && keys.includes('interceptorTransactionStack')) throw new Error('the simulation stack cannot be read')
		return await readStorage(keys)
	}
}

async function createApprovedWebsite(modules: Awaited<ReturnType<typeof loadModules>>, socket = websiteSocket) {
	const { updateWebsiteAccess, setUseSignersAddressAsActiveAddress, updateTabState, websiteSocketToString, handleInterceptedRequest } = modules
	await setUseSignersAddressAsActiveAddress(false)
	await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])
	await updateTabState(socket.tabId, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: account }))
	const { port, messages } = createPort(socket.tabId)
	const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
		[websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
	} }]])
	const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
	const send = async (requestId: number, method: string, params: readonly unknown[], usingInterceptorWithoutSigner = false) => {
		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner,
			uniqueRequestIdentifier: { requestId, requestSocket: socket },
			method,
			params,
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		return messages.find((message) => message.requestId === requestId)
	}
	return { messages, send, simulationServicesOwner, websiteTabConnections }
}

type Website = Awaited<ReturnType<typeof createApprovedWebsite>>

const dispatchPopup = async (modules: Awaited<ReturnType<typeof loadModules>>, { simulationServicesOwner, websiteTabConnections }: Pick<Website, 'simulationServicesOwner' | 'websiteTabConnections'>, request: Parameters<typeof import('../../app/ts/background/popupMessageDispatcher.js').dispatchPopupMessage>[1]) => {
	const { dispatchPopupMessage } = await import('../../app/ts/background/popupMessageDispatcher.js')
	return await dispatchPopupMessage({
		websiteTabConnections,
		simulationServicesOwner,
		settings: await modules.getSettings(),
		publishRpcConnectionStatus: noopPublishRpcConnectionStatus,
		simulationAbortController: undefined,
		confirmTransactionAbortController: new AbortController(),
		resetSimulationState: async () => undefined,
	}, request)
}

// Commits a switch to another chain that cannot finish, and returns how to let its repair succeed.
async function failNetworkSwitch(modules: Awaited<ReturnType<typeof loadModules>>, failure: 'stack clearing' | 'service installation', websiteTabConnections: Website['websiteTabConnections']) {
	const original = createEthereumWithGetBlockCounter({ count: 0 })
	let installationFails = failure === 'service installation'
	const simulationServicesOwner = createTestSimulationServicesOwner(original, (network) => {
		if (installationFails) throw new Error('the services cannot be installed')
		return createEthereumWithGetBlockCounter({ count: 0 }, { rpcEntry: network })
	})
	const originalSet = browser.storage.local.set
	if (failure === 'stack clearing') {
		browser.storage.local.set = async (items) => {
			if ('interceptorTransactionStack' in items) throw new Error('the simulation stack cannot be written')
			return await originalSet(items)
		}
	}
	const rpcNetwork = { ...(await modules.getSettings()).activeRpcNetwork, name: 'Another chain', chainId: 2n, httpsRpc: 'https://another-chain.example' }
	await assert.rejects(modules.changeActiveAddressAndChain(simulationServicesOwner, websiteTabConnections, { simulationMode: true, rpcNetwork, promptForAccessesIfNeeded: false }))
	return {
		simulationServicesOwner,
		letRepairSucceed: async () => {
			installationFails = false
			browser.storage.local.set = originalSet
			await modules.readNetworkSnapshot(simulationServicesOwner)
		},
	}
}

const waitUntilStored = async <T>(read: () => Promise<T | undefined>) => {
	while (await read() === undefined) await new Promise((resolve) => setTimeout(resolve, 0))
	return await read()
}

describe.each(['stack clearing', 'service installation'] as const)('a rejection in a popup while %s of a network change fails', (failure) => {
	test('answers a simulation stack request without reading the stack', async () => {
		installBrowserMock()
		const modules = await loadModules()
		await modules.changeSimulationMode({ simulationMode: true, activeSimulationAddress: account })
		// A decision is remembered per socket, so each case asks from its own.
		const socket = { tabId: 1, connectionName: failure === 'stack clearing' ? 1n : 2n }
		const { messages, send, websiteTabConnections } = await createApprovedWebsite(modules, socket)
		const { getFetchSimulationStackRequestPromise } = await import('../../app/ts/background/storageVariables.js')
		const request = send(1, 'interceptor_getSimulationStack', ['2.0.0'], true)
		const stored = await waitUntilStored(getFetchSimulationStackRequestPromise)
		assert.equal(stored?.simulationOverlayEnabled, true)
		const { simulationServicesOwner, letRepairSucceed } = await failNetworkSwitch(modules, failure, websiteTabConnections)
		try {
			await dispatchPopup(modules, { simulationServicesOwner, websiteTabConnections }, {
				method: 'popup_fetchSimulationStackRequestConfirmation',
				data: { accept: false, simulationStackVersion: '2.0.0', uniqueRequestIdentifier: { requestId: 1, requestSocket: socket } },
			})
			await request
			const reply = messages.find((message) => message.requestId === 1)
			assert.equal(reply?.result, undefined)
			assert.equal(reply?.error?.code, 4001)
		} finally {
			await letRepairSucceed()
		}
	})

	test('answers a chain change request', async () => {
		installBrowserMock()
		const modules = await loadModules()
		await modules.changeSimulationMode({ simulationMode: true, activeSimulationAddress: account })
		const { messages, send, websiteTabConnections } = await createApprovedWebsite(modules)
		const { getChainChangeConfirmationPromise } = await import('../../app/ts/background/storageVariables.js')
		const request = send(1, 'wallet_switchEthereumChain', [{ chainId: '0x5' }], true)
		const stored = await waitUntilStored(getChainChangeConfirmationPromise)
		if (stored === undefined) throw new Error('missing chain change dialog')
		const { simulationServicesOwner, letRepairSucceed } = await failNetworkSwitch(modules, failure, websiteTabConnections)
		try {
			await dispatchPopup(modules, { simulationServicesOwner, websiteTabConnections }, {
				method: 'popup_changeChainDialog',
				data: { rpcNetwork: stored.rpcNetwork, uniqueRequestIdentifier: { requestId: 1, requestSocket: websiteSocket }, accept: false },
			})
			await request
			assert.equal(messages.find((message) => message.requestId === 1)?.error?.code, 4001)
		} finally {
			await letRepairSucceed()
		}
	})

	test.each([['no decision for the website', []], ['page access but no decision for the address', [{ website, access: true, addressAccess: [] }]]] as const)('answers an access request whose dialog moved to another address, with %s', async (_description, websiteAccess) => {
		installBrowserMock()
		const modules = await loadModules()
		const otherAccount = 0x5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5dn
		await modules.updateUserAddressBookEntries(() => [{ type: 'contact', name: 'Moved to', address: otherAccount, chainId: 'AllChains', entrySource: 'User', useAsActiveAddress: true }])
		await modules.changeSimulationMode({ simulationMode: true, activeSimulationAddress: account })
		const { messages, simulationServicesOwner: initialOwner, websiteTabConnections } = await createApprovedWebsite(modules)
		await modules.updateWebsiteAccess(() => websiteAccess)
		const { getActiveAddressEntryForChain } = await import('../../app/ts/background/metadataUtils.js')
		const address = await getActiveAddressEntryForChain(account, 1n)
		await modules.requestAccessFromUser(initialOwner, websiteTabConnections, websiteSocket, website, {
			interceptorRequest: true, usingInterceptorWithoutSigner: true,
			uniqueRequestIdentifier: { requestId: 1, requestSocket: websiteSocket }, method: 'eth_requestAccounts',
		}, address, await modules.getSettings(), address, noopPublishRpcConnectionStatus)
		const [pending] = await modules.getPendingAccessRequests()
		if (pending === undefined) throw new Error('missing access request')
		const { simulationServicesOwner, letRepairSucceed } = await failNetworkSwitch(modules, failure, websiteTabConnections)
		try {
			await dispatchPopup(modules, { simulationServicesOwner, websiteTabConnections }, {
				method: 'popup_interceptorAccess',
				data: { userReply: 'Rejected', accessRequestId: pending.accessRequestId, requestAccessToAddress: otherAccount, originalRequestAccessToAddress: account },
			})
			assert.deepEqual(await modules.getPendingAccessRequests(), [])
			assert.equal(messages.find((message) => message.requestId === 1)?.error?.code, 4100)
		} finally {
			await letRepairSucceed()
		}
	})
})

test('a chain change dialog reloaded while services cannot be installed receives its request', async () => {
	const { runtimeMessages } = installBrowserMock()
	const modules = await loadModules()
	await modules.changeSimulationMode({ simulationMode: true, activeSimulationAddress: account })
	const { messages, send, websiteTabConnections } = await createApprovedWebsite(modules)
	const { getChainChangeConfirmationPromise } = await import('../../app/ts/background/storageVariables.js')
	const request = send(1, 'wallet_switchEthereumChain', [{ chainId: '0x5' }], true)
	const stored = await waitUntilStored(getChainChangeConfirmationPromise)
	if (stored === undefined) throw new Error('missing chain change dialog')
	const { simulationServicesOwner, letRepairSucceed } = await failNetworkSwitch(modules, 'service installation', websiteTabConnections)
	try {
		await assert.rejects(modules.readNetworkSnapshot(simulationServicesOwner))
		runtimeMessages.length = 0
		const reply = await dispatchPopup(modules, { simulationServicesOwner, websiteTabConnections }, { method: 'popup_readyAndListening', data: { page: 'changeChain' } })
		assert.deepEqual(reply, { method: 'popup_readyAndListening', data: { popupOrTabId: stored.popupOrTabId, confirmTransactionBootstrap: undefined } })
		assert.ok(runtimeMessages.some((message) => message.method === 'popup_ChangeChainRequest'))

		await dispatchPopup(modules, { simulationServicesOwner, websiteTabConnections }, {
			method: 'popup_changeChainDialog',
			data: { rpcNetwork: stored.rpcNetwork, uniqueRequestIdentifier: { requestId: 1, requestSocket: websiteSocket }, accept: false },
		})
		await request
		assert.equal(messages.find((message) => message.requestId === 1)?.error?.code, 4001)
	} finally {
		await letRepairSucceed()
	}
})

test('a rejection after a background restart sends the website a rejection, not the stack', async () => {
	installBrowserMock()
	const modules = await loadModules()
	await modules.changeSimulationMode({ simulationMode: true, activeSimulationAddress: account })
	const { messages, simulationServicesOwner, websiteTabConnections } = await createApprovedWebsite(modules)
	const { setFetchSimulationStackRequestPromise } = await import('../../app/ts/background/storageVariables.js')
	const uniqueRequestIdentifier = { requestId: 1, requestSocket: websiteSocket }
	await setFetchSimulationStackRequestPromise({ website, popupOrTabId: { type: 'popup', id: 1 }, simulationOverlayEnabled: true, simulationStackVersion: '2.0.0', uniqueRequestIdentifier })
	await dispatchPopup(modules, { simulationServicesOwner, websiteTabConnections }, {
		method: 'popup_fetchSimulationStackRequestConfirmation',
		data: { accept: false, simulationStackVersion: '2.0.0', uniqueRequestIdentifier },
	})
	const reply = messages.find((message) => message.requestId === 1)
	assert.equal(reply?.result, undefined)
	assert.equal(reply?.error?.code, 4001)
	await setFetchSimulationStackRequestPromise(undefined)
})

describe('an unreadable simulation stack', () => {
	test('leaves stack-independent RPCs working and fails simulation-dependent requests explicitly', async () => {
		installBrowserMock()
		const modules = await loadModules()
		await modules.changeSimulationMode({ simulationMode: true, activeSimulationAddress: account })
		const { send } = await createApprovedWebsite(modules)
		failSimulationStackReads()

		assert.equal((await send(1, 'eth_chainId', []))?.result, '0x1')
		assert.equal((await send(2, 'net_version', []))?.result, '1')
		assert.deepEqual((await send(3, 'eth_accounts', []))?.result, [addressString(account)])

		for (const [requestId, method, params] of [
			[4, 'eth_getBalance', [addressString(account), 'latest']],
			[5, 'eth_sendTransaction', [{ from: addressString(account), to: addressString(account), value: '0x0', data: '0x' }]],
		] as const) {
			const reply = await send(requestId, method, params)
			assert.equal(reply?.result, undefined)
			assert.equal(reply?.error?.code, 123456)
		}
		assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	})

	test('leaves stack-independent RPCs working and refuses simulation while a network change cannot clear the stack', async () => {
		installBrowserMock()
		const modules = await loadModules()
		await modules.changeSimulationMode({ simulationMode: true, activeSimulationAddress: account })
		const { send, simulationServicesOwner, websiteTabConnections } = await createApprovedWebsite(modules)
		const originalSet = browser.storage.local.set
		browser.storage.local.set = async (items) => {
			if ('interceptorTransactionStack' in items) throw new Error('the simulation stack cannot be written')
			return await originalSet(items)
		}
		const rpcNetwork = { ...(await modules.getSettings()).activeRpcNetwork, name: 'Another chain', chainId: 2n, httpsRpc: 'https://another-chain.example' }
		await assert.rejects(modules.changeActiveAddressAndChain(simulationServicesOwner, websiteTabConnections, { simulationMode: true, rpcNetwork, promptForAccessesIfNeeded: false }))

		assert.ok((await send(1, 'eth_chainId', []))?.result !== undefined)
		assert.deepEqual((await send(2, 'eth_accounts', []))?.result, [addressString(account)])
		assert.equal((await send(3, 'eth_getBalance', [addressString(account), 'latest']))?.error?.code, 123456)

		browser.storage.local.set = originalSet
		assert.equal((await modules.readNetworkSnapshot(simulationServicesOwner)).simulation.kind, 'loaded')
	})

	test('still forwards wallet requests and answers eth_accounts on a signer-only network', async () => {
		installBrowserMock()
		const modules = await loadModules()
		await modules.changeSimulationMode({
			simulationMode: false,
			rpcNetwork: { name: 'Signer only', chainId: 1n, httpsRpc: undefined, currencyName: 'Ether?', currencyTicker: 'ETH?', primary: false, minimized: true },
			activeSimulationAddress: undefined,
			activeSigningAddress: account,
		})
		const { send } = await createApprovedWebsite(modules)
		failSimulationStackReads()

		assert.equal((await send(1, 'eth_getBalance', [addressString(account), 'latest']))?.type, 'forwardToSigner')
		assert.equal((await send(2, 'eth_sendTransaction', [{ from: addressString(account), to: addressString(account), value: '0x0', data: '0x' }]))?.type, 'forwardToSigner')
		assert.deepEqual((await send(3, 'eth_accounts', []))?.result, [addressString(account)])
	})

	test('rejects a simulation stack request through the popup dispatcher when the overlay is off', async () => {
		installBrowserMock()
		const modules = await loadModules()
		await modules.changeSimulationMode({ simulationMode: false, activeSigningAddress: account })
		const { messages, send, simulationServicesOwner, websiteTabConnections } = await createApprovedWebsite(modules)
		const { dispatchPopupMessage } = await import('../../app/ts/background/popupMessageDispatcher.js')
		const { getFetchSimulationStackRequestPromise } = await import('../../app/ts/background/storageVariables.js')
		failSimulationStackReads()

		const request = send(1, 'interceptor_getSimulationStack', ['2.0.0'], true)
		while (await getFetchSimulationStackRequestPromise() === undefined) await new Promise((resolve) => setTimeout(resolve, 0))
		const stored = await getFetchSimulationStackRequestPromise()
		assert.equal(stored?.simulationOverlayEnabled, false)
		await dispatchPopupMessage({
			websiteTabConnections,
			simulationServicesOwner,
			settings: await modules.getSettings(),
			publishRpcConnectionStatus: noopPublishRpcConnectionStatus,
			simulationAbortController: undefined,
			confirmTransactionAbortController: new AbortController(),
			resetSimulationState: async () => undefined,
		}, {
			method: 'popup_fetchSimulationStackRequestConfirmation',
			data: { accept: false, simulationStackVersion: '2.0.0', uniqueRequestIdentifier: { requestId: 1, requestSocket: websiteSocket } },
		})
		await request

		const reply = messages.find((message) => message.requestId === 1)
		assert.equal(reply?.result, undefined)
		assert.equal(reply?.error?.code, 4001)
	})
})
