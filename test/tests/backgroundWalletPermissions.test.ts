import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { confirmedSignerOwnership, createEthereumWithGetBlockCounter, createPort, createRestoringBrowserMockInstaller, loadModules, noopPublishRpcConnectionStatus, waitForPortMessageCount } from './backgroundEthAccountsTestHarness.js'
import { settleWithin } from '../harness/async.js'

const installBrowserMock = createRestoringBrowserMockInstaller()

describe('background wallet_requestPermissions and wallet_revokePermissions', () => {
	test('falls back to the pending request address when popup approval reply omits address fields', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			updateTabState,
			getPendingAccessRequests,
			resolveInterceptorAccess,
			getSettings,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x6969696969696969696969696969696969696969n
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: account })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [])
		await updateTabState(1, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: account }))

		const socket = { tabId: 1, connectionName: 0n }
		const { port } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 21, requestSocket: socket },
			method: 'wallet_requestPermissions',
			params: [{ eth_accounts: {} }],
		}

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		const pendingRequest = (await getPendingAccessRequests())[0]
		if (pendingRequest === undefined) throw new Error('Missing pending request')
		const siteApprovalResolution = resolveInterceptorAccess(
			simulationServicesOwner,
			websiteTabConnections,
			{
				userReply: 'Approved',
				requestAccessToAddress: undefined,
				originalRequestAccessToAddress: undefined,
				accessRequestId: pendingRequest.accessRequestId,
			},
			noopPublishRpcConnectionStatus,
		)
		await siteApprovalResolution

		const access = (await getSettings()).websiteAccess.find((entry) => entry.website.websiteOrigin === websiteOrigin)
		assert.equal(access?.access, true)
		assert.deepEqual(access?.addressAccess, [{ address: account, access: true }])
	})

	test('popup-approved wallet_requestPermissions stores address access and returns restrictReturnedAccounts', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			updateTabState,
			getPendingAccessRequests,
			resolveInterceptorAccess,
			getSettings,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x6767676767676767676767676767676767676767n
		const accountString = '0x6767676767676767676767676767676767676767'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: account })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [])
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
			method: 'wallet_requestPermissions',
			params: [{ eth_accounts: {} }],
		}

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		const pendingRequest = (await getPendingAccessRequests())[0]
		if (pendingRequest === undefined) throw new Error('Missing pending request')
		const siteApprovalResolution = resolveInterceptorAccess(
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
		await siteApprovalResolution

		const permissionReply = messages.filter((message) => message.method === 'wallet_requestPermissions' && message.requestId === 22).at(-1)
		assert.deepEqual(permissionReply?.result, [{
			parentCapability: 'eth_accounts',
			caveats: [{
				type: 'restrictReturnedAccounts',
				value: [accountString],
			}],
			invoker: websiteOrigin,
		}])
		const access = (await getSettings()).websiteAccess.find((entry) => entry.website.websiteOrigin === websiteOrigin)
		assert.equal(access?.access, true)
		assert.deepEqual(access?.addressAccess, [{ address: account, access: true }])
	})

	test('simulation-mode wallet_requestPermissions requires address consent for a site-only approval', async () => {
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
		const account = 0x7171717171717171717171717171717171717171n
		const accountString = '0x7171717171717171717171717171717171717171'
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 24, requestSocket: socket },
			method: 'wallet_requestPermissions',
			params: [{ eth_accounts: {} }],
		}

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		const pendingRequest = (await getPendingAccessRequests())[0]
		if (pendingRequest === undefined) throw new Error('Missing address access request')
		assert.equal(pendingRequest.requestAccessToAddress?.address, account)
		assert.deepEqual(messages.filter((message) => message.method === 'accountsChanged'), [])
		assert.deepEqual(messages.filter((message) => message.method === 'wallet_requestPermissions' && message.requestId === 24), [])

		await resolveInterceptorAccess(simulationServicesOwner, websiteTabConnections, {
			userReply: 'Approved',
			requestAccessToAddress: account,
			originalRequestAccessToAddress: account,
			accessRequestId: pendingRequest.accessRequestId,
		}, noopPublishRpcConnectionStatus)

		assert.deepEqual(messages.filter((message) => message.method === 'accountsChanged').map((message) => message.requestId), [24])
		assert.deepEqual(messages.filter((message) => message.method === 'wallet_requestPermissions' && message.requestId === 24).at(-1)?.result, [{
			parentCapability: 'eth_accounts',
			caveats: [{
				type: 'restrictReturnedAccounts',
				value: [accountString],
			}],
			invoker: websiteOrigin,
		}])
		assert.equal((await getPendingAccessRequests()).length, 0)
		assert.deepEqual((await getSettings()).websiteAccess[0]?.addressAccess, [{ address: account, access: true }])
	})

	test('does not bypass access for wallet_requestPermissions with unsupported permission keys', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			getPendingAccessRequests,
			getSettings,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x7474747474747474747474747474747474747474n
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port } = createPort(socket.tabId)
		const connection = { port, socket, websiteOrigin, approved: false, wantsToConnect: true }
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: connection,
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 26, requestSocket: socket },
			method: 'wallet_requestPermissions',
			params: [{ eth_accounts: {}, wallet_snap: {} }],
		}

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(connection.approved, false)
		assert.equal((await getPendingAccessRequests()).length, 1)
		assert.equal((await getSettings()).websiteAccess[0]?.addressAccess, undefined)
	})

	test('first-time wallet_requestPermissions uses one dialog that identifies the address', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			getPendingAccessRequests,
			resolveInterceptorAccess,
			getSettings,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x6767676767676767676767676767676767676767n
		const accountString = '0x6767676767676767676767676767676767676767'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: account })
		await setUseSignersAddressAsActiveAddress(false)

		const socket = { tabId: 1, connectionName: 0n }
		let port: browser.runtime.Port
		const { port: createdPort, messages } = createPort(socket.tabId, (message) => {
			if (message.method !== 'request_signer_to_eth_requestAccounts') return
			void handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
				interceptorRequest: true,
				interceptorInternalRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 230, requestSocket: socket },
				method: 'eth_accounts_reply',
				params: [{ signerProviderGeneration: 1, type: 'success', accounts: [accountString], requestAccounts: true }],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
		})
		port = createdPort
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 23, requestSocket: socket },
			method: 'wallet_requestPermissions',
			params: [{ eth_accounts: {} }],
		}

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		const siteLevelPendingRequest = (await getPendingAccessRequests())[0]
		if (siteLevelPendingRequest === undefined) throw new Error('Missing combined site and address access request')
		assert.equal(siteLevelPendingRequest.requestAccessToAddress?.address, account)
		const siteApprovalResolution = resolveInterceptorAccess(
			simulationServicesOwner,
			websiteTabConnections,
			{
				userReply: 'Approved',
				requestAccessToAddress: account,
				originalRequestAccessToAddress: account,
				accessRequestId: siteLevelPendingRequest.accessRequestId,
			},
			noopPublishRpcConnectionStatus,
		)
		await siteApprovalResolution

		assert.equal((await getPendingAccessRequests()).length, 0)
		await waitForPortMessageCount(messages, 'wallet_requestPermissions', 1)
		const permissionReply = messages.filter((message) => message.method === 'wallet_requestPermissions' && message.requestId === 23).at(-1)
		assert.equal(permissionReply?.error, undefined)
		assert.deepEqual(permissionReply?.result, [{
			parentCapability: 'eth_accounts',
			caveats: [{
				type: 'restrictReturnedAccounts',
				value: [accountString],
			}],
			invoker: websiteOrigin,
		}])
		const access = (await getSettings()).websiteAccess.find((entry) => entry.website.websiteOrigin === websiteOrigin)
		assert.equal(access?.access, true)
		assert.deepEqual(access?.addressAccess, [{ address: account, access: true }])
	})

	test('site-approved wallet_requestPermissions opens address consent after releasing the popup semaphore', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			requestAccessFromUser,
			createInterceptedRequestReplay,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			getPendingAccessRequests,
			getSettings,
			resolveInterceptorAccess,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x7373737373737373737373737373737373737373n
		const accountString = '0x7373737373737373737373737373737373737373'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		let port: browser.runtime.Port
		const { port: createdPort, messages } = createPort(socket.tabId, (message) => {
			if (message.method !== 'request_signer_to_eth_requestAccounts') return
			void handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
				interceptorRequest: true,
				interceptorInternalRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 731, requestSocket: socket },
				method: 'eth_accounts_reply',
				params: [{ signerProviderGeneration: 1, type: 'success', accounts: [accountString], requestAccounts: true }],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
		})
		port = createdPort
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 73, requestSocket: socket },
			method: 'wallet_requestPermissions',
			params: [{ eth_accounts: {} }],
		}

		await settleWithin(requestAccessFromUser(
			websiteTabConnections,
			socket,
			website,
			request,
			undefined,
			await getSettings(),
			undefined,
			createInterceptedRequestReplay(simulationServicesOwner, websiteTabConnections, noopPublishRpcConnectionStatus),
		), 100, 'requestAccessFromUser did not resolve')

		const pendingRequests = await getPendingAccessRequests()
		assert.equal(messages.some((message) => message.method === 'wallet_requestPermissions' && message.requestId === 73 && message.error?.code === -32002), false)
		assert.equal(pendingRequests.length, 1)
		const pendingRequest = pendingRequests[0]
		if (pendingRequest === undefined) throw new Error('Missing address access request')
		assert.equal(pendingRequest.requestAccessToAddress?.address, account)

		await resolveInterceptorAccess(simulationServicesOwner, websiteTabConnections, {
			userReply: 'Approved',
			requestAccessToAddress: account,
			originalRequestAccessToAddress: account,
			accessRequestId: pendingRequest.accessRequestId,
		}, noopPublishRpcConnectionStatus)

		assert.equal((await getPendingAccessRequests()).length, 0)
		assert.deepEqual(messages.filter((message) => message.method === 'wallet_requestPermissions' && message.requestId === 73).at(-1)?.result, [{
			parentCapability: 'eth_accounts',
			caveats: [{
				type: 'restrictReturnedAccounts',
				value: [accountString],
			}],
			invoker: websiteOrigin,
		}])
		assert.deepEqual((await getSettings()).websiteAccess[0]?.addressAccess, [{ address: account, access: true }])
	})

	test('wallet_revokePermissions clears website account access and keeps the website entry', async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, changeSimulationMode, setUseSignersAddressAsActiveAddress, updateWebsiteAccess, getSettings } = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x1111111111111111111111111111111111111111n
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 10, requestSocket: socket },
			method: 'wallet_revokePermissions',
			params: [{ eth_accounts: {} }],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		const accessLossEvents = messages.filter((message) => message.method === 'accountsChanged' || message.method === 'disconnect')
		assert.deepEqual(accessLossEvents.map((message) => message.method), ['accountsChanged', 'disconnect'])
		assert.deepEqual(accessLossEvents[0]?.result, [])
		assert.equal(messages.some((message) => message.method === 'safe_apps_compatibility'), false)
		const revokeReplies = messages.filter((message) => message.method === 'wallet_revokePermissions' && message.requestId === 10)
		assert.equal(revokeReplies.at(-1)?.result, null)
		assert.equal(websiteTabConnections.get(socket.tabId)?.connections[connectionKey]?.approved, false)
		const access = (await getSettings()).websiteAccess.find((entry) => entry.website.websiteOrigin === websiteOrigin)
		assert.notEqual(access, undefined)
		assert.equal(access?.website.websiteOrigin, websiteOrigin)
		assert.equal(access?.access, undefined)
		assert.equal(access?.addressAccess, undefined)
	})

	test('wallet_revokePermissions succeeds when the website is already unauthorized', async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, changeSimulationMode, setUseSignersAddressAsActiveAddress, updateWebsiteAccess, getSettings, getPendingAccessRequests } = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x1111111111111111111111111111111111111111n
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: false, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 11, requestSocket: socket },
			method: 'wallet_revokePermissions',
			params: [{ eth_accounts: {} }],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		const revokeReplies = messages.filter((message) => message.method === 'wallet_revokePermissions' && message.requestId === 11)
		assert.equal(revokeReplies.at(-1)?.result, null)
		const access = (await getSettings()).websiteAccess.find((entry) => entry.website.websiteOrigin === websiteOrigin)
		assert.notEqual(access, undefined)
		assert.equal(access?.website.websiteOrigin, websiteOrigin)
		assert.equal(access?.access, false)
		assert.equal(access?.addressAccess, undefined)

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 15, requestSocket: socket },
			method: 'eth_requestAccounts',
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		const pendingRequests = await getPendingAccessRequests()
		assert.equal(pendingRequests.length, 0)
	})

	test('wallet_revokePermissions succeeds when the Interceptor is disabled for the website', async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, changeSimulationMode, setUseSignersAddressAsActiveAddress, updateWebsiteAccess, getSettings } = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x1111111111111111111111111111111111111111n
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }], interceptorDisabled: true }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 12, requestSocket: socket },
			method: 'wallet_revokePermissions',
			params: [{ eth_accounts: {} }],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		const revokeReplies = messages.filter((message) => message.method === 'wallet_revokePermissions' && message.requestId === 12)
		assert.equal(revokeReplies.at(-1)?.result, null)
		const access = (await getSettings()).websiteAccess.find((entry) => entry.website.websiteOrigin === websiteOrigin)
		assert.notEqual(access, undefined)
		assert.equal(access?.website.websiteOrigin, websiteOrigin)
		assert.equal(access?.access, undefined)
		assert.equal(access?.addressAccess, undefined)
		assert.equal(access?.interceptorDisabled, true)
	})

	test('wallet_revokePermissions causes later account requests to prompt again instead of auto-denying', async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, changeSimulationMode, setUseSignersAddressAsActiveAddress, updateWebsiteAccess, getPendingAccessRequests, syncWebsiteApprovalsWithSettings } = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x1111111111111111111111111111111111111111n
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 13, requestSocket: socket },
			method: 'wallet_revokePermissions',
			params: [{ eth_accounts: {} }],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(websiteTabConnections.get(socket.tabId)?.connections[connectionKey]?.approved, false)
		assert.equal(websiteTabConnections.get(socket.tabId)?.connections[connectionKey]?.wantsToConnect, false)
		await syncWebsiteApprovalsWithSettings(websiteTabConnections, { promptForAccessesIfNeeded: true })
		assert.equal((await getPendingAccessRequests()).length, 0)

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 14, requestSocket: socket },
			method: 'eth_requestAccounts',
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		const pendingRequests = await getPendingAccessRequests()
		assert.equal(pendingRequests.length, 1)
		assert.equal(pendingRequests[0]?.website.websiteOrigin, websiteOrigin)
	})

	test('wallet_revokePermissions rejects unsupported permission params without revoking access', async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, changeSimulationMode, setUseSignersAddressAsActiveAddress, updateWebsiteAccess, getSettings } = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x1111111111111111111111111111111111111111n
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const unsupportedParams: (readonly unknown[])[] = [
			[],
			[{ wallet_switchEthereumChain: {} }],
			[{ wallet_snap: {} }],
			[{ eth_accounts: {}, wallet_snap: {} }],
			[{ eth_accounts: { foo: 1 } }],
		]
		for (const [index, params] of unsupportedParams.entries()) {
			const requestId = 13 + index
			await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
				interceptorRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId, requestSocket: socket },
				method: 'wallet_revokePermissions',
				params,
			}, websiteTabConnections, noopPublishRpcConnectionStatus)

			const revokeReplies = messages.filter((message) => message.method === 'wallet_revokePermissions' && message.requestId === requestId)
			assert.equal(revokeReplies.at(-1)?.error?.code, -32700)
			assert.equal(websiteTabConnections.get(socket.tabId)?.connections[connectionKey]?.approved, true)
			const access = (await getSettings()).websiteAccess.find((entry) => entry.website.websiteOrigin === websiteOrigin)
			assert.equal(access?.access, true)
			assert.deepEqual(access?.addressAccess, [{ address: account, access: true }])
		}
	})
})
