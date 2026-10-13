import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import type { WebsiteTabConnections } from '../../app/ts/types/user-interface-types.js'
import { flushMicrotasks } from '../harness/async.js'
import { confirmedSignerOwnership, createEthereumWithGetBlockCounter, createPort, createRestoringBrowserMockInstaller, loadModules, noopPublishRpcConnectionStatus, waitForInternalWindowMessageDelivery } from './backgroundEthAccountsTestHarness.js'

const installBrowserMock = createRestoringBrowserMockInstaller()

describe('background signer account discovery and page ownership', () => {
	test('normalizes signer state before access and keeps unavailable discovery out of provider warnings', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			updateWebsiteAccess,
			updateTabState,
			getTabState,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const staleAccount = 0x4444444444444444444444444444444444444444n
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: staleAccount })
		await setUseSignersAddressAsActiveAddress(false)

		const socket = { tabId: 1, connectionName: 0n }
		const childSocket = { tabId: 1, connectionName: 1n }
		await updateTabState(socket.tabId, (previousState) => ({
			...previousState,
			signerName: 'MetaMask',
			signerConnected: true,
			signerAccounts: [staleAccount],
			signerChain: 1n,
			signerAccountError: { code: 4001, message: 'Stale signer error' },
			activeSigningAddress: staleAccount,
		}))
		const { port, messages } = createPort(socket.tabId, undefined, 0)
		const { port: childPort, messages: childMessages } = createPort(childSocket.tabId, undefined, 1)
		const connectionKey = websiteSocketToString(socket)
		const childConnectionKey = websiteSocketToString(childSocket)
		const connection = { port, socket, websiteOrigin, approved: false, wantsToConnect: true }
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: connection,
			[childConnectionKey]: { port: childPort, socket: childSocket, websiteOrigin, approved: false, wantsToConnect: false },
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: true,
			uniqueRequestIdentifier: { requestId: 90, requestSocket: socket },
			method: 'connected_to_signer',
			params: [false, 'NoSigner', 2],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		const noSignerState = await getTabState(socket.tabId)
		assert.equal(noSignerState.signerName, 'NoSigner')
		assert.equal(noSignerState.signerConnected, false)
		assert.deepEqual(noSignerState.signerAccounts, [])
		assert.equal(noSignerState.signerChain, undefined)
		assert.equal(noSignerState.signerAccountError, undefined)
		assert.equal(noSignerState.activeSigningAddress, undefined)
		assert.equal(messages.some((message) => message.method === 'request_signer_chainId'), false)

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: true,
			uniqueRequestIdentifier: { requestId: 91, requestSocket: socket },
			method: 'eth_accounts_reply',
			params: [{
				signerProviderGeneration: 2,
				type: 'error',
				requestAccounts: false,
				signerUnavailable: true,
				error: { code: 4900, message: 'No signer wallet is available to this page. Enable your wallet extension for this site, then try again.' },
			}],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		assert.equal((await getTabState(socket.tabId)).signerAccountError, undefined)

		// Signer identity is trusted extension state and must be current before the website receives access.
		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 92, requestSocket: socket },
			method: 'connected_to_signer',
			params: [true, 'MetaMask', 3],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		const identifiedSignerState = await getTabState(socket.tabId)
		assert.equal(identifiedSignerState.signerName, 'MetaMask')
		assert.equal(identifiedSignerState.signerConnected, true)
		assert.equal(messages.some((message) => message.method === 'request_signer_chainId'), false)

		await handleInterceptedRequest(childPort, websiteOrigin, website, simulationServicesOwner, childSocket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: true,
			uniqueRequestIdentifier: { requestId: 94, requestSocket: childSocket },
			method: 'connected_to_signer',
			params: [false, 'NoSigner', 4],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		const stateAfterChildFrame = await getTabState(socket.tabId)
		assert.equal(stateAfterChildFrame.signerName, 'MetaMask')
		assert.equal(stateAfterChildFrame.signerConnected, true)
		assert.equal(childMessages.some((message) => message.method === 'request_signer_chainId'), false)

		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])
		connection.approved = true
		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 93, requestSocket: socket },
			method: 'eth_accounts_reply',
			params: [{ signerProviderGeneration: 3, type: 'error', requestAccounts: false, error: { code: 4900, message: 'MetaMask disconnected' } }],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		const signerErrorState = await getTabState(socket.tabId)
		assert.equal(signerErrorState.signerName, 'MetaMask')
		assert.equal(signerErrorState.signerConnected, true)
		assert.deepEqual(signerErrorState.signerAccountError, { code: 4900, message: 'MetaMask disconnected' })
	})

	test('refreshes accounts after signer identity or page ownership changes', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			updateWebsiteAccess,
			updateTabState,
			getTabState,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			createInternalMessageListener,
			INTERNAL_CHANNEL_NAME,
			registerWebsiteConnectionAndProvisionallyClaimSignerState,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const braveAccount = 0x4141414141414141414141414141414141414141n
		const metaMaskAccount = 0x4242424242424242424242424242424242424242n
		const metaMaskAccountString = '0x4242424242424242424242424242424242424242'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: braveAccount })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: metaMaskAccount, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		const signerAccountSnapshots: bigint[][] = []
		const { port: createdPort, messages } = createPort(socket.tabId, (message) => {
			if (message.method !== 'request_signer_to_eth_requestAccounts') return
			void (async () => {
				signerAccountSnapshots.push([...(await getTabState(socket.tabId)).signerAccounts])
				await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
					interceptorRequest: true,
					interceptorInternalRequest: true,
					usingInterceptorWithoutSigner: false,
					uniqueRequestIdentifier: { requestId: 202, requestSocket: socket },
					method: 'eth_accounts_reply',
					params: [{ signerProviderGeneration: 2, type: 'success', accounts: [metaMaskAccountString], requestAccounts: true }],
				}, websiteTabConnections, noopPublishRpcConnectionStatus)
			})()
		}, 0)
		const port = createdPort
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		await updateTabState(socket.tabId, (previousState) => ({
			...previousState,
			signerName: 'Brave',
			signerConnected: true,
			signerAccounts: [braveAccount],
			signerChain: 1n,
			signerAccountError: { code: 4001, message: 'Stale Brave error' },
			activeSigningAddress: braveAccount,
		}))

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 200, requestSocket: socket },
			method: 'connected_to_signer',
			params: [true, 'MetaMask', 2],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		const stateAfterMetaMaskSelection = await getTabState(socket.tabId)
		assert.equal(stateAfterMetaMaskSelection.signerName, 'MetaMask')
		assert.equal(stateAfterMetaMaskSelection.signerConnected, true)
		assert.deepEqual(stateAfterMetaMaskSelection.signerAccounts, [])
		assert.equal(stateAfterMetaMaskSelection.signerChain, undefined)
		assert.equal(stateAfterMetaMaskSelection.signerAccountError, undefined)
		assert.equal(stateAfterMetaMaskSelection.activeSigningAddress, undefined)

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 201, requestSocket: socket },
			method: 'eth_requestAccounts',
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.deepEqual(signerAccountSnapshots, [[]])
		assert.equal(messages.filter((message) => message.method === 'request_signer_to_eth_requestAccounts').length, 1)
		assert.deepEqual(messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 201).at(-1)?.result, [metaMaskAccountString])
		assert.deepEqual((await getTabState(socket.tabId)).signerAccounts, [metaMaskAccount])

		const nextSocket = { tabId: socket.tabId, connectionName: 1n }
		const { port: nextPort } = createPort(nextSocket.tabId, undefined, 0, nextSocket.connectionName)
		const tabConnection = websiteTabConnections.get(nextSocket.tabId)
		if (tabConnection === undefined) throw new Error('Missing tab connection')
		await registerWebsiteConnectionAndProvisionallyClaimSignerState(
			websiteTabConnections,
			nextSocket,
			{ port: nextPort, socket: nextSocket, websiteOrigin, approved: true, wantsToConnect: true },
			true,
		)
		await handleInterceptedRequest(nextPort, websiteOrigin, website, simulationServicesOwner, nextSocket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 203, requestSocket: nextSocket },
			method: 'connected_to_signer',
			params: [true, 'MetaMask', 1],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		const stateAfterNewPageConnection = await getTabState(nextSocket.tabId)
		assert.equal(stateAfterNewPageConnection.signerName, 'MetaMask')
		assert.equal(stateAfterNewPageConnection.signerConnected, true)
		assert.deepEqual(stateAfterNewPageConnection.signerAccounts, [])
		assert.equal(stateAfterNewPageConnection.signerChain, undefined)
		assert.equal(stateAfterNewPageConnection.signerAccountError, undefined)
		assert.equal(stateAfterNewPageConnection.activeSigningAddress, undefined)

		const currentSignerError = { code: 4001, message: 'Current MetaMask error' }
		await updateTabState(nextSocket.tabId, (previousState) => ({
			...previousState,
			signerAccounts: [metaMaskAccount],
			signerChain: 5n,
			signerAccountError: currentSignerError,
			activeSigningAddress: metaMaskAccount,
		}))
		const staleAccountCompletionErrors: Array<{ code: number, message: string } | undefined> = []
		const completionChannel = new BroadcastChannel(INTERNAL_CHANNEL_NAME)
		const completionListener = createInternalMessageListener((message) => {
			if (message.method !== 'window_signer_accounts_changed') return
			if (message.data.socket.connectionName !== socket.connectionName) return
			staleAccountCompletionErrors.push(message.data.error)
		})
		completionChannel.addEventListener('message', completionListener)
		try {
			await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
				interceptorRequest: true,
				interceptorInternalRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 204, requestSocket: socket },
				method: 'eth_accounts_reply',
				params: [{ signerProviderGeneration: 1, type: 'success', accounts: ['0x4141414141414141414141414141414141414141'], requestAccounts: true }],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
			await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
				interceptorRequest: true,
				interceptorInternalRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 205, requestSocket: socket },
				method: 'eth_accounts_reply',
				params: [{ signerProviderGeneration: 1, type: 'error', requestAccounts: true, error: { code: 4001, message: 'Late Brave error' } }],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
			await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
				interceptorRequest: true,
				interceptorInternalRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 206, requestSocket: socket },
				method: 'signer_chainChanged',
				params: ['0x2', 2],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
			await waitForInternalWindowMessageDelivery()
		} finally {
			completionChannel.removeEventListener('message', completionListener)
			completionChannel.close()
		}

		assert.deepEqual(staleAccountCompletionErrors, [])
		assert.equal(tabConnection.signerStateOwner?.connectionName, nextSocket.connectionName)
		const stateAfterStaleReplies = await getTabState(nextSocket.tabId)
		assert.deepEqual(stateAfterStaleReplies.signerAccounts, [metaMaskAccount])
		assert.equal(stateAfterStaleReplies.activeSigningAddress, metaMaskAccount)
		assert.equal(stateAfterStaleReplies.signerChain, 5n)
		assert.deepEqual(stateAfterStaleReplies.signerAccountError, currentSignerError)
	})

	test('waits for provisional page ownership before reading or requesting signer accounts', async () => {
		installBrowserMock()
		const {
			changeSimulationMode,
			getTabState,
			handleInterceptedRequest,
			registerWebsiteConnectionAndProvisionallyClaimSignerState,
			setUseSignersAddressAsActiveAddress,
			updateTabState,
			updateWebsiteAccess,
			websiteSocketToString,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const staleAccount = 0x5151515151515151515151515151515151515151n
		const currentAccount = 0x5252525252525252525252525252525252525252n
		const currentAccountString = '0x5252525252525252525252525252525252525252'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: staleAccount })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: currentAccount, access: true }] }])

		const previousSocket = { tabId: 1, connectionName: 50n }
		const restoredSocket = { tabId: 1, connectionName: 51n }
		const { port: previousPort } = createPort(previousSocket.tabId, undefined, 0, previousSocket.connectionName)
		let restoredPort: browser.runtime.Port
		const { port: createdRestoredPort, messages } = createPort(restoredSocket.tabId, (message) => {
			if (message.method !== 'request_signer_to_eth_accounts') return
			void handleInterceptedRequest(restoredPort, websiteOrigin, website, simulationServicesOwner, restoredSocket, {
				interceptorRequest: true,
				interceptorInternalRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 302, requestSocket: restoredSocket },
				method: 'eth_accounts_reply',
				params: [{ signerProviderGeneration: 1, type: 'success', accounts: [currentAccountString], requestAccounts: false }],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
		}, 0, restoredSocket.connectionName)
		restoredPort = createdRestoredPort
		const websiteTabConnections = new Map([[restoredSocket.tabId, {
			signerStateOwner: {
				connectionName: previousSocket.connectionName,
				confirmed: true,
				generation: 1,
				providerGeneration: 7,
			},
			connections: {
				[websiteSocketToString(previousSocket)]: { port: previousPort, socket: previousSocket, websiteOrigin, approved: true, wantsToConnect: true },
			},
		}]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		await updateTabState(restoredSocket.tabId, (previousState) => ({
			...previousState,
			signerName: 'MetaMask',
			signerConnected: true,
			signerAccounts: [staleAccount],
			signerChain: 1n,
			activeSigningAddress: staleAccount,
		}))
		await registerWebsiteConnectionAndProvisionallyClaimSignerState(
			websiteTabConnections,
			restoredSocket,
			{ port: restoredPort, socket: restoredSocket, websiteOrigin, approved: true, wantsToConnect: true },
			true,
		)

		const accountRequest = handleInterceptedRequest(restoredPort, websiteOrigin, website, simulationServicesOwner, restoredSocket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 300, requestSocket: restoredSocket },
			method: 'eth_accounts',
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		await flushMicrotasks()
		assert.equal(messages.some((message) => message.method === 'request_signer_to_eth_accounts'), false)
		assert.equal(messages.some((message) => message.method === 'eth_accounts' && message.requestId === 300), false)

		await handleInterceptedRequest(restoredPort, websiteOrigin, website, simulationServicesOwner, restoredSocket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 301, requestSocket: restoredSocket },
			method: 'connected_to_signer',
			params: [true, 'MetaMask', 1],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		await accountRequest

		assert.deepEqual(messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 300).at(-1)?.result, [currentAccountString])
		assert.deepEqual((await getTabState(restoredSocket.tabId)).signerAccounts, [currentAccount])
	})

	test('finishes the first account request when the signer changes on the same page port', async () => {
		installBrowserMock()
		const {
			changeSimulationMode,
			handleInterceptedRequest,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			websiteSocketToString,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x6060606060606060606060606060606060606060n
		const accountString = '0x6060606060606060606060606060606060606060'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])

		const socket = { tabId: 1, connectionName: 59n }
		let port: browser.runtime.Port
		let websiteTabConnections: WebsiteTabConnections
		const createdPort = createPort(socket.tabId, (message) => {
			if (message.method !== 'request_signer_to_eth_requestAccounts') return
			void (async () => {
				await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
					interceptorRequest: true,
					interceptorInternalRequest: true,
					usingInterceptorWithoutSigner: false,
					uniqueRequestIdentifier: { requestId: 308, requestSocket: socket },
					method: 'connected_to_signer',
					params: [true, 'MetaMask', 2],
				}, websiteTabConnections, noopPublishRpcConnectionStatus)
				await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
					interceptorRequest: true,
					interceptorInternalRequest: true,
					usingInterceptorWithoutSigner: false,
					uniqueRequestIdentifier: { requestId: 309, requestSocket: socket },
					method: 'eth_accounts_reply',
					params: [{ signerProviderGeneration: 2, type: 'success', accounts: [accountString], requestAccounts: true }],
				}, websiteTabConnections, noopPublishRpcConnectionStatus)
			})()
		}, 0, socket.connectionName)
		port = createdPort.port
		websiteTabConnections = new Map([[socket.tabId, {
			...confirmedSignerOwnership(socket),
			connections: {
				[websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
			},
		}]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: true,
			uniqueRequestIdentifier: { requestId: 307, requestSocket: socket },
			method: 'eth_requestAccounts',
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(createdPort.messages.filter((message) => message.method === 'request_signer_to_eth_requestAccounts').length, 1)
		assert.deepEqual(createdPort.messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 307).at(-1)?.result, [accountString])
	})

	test('rejects stale account and chain callbacks from an older signer epoch on the current port', async () => {
		installBrowserMock()
		const {
			changeSimulationMode,
			createInternalMessageListener,
			getTabState,
			handleInterceptedRequest,
			INTERNAL_CHANNEL_NAME,
			setUseSignersAddressAsActiveAddress,
			updateTabState,
			updateWebsiteAccess,
			websiteSocketToString,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const currentAccount = 0x6161616161616161616161616161616161616161n
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 60n }
		const { port } = createPort(socket.tabId, undefined, 0, socket.connectionName)
		const websiteTabConnections = new Map([[socket.tabId, {
			signerStateOwner: {
				connectionName: socket.connectionName,
				confirmed: true,
				generation: 4,
				providerGeneration: 2,
			},
			connections: {
				[websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
			},
		}]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const currentError = { code: 4001, message: 'Current signer error' }
		await updateTabState(socket.tabId, (previousState) => ({
			...previousState,
			signerName: 'MetaMask',
			signerConnected: true,
			signerAccounts: [currentAccount],
			signerChain: 5n,
			signerAccountError: currentError,
			activeSigningAddress: currentAccount,
		}))
		const completionErrors: Array<{ code: number, message: string } | undefined> = []
		const completionChannel = new BroadcastChannel(INTERNAL_CHANNEL_NAME)
		const completionListener = createInternalMessageListener((message) => {
			if (message.method === 'window_signer_accounts_changed' && message.data.socket.connectionName === socket.connectionName) completionErrors.push(message.data.error)
		})
		completionChannel.addEventListener('message', completionListener)
		try {
			for (const { requestId, params } of [
				{ requestId: 310, params: { signerProviderGeneration: 1, type: 'success', accounts: ['0x6262626262626262626262626262626262626262'], requestAccounts: true } },
				{ requestId: 311, params: { signerProviderGeneration: 1, type: 'error', requestAccounts: true, error: { code: 4900, message: 'Stale error' } } },
			]) {
				await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
					interceptorRequest: true,
					interceptorInternalRequest: true,
					usingInterceptorWithoutSigner: false,
					uniqueRequestIdentifier: { requestId, requestSocket: socket },
					method: 'eth_accounts_reply',
					params: [params],
				}, websiteTabConnections, noopPublishRpcConnectionStatus)
			}
			await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
				interceptorRequest: true,
				interceptorInternalRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 312, requestSocket: socket },
				method: 'signer_chainChanged',
				params: ['0x2', 1],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
			await waitForInternalWindowMessageDelivery()
		} finally {
			completionChannel.removeEventListener('message', completionListener)
			completionChannel.close()
		}

		assert.deepEqual(completionErrors, [])
		const tabState = await getTabState(socket.tabId)
		assert.deepEqual(tabState.signerAccounts, [currentAccount])
		assert.equal(tabState.signerChain, 5n)
		assert.deepEqual(tabState.signerAccountError, currentError)
		assert.equal(tabState.activeSigningAddress, currentAccount)
	})
})
