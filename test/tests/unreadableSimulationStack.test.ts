import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { addressString, confirmedSignerOwnership, createEthereumWithGetBlockCounter, createPort, installBrowserMock, loadModules, noopPublishRpcConnectionStatus } from './backgroundEthAccountsTestHarness.js'

const account = 0x4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4cn
const websiteOrigin = 'https://unreadable-stack.example'
const website = { websiteOrigin, icon: undefined, title: undefined }
const socket = { tabId: 1, connectionName: 0n }

// Like an IndexedDB failure of the simulation stack: storage.local keeps working, so everything but the stack can still be read.
function failSimulationStackReads() {
	const readStorage = browser.storage.local.get
	browser.storage.local.get = async (keys) => {
		if (Array.isArray(keys) && keys.includes('interceptorTransactionStack')) throw new Error('the simulation stack cannot be read')
		return await readStorage(keys)
	}
}

async function createApprovedWebsite(modules: Awaited<ReturnType<typeof loadModules>>) {
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
			data: { accept: false, simulationStackVersion: '2.0.0', uniqueRequestIdentifier: { requestId: 1, requestSocket: socket } },
		})
		await request

		const reply = messages.find((message) => message.requestId === 1)
		assert.equal(reply?.result, undefined)
		assert.equal(reply?.error?.code, 4001)
	})
})
