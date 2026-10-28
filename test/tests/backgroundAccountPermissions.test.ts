// Being split by behaviour into background*.test.ts files that use the restoring browser mock of backgroundEthAccountsTestHarness.ts. The following pull requests of the split move the tests left here and delete this file.
import { notifyWebsiteLifecycle } from '../../app/ts/background/websiteLifecycle.js'
import type { WebsiteTabConnections } from '../../app/ts/types/user-interface-types.js'
import * as assert from 'assert'
import { describe, spyOn, test } from 'bun:test'
import { addressString, confirmedSignerOwnership, createDeferredValue, createEthereumWithGetBlockCounter, createPort, installBrowserMock, loadModules, noopPublishRpcConnectionStatus, waitForPortMessageCount } from './backgroundEthAccountsTestHarness.js'

const lifecycle = (connections: WebsiteTabConnections) => connections.lifecycle

async function refreshSafeAppsPorts(connections: WebsiteTabConnections) {
	notifyWebsiteLifecycle(lifecycle(connections)?.accessReconciled)
	await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('background eth_accounts', () => {

	test('shared top-frame identity accepts MV2 and top-frame ports and rejects child frames', async () => {
		installBrowserMock()
		const { isTopFramePort } = await loadModules()
		for (const frameId of [undefined, 0, 1, 9]) {
			assert.equal(isTopFramePort(createPort(1, undefined, frameId).port), frameId === undefined || frameId === 0)
		}
	})

	test('disabled Safe Apps has no lifecycle work, reads, or port traffic', async () => {
		installBrowserMock()
		const { initializeSafeAppsCompatibility, websiteSocketToString } = await loadModules()
		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin: 'app.example', approved: true, wantsToConnect: true },
		} }]])
		const dispose = await initializeSafeAppsCompatibility(connections)
		const read = spyOn(browser.storage.local, 'get')
		try {
			notifyWebsiteLifecycle(lifecycle(connections)?.approvalChanged, socket, true)
			notifyWebsiteLifecycle(lifecycle(connections)?.signerConnected, socket, true)
			notifyWebsiteLifecycle(lifecycle(connections)?.signerAccountsChanged, socket)
			notifyWebsiteLifecycle(lifecycle(connections)?.accessReconciled)
			notifyWebsiteLifecycle(lifecycle(connections)?.approvalChanged, socket, false)
			notifyWebsiteLifecycle(lifecycle(connections)?.connectionRemoved, socket)
			await new Promise((resolve) => setTimeout(resolve, 0))
			assert.equal(read.mock.calls.length, 0)
			assert.deepEqual(messages, [])
		} finally { read.mockRestore(); dispose() }
	})

	test('Safe Apps settings activate and dispose the coordinator for existing ports', async () => {
		installBrowserMock()
		const { initializeSafeAppsCompatibility, setSafeAppsCompatibilityMode, websiteSocketToString } = await loadModules()
		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin: 'app.example', approved: false, wantsToConnect: false },
		} }]])
		const dispose = await initializeSafeAppsCompatibility(connections)
		try {
			assert.deepEqual(messages, [])
			await setSafeAppsCompatibilityMode(true)
			await waitForPortMessageCount(messages, 'safe_apps_compatibility', 1)
			await setSafeAppsCompatibilityMode(false)
			assert.equal(messages.filter((message) => message.method === 'safe_apps_compatibility').length, 2)
			const read = spyOn(browser.storage.local, 'get')
			try {
				notifyWebsiteLifecycle(lifecycle(connections)?.signerAccountsChanged, socket)
				notifyWebsiteLifecycle(lifecycle(connections)?.accessReconciled)
				await new Promise((resolve) => setTimeout(resolve, 0))
				assert.equal(read.mock.calls.length, 0)
				assert.equal(messages.length, 2)
			} finally { read.mockRestore() }
			await setSafeAppsCompatibilityMode(true)
			await waitForPortMessageCount(messages, 'safe_apps_compatibility', 3)
		} finally { dispose() }
	})

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

	test('does not enable Safe compatibility or expose an active address to an unapproved connected_to_signer request', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			setSafeAppsCompatibilityMode,
			initializeSafeAppsCompatibility,
			updateWebsiteAccess,
			updateTabState,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4bn
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: account })
		await setUseSignersAddressAsActiveAddress(false)
		await setSafeAppsCompatibilityMode(true)
		await updateWebsiteAccess(() => [])

		const socket = { tabId: 1, connectionName: 0n }
		await updateTabState(socket.tabId, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: account }))
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		await initializeSafeAppsCompatibility(websiteTabConnections)
		const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 12, requestSocket: socket },
			method: 'connected_to_signer',
			params: [true, 'MetaMask', 2],
		}

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)
		await waitForPortMessageCount(messages, 'safe_apps_compatibility', 1)

		const connectedReplies = messages.filter((message) => message.method === 'connected_to_signer' && message.requestId === 12)
		const connectedResult = connectedReplies.at(-1)?.result
		assert.equal(connectedResult?.metamaskCompatibilityMode, false)
		assert.deepEqual(messages.find((message) => message.method === 'safe_apps_compatibility')?.result, { enabled: false, canRequestAccess: true })
		assert.equal('activeAddress' in (connectedResult ?? {}), false)
		assert.equal(websiteTabConnections.get(socket.tabId)?.connections[connectionKey]?.approved, false)
	})

	test('ordinary signer reload restores EOA consent and requests accounts without a lifecycle observer', async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, changeSimulationMode, setUseSignersAddressAsActiveAddress, updateWebsiteAccess, updateTabState, getSettings } = await loadModules()
		const account = 0x5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5bn
		const websiteOrigin = 'https://ordinary.example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: account })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])
		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId, undefined, 0)
		await updateTabState(socket.tabId, (previous) => ({ ...previous, signerAccounts: [account], activeSigningAddress: account }))
		const connection = { port, socket, websiteOrigin, approved: false, wantsToConnect: false }
		const connections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: { [websiteSocketToString(socket)]: connection } }]])
		const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		assert.equal((await getSettings()).activeSigningSafeAddress, undefined)
		assert.equal('lifecycle' in connections, false)
		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
			interceptorRequest: true, interceptorInternalRequest: true, usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 13, requestSocket: socket },
			method: 'connected_to_signer', params: [true, 'MetaMask', 1],
		}, connections, noopPublishRpcConnectionStatus)
		assert.equal(connection.approved, true)
		assert.equal(messages.filter((message) => message.method === 'request_signer_to_eth_accounts').length, 1)
		assert.equal(messages.some((message) => message.method === 'safe_apps_compatibility'), false)
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

	test('enables Safe compatibility only while an owned configured Safe is active', async () => {
		installBrowserMock()
		const {
			changeSimulationMode,
			setSafeAppsCompatibilityMode,
			initializeSafeAppsCompatibility,
			setUseSignersAddressAsActiveAddress,
			updateTabState,
			updateUserAddressBookEntries,
			updateWebsiteAccess,
			websiteSocketToString,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const signerAddress = 0x6767676767676767676767676767676767676767n
		const configuredSafeAddress = 0x6868686868686868686868686868686868686868n
		await changeSimulationMode({
			simulationMode: false,
			activeSimulationAddress: undefined,
			activeSigningAddress: signerAddress,
			activeSigningSafeAddress: configuredSafeAddress,
		})
		await setUseSignersAddressAsActiveAddress(false)
		await setSafeAppsCompatibilityMode(true)
		await updateUserAddressBookEntries(() => [{
			type: 'safe',
			name: 'Configured Safe',
			address: configuredSafeAddress,
			chainId: 1n,
			entrySource: 'User',
			useAsActiveAddress: true,
			safeSignerAddresses: [signerAddress],
		}])
		await updateWebsiteAccess(() => [{
			website,
			access: true,
			addressAccess: [
				{ address: signerAddress, access: true },
				{ address: configuredSafeAddress, access: true },
			],
		}])

		const socket = { tabId: 1, connectionName: 0n }
		await updateTabState(socket.tabId, (previousState) => ({
			...previousState,
			signerName: 'MetaMask',
			signerConnected: true,
			signerAccounts: [signerAddress],
			activeSigningAddress: signerAddress,
		}))
		const { port, messages } = createPort(socket.tabId, undefined, 0)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		await initializeSafeAppsCompatibility(websiteTabConnections)

		await refreshSafeAppsPorts(websiteTabConnections)

		assert.deepEqual(messages.filter((message) => message.method === 'safe_apps_compatibility').map((message) => message.result?.enabled), [true])
	})

	for (const { accountKind, discoveredAccount, expectedCompatibility, coldStart, safeConsent, featureEnabled } of [
		{ accountKind: 'owner', discoveredAccount: 0x7171717171717171717171717171717171717171n, expectedCompatibility: true, coldStart: false, safeConsent: true, featureEnabled: true },
		{ accountKind: 'non-owner', discoveredAccount: 0x7272727272727272727272727272727272727272n, expectedCompatibility: false, coldStart: false, safeConsent: true, featureEnabled: true },
		{ accountKind: 'owner on a direct fresh page', discoveredAccount: 0x7171717171717171717171717171717171717171n, expectedCompatibility: true, coldStart: true, safeConsent: true, featureEnabled: true },
		{ accountKind: 'non-owner on a direct fresh page', discoveredAccount: 0x7272727272727272727272727272727272727272n, expectedCompatibility: false, coldStart: true, safeConsent: true, featureEnabled: true },
		{ accountKind: 'owner without Safe consent', discoveredAccount: 0x7171717171717171717171717171717171717171n, expectedCompatibility: false, coldStart: true, safeConsent: false, featureEnabled: true },
		{ accountKind: 'owner with compatibility disabled', discoveredAccount: 0x7171717171717171717171717171717171717171n, expectedCompatibility: false, coldStart: true, safeConsent: true, featureEnabled: false },
	] as const) {
		test(`waits for fresh ${ accountKind } account discovery before publishing Safe compatibility`, async () => {
			installBrowserMock()
			const {
				changeSimulationMode,
				getTabState,
				rememberSigningAddressPreference,
				handleInterceptedRequest,
				setSafeAppsCompatibilityMode,
				initializeSafeAppsCompatibility,
				setUseSignersAddressAsActiveAddress,
				updateTabState,
				updateUserAddressBookEntries,
				updateWebsiteAccess,
				websiteSocketToString,
			} = await loadModules()
			const websiteOrigin = 'https://safe-app.example.test'
			const website = { websiteOrigin, icon: undefined, title: undefined }
			const safeOwner = 0x7171717171717171717171717171717171717171n
			const configuredSafeAddress = 0x7373737373737373737373737373737373737373n
			await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: safeOwner, activeSigningSafeAddress: configuredSafeAddress })
			await setUseSignersAddressAsActiveAddress(false)
			await setSafeAppsCompatibilityMode(featureEnabled)
			await updateUserAddressBookEntries(() => [{
				type: 'safe',
				name: 'Configured Safe',
				address: configuredSafeAddress,
				chainId: 1n,
				entrySource: 'User',
				useAsActiveAddress: true,
				safeSignerAddresses: [safeOwner],
			}])
			await rememberSigningAddressPreference({ signerAddress: safeOwner, selection: 'safe', safeAddress: configuredSafeAddress, chainId: 1n })
			await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: configuredSafeAddress, access: safeConsent }] }])

			const socket = { tabId: 1, connectionName: 0n }
			let replyToDiscovery: (() => Promise<void>) | undefined
			const { port, messages } = createPort(socket.tabId, (message) => {
				if (message.method !== 'request_signer_to_eth_accounts') return
				replyToDiscovery = async () => {
					await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
						interceptorRequest: true,
						interceptorInternalRequest: true,
						usingInterceptorWithoutSigner: false,
						uniqueRequestIdentifier: { requestId: 171, requestSocket: socket },
						method: 'eth_accounts_reply',
						params: [{ signerProviderGeneration: 1, type: 'success', accounts: [addressString(discoveredAccount)], requestAccounts: false }],
					}, websiteTabConnections, noopPublishRpcConnectionStatus)
				}
			})
			const websiteTabConnections = new Map([[socket.tabId, { signerStateOwner: { ...confirmedSignerOwnership(socket).signerStateOwner, confirmed: !coldStart }, connections: {
				[websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: !coldStart, wantsToConnect: !coldStart },
			} }]])
			await initializeSafeAppsCompatibility(websiteTabConnections)
			const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
			await updateTabState(socket.tabId, (previousState) => ({
				...previousState,
				signerName: 'MetaMask',
				signerConnected: true,
				signerAccounts: [],
				activeSigningAddress: safeOwner,
			}))

			if (coldStart) {
				await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
					interceptorRequest: true,
					interceptorInternalRequest: true,
					usingInterceptorWithoutSigner: false,
					uniqueRequestIdentifier: { requestId: 170, requestSocket: socket },
					method: 'connected_to_signer',
					params: [true, 'MetaMask', 1],
				}, websiteTabConnections, noopPublishRpcConnectionStatus)
			} else notifyWebsiteLifecycle(lifecycle(websiteTabConnections)?.signerConnected, socket, false)
			await waitForPortMessageCount(messages, 'request_signer_to_eth_accounts', 1)
			assert.equal(messages.filter((message) => message.method === 'request_signer_to_eth_accounts').length, 1)
			assert.equal(messages.some((message) => message.method === 'safe_apps_compatibility' && message.result?.enabled === true), false)
			if (coldStart) assert.equal(websiteTabConnections.get(socket.tabId)?.connections[websiteSocketToString(socket)]?.approved, false)
			if (replyToDiscovery === undefined) throw new Error('Safe Apps signer-account discovery was not requested')
			await replyToDiscovery()
			await refreshSafeAppsPorts(websiteTabConnections)
			const refreshedTabState = await getTabState(socket.tabId)
			assert.deepEqual(refreshedTabState.signerAccounts, [discoveredAccount])
			assert.equal(refreshedTabState.activeSigningAddress, discoveredAccount)
			if (coldStart) assert.equal(websiteTabConnections.get(socket.tabId)?.connections[websiteSocketToString(socket)]?.approved, expectedCompatibility)
			await refreshSafeAppsPorts(websiteTabConnections)
			assert.equal(messages.some((message) => message.method === 'safe_apps_compatibility' && message.result?.enabled === true), expectedCompatibility)
		})
	}

	test('does not let an older async Safe compatibility enable overwrite a newer disable', async () => {
		installBrowserMock()
		const {
			changeSimulationMode,
			setSafeAppsCompatibilityMode,
			initializeSafeAppsCompatibility,
			setUseSignersAddressAsActiveAddress,
			updateTabState,
			updateUserAddressBookEntries,
			updateWebsiteAccess,
			websiteSocketToString,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const signerAddress = 0x6969696969696969696969696969696969696969n
		const configuredSafeAddress = 0x7070707070707070707070707070707070707070n
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: signerAddress, activeSigningSafeAddress: configuredSafeAddress })
		await setUseSignersAddressAsActiveAddress(false)
		await setSafeAppsCompatibilityMode(true)
		await updateUserAddressBookEntries(() => [{
			type: 'safe',
			name: 'Configured Safe',
			address: configuredSafeAddress,
			chainId: 1n,
			entrySource: 'User',
			useAsActiveAddress: true,
			safeSignerAddresses: [signerAddress],
		}])
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: configuredSafeAddress, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		await updateTabState(socket.tabId, (previousState) => ({
			...previousState,
			signerName: 'MetaMask',
			signerConnected: true,
			signerAccounts: [signerAddress],
			activeSigningAddress: signerAddress,
		}))
		const { port, messages } = createPort(socket.tabId, undefined, 0)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		await initializeSafeAppsCompatibility(websiteTabConnections)
		const delayedReadStarted = createDeferredValue<undefined>()
		const releaseDelayedRead = createDeferredValue<undefined>()
		const originalStorageGet = browser.storage.local.get
		let delayNextSafeAppsModeRead = true
		Object.defineProperty(browser.storage.local, 'get', {
			configurable: true,
			value: async (keys?: string | string[] | Record<string, unknown> | null) => {
				const result = await originalStorageGet(keys)
				if (delayNextSafeAppsModeRead && (keys === 'simulationMode' || (Array.isArray(keys) && keys.includes('simulationMode')))) {
					delayNextSafeAppsModeRead = false
					delayedReadStarted.resolve(undefined)
					await releaseDelayedRead.promise
				}
				return result
			},
		})

		const olderEnablePublication = refreshSafeAppsPorts(websiteTabConnections)
		await delayedReadStarted.promise
		await setSafeAppsCompatibilityMode(false)
		await refreshSafeAppsPorts(websiteTabConnections)
		assert.deepEqual(messages.filter((message) => message.method === 'safe_apps_compatibility').map((message) => message.result?.enabled), [false])

		releaseDelayedRead.resolve(undefined)
		await olderEnablePublication
		assert.deepEqual(messages.filter((message) => message.method === 'safe_apps_compatibility').map((message) => message.result?.enabled), [false])
	})

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
		const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
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
		const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
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
		const pendingWebsite = createDeferredValue<typeof website>()
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
		const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
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
		const pendingWebsite = createDeferredValue<typeof website>()
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
		const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
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
		const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
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
		const account = 0x7777777777777777777777777777777777777777n
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
		const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
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
		const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
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
		const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
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
		const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
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
		const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
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
		const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
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
		const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
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
		const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })

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
		const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })

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
		const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })

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
		const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const unsupportedParams: unknown[] = [
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
