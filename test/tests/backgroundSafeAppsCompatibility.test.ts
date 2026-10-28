import * as assert from 'node:assert'
import { describe, spyOn, test } from 'bun:test'
import { notifyWebsiteLifecycle } from '../../app/ts/background/websiteLifecycle.js'
import type { InterceptedRequest } from '../../app/ts/utils/requests.js'
import type { WebsiteTabConnections } from '../../app/ts/types/user-interface-types.js'
import { flushMicrotasks } from '../harness/async.js'
import { addressString, confirmedSignerOwnership, createEthereumWithGetBlockCounter, createPort, createRestoringBrowserMockInstaller, loadModules, noopPublishRpcConnectionStatus, waitForPortMessageCount } from './backgroundEthAccountsTestHarness.js'
import { readProperty } from '../harness/assertions.js'

const installBrowserMock = createRestoringBrowserMockInstaller()

const lifecycle = (connections: WebsiteTabConnections) => connections.lifecycle

// Fires the access-reconciled lifecycle event and lets the Safe Apps coordinator finish publishing to the ports.
async function refreshSafeAppsPorts(connections: WebsiteTabConnections) {
	notifyWebsiteLifecycle(lifecycle(connections)?.accessReconciled)
	await flushMicrotasks()
}

describe('background Safe Apps compatibility and website lifecycle observers', () => {
	test('shared top-frame identity accepts MV2 and top-frame ports and rejects child frames', async () => {
		installBrowserMock()
		const { isTopFramePort } = await loadModules()
		for (const frameId of [undefined, 0, 1, 9]) {
			assert.equal(isTopFramePort(createPort(1, undefined, frameId).port), frameId === undefined || frameId === 0)
		}
	})

	test('disabled Safe Apps has no lifecycle work, reads, or port traffic', async () => {
		const browserMock = installBrowserMock()
		const { initializeSafeAppsCompatibility, websiteSocketToString } = await loadModules()
		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin: 'app.example', approved: true, wantsToConnect: true },
		} }]])
		const dispose = await initializeSafeAppsCompatibility(connections)
		const read = spyOn(browserMock.browser.storage.local, 'get')
		try {
			notifyWebsiteLifecycle(lifecycle(connections)?.approvalChanged, socket, true)
			notifyWebsiteLifecycle(lifecycle(connections)?.signerConnected, socket, true)
			notifyWebsiteLifecycle(lifecycle(connections)?.signerAccountsChanged, socket)
			notifyWebsiteLifecycle(lifecycle(connections)?.accessReconciled)
			notifyWebsiteLifecycle(lifecycle(connections)?.approvalChanged, socket, false)
			notifyWebsiteLifecycle(lifecycle(connections)?.connectionRemoved, socket)
			await flushMicrotasks()
			assert.equal(read.mock.calls.length, 0)
			assert.deepEqual(messages, [])
		} finally { read.mockRestore(); dispose() }
	})

	test('Safe Apps settings activate and dispose the coordinator for existing ports', async () => {
		const browserMock = installBrowserMock()
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
			const read = spyOn(browserMock.browser.storage.local, 'get')
			try {
				notifyWebsiteLifecycle(lifecycle(connections)?.signerAccountsChanged, socket)
				notifyWebsiteLifecycle(lifecycle(connections)?.accessReconciled)
				await flushMicrotasks()
				assert.equal(read.mock.calls.length, 0)
				assert.equal(messages.length, 2)
			} finally { read.mockRestore() }
			await setSafeAppsCompatibilityMode(true)
			await waitForPortMessageCount(messages, 'safe_apps_compatibility', 3)
		} finally { dispose() }
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
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const request: InterceptedRequest = {
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
		assert.equal(readProperty(connectedResult, 'metamaskCompatibilityMode'), false)
		assert.deepEqual(messages.find((message) => message.method === 'safe_apps_compatibility')?.result, { enabled: false, canRequestAccess: true })
		assert.equal(typeof connectedResult === 'object' && connectedResult !== null && 'activeAddress' in connectedResult, false)
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
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
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

		assert.deepEqual(messages.filter((message) => message.method === 'safe_apps_compatibility').map((message) => readProperty(message.result, 'enabled')), [true])
	})

	for (const { accountKind, discoveredAccount, expectedCompatibility, coldStart, safeConsent, featureEnabled } of [
		{ accountKind: 'owner', discoveredAccount: 0x7171717171717171717171717171717171717171n, expectedCompatibility: true, coldStart: false, safeConsent: true, featureEnabled: true },
		{ accountKind: 'non-owner', discoveredAccount: 0x7272727272727272727272727272727272727272n, expectedCompatibility: false, coldStart: false, safeConsent: true, featureEnabled: true },
		{ accountKind: 'owner on a direct fresh page', discoveredAccount: 0x7171717171717171717171717171717171717171n, expectedCompatibility: true, coldStart: true, safeConsent: true, featureEnabled: true },
		{ accountKind: 'non-owner on a direct fresh page', discoveredAccount: 0x7272727272727272727272727272727272727272n, expectedCompatibility: false, coldStart: true, safeConsent: true, featureEnabled: true },
		{ accountKind: 'owner without Safe consent', discoveredAccount: 0x7171717171717171717171717171717171717171n, expectedCompatibility: false, coldStart: true, safeConsent: false, featureEnabled: true },
		{ accountKind: 'owner with compatibility disabled', discoveredAccount: 0x7171717171717171717171717171717171717171n, expectedCompatibility: false, coldStart: true, safeConsent: true, featureEnabled: false },
	]) {
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
			const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
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
			assert.equal(messages.some((message) => message.method === 'safe_apps_compatibility' && readProperty(message.result, 'enabled') === true), false)
			if (coldStart) assert.equal(websiteTabConnections.get(socket.tabId)?.connections[websiteSocketToString(socket)]?.approved, false)
			if (replyToDiscovery === undefined) throw new Error('Safe Apps signer-account discovery was not requested')
			await replyToDiscovery()
			await refreshSafeAppsPorts(websiteTabConnections)
			const refreshedTabState = await getTabState(socket.tabId)
			assert.deepEqual(refreshedTabState.signerAccounts, [discoveredAccount])
			assert.equal(refreshedTabState.activeSigningAddress, discoveredAccount)
			if (coldStart) assert.equal(websiteTabConnections.get(socket.tabId)?.connections[websiteSocketToString(socket)]?.approved, expectedCompatibility)
			await refreshSafeAppsPorts(websiteTabConnections)
			assert.equal(messages.some((message) => message.method === 'safe_apps_compatibility' && readProperty(message.result, 'enabled') === true), expectedCompatibility)
		})
	}

	test('does not let an older async Safe compatibility enable overwrite a newer disable', async () => {
		const browserMock = installBrowserMock()
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
		const delayedReadStarted = Promise.withResolvers<undefined>()
		const releaseDelayedRead = Promise.withResolvers<undefined>()
		const localStorage = browserMock.browser.storage.local
		const readLocalStorage = localStorage.get
		let delayNextSafeAppsModeRead = true
		localStorage.get = async (keys) => {
			const result = await readLocalStorage(keys)
			if (delayNextSafeAppsModeRead && (keys === 'simulationMode' || (Array.isArray(keys) && keys.includes('simulationMode')))) {
				delayNextSafeAppsModeRead = false
				delayedReadStarted.resolve(undefined)
				await releaseDelayedRead.promise
			}
			return result
		}

		const olderEnablePublication = refreshSafeAppsPorts(websiteTabConnections)
		await delayedReadStarted.promise
		await setSafeAppsCompatibilityMode(false)
		await refreshSafeAppsPorts(websiteTabConnections)
		assert.deepEqual(messages.filter((message) => message.method === 'safe_apps_compatibility').map((message) => readProperty(message.result, 'enabled')), [false])

		releaseDelayedRead.resolve(undefined)
		await olderEnablePublication
		await flushMicrotasks()
		assert.deepEqual(messages.filter((message) => message.method === 'safe_apps_compatibility').map((message) => readProperty(message.result, 'enabled')), [false])
	})
})
