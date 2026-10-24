// These tests guard current access-control behaviour and all stay; they call the website-access reconciliation API that the background access rework replaces, so that change moves each of them unchanged into background*.test.ts before deleting this file.
import { notifyWebsiteLifecycle } from '../../app/ts/background/websiteLifecycle.js'
import type { WebsiteTabConnections } from '../../app/ts/types/user-interface-types.js'
import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { addressString, confirmedSignerOwnership, createDeferredValue, createEthereumWithGetBlockCounter, createPort, installBrowserMock, loadModules, noopPublishRpcConnectionStatus, waitForPortMessageCount } from './backgroundEthAccountsTestHarness.js'

const lifecycle = (connections: WebsiteTabConnections) => connections.lifecycle

async function refreshSafeAppsPorts(connections: WebsiteTabConnections) {
	notifyWebsiteLifecycle(lifecycle(connections)?.accessReconciled)
	await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('background eth_accounts', () => {

	test('optional lifecycle observers do not block or fail strict access reconciliation', async () => {
		const { runtimeMessages } = installBrowserMock()
		const { updateWebsiteApprovalAccesses, getSettings } = await loadModules()
		const connections = Object.assign(new Map(), { lifecycle: { accessReconciled: () => { throw new Error('Observer failed') } } })
		assert.equal(typeof await updateWebsiteApprovalAccesses(undefined, connections, await getSettings(), false, true), 'number')
		await new Promise((resolve) => setTimeout(resolve, 0))
		assert.equal(runtimeMessages.some((message) => typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_UnexpectedErrorOccured'), true)
	})

	test('async lifecycle callback rejection is reported without delaying access reconciliation', async () => {
		const { runtimeMessages } = installBrowserMock()
		const { updateWebsiteApprovalAccesses, getSettings } = await loadModules()
		const releaseCallback = createDeferredValue<undefined>()
		const connections = Object.assign(new Map(), { lifecycle: { accessReconciled: async () => {
			await releaseCallback.promise
			throw new Error('Async observer failed')
		} } })
		assert.equal(typeof await updateWebsiteApprovalAccesses(undefined, connections, await getSettings(), false, true), 'number')
		releaseCallback.resolve(undefined)
		await new Promise((resolve) => setTimeout(resolve, 0))
		assert.equal(runtimeMessages.some((message) => typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_UnexpectedErrorOccured'), true)
	})

	test('access reconciliation invokes only the explicitly supplied connection callbacks', async () => {
		installBrowserMock()
		const { updateWebsiteApprovalAccesses, getSettings } = await loadModules()
		const calls: string[] = []
		const first = Object.assign(new Map(), { lifecycle: { accessReconciled: () => { calls.push('first') } } })
		const second = Object.assign(new Map(), { lifecycle: { accessReconciled: () => { calls.push('second') } } })
		const settings = await getSettings()
		await updateWebsiteApprovalAccesses(undefined, first, settings, false, true)
		assert.deepEqual(calls, ['first'])
		await updateWebsiteApprovalAccesses(undefined, new Map(), settings, false, true)
		assert.deepEqual(calls, ['first'])
		await updateWebsiteApprovalAccesses(undefined, second, settings, false, true)
		assert.deepEqual(calls, ['first', 'second'])
	})

	test('does not advertise an approved EOA as a Safe on top-frame reload or child-frame approval', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			setSafeAppsCompatibilityMode,
			initializeSafeAppsCompatibility,
			updateWebsiteAccess,
			updateWebsiteApprovalAccesses,
			updateTabState,
			getSettings,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5bn
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: account })
		await setUseSignersAddressAsActiveAddress(false)
		await setSafeAppsCompatibilityMode(true)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		await updateTabState(socket.tabId, (previousState) => ({ ...previousState, signerName: 'MetaMask', signerConnected: true, signerAccounts: [account], activeSigningAddress: account }))
		const { port, messages } = createPort(socket.tabId, undefined, 0)
		const connectionKey = websiteSocketToString(socket)
		const connection = { port, socket, websiteOrigin, approved: false, wantsToConnect: false }
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: { [connectionKey]: connection } }]])
		await initializeSafeAppsCompatibility(websiteTabConnections)
		const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 13, requestSocket: socket },
			method: 'connected_to_signer',
			params: [true, 'MetaMask', 1],
		}

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		const connectedResult = messages.find((message) => message.method === 'connected_to_signer' && message.requestId === 13)?.result
		assert.equal(connection.approved, true)
		assert.equal(connection.wantsToConnect, true)
		assert.equal(connectedResult?.metamaskCompatibilityMode, false)
		await waitForPortMessageCount(messages, 'safe_apps_compatibility', 1)
		assert.equal(messages.find((message) => message.method === 'safe_apps_compatibility')?.result?.enabled, false)
		assert.deepEqual(messages.find((message) => message.method === 'accountsChanged')?.result, [addressString(account)])

		const childSocket = { tabId: 2, connectionName: 1n }
		const { port: childPort, messages: childMessages } = createPort(childSocket.tabId, undefined, 2, childSocket.connectionName)
		const childConnection = { port: childPort, socket: childSocket, websiteOrigin, approved: false, wantsToConnect: false }
		const childConnections = new Map([[childSocket.tabId, { ...confirmedSignerOwnership(childSocket), connections: { [websiteSocketToString(childSocket)]: childConnection } }]])
		await initializeSafeAppsCompatibility(childConnections)
		await updateTabState(childSocket.tabId, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: account }))
		await handleInterceptedRequest(childPort, websiteOrigin, website, simulationServicesOwner, childSocket, {
			...request,
			uniqueRequestIdentifier: { requestId: 14, requestSocket: childSocket },
		}, childConnections, noopPublishRpcConnectionStatus)
		const childResult = childMessages.find((message) => message.method === 'connected_to_signer' && message.requestId === 14)?.result
		assert.equal(childConnection.approved, false)
		assert.equal(childResult?.metamaskCompatibilityMode, false)

		await updateWebsiteApprovalAccesses(simulationServicesOwner, childConnections, await getSettings(), false)
		await waitForPortMessageCount(childMessages, 'safe_apps_compatibility', 1)
		assert.equal(childConnection.approved, true)
		assert.equal(childMessages.filter((message) => message.method === 'safe_apps_compatibility').every((message) => message.result?.enabled === false), true)
		await refreshSafeAppsPorts(childConnections)
		assert.equal(childMessages.filter((message) => message.method === 'safe_apps_compatibility').every((message) => message.result?.enabled === false), true)
	})

	test('keeps Safe compatibility disabled when address consent is granted only to an EOA', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			setSafeAppsCompatibilityMode,
			initializeSafeAppsCompatibility,
			updateWebsiteAccess,
			updateWebsiteApprovalAccesses,
			updateTabState,
			getSettings,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x6666666666666666666666666666666666666666n
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: account })
		await setUseSignersAddressAsActiveAddress(false)
		await setSafeAppsCompatibilityMode(true)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [] }])

		const socket = { tabId: 1, connectionName: 0n }
		await updateTabState(socket.tabId, (previousState) => ({ ...previousState, signerName: 'MetaMask', signerConnected: true, signerAccounts: [account], activeSigningAddress: account }))
		const { port, messages } = createPort(socket.tabId, undefined, 0)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		await initializeSafeAppsCompatibility(websiteTabConnections)
		const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const connectedRequest = {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 15, requestSocket: socket },
			method: 'connected_to_signer',
			params: [true, 'MetaMask', 1],
		}

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, connectedRequest, websiteTabConnections, noopPublishRpcConnectionStatus)
		await waitForPortMessageCount(messages, 'safe_apps_compatibility', 1)
		assert.equal(messages.find((message) => message.method === 'connected_to_signer' && message.requestId === 15)?.result?.metamaskCompatibilityMode, false)
		assert.equal(messages.filter((message) => message.method === 'safe_apps_compatibility').every((message) => message.result?.enabled === false), true)

		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])
		await updateWebsiteApprovalAccesses(simulationServicesOwner, websiteTabConnections, await getSettings(), false)
		assert.equal(messages.filter((message) => message.method === 'safe_apps_compatibility').every((message) => message.result?.enabled === false), true)
		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
			...connectedRequest,
			uniqueRequestIdentifier: { requestId: 16, requestSocket: socket },
			params: [false, 'NoSigner', 2],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		await waitForPortMessageCount(messages, 'safe_apps_compatibility', 3)
		assert.equal(messages.find((message) => message.method === 'connected_to_signer' && message.requestId === 16)?.result?.metamaskCompatibilityMode, false)
		assert.equal(messages.filter((message) => message.method === 'safe_apps_compatibility').every((message) => message.result?.enabled === false), true)
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
		} = await loadModules()
		const { getActiveAddressEntryForChain } = await import('../../app/ts/background/metadataUtils.js')
		const firstWorkerAccess = await import('../../app/ts/background/windows/interceptorAccess.js?access-dialog-worker-before-restart')
		const restartedWorkerAccess = await import('../../app/ts/background/windows/interceptorAccess.js?access-dialog-worker-after-restart')
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
		const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 111, requestSocket: socket },
			method: 'eth_requestAccounts',
		} as const
		const requestAccessToAddress = await getActiveAddressEntryForChain(account, 1n)
		const settings = await getSettings()

		await firstWorkerAccess.requestAccessFromUser(
			simulationServicesOwner,
			websiteTabConnections,
			socket,
			website,
			request,
			requestAccessToAddress,
			settings,
			requestAccessToAddress,
			noopPublishRpcConnectionStatus,
		)
		await restartedWorkerAccess.requestAccessFromUser(
			simulationServicesOwner,
			websiteTabConnections,
			socket,
			website,
			request,
			requestAccessToAddress,
			settings,
			requestAccessToAddress,
			noopPublishRpcConnectionStatus,
		)

		assert.equal((await getPendingAccessRequests()).length, 1)
		assert.equal(messages.some((message) => message.requestId === 111), false)
		const pendingRequest = (await getPendingAccessRequests())[0]
		if (pendingRequest === undefined) throw new Error('Missing pending request after worker restart')
		await restartedWorkerAccess.resolveInterceptorAccess(
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

	test('site-approved wallet_requestPermissions opens address consent after releasing the popup semaphore', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			requestAccessFromUser,
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
		const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 73, requestSocket: socket },
			method: 'wallet_requestPermissions',
			params: [{ eth_accounts: {} }],
		}

		await Promise.race([
			requestAccessFromUser(
				simulationServicesOwner,
				websiteTabConnections,
				socket,
				website,
				request,
				undefined,
				await getSettings(),
				undefined,
				noopPublishRpcConnectionStatus,
			),
			new Promise((_, reject) => setTimeout(() => reject(new Error('requestAccessFromUser did not resolve')), 100)),
		])

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

	test('wallet_revokePermissions causes later account requests to prompt again instead of auto-denying', async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, changeSimulationMode, setUseSignersAddressAsActiveAddress, updateWebsiteAccess, getPendingAccessRequests, updateWebsiteApprovalAccesses, getSettings } = await loadModules()
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
		const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 13, requestSocket: socket },
			method: 'wallet_revokePermissions',
			params: [{ eth_accounts: {} }],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(websiteTabConnections.get(socket.tabId)?.connections[connectionKey]?.approved, false)
		assert.equal(websiteTabConnections.get(socket.tabId)?.connections[connectionKey]?.wantsToConnect, false)
		await updateWebsiteApprovalAccesses(simulationServicesOwner, websiteTabConnections, await getSettings(), true)
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

})
