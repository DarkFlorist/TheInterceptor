import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import type { InterceptedRequest } from '../../app/ts/utils/requests.js'
import { confirmedSignerOwnership, createEthereumWithGetBlockCounter, createPort, createRestoringBrowserMockInstaller, loadModules, noopPublishRpcConnectionStatus } from './backgroundEthAccountsTestHarness.js'

const installBrowserMock = createRestoringBrowserMockInstaller()

type InterceptorAccessModule = typeof import('../../app/ts/background/windows/interceptorAccess.js')

const isInterceptorAccessModule = (loadedModule: unknown): loadedModule is InterceptorAccessModule => typeof loadedModule === 'object'
	&& loadedModule !== null
	&& 'requestAccessFromUser' in loadedModule
	&& typeof loadedModule.requestAccessFromUser === 'function'

// Loads an independent instance of the access dialog module, because Bun keys module instances by the full specifier including the query.
async function importSeparateInterceptorAccessModule(instanceName: string): Promise<InterceptorAccessModule> {
	const loadedModule: unknown = await import(`../../app/ts/background/windows/interceptorAccess.js?${ instanceName }`)
	if (!isInterceptorAccessModule(loadedModule)) throw new Error(`The separate interceptorAccess module instance ${ instanceName } did not load`)
	return loadedModule
}

