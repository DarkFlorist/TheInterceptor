import * as assert from 'assert'
import { describe, test } from 'bun:test'
import type { WebsiteTabConnections } from '../../app/ts/types/user-interface-types.js'
import { ICON_NOT_ACTIVE, ICON_NOT_ACTIVE_WITH_SHIELD } from '../../app/ts/utils/constants.js'
import { getWalletSwitchRequestId, confirmedSignerOwnership, createDeferredValue, createEthereumWithGetBlockCounter, createPort, createTestSimulationServicesOwner, installBrowserMock, loadModules, noopPublishRpcConnectionStatus, waitForPortMessageCount } from './backgroundEthAccountsTestHarness.js'

describe('background eth_accounts', () => {
	const setUpAddressLevelBlockAllWithUnreadableActiveRpcNetwork = async (consentedWebsiteOrigin: string) => {
		const { changeSimulationMode, updateUserAddressBookEntries, updateWebsiteAccess } = await loadModules()
		const activeAddress = 0x1010101010101010101010101010101010101010n
		await updateUserAddressBookEntries(() => [{
			type: 'contact',
			name: 'Blocked active address',
			address: activeAddress,
			chainId: 'AllChains',
			entrySource: 'User',
			useAsActiveAddress: true,
			askForAddressAccess: false,
			declarativeNetRequestBlockMode: 'block-all',
		}])
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: activeAddress })
		// Persisted consent only; the website itself has no site-level block rule.
		await updateWebsiteAccess(() => [{ website: { websiteOrigin: consentedWebsiteOrigin, icon: undefined, title: undefined }, access: true }])
		await browser.storage.local.set({ activeRpcNetwork: 'corrupt' })
	}

	const withSilencedWarnings = async <T>(operation: () => Promise<T>) => {
		const originalWarn = console.warn
		console.warn = () => undefined
		try {
			return await operation()
		} finally {
			console.warn = originalWarn
		}
	}

	test('blocks newly registered tabs with persisted consent while the active RPC network is unreadable', async () => {
		const browserMock = installBrowserMock({ manifestVersion: 3 })
		const { registerWebsiteConnectionAndReconcileRequestBlocks, areWeBlocking, updateDeclarativeNetRequestBlocks } = await loadModules()
		const consentedWebsiteOrigin = 'consented-startup.example'
		await setUpAddressLevelBlockAllWithUnreadableActiveRpcNetwork(consentedWebsiteOrigin)
		const consentedSocket = { tabId: 9876, connectionName: 0n }
		const unconsentedSocket = { tabId: 9877, connectionName: 0n }
		const websiteTabConnections: WebsiteTabConnections = new Map()
		// Background startup reconciles before any content script connects.
		await withSilencedWarnings(async () => await updateDeclarativeNetRequestBlocks(websiteTabConnections))
		// Connections register unapproved through the same call content-script connection uses; runtime approval is never restored while settings are unavailable.
		await withSilencedWarnings(async () => await (await registerWebsiteConnectionAndReconcileRequestBlocks(websiteTabConnections, consentedSocket, { port: createPort(consentedSocket.tabId).port, socket: consentedSocket, websiteOrigin: consentedWebsiteOrigin, approved: false, wantsToConnect: false }, true)).requestBlocksReconciliation)
		await withSilencedWarnings(async () => await (await registerWebsiteConnectionAndReconcileRequestBlocks(websiteTabConnections, unconsentedSocket, { port: createPort(unconsentedSocket.tabId).port, socket: unconsentedSocket, websiteOrigin: 'unconsented.example', approved: false, wantsToConnect: false }, true)).requestBlocksReconciliation)

		assert.deepEqual(browserMock.requestBlockingCalls.blockedSessionTabIds, [consentedSocket.tabId])
		assert.equal(await withSilencedWarnings(async () => await areWeBlocking(consentedSocket.tabId, consentedWebsiteOrigin)), true)
		assert.equal(await withSilencedWarnings(async () => await areWeBlocking(unconsentedSocket.tabId, 'unconsented.example')), false)
	})

	test('blocks a consented tab registered after the active RPC network becomes unreadable at runtime', async () => {
		const browserMock = installBrowserMock({ manifestVersion: 3 })
		const { registerWebsiteConnectionAndReconcileRequestBlocks, areWeBlocking, changeSimulationMode, updateDeclarativeNetRequestBlocks, updateUserAddressBookEntries, updateWebsiteAccess } = await loadModules()
		const consentedWebsiteOrigin = 'consented-runtime.example'
		const activeAddress = 0x1010101010101010101010101010101010101010n
		await updateUserAddressBookEntries(() => [{ type: 'contact', name: 'Blocked active address', address: activeAddress, chainId: 'AllChains', entrySource: 'User', useAsActiveAddress: true, askForAddressAccess: false, declarativeNetRequestBlockMode: 'block-all' }])
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: activeAddress })
		await updateWebsiteAccess(() => [{ website: { websiteOrigin: consentedWebsiteOrigin, icon: undefined, title: undefined }, access: true }])
		const websiteTabConnections: WebsiteTabConnections = new Map()
		// A healthy reconciliation runs first, so no earlier fail-closed state is carried into the registration below.
		await updateDeclarativeNetRequestBlocks(websiteTabConnections)
		assert.deepEqual(browserMock.requestBlockingCalls.blockedSessionTabIds, [])
		await browser.storage.local.set({ activeRpcNetwork: 'corrupt' })
		const socket = { tabId: 9879, connectionName: 0n }

		await withSilencedWarnings(async () => await (await registerWebsiteConnectionAndReconcileRequestBlocks(websiteTabConnections, socket, { port: createPort(socket.tabId).port, socket, websiteOrigin: consentedWebsiteOrigin, approved: false, wantsToConnect: false }, true)).requestBlocksReconciliation)

		assert.deepEqual(browserMock.requestBlockingCalls.blockedSessionTabIds, [socket.tabId])
		assert.equal(await withSilencedWarnings(async () => await areWeBlocking(socket.tabId, consentedWebsiteOrigin)), true)
	})

	test('blocks a tab when a consented child frame registers after an unconsented top frame while the active RPC network is unreadable', async () => {
		const browserMock = installBrowserMock({ manifestVersion: 3 })
		const { registerWebsiteConnectionAndReconcileRequestBlocks } = await loadModules()
		const consentedFrameOrigin = 'consented-frame.example'
		await setUpAddressLevelBlockAllWithUnreadableActiveRpcNetwork(consentedFrameOrigin)
		const tabId = 9881
		const topFrameSocket = { tabId, connectionName: 0n }
		const childFrameSocket = { tabId, connectionName: 1n }
		const websiteTabConnections: WebsiteTabConnections = new Map()
		await withSilencedWarnings(async () => await (await registerWebsiteConnectionAndReconcileRequestBlocks(websiteTabConnections, topFrameSocket, { port: createPort(tabId).port, socket: topFrameSocket, websiteOrigin: 'unconsented-top.example', approved: false, wantsToConnect: false }, true)).requestBlocksReconciliation)
		assert.deepEqual(browserMock.requestBlockingCalls.blockedSessionTabIds, [])

		await withSilencedWarnings(async () => await (await registerWebsiteConnectionAndReconcileRequestBlocks(websiteTabConnections, childFrameSocket, { port: createPort(tabId, undefined, 1, childFrameSocket.connectionName).port, socket: childFrameSocket, websiteOrigin: consentedFrameOrigin, approved: false, wantsToConnect: false }, false)).requestBlocksReconciliation)

		// Checked straight after registration, before areWeBlocking or any navigation-completion update could reconcile.
		assert.deepEqual(browserMock.requestBlockingCalls.blockedSessionTabIds, [tabId])
	})

	test('shows the blocking shield only after persisted-consent tab blocking is applied while the active RPC network is unreadable', async () => {
		const browserMock = installBrowserMock({ manifestVersion: 3 })
		const { areWeBlocking, getTabState, registerWebsiteConnectionAndProvisionallyClaimSignerState, updateDeclarativeNetRequestBlocks } = await loadModules()
		const { updateExtensionIcon } = await import('../../app/ts/background/iconHandler.js')
		const consentedWebsiteOrigin = 'consented-icon.example'
		await setUpAddressLevelBlockAllWithUnreadableActiveRpcNetwork(consentedWebsiteOrigin)
		const websiteTabConnections: WebsiteTabConnections = new Map()
		const socket = { tabId: 9882, connectionName: 0n }
		// Registered without its request-block reconciliation, so blocking is not applied yet.
		await registerWebsiteConnectionAndProvisionallyClaimSignerState(websiteTabConnections, socket, { port: createPort(socket.tabId).port, socket, websiteOrigin: consentedWebsiteOrigin, approved: false, wantsToConnect: false }, true)

		await withSilencedWarnings(async () => await updateExtensionIcon(socket.tabId, consentedWebsiteOrigin, 1))

		// The icon path only reads blocking state, and nothing is applied before reconciliation.
		assert.equal(browserMock.requestBlockingCalls.declarativeNetRequestUpdates, 0)
		assert.equal(await areWeBlocking(socket.tabId, consentedWebsiteOrigin), false)
		assert.equal((await getTabState(socket.tabId)).tabIconDetails.icon, ICON_NOT_ACTIVE)

		await withSilencedWarnings(async () => await updateDeclarativeNetRequestBlocks(websiteTabConnections))
		await withSilencedWarnings(async () => await updateExtensionIcon(socket.tabId, consentedWebsiteOrigin, 2))

		assert.equal(await areWeBlocking(socket.tabId, consentedWebsiteOrigin), true)
		const { tabIconDetails } = await getTabState(socket.tabId)
		assert.equal(tabIconDetails.icon, ICON_NOT_ACTIVE_WITH_SHIELD)
		assert.match(tabIconDetails.iconReason, /RPC configuration is unavailable/)
		assert.match(tabIconDetails.iconReason, /blocking external requests/)
	})

	test('does not show the blocking shield when applying persisted-consent tab blocking fails', async () => {
		installBrowserMock({ manifestVersion: 3 })
		const { areWeBlocking, getTabState, registerWebsiteConnectionAndProvisionallyClaimSignerState, updateDeclarativeNetRequestBlocks } = await loadModules()
		const { updateExtensionIcon } = await import('../../app/ts/background/iconHandler.js')
		const consentedWebsiteOrigin = 'consented-rejected.example'
		await setUpAddressLevelBlockAllWithUnreadableActiveRpcNetwork(consentedWebsiteOrigin)
		const websiteTabConnections: WebsiteTabConnections = new Map()
		const socket = { tabId: 9883, connectionName: 0n }
		await registerWebsiteConnectionAndProvisionallyClaimSignerState(websiteTabConnections, socket, { port: createPort(socket.tabId).port, socket, websiteOrigin: consentedWebsiteOrigin, approved: false, wantsToConnect: false }, true)
		Object.defineProperty(browser.declarativeNetRequest, 'updateSessionRules', { configurable: true, value: async () => { throw new Error('Session rules unavailable') } })

		await assert.rejects(withSilencedWarnings(async () => await updateDeclarativeNetRequestBlocks(websiteTabConnections)), /Session rules unavailable/)
		await withSilencedWarnings(async () => await updateExtensionIcon(socket.tabId, consentedWebsiteOrigin, 1))

		assert.equal(await areWeBlocking(socket.tabId, consentedWebsiteOrigin), false)
		const { tabIconDetails } = await getTabState(socket.tabId)
		assert.equal(tabIconDetails.icon, ICON_NOT_ACTIVE)
		assert.doesNotMatch(tabIconDetails.iconReason, /blocking external requests/)
	})

	test('keeps tab blocking rules applied before a service-worker restart while the active RPC network is unreadable', async () => {
		const blockedBeforeRestartTabId = 9878
		const browserMock = installBrowserMock({ manifestVersion: 3, initialSessionRules: [{ id: 1, condition: { tabIds: [blockedBeforeRestartTabId] } }] })
		const { areWeBlocking, updateDeclarativeNetRequestBlocks } = await loadModules()
		await setUpAddressLevelBlockAllWithUnreadableActiveRpcNetwork('consented-restart.example')
		// Startup reconciles before any content script reconnects.
		const emptyConnections: WebsiteTabConnections = new Map()

		await withSilencedWarnings(async () => await updateDeclarativeNetRequestBlocks(emptyConnections))

		assert.deepEqual(browserMock.requestBlockingCalls.blockedSessionTabIds, [blockedBeforeRestartTabId])
		assert.equal(await withSilencedWarnings(async () => await areWeBlocking(blockedBeforeRestartTabId, 'consented-restart.example')), true)
	})

	test('completes signer callbacks but rejects RPC requests while configuration and services are unavailable', async () => {
		const { readStoredValue } = installBrowserMock()
		const {
			changeSimulationMode,
			getTabState,
			getPendingWatchAssetRequests,
			handleInterceptedRequest,
			updateTabState,
			updatePendingWatchAssetRequests,
			websiteSocketToString,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const previousAccount = 0x1010101010101010101010101010101010101010n
		const nextAccount = 0x2020202020202020202020202020202020202020n
		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		let signerAccountsChangedCalls = 0
		const websiteTabConnections = Object.assign(new Map([[socket.tabId, {
			...confirmedSignerOwnership(socket),
			connections: {
				[websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
			},
		}]]), { lifecycle: { signerAccountsChanged: () => { signerAccountsChangedCalls += 1 } } })
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: previousAccount })
		await updateTabState(socket.tabId, (previousState) => ({
			...previousState,
			signerAccounts: [previousAccount],
			activeSigningAddress: previousAccount,
		}))
		const storedActiveRpcNetwork = readStoredValue('activeRpcNetwork')
		const storedActiveSigningAddress = readStoredValue('activeSigningAddress')
		await browser.storage.local.set({ rpcEntries: 'corrupt' })
		simulationServicesOwner.clear()

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 1, requestSocket: socket },
			method: 'eth_accounts_reply',
			params: [{
				signerProviderGeneration: 1,
				type: 'success',
				accounts: ['0x2020202020202020202020202020202020202020'],
				requestAccounts: false,
			}],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.deepEqual((await getTabState(socket.tabId)).signerAccounts, [nextAccount])
		assert.equal((await getTabState(socket.tabId)).activeSigningAddress, nextAccount)
		assert.deepEqual(readStoredValue('activeRpcNetwork'), storedActiveRpcNetwork)
		assert.deepEqual(readStoredValue('activeSigningAddress'), storedActiveSigningAddress)
		assert.equal(signerAccountsChangedCalls, 1)

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 2, requestSocket: socket },
			method: 'signer_chainChanged',
			params: ['0x2', 1],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		assert.equal((await getTabState(socket.tabId)).signerChain, 2n)
		assert.deepEqual(readStoredValue('activeRpcNetwork'), storedActiveRpcNetwork)

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 3, requestSocket: socket },
			method: 'eth_chainId',
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		const rpcReply = messages.find((message) => message.method === 'eth_chainId' && message.requestId === 3)
		assert.equal(rpcReply?.error?.code, 4900)

		const watchAssetIdentifier = { requestId: 4, requestSocket: socket }
		const signerIdentity = { tabId: socket.tabId, connectionName: socket.connectionName, ownerGeneration: 1, signerProviderGeneration: 1 }
		const requestedAsset = { type: 'ERC20' as const, options: { address: 0x3030303030303030303030303030303030303030n, chainId: 1 } }
		const token = {
			type: 'ERC20' as const,
			name: 'Test Token',
			symbol: 'TEST',
			decimals: 18n,
			address: requestedAsset.options.address,
			chainId: 1n,
			entrySource: 'User' as const,
		}
		await updatePendingWatchAssetRequests(() => [{
			website,
			popupOrTabId: { type: 'popup', id: 12 },
			request: {
				interceptorRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: watchAssetIdentifier,
				method: 'wallet_watchAsset',
				params: [{ type: 'ERC20', options: { address: '0x3030303030303030303030303030303030303030', chainId: 1 } }],
			},
			requestedAsset,
			currentToken: token,
			token,
			proposedImageUrl: undefined,
			selectedImageUri: undefined,
			imageDownloadError: undefined,
			forwardToSigner: { signerName: 'MetaMask', connectionName: socket.connectionName, ownerGeneration: 1, signerProviderGeneration: 1 },
			forwardingStatus: { status: 'pending' },
		}])
		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 5, requestSocket: socket },
			method: 'signer_reply',
			params: [{
				success: true,
				signerProviderGeneration: 1,
				forwardRequest: {
					type: 'forwardToSigner',
					replyWithSignersReply: true,
					method: 'wallet_watchAsset',
					params: {
						parameters: requestedAsset,
						uniqueRequestIdentifier: { requestId: watchAssetIdentifier.requestId, requestSocket: { tabId: socket.tabId, connectionName: '0x0' } },
						signerIdentity: { ...signerIdentity, connectionName: '0x0' },
					},
					requestId: watchAssetIdentifier.requestId,
				},
				reply: true,
			}],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		assert.deepEqual((await getPendingWatchAssetRequests())[0]?.forwardingStatus, { status: 'completed', accepted: true })
	})

	test.each([
		{ websiteAccess: 'unapproved', expectedSignerChain: 1n },
		{ websiteAccess: 'denied', expectedSignerChain: 1n },
		{ websiteAccess: 'approved', expectedSignerChain: 5n },
	] as const)('uses the stored $websiteAccess website approval for signer callbacks while the active RPC network is unreadable', async ({ websiteAccess, expectedSignerChain }) => {
		installBrowserMock()
		const { getTabState, handleInterceptedRequest, updateTabState, updateWebsiteAccess, websiteSocketToString } = await loadModules()
		const websiteOrigin = `https://${ websiteAccess }-signer-callback.example`
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const socket = { tabId: 4321, connectionName: 0n }
		const { port } = createPort(socket.tabId)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		if (websiteAccess !== 'unapproved') await updateWebsiteAccess(() => [{ website, access: websiteAccess === 'approved' }])
		await updateTabState(socket.tabId, (previousState) => ({ ...previousState, signerChain: 1n }))
		await browser.storage.local.set({ activeRpcNetwork: 'corrupt' })
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })

		const originalWarn = console.warn
		console.warn = () => undefined
		try {
			await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
				interceptorRequest: true,
				interceptorInternalRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 1, requestSocket: socket },
				method: 'signer_chainChanged',
				params: ['0x5', 1],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
		} finally {
			console.warn = originalWarn
		}

		assert.equal((await getTabState(socket.tabId)).signerChain, expectedSignerChain)
	})

	test.each(['reset', 'clear'])('decides a parked chain switch from the live owner when the owner is %s before execution', async (lifecycleChange) => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, changeSimulationMode, setUseSignersAddressAsActiveAddress, updateWebsiteAccess, getChainChangeConfirmationPromise, resolveChainChange } = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x1111111111111111111111111111111111111111n
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const initialServices = createEthereumWithGetBlockCounter({ count: 0 })
		const replacementServiceState = createEthereumWithGetBlockCounter({ count: 0 }, { initialBlockPolling: false })
		const replacementNetwork = { ...initialServices.ethereum.getRpcEntry(), name: 'Replacement', chainId: 10n, httpsRpc: 'https://replacement.invalid' }
		const replacementEthereum = new Proxy(replacementServiceState.ethereum, {
			get(target, property, receiver) {
				if (property === 'getRpcEntry') return () => replacementNetwork
				if (property === 'getChainId') return () => replacementNetwork.chainId
				return Reflect.get(target, property, receiver)
			},
		})
		const replacementServices = { ethereum: replacementEthereum, tokenPriceService: replacementServiceState.tokenPriceService }
		const simulationServicesOwner = createTestSimulationServicesOwner(
			{ ethereum: initialServices.ethereum, tokenPriceService: initialServices.tokenPriceService },
			() => replacementServices,
		)
		const settingsReadStarted = createDeferredValue<void>()
		const releaseSettingsRead = createDeferredValue<void>()
		const originalGet = browser.storage.local.get.bind(browser.storage.local)
		let paused = false
		let settingsSnapshotReads = 0
		Object.defineProperty(browser.storage.local, 'get', {
			configurable: true,
			value: async (keys: string | readonly string[]) => {
				const requestedKeys = Array.isArray(keys) ? keys : [keys]
				if (requestedKeys.includes('simulationMode') && requestedKeys.includes('rpcEntries')) settingsSnapshotReads += 1
				if (!paused && settingsSnapshotReads === 2) {
					paused = true
					settingsReadStarted.resolve(undefined)
					await releaseSettingsRead.promise
				}
				return await originalGet(keys)
			},
		})
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 1, requestSocket: socket },
			method: 'wallet_switchEthereumChain',
			params: [{ chainId: '0x1' }],
		}

		const requestPromise = handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)
		await settingsReadStarted.promise
		initialServices.ethereum.setBlockPolling(false)
		if (lifecycleChange === 'reset') simulationServicesOwner.reset(replacementNetwork)
		else simulationServicesOwner.clear()
		releaseSettingsRead.resolve(undefined)
		if (lifecycleChange === 'reset') {
			// The request was admitted on chain 1, but the live owner moved to chain 10 while it was parked, so the switch back to chain 1 must ask the user instead of reporting success.
			const deadline = Date.now() + 1000
			let pendingChainChange = await getChainChangeConfirmationPromise()
			while (pendingChainChange === undefined) {
				if (Date.now() >= deadline) throw new Error('Expected the chain change dialog to open for the live chain')
				await new Promise((resolve) => setTimeout(resolve, 0))
				pendingChainChange = await getChainChangeConfirmationPromise()
			}
			await resolveChainChange(simulationServicesOwner, websiteTabConnections, {
				method: 'popup_changeChainDialog',
				data: { rpcNetwork: pendingChainChange.rpcNetwork, uniqueRequestIdentifier: request.uniqueRequestIdentifier, accept: false },
			})
		}
		await requestPromise

		const reply = messages.find((message) => message.method === request.method && message.requestId === request.uniqueRequestIdentifier.requestId)
		assert.equal(reply?.result, undefined)
		assert.equal(reply?.error?.code, lifecycleChange === 'reset' ? 4001 : 4900)
		assert.equal(initialServices.ethereum.isBlockPolling(), false)
		assert.equal(replacementEthereum.isBlockPolling(), lifecycleChange === 'reset')
	})

	test('awaits retry-state publishing before replying to a waking RPC request', async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, changeSimulationMode, setUseSignersAddressAsActiveAddress, updateWebsiteAccess, setRpcConnectionStatus, getRpcConnectionStatus } = await loadModules()
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
		const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 }, { initialBlockPolling: false })
		const rpcNetwork = ethereum.getRpcEntry()
		await setRpcConnectionStatus({
			isConnected: false,
			lastConnnectionAttempt: new Date('2024-01-01T00:00:00.000Z'),
			latestBlock: undefined,
			rpcNetwork,
			retrying: false,
		})
		const publishedRetryStates: boolean[] = []
		const publishRpcConnectionStatus: PublishRpcConnectionStatus = async (_method, rpcConnectionStatus) => {
			await new Promise((resolve) => setTimeout(resolve, 10))
			publishedRetryStates.push(rpcConnectionStatus.retrying)
			await setRpcConnectionStatus(rpcConnectionStatus)
		}
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 2, requestSocket: socket },
			method: 'eth_chainId',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, request, websiteTabConnections, publishRpcConnectionStatus)

		assert.deepEqual(publishedRetryStates, [true])
		assert.equal((await getRpcConnectionStatus())?.retrying, true)
		const chainIdReplies = messages.filter((message) => message.method === 'eth_chainId' && message.requestId === 2)
		assert.equal(chainIdReplies.at(-1)?.result, 1n)
	})

	test('does not wait for retry-state publishing before replying to eth_requestAccounts', async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, changeSimulationMode, setUseSignersAddressAsActiveAddress, updateWebsiteAccess, setRpcConnectionStatus } = await loadModules()
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
		const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 }, { initialBlockPolling: false })
		await setRpcConnectionStatus({
			isConnected: false,
			lastConnnectionAttempt: new Date('2024-01-01T00:00:00.000Z'),
			latestBlock: undefined,
			rpcNetwork: ethereum.getRpcEntry(),
			retrying: false,
		})
		let publishCalls = 0
		const publishRpcConnectionStatus: PublishRpcConnectionStatus = async () => {
			publishCalls += 1
			await new Promise(() => undefined)
		}
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 15, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, request, websiteTabConnections, publishRpcConnectionStatus)

		assert.equal(publishCalls, 0)
		const requestAccountsReplies = messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 15)
		assert.deepEqual(requestAccountsReplies.at(-1)?.result, ['0x1111111111111111111111111111111111111111'])
	})

	test('refresh signer accounts for approved eth_accounts requests when the tab cache is empty', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			sendInternalWindowMessage,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			updateTabState,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x2222222222222222222222222222222222222222n
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId, (message) => {
			if (message.method !== 'request_signer_to_eth_accounts') return
			void (async () => {
				await updateTabState(socket.tabId, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: account }))
				sendInternalWindowMessage({
					method: 'window_signer_accounts_changed',
					data: { socket, signerStateOwnerGeneration: 1, signerProviderGeneration: 1 },
				})
			})()
		})
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 7, requestSocket: socket },
			method: 'eth_accounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(messages.filter((message) => message.method === 'request_signer_to_eth_accounts').length, 1)
		assert.equal(messages.some((message) => message.method === 'request_signer_to_eth_requestAccounts'), false)
		const ethAccountsReplies = messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 7)
		assert.deepEqual(ethAccountsReplies.at(-1)?.result, ['0x2222222222222222222222222222222222222222'])
	})

	test('refreshes an approved signer account before forwarding wallet_getCapabilities', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			sendInternalWindowMessage,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			updateTabState,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x2323232323232323232323232323232323232323n
		const accountString = '0x2323232323232323232323232323232323232323'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId, (message) => {
			if (message.method !== 'request_signer_to_eth_accounts') return
			void (async () => {
				await updateTabState(socket.tabId, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: account }))
				sendInternalWindowMessage({
					method: 'window_signer_accounts_changed',
					data: { socket, signerStateOwnerGeneration: 1, signerProviderGeneration: 1 },
				})
			})()
		})
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 8, requestSocket: socket },
			method: 'wallet_getCapabilities',
			params: [accountString, ['0x2105']],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(messages.filter((message) => message.method === 'request_signer_to_eth_accounts').length, 1)
		assert.deepEqual(messages.find((message) => message.method === 'wallet_getCapabilities'), {
			interceptorApproved: true,
			requestId: 8,
			type: 'forwardToSigner',
			replyWithSignersReply: true,
			method: 'wallet_getCapabilities',
			params: [accountString, ['0x2105']],
		})
	})

	test('routes one tab-wide signer refresh while serializing passive and interactive discovery', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			refreshSignerAccountsFromApprovedWebsitePorts,
			sendCallbackToConfirmedSignerOwner,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x2323232323232323232323232323232323232323n
		const accountString = '0x2323232323232323232323232323232323232323'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		const childSocket = { tabId: 1, connectionName: 1n }
		const { port, messages } = createPort(socket.tabId)
		const { port: childPort, messages: childMessages } = createPort(childSocket.tabId, undefined, 2, childSocket.connectionName)
		const connectionKey = websiteSocketToString(socket)
		const childConnectionKey = websiteSocketToString(childSocket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
			[childConnectionKey]: { port: childPort, socket: childSocket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const replyWithSignerAccounts = async (requestId: number, requestAccounts: boolean, accounts: readonly string[]) => {
			await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
				interceptorRequest: true,
				interceptorInternalRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId, requestSocket: socket },
				method: 'eth_accounts_reply',
				params: [{ signerProviderGeneration: 1, type: 'success', accounts, requestAccounts }],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
		}

		const passiveRequest = refreshSignerAccountsFromApprovedWebsitePorts(websiteTabConnections, false)
		await waitForPortMessageCount(messages, 'request_signer_to_eth_accounts', 1)

		const interactiveRequest = handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 71, requestSocket: socket },
			method: 'eth_requestAccounts',
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		await new Promise((resolve) => setTimeout(resolve, 0))
		const interactiveRequestsBeforePassiveReply = messages.filter((message) => message.method === 'request_signer_to_eth_requestAccounts').length

		await replyWithSignerAccounts(90, false, [])
		await waitForPortMessageCount(messages, 'request_signer_to_eth_requestAccounts', 1)
		await replyWithSignerAccounts(91, true, [accountString])
		await Promise.all([passiveRequest, interactiveRequest])

		assert.equal(interactiveRequestsBeforePassiveReply, 0)
		assert.equal(childMessages.some((message) => message.method === 'request_signer_to_eth_accounts' || message.method === 'request_signer_to_eth_requestAccounts'), false)
		assert.deepEqual(messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 71).at(-1)?.result, [accountString])
		const signerStateToken = sendCallbackToConfirmedSignerOwner(websiteTabConnections, socket.tabId, { method: 'request_signer_to_wallet_switchEthereumChain', result: 2n, walletSwitchRequestId: 'test-switch' })
		assert.notEqual(signerStateToken, false)
		if (signerStateToken === false) throw new Error('Expected a confirmed signer owner')
		assert.equal(signerStateToken.port, port)
		assert.equal(messages.filter((message) => message.method === 'request_signer_to_wallet_switchEthereumChain').length, 1)
		assert.equal(childMessages.some((message) => message.method === 'request_signer_to_wallet_switchEthereumChain'), false)
	})

	test('uses an unapproved signer owner for tab-wide refresh when a sibling frame is approved', async () => {
		installBrowserMock()
		const {
			changeSimulationMode,
			handleInterceptedRequest,
			refreshSignerAccountsFromApprovedWebsitePorts,
			sendCallbackToConfirmedSignerOwner,
			setUseSignersAddressAsActiveAddress,
			websiteSocketToString,
			getTabState,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const socket = { tabId: 1, connectionName: 0n }
		const childSocket = { tabId: 1, connectionName: 1n }
		const { port, messages } = createPort(socket.tabId)
		const { port: childPort, messages: childMessages } = createPort(childSocket.tabId, undefined, 2, childSocket.connectionName)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: false, wantsToConnect: false },
			[websiteSocketToString(childSocket)]: { port: childPort, socket: childSocket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const account = '0x2424242424242424242424242424242424242424'
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)

		const refresh = refreshSignerAccountsFromApprovedWebsitePorts(websiteTabConnections, false)
		await waitForPortMessageCount(messages, 'request_signer_to_eth_accounts', 1)
		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 92, requestSocket: socket },
			method: 'eth_accounts_reply',
			params: [{ signerProviderGeneration: 1, type: 'success', accounts: [account], requestAccounts: false }],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		await refresh

		assert.deepEqual((await getTabState(socket.tabId)).signerAccounts, [0x2424242424242424242424242424242424242424n])
		assert.equal(childMessages.some((message) => message.method === 'request_signer_to_eth_accounts'), false)
		const signerStateToken = sendCallbackToConfirmedSignerOwner(websiteTabConnections, socket.tabId, { method: 'request_signer_to_wallet_switchEthereumChain', result: 2n, walletSwitchRequestId: 'test-switch' })
		assert.notEqual(signerStateToken, false)
		assert.equal(messages.filter((message) => message.method === 'request_signer_to_wallet_switchEthereumChain').length, 1)
		assert.equal(childMessages.some((message) => message.method === 'request_signer_to_wallet_switchEthereumChain'), false)
		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 94, requestSocket: socket },
			method: 'signer_chainChanged',
			params: ['0x2', 1],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		assert.equal((await getTabState(socket.tabId)).signerChain, 2n)
	})

	test('does not send a callback when a recreated connection reuses the expected generations', async () => {
		installBrowserMock()
		const { sendCallbackToExpectedConfirmedSignerOwner, websiteSocketToString } = await loadModules()
		const expectedSocket = { tabId: 1, connectionName: 0n }
		const currentSocket = { tabId: 1, connectionName: 1n }
		const { port: currentPort, messages: currentSignerMessages } = createPort(currentSocket.tabId, undefined, undefined, currentSocket.connectionName)
		const websiteTabConnections = new Map([[currentSocket.tabId, {
			signerStateOwner: { connectionName: currentSocket.connectionName, confirmed: true, generation: 1, providerGeneration: 1 },
			connections: {
				[websiteSocketToString(currentSocket)]: { port: currentPort, socket: currentSocket, websiteOrigin: 'https://example.test', approved: true, wantsToConnect: true },
			},
		}]])

		const result = sendCallbackToExpectedConfirmedSignerOwner(websiteTabConnections, {
			tabId: expectedSocket.tabId,
			connectionName: expectedSocket.connectionName,
			ownerGeneration: 1,
			signerProviderGeneration: 1,
		}, { method: 'request_signer_to_wallet_switchEthereumChain', result: 2n, walletSwitchRequestId: 'test-switch' })

		assert.equal(result, false)
		assert.equal(currentSignerMessages.length, 0)
	})

	test('settles a pending chain switch when its exact signer owner disconnects', async () => {
		installBrowserMock()
		const {
			changeSimulationMode,
			removeWebsiteTabConnection,
			resolveChainChange,
			setChainChangeConfirmationPromise,
			websiteSocketToString,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const ownerSocket = { tabId: 1, connectionName: 0n }
		const requestSocket = { tabId: 1, connectionName: 1n }
		const { port: ownerPort, messages: ownerMessages } = createPort(ownerSocket.tabId)
		const { port: requestPort, messages: requestMessages } = createPort(requestSocket.tabId, undefined, 2, requestSocket.connectionName)
		const websiteTabConnections = new Map([[ownerSocket.tabId, { ...confirmedSignerOwnership(ownerSocket), connections: {
			[websiteSocketToString(ownerSocket)]: { port: ownerPort, socket: ownerSocket, websiteOrigin, approved: false, wantsToConnect: false },
			[websiteSocketToString(requestSocket)]: { port: requestPort, socket: requestSocket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const currentRpcNetwork = {
			name: 'Current RPC',
			chainId: 1n,
			httpsRpc: 'https://current.example',
			currencyName: 'Ether',
			currencyTicker: 'ETH',
			primary: true,
			minimized: false,
		}
		const requestedRpcNetwork = {
			name: 'Requested RPC',
			chainId: 2n,
			httpsRpc: 'https://requested.example',
			currencyName: 'Ether',
			currencyTicker: 'ETH',
			primary: true,
			minimized: false,
		}
		const uniqueRequestIdentifier = { requestId: 93, requestSocket }
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier,
			method: 'wallet_switchEthereumChain' as const,
			params: [{ chainId: requestedRpcNetwork.chainId }],
		}
		await changeSimulationMode({ simulationMode: false, rpcNetwork: currentRpcNetwork, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setChainChangeConfirmationPromise({
			website,
			popupOrTabId: { type: 'popup', id: 9 },
			request,
			rpcNetwork: requestedRpcNetwork,
			simulationMode: false,
		})
		const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const resolution = resolveChainChange(simulationServicesOwner, websiteTabConnections, {
			method: 'popup_changeChainDialog',
			data: { rpcNetwork: requestedRpcNetwork, uniqueRequestIdentifier, accept: true },
		})
		await waitForPortMessageCount(ownerMessages, 'request_signer_to_wallet_switchEthereumChain', 1)

		await removeWebsiteTabConnection(websiteTabConnections, ownerSocket, ownerPort)
		await resolution

		const reply = requestMessages.find((message) => message.method === 'wallet_switchEthereumChain' && message.requestId === uniqueRequestIdentifier.requestId)
		assert.equal(reply?.error?.code, 4900)
		assert.equal(reply?.error?.message, 'Signer connection changed before the previous wallet replied.')
	})

	test('accepts the exact solicited chain reply after the approving sibling disconnects', async () => {
		installBrowserMock()
		const {
			changeSimulationMode,
			handleInterceptedRequest,
			removeWebsiteTabConnection,
			resolveChainChange,
			setChainChangeConfirmationPromise,
			websiteSocketToString,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const ownerSocket = { tabId: 1, connectionName: 0n }
		const approvingSocket = { tabId: 1, connectionName: 1n }
		const requestSocket = { tabId: 1, connectionName: 2n }
		const { port: ownerPort, messages: ownerMessages } = createPort(ownerSocket.tabId)
		const { port: approvingPort } = createPort(approvingSocket.tabId, undefined, 2, approvingSocket.connectionName)
		const { port: requestPort, messages: requestMessages } = createPort(requestSocket.tabId, undefined, 3, requestSocket.connectionName)
		const websiteTabConnections = new Map([[ownerSocket.tabId, { ...confirmedSignerOwnership(ownerSocket), connections: {
			[websiteSocketToString(ownerSocket)]: { port: ownerPort, socket: ownerSocket, websiteOrigin, approved: false, wantsToConnect: false },
			[websiteSocketToString(approvingSocket)]: { port: approvingPort, socket: approvingSocket, websiteOrigin, approved: true, wantsToConnect: true },
			[websiteSocketToString(requestSocket)]: { port: requestPort, socket: requestSocket, websiteOrigin, approved: false, wantsToConnect: false },
		} }]])
		const currentRpcNetwork = {
			name: 'Current RPC',
			chainId: 1n,
			httpsRpc: 'https://current.example',
			currencyName: 'Ether',
			currencyTicker: 'ETH',
			primary: true,
			minimized: false,
		}
		const requestedRpcNetwork = {
			name: 'Sepolia',
			chainId: 11155111n,
			httpsRpc: 'https://sepolia.example',
			currencyName: 'Sepolia Testnet ETH',
			currencyTicker: 'SEETH',
			primary: true,
			minimized: false,
		}
		const uniqueRequestIdentifier = { requestId: 95, requestSocket }
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier,
			method: 'wallet_switchEthereumChain' as const,
			params: [{ chainId: requestedRpcNetwork.chainId }],
		}
		await changeSimulationMode({ simulationMode: false, rpcNetwork: currentRpcNetwork, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setChainChangeConfirmationPromise({
			website,
			popupOrTabId: { type: 'popup', id: 10 },
			request,
			rpcNetwork: requestedRpcNetwork,
			simulationMode: false,
		})
		const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const resolution = resolveChainChange(simulationServicesOwner, websiteTabConnections, {
			method: 'popup_changeChainDialog',
			data: { rpcNetwork: requestedRpcNetwork, uniqueRequestIdentifier, accept: true },
		})
		await waitForPortMessageCount(ownerMessages, 'request_signer_to_wallet_switchEthereumChain', 1)
		await new Promise((resolve) => setTimeout(resolve, 0))

		await removeWebsiteTabConnection(websiteTabConnections, approvingSocket, approvingPort)
		await handleInterceptedRequest(ownerPort, websiteOrigin, website, simulationServicesOwner, ownerSocket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 96, requestSocket: ownerSocket },
			method: 'wallet_switchEthereumChain_reply',
			params: [{ accept: true, chainId: '0xaa36a7', signerProviderGeneration: 1, walletSwitchRequestId: getWalletSwitchRequestId(ownerMessages) }],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		await Promise.race([
			resolution,
			new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Solicited chain reply did not settle')), 100)),
		])

		const reply = requestMessages.find((message) => message.method === 'wallet_switchEthereumChain' && message.requestId === uniqueRequestIdentifier.requestId)
		assert.equal(reply?.result, null)
	})

	test('rejects a conflicting popup switch and ignores another tab reply while a dapp switch is pending', async () => {
		installBrowserMock()
		const {
			changeSimulationMode,
			getRequiredSettings,
			handleInterceptedRequest,
			popupChangeActiveRpc,
			resolveChainChange,
			saveCurrentTabId,
			setChainChangeConfirmationPromise,
			websiteSocketToString,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const requestSocket = { tabId: 1, connectionName: 0n }
		const popupSocket = { tabId: 2, connectionName: 0n }
		const { port: requestPort, messages: requestMessages } = createPort(requestSocket.tabId)
		const { port: popupPort, messages: popupMessages } = createPort(popupSocket.tabId)
		const websiteTabConnections = new Map([
			[requestSocket.tabId, { ...confirmedSignerOwnership(requestSocket), connections: {
				[websiteSocketToString(requestSocket)]: { port: requestPort, socket: requestSocket, websiteOrigin, approved: true, wantsToConnect: true },
			} }],
			[popupSocket.tabId, { ...confirmedSignerOwnership(popupSocket), connections: {
				[websiteSocketToString(popupSocket)]: { port: popupPort, socket: popupSocket, websiteOrigin, approved: true, wantsToConnect: true },
			} }],
		])
		const currentRpcNetwork = {
			name: 'Current RPC',
			chainId: 1n,
			httpsRpc: 'https://current.example',
			currencyName: 'Ether',
			currencyTicker: 'ETH',
			primary: true,
			minimized: false,
		}
		const requestedRpcNetwork = {
			name: 'Sepolia',
			chainId: 11155111n,
			httpsRpc: 'https://sepolia.example',
			currencyName: 'Sepolia Testnet ETH',
			currencyTicker: 'SEETH',
			primary: true,
			minimized: false,
		}
		const popupRpcNetwork = {
			name: 'Holesky',
			chainId: 17000n,
			httpsRpc: 'https://holesky.example',
			currencyName: 'Holesky Testnet ETH',
			currencyTicker: 'HOETH',
			primary: true,
			minimized: false,
		}
		const uniqueRequestIdentifier = { requestId: 97, requestSocket }
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier,
			method: 'wallet_switchEthereumChain' as const,
			params: [{ chainId: requestedRpcNetwork.chainId }],
		}
		await changeSimulationMode({ simulationMode: false, rpcNetwork: currentRpcNetwork, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setChainChangeConfirmationPromise({
			website,
			popupOrTabId: { type: 'popup', id: 11 },
			request,
			rpcNetwork: requestedRpcNetwork,
			simulationMode: false,
		})
		const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		let requestSettled = false
		const resolution = resolveChainChange(simulationServicesOwner, websiteTabConnections, {
			method: 'popup_changeChainDialog',
			data: { rpcNetwork: requestedRpcNetwork, uniqueRequestIdentifier, accept: true },
		}).then(() => { requestSettled = true })
		await waitForPortMessageCount(requestMessages, 'request_signer_to_wallet_switchEthereumChain', 1)
		await new Promise((resolve) => setTimeout(resolve, 0))

		await saveCurrentTabId(popupSocket.tabId)
		const popupReply = await popupChangeActiveRpc(simulationServicesOwner, websiteTabConnections, {
			method: 'popup_changeActiveRpc',
			data: popupRpcNetwork,
		})
		assert.deepEqual(popupReply, { type: 'PopupSettingsChangeReply', ok: false, message: 'A network switch is already waiting for your wallet.' })
		assert.equal(popupMessages.some((message) => message.method === 'request_signer_to_wallet_switchEthereumChain'), false)
		await handleInterceptedRequest(popupPort, websiteOrigin, website, simulationServicesOwner, popupSocket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 98, requestSocket: popupSocket },
			method: 'wallet_switchEthereumChain_reply',
			params: [{ accept: false, chainId: '0x4268', error: { code: 4001, message: 'Popup tab rejected' }, walletSwitchRequestId: getWalletSwitchRequestId(requestMessages), signerProviderGeneration: 1 }],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		await new Promise((resolve) => setTimeout(resolve, 0))
		assert.equal(requestSettled, false)

		await handleInterceptedRequest(requestPort, websiteOrigin, website, simulationServicesOwner, requestSocket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 99, requestSocket },
			method: 'wallet_switchEthereumChain_reply',
			params: [{ accept: false, chainId: '0xaa36a7', error: { code: 4001, message: 'Dapp tab rejected' }, walletSwitchRequestId: getWalletSwitchRequestId(requestMessages), signerProviderGeneration: 1 }],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		await resolution

		const reply = requestMessages.find((message) => message.method === 'wallet_switchEthereumChain' && message.requestId === uniqueRequestIdentifier.requestId)
		assert.equal(reply?.error?.code, 4001)
		assert.equal(reply?.error?.message, 'Dapp tab rejected')
	})

	test('keeps the production chain dialog guarded while signer resolution starts', async () => {
		const { waitForDeferredChainChangeRemoval, releaseDeferredChainChangeRemoval } = installBrowserMock({ deferFirstChainChangeRemoval: true })
		const {
			changeSimulationMode,
			getChainChangeConfirmationPromise,
			handleInterceptedRequest,
			openChangeChainDialog,
			resolveChainChange,
			websiteSocketToString,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const currentRpcNetwork = {
			name: 'Current RPC',
			chainId: 1n,
			httpsRpc: 'https://current.example',
			currencyName: 'Ether',
			currencyTicker: 'ETH',
			primary: true,
			minimized: false,
		}
		const requestedRpcNetwork = {
			name: 'Sepolia',
			chainId: 11155111n,
			httpsRpc: 'https://sepolia.example',
			currencyName: 'Sepolia Testnet ETH',
			currencyTicker: 'SEETH',
			primary: true,
			minimized: false,
		}
		const secondRpcNetwork = {
			name: 'Holesky',
			chainId: 17000n,
			httpsRpc: 'https://holesky.example',
			currencyName: 'Holesky Testnet ETH',
			currencyTicker: 'HOETH',
			primary: true,
			minimized: false,
		}
		const firstUniqueRequestIdentifier = { requestId: 100, requestSocket: socket }
		const firstRequest = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: firstUniqueRequestIdentifier,
			method: 'wallet_switchEthereumChain' as const,
			params: [{ chainId: requestedRpcNetwork.chainId }],
		}
		const secondUniqueRequestIdentifier = { requestId: 101, requestSocket: socket }
		const secondRequest = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: secondUniqueRequestIdentifier,
			method: 'wallet_switchEthereumChain' as const,
			params: [{ chainId: secondRpcNetwork.chainId }],
		}
		await changeSimulationMode({ simulationMode: false, rpcNetwork: currentRpcNetwork, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const firstResolution = openChangeChainDialog(
			simulationServicesOwner,
			websiteTabConnections,
			firstRequest,
			false,
			website,
			{ method: 'wallet_switchEthereumChain', params: [{ chainId: requestedRpcNetwork.chainId }] },
		)
		const pendingDeadline = Date.now() + 100
		let pendingChainChange = await getChainChangeConfirmationPromise()
		while (pendingChainChange === undefined && Date.now() < pendingDeadline) {
			await new Promise((resolve) => setTimeout(resolve, 0))
			pendingChainChange = await getChainChangeConfirmationPromise()
		}
		if (pendingChainChange === undefined) throw new Error('Missing production chain-change dialog state')
		await resolveChainChange(simulationServicesOwner, websiteTabConnections, {
			method: 'popup_changeChainDialog',
			data: { rpcNetwork: requestedRpcNetwork, uniqueRequestIdentifier: firstUniqueRequestIdentifier, accept: true },
		})
		await Promise.race([
			waitForDeferredChainChangeRemoval(),
			new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Chain resolution did not start')), 100)),
		])
		await new Promise((resolve) => setTimeout(resolve, 0))

		const secondResolution = await Promise.race([
			openChangeChainDialog(
				simulationServicesOwner,
				websiteTabConnections,
				secondRequest,
				false,
				website,
				{ method: 'wallet_switchEthereumChain', params: [{ chainId: secondRpcNetwork.chainId }] },
			),
			new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Second chain dialog was not rejected')), 100)),
		])
		assert.equal(secondResolution.error?.code, 4001)

		releaseDeferredChainChangeRemoval()
		await waitForPortMessageCount(messages, 'request_signer_to_wallet_switchEthereumChain', 1)
		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 102, requestSocket: socket },
			method: 'wallet_switchEthereumChain_reply',
			params: [{ accept: false, chainId: '0xaa36a7', error: { code: 4001, message: 'First signer rejected' }, walletSwitchRequestId: getWalletSwitchRequestId(messages), signerProviderGeneration: 1 }],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		const firstResult = await Promise.race([
			firstResolution,
			new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('First production chain dialog did not settle')), 100)),
		])
		assert.equal(firstResult.error?.message, 'First signer rejected')
	})

	test('resolves approved eth_requestAccounts after signer account state is refreshed', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			getTabState,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x4444444444444444444444444444444444444444n
		const accountString = '0x4444444444444444444444444444444444444444'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		const siblingSocket = { tabId: 1, connectionName: 1n }
		const stateAtDappReply: Array<bigint | undefined> = []
		const { port: createdPort, messages } = createPort(socket.tabId, (message) => {
			if (message.method === 'request_signer_to_eth_requestAccounts') {
				void handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
					interceptorRequest: true,
					interceptorInternalRequest: true,
					usingInterceptorWithoutSigner: false,
					uniqueRequestIdentifier: { requestId: 99, requestSocket: socket },
					method: 'eth_accounts_reply',
					params: [{ signerProviderGeneration: 1, type: 'success', accounts: [accountString], requestAccounts: true }],
				}, websiteTabConnections, noopPublishRpcConnectionStatus)
			}
			if (message.method === 'eth_accounts' && message.requestId === 9) {
				void getTabState(socket.tabId).then((tabState) => {
					stateAtDappReply.push(tabState.activeSigningAddress)
				})
			}
		})
		const port = createdPort
		const { port: siblingPort, messages: siblingMessages } = createPort(siblingSocket.tabId, undefined, undefined, siblingSocket.connectionName)
		const connectionKey = websiteSocketToString(socket)
		const siblingConnectionKey = websiteSocketToString(siblingSocket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
			[siblingConnectionKey]: { port: siblingPort, socket: siblingSocket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 9, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(messages.filter((message) => message.method === 'request_signer_to_eth_requestAccounts').length, 1)
		await new Promise((resolve) => setTimeout(resolve, 0))
		assert.deepEqual((await getTabState(socket.tabId)).signerAccounts, [account])
		assert.deepEqual(stateAtDappReply, [account])
		const requestAccountsReplies = messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 9)
		assert.deepEqual(requestAccountsReplies.at(-1)?.result, ['0x4444444444444444444444444444444444444444'])
		const requestAccountsReplyIndex = messages.findIndex((message) => message.method === 'eth_accounts' && message.requestId === 9)
		const accountChangedMessages = messages.filter((message) => message.method === 'accountsChanged')
		const accountChangedIndex = messages.findIndex((message) => message.method === 'accountsChanged')
		assert.notEqual(requestAccountsReplyIndex, -1)
		assert.notEqual(accountChangedIndex, -1)
		assert.equal(accountChangedIndex < requestAccountsReplyIndex, true)
		assert.equal(messages.some((message) => message.method === 'connect'), false)
		assert.deepEqual(accountChangedMessages.map((message) => message.result), [[accountString]])
		assert.deepEqual(accountChangedMessages.map((message) => message.requestId), [9])
		const siblingAccountChangedMessages = siblingMessages.filter((message) => message.method === 'accountsChanged')
		assert.deepEqual(siblingAccountChangedMessages.map((message) => message.result), [[accountString]])
		assert.deepEqual(siblingAccountChangedMessages.map((message) => message.requestId), [undefined])
	})

	test('suppresses unscoped connect events for requester during signer refresh with page-level access', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			updateUserAddressBookEntries,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x4545454545454545454545454545454545454545n
		const accountString = '0x4545454545454545454545454545454545454545'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateUserAddressBookEntries(() => [{
			type: 'contact',
			name: 'signer account',
			address: account,
			entrySource: 'User',
			useAsActiveAddress: true,
			askForAddressAccess: false,
		}])
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		const siblingSocket = { tabId: 1, connectionName: 1n }
		const { port: createdPort, messages } = createPort(socket.tabId, (message) => {
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
		const port = createdPort
		const { port: siblingPort, messages: siblingMessages } = createPort(siblingSocket.tabId, undefined, undefined, siblingSocket.connectionName)
		const connectionKey = websiteSocketToString(socket)
		const siblingConnectionKey = websiteSocketToString(siblingSocket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
			[siblingConnectionKey]: { port: siblingPort, socket: siblingSocket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 17, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(messages.some((message) => message.method === 'connect'), false)
		assert.deepEqual(messages.filter((message) => message.method === 'accountsChanged').map((message) => message.requestId), [17])
		assert.deepEqual(messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 17).map((message) => message.result), [[accountString]])
		assert.deepEqual(messages.filter((message) => message.method !== 'eth_accounts_reply').map((message) => message.method), ['request_signer_to_eth_requestAccounts', 'accountsChanged', 'eth_accounts'])
		assert.deepEqual(siblingMessages.filter((message) => message.method === 'accountsChanged').map((message) => message.requestId), [undefined])
		assert.deepEqual(siblingMessages.filter((message) => message.method === 'accountsChanged').map((message) => message.result), [[accountString]])
	})

	for (const manifestVersion of [2, 3] as const) {
		test(`replays only accountsChanged before wallet_requestPermissions resolves for manifest v${ manifestVersion }`, async () => {
			const browserMock = installBrowserMock({ manifestVersion })
			const {
				handleInterceptedRequest,
				websiteSocketToString,
				changeSimulationMode,
				setUseSignersAddressAsActiveAddress,
				updateWebsiteAccess,
				updateDeclarativeNetRequestBlocks,
			} = await loadModules()
			const websiteOrigin = `https://manifest-v${ manifestVersion }.example.test`
			const website = { websiteOrigin, icon: undefined, title: undefined }
			const account = 0x4646464646464646464646464646464646464646n
			const accountString = '0x4646464646464646464646464646464646464646'
			await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
			await setUseSignersAddressAsActiveAddress(false)
			await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }], declarativeNetRequestBlockMode: 'block-all' }])

			const socket = { tabId: 1, connectionName: 0n }
			const { port: createdPort, messages } = createPort(socket.tabId, (message) => {
				if (message.method !== 'request_signer_to_eth_requestAccounts') return
				void handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
					interceptorRequest: true,
					interceptorInternalRequest: true,
					usingInterceptorWithoutSigner: false,
					uniqueRequestIdentifier: { requestId: 104, requestSocket: socket },
					method: 'eth_accounts_reply',
					params: [{ signerProviderGeneration: 1, type: 'success', accounts: [accountString], requestAccounts: true }],
				}, websiteTabConnections, noopPublishRpcConnectionStatus)
			})
			const port = createdPort
			const connectionKey = websiteSocketToString(socket)
			const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
				[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
			} }]])
			await updateDeclarativeNetRequestBlocks(websiteTabConnections)
			const { ethereum, tokenPriceService, simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
			const request = {
				interceptorRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 19, requestSocket: socket },
				method: 'wallet_requestPermissions',
				params: [{ eth_accounts: {} }],
			}

			await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

			const permissionResult = [{
				parentCapability: 'eth_accounts',
				caveats: [{
					type: 'restrictReturnedAccounts',
					value: [accountString],
				}],
				invoker: websiteOrigin,
			}]
			assert.equal(messages.some((message) => message.method === 'connect'), false)
			assert.deepEqual(messages.filter((message) => message.method === 'accountsChanged').map((message) => message.requestId), [19])
			assert.deepEqual(messages.filter((message) => message.method === 'wallet_requestPermissions' && message.requestId === 19).map((message) => message.result), [permissionResult])
			assert.deepEqual(messages.filter((message) => message.method !== 'eth_accounts_reply').map((message) => message.method), ['request_signer_to_eth_requestAccounts', 'accountsChanged', 'wallet_requestPermissions'])
			assert.equal(browserMock.readStoredValue('latestUnexpectedError'), undefined)
			assert.equal(browserMock.requestBlockingCalls.webRequestListenerAdds > 0, manifestVersion === 2)
			assert.equal(browserMock.requestBlockingCalls.webRequestListenerRemovals > 0, manifestVersion === 2)
			assert.equal(browserMock.requestBlockingCalls.declarativeNetRequestUpdates > 0, manifestVersion === 3)
		})
	}

})