describe('background eth_requestAccounts address consent', () => {
	test('requires visible address consent after signer discovery for site-approved eth_requestAccounts', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			getPendingAccessRequests,
			getSettings,
			resolveInterceptorAccess,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x5555555555555555555555555555555555555555n
		const accountString = '0x5555555555555555555555555555555555555555'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId, (message) => {
			if (message.method !== 'request_signer_to_eth_requestAccounts') return
			void handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
				interceptorRequest: true,
				interceptorInternalRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 100, requestSocket: socket },
				method: 'eth_accounts_reply',
				params: [{ signerProviderGeneration: 1, type: 'success', accounts: [accountString], requestAccounts: true }],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
		})
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 10, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(messages.filter((message) => message.method === 'request_signer_to_eth_requestAccounts').length, 1)
		assert.equal(messages.some((message) => message.method === 'connect'), false)
		assert.deepEqual(messages.filter((message) => message.method === 'accountsChanged'), [])
		assert.deepEqual(messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 10), [])
		const pendingRequest = (await getPendingAccessRequests())[0]
		if (pendingRequest === undefined) throw new Error('Missing address access request')
		assert.equal(pendingRequest.requestAccessToAddress?.address, account)
		assert.deepEqual(pendingRequest.signerAccounts, [account])
		assert.deepEqual((await getSettings()).websiteAccess[0]?.addressAccess, undefined)

		await resolveInterceptorAccess(simulationServicesOwner, websiteTabConnections, {
			userReply: 'Approved',
			requestAccessToAddress: account,
			originalRequestAccessToAddress: account,
			accessRequestId: pendingRequest.accessRequestId,
		}, noopPublishRpcConnectionStatus)

		assert.deepEqual(messages.filter((message) => message.method === 'accountsChanged').map((message) => message.result), [[accountString]])
		assert.deepEqual(messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 10).map((message) => message.result), [[accountString]])
		assert.equal((await getPendingAccessRequests()).length, 0)
		assert.deepEqual((await getSettings()).websiteAccess[0]?.addressAccess, [{ address: account, access: true }])
	})

	test('does not override an explicitly denied address for site-approved eth_requestAccounts', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			updateTabState,
			getPendingAccessRequests,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x5656565656565656565656565656565656565656n
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: account })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: false }] }])
		await updateTabState(1, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: account }))

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 22, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(messages.some((message) => message.method === 'connect' || message.method === 'accountsChanged'), false)
		assert.equal(messages.filter((message) => message.method === 'eth_requestAccounts' && message.requestId === 22).at(-1)?.error?.code, 4100)
		assert.equal((await getPendingAccessRequests()).length, 0)
	})

	test('does not approve the port before site-approved eth_requestAccounts receives address consent', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			updateTabState,
			getPendingAccessRequests,
			getSettings,
			resolveInterceptorAccess,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const pendingWebsite = Promise.withResolvers<typeof website>()
		const account = 0x5757575757575757575757575757575757575757n
		const accountString = '0x5757575757575757575757575757575757575757'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: account })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])
		await updateTabState(1, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: account }))

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connection = { port, socket, websiteOrigin, approved: false, wantsToConnect: true }
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: connection,
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const requestAccountsPromise = handleInterceptedRequest(port, websiteOrigin, pendingWebsite.promise, simulationServicesOwner, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 23, requestSocket: socket },
			method: 'eth_requestAccounts',
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 24, requestSocket: socket },
			method: 'eth_accounts',
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(connection.approved, false)
		assert.deepEqual(messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 24).map((message) => message.result), [[]])
		assert.equal((await getSettings()).websiteAccess[0]?.addressAccess, undefined)

		pendingWebsite.resolve(website)
		await requestAccountsPromise

		const pendingRequest = (await getPendingAccessRequests())[0]
		if (pendingRequest === undefined) throw new Error('Missing address access request')
		assert.equal(pendingRequest.requestAccessToAddress?.address, account)
		assert.equal(connection.approved, false)
		assert.deepEqual(messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 23), [])
		assert.equal((await getSettings()).websiteAccess[0]?.addressAccess, undefined)

		await resolveInterceptorAccess(simulationServicesOwner, websiteTabConnections, {
			userReply: 'Approved',
			requestAccessToAddress: account,
			originalRequestAccessToAddress: account,
			accessRequestId: pendingRequest.accessRequestId,
		}, noopPublishRpcConnectionStatus)

		assert.equal(connection.approved, true)
		assert.deepEqual(messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 23).map((message) => message.result), [[accountString]])
		assert.deepEqual((await getSettings()).websiteAccess[0]?.addressAccess, [{ address: account, access: true }])
	})

	test('does not overwrite an address denial made while site-approved eth_requestAccounts is pending', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			updateTabState,
			getSettings,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const pendingWebsite = Promise.withResolvers<typeof website>()
		const account = 0x5858585858585858585858585858585858585858n
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: account })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])
		await updateTabState(1, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: account }))

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connection = { port, socket, websiteOrigin, approved: false, wantsToConnect: true }
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: connection,
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const requestAccountsPromise = handleInterceptedRequest(port, websiteOrigin, pendingWebsite.promise, simulationServicesOwner, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 25, requestSocket: socket },
			method: 'eth_requestAccounts',
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: false }] }])
		pendingWebsite.resolve(website)
		await requestAccountsPromise

		assert.equal(connection.approved, false)
		assert.equal(messages.filter((message) => message.method === 'eth_requestAccounts' && message.requestId === 25).at(-1)?.error?.code, 4100)
		assert.deepEqual((await getSettings()).websiteAccess[0]?.addressAccess, [{ address: account, access: false }])
	})

	test('uses wallet metadata for cached signer address consent when a same-address Safe exists', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			updateTabState,
			updateUserAddressBookEntries,
			getPendingAccessRequests,
			getSettings,
			resolveInterceptorAccess,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x6666666666666666666666666666666666666666n
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])
		await updateUserAddressBookEntries(() => [{
			type: 'safe',
			name: 'Same-address Safe',
			address: account,
			chainId: 1n,
			entrySource: 'User',
			useAsActiveAddress: true,
			safeSignerAddresses: [account],
		}])
		await updateTabState(1, (previousState) => ({
			...previousState,
			signerAccounts: [account],
			activeSigningAddress: undefined,
			signerAccountError: { code: 4900, message: 'Stale signer error' },
		}))

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 11, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(messages.some((message) => message.method === 'request_signer_to_eth_requestAccounts'), false)
		assert.equal(messages.some((message) => message.method === 'connect'), false)
		assert.deepEqual(messages.filter((message) => message.method === 'accountsChanged'), [])
		const pendingRequest = (await getPendingAccessRequests())[0]
		if (pendingRequest === undefined) throw new Error('Missing address access request')
		assert.equal(pendingRequest.requestAccessToAddress?.address, account)
		assert.notEqual(pendingRequest.requestAccessToAddress?.type, 'safe')

		await resolveInterceptorAccess(simulationServicesOwner, websiteTabConnections, {
			userReply: 'Approved',
			requestAccessToAddress: account,
			originalRequestAccessToAddress: account,
			accessRequestId: pendingRequest.accessRequestId,
		}, noopPublishRpcConnectionStatus)

		assert.deepEqual(messages.filter((message) => message.method === 'accountsChanged').map((message) => message.result), [['0x6666666666666666666666666666666666666666']])
		assert.deepEqual(messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 11).at(-1)?.result, ['0x6666666666666666666666666666666666666666'])
		assert.equal((await getPendingAccessRequests()).length, 0)
		assert.deepEqual((await getSettings()).websiteAccess[0]?.addressAccess, [{ address: account, access: true }])
	})

	test('reuses a persisted access dialog when the same eth_requestAccounts is replayed after restart', async () => {
		installBrowserMock()
		const {
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			getPendingAccessRequests,
			getSettings,
			createInterceptedRequestReplay,
			requestAccessFromUser: requestAccessFromUserAfterRestart,
			resolveInterceptorAccess: resolveInterceptorAccessAfterRestart,
		} = await loadModules()
		const { getActiveAddressEntryForChain } = await import('../../app/ts/background/metadataUtils.js')
		// A separately loaded dialog module stands in for the worker that ran before the restart; the shared modules are the restarted worker.
		const firstWorkerAccess = await importSeparateInterceptorAccessModule('access-dialog-worker-before-restart')
		const websiteOrigin = 'https://app.safe.global'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x6677667766776677667766776677667766776677n
		const accountString = '0x6677667766776677667766776677667766776677'
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const request: InterceptedRequest = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 111, requestSocket: socket },
			method: 'eth_requestAccounts',
		}
		const requestAccessToAddress = await getActiveAddressEntryForChain(account, 1n)
		const settings = await getSettings()

		const replayInterceptedRequest = createInterceptedRequestReplay(simulationServicesOwner, websiteTabConnections, noopPublishRpcConnectionStatus)
		await firstWorkerAccess.requestAccessFromUser(
			websiteTabConnections,
			socket,
			website,
			request,
			requestAccessToAddress,
			settings,
			requestAccessToAddress,
			replayInterceptedRequest,
		)
		await requestAccessFromUserAfterRestart(
			websiteTabConnections,
			socket,
			website,
			request,
			requestAccessToAddress,
			settings,
			requestAccessToAddress,
			replayInterceptedRequest,
		)

		assert.equal((await getPendingAccessRequests()).length, 1)
		assert.equal(messages.some((message) => message.requestId === 111), false)
		const pendingRequest = (await getPendingAccessRequests())[0]
		if (pendingRequest === undefined) throw new Error('Missing pending request after worker restart')
		await resolveInterceptorAccessAfterRestart(
			simulationServicesOwner,
			websiteTabConnections,
			{
				userReply: 'Approved',
				requestAccessToAddress: pendingRequest.requestAccessToAddress?.address,
				originalRequestAccessToAddress: pendingRequest.originalRequestAccessToAddress?.address,
				accessRequestId: pendingRequest.accessRequestId,
			},
			noopPublishRpcConnectionStatus,
		)

		assert.deepEqual(messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 111).map((message) => message.result), [[accountString]])
	})

	test('uses refreshed website access after signer account discovery', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			getPendingAccessRequests,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const accountString = '0x7777777777777777777777777777777777777777'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId, (message) => {
			if (message.method !== 'request_signer_to_eth_requestAccounts') return
			void (async () => {
				await updateWebsiteAccess(() => [{ website, access: false, addressAccess: undefined }])
				await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
					interceptorRequest: true,
					interceptorInternalRequest: true,
					usingInterceptorWithoutSigner: false,
					uniqueRequestIdentifier: { requestId: 101, requestSocket: socket },
					method: 'eth_accounts_reply',
					params: [{ signerProviderGeneration: 1, type: 'success', accounts: [accountString], requestAccounts: true }],
				}, websiteTabConnections, noopPublishRpcConnectionStatus)
			})()
		})
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 12, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(messages.filter((message) => message.method === 'request_signer_to_eth_requestAccounts').length, 1)
		assert.equal(messages.some((message) => message.method === 'connect'), false)
		assert.equal(messages.some((message) => message.method === 'accountsChanged'), false)
		assert.equal((await getPendingAccessRequests()).length, 0)
		const requestAccountsReplies = messages.filter((message) => message.method === 'eth_requestAccounts' && message.requestId === 12)
		assert.equal(requestAccountsReplies.at(-1)?.error?.code, 4100)
		assert.equal(requestAccountsReplies.at(-1)?.error?.message, 'The requested method and/or account has not been authorized by the user.')
	})

	test('keeps sibling connection events when address consent resolves eth_requestAccounts', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			updateTabState,
			getPendingAccessRequests,
			getSettings,
			resolveInterceptorAccess,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x6868686868686868686868686868686868686868n
		const accountString = '0x6868686868686868686868686868686868686868'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: account })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])
		await updateTabState(1, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: account }))

		const socket = { tabId: 1, connectionName: 0n }
		const siblingSocket = { tabId: 1, connectionName: 1n }
		const { port, messages } = createPort(socket.tabId)
		const { port: siblingPort, messages: siblingMessages } = createPort(siblingSocket.tabId, undefined, undefined, siblingSocket.connectionName)
		const connectionKey = websiteSocketToString(socket)
		const siblingConnectionKey = websiteSocketToString(siblingSocket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
			[siblingConnectionKey]: { port: siblingPort, socket: siblingSocket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 18, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		const pendingRequest = (await getPendingAccessRequests())[0]
		if (pendingRequest === undefined) throw new Error('Missing address access request')
		assert.equal(pendingRequest.requestAccessToAddress?.address, account)
		assert.deepEqual(messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 18), [])
		assert.deepEqual(siblingMessages.filter((message) => message.method === 'connect' || message.method === 'accountsChanged' || message.method === 'chainChanged'), [])

		await resolveInterceptorAccess(simulationServicesOwner, websiteTabConnections, {
			userReply: 'Approved',
			requestAccessToAddress: account,
			originalRequestAccessToAddress: account,
			accessRequestId: pendingRequest.accessRequestId,
		}, noopPublishRpcConnectionStatus)

		assert.equal((await getPendingAccessRequests()).length, 0)
		const requestLifecycleMessages = messages.filter((message) => message.method === 'connect' || message.method === 'accountsChanged' || message.method === 'chainChanged')
		assert.deepEqual(requestLifecycleMessages.map((message) => message.method), ['accountsChanged'])
		assert.deepEqual(requestLifecycleMessages.map((message) => message.requestId), [18])
		assert.deepEqual(messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 18).at(-1)?.result, [accountString])
		const siblingLifecycleMessages = siblingMessages.filter((message) => message.method === 'connect' || message.method === 'accountsChanged' || message.method === 'chainChanged')
		assert.deepEqual(siblingLifecycleMessages.map((message) => message.method), ['connect', 'accountsChanged', 'chainChanged'])
		assert.deepEqual(siblingLifecycleMessages.map((message) => message.requestId), [undefined, undefined, undefined])
		assert.deepEqual(siblingLifecycleMessages.map((message) => message.result), [['0x1'], [accountString], '0x1'])
		const access = (await getSettings()).websiteAccess.find((entry) => entry.website.websiteOrigin === websiteOrigin)
		assert.equal(access?.access, true)
		assert.deepEqual(access?.addressAccess, [{ address: account, access: true }])
	})
})
