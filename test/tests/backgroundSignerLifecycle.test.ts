import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { confirmedSignerOwnership, createEthereumWithGetBlockCounter, createPort, installBrowserMock, loadModules, noopPublishRpcConnectionStatus, waitForPortMessageCount } from './backgroundEthAccountsTestHarness.js'

describe('background eth_accounts', () => {
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
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 }, { initialBlockPolling: false })
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

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, publishRpcConnectionStatus)

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
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 }, { initialBlockPolling: false })
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

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, publishRpcConnectionStatus)

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
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 7, requestSocket: socket },
			method: 'eth_accounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

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
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
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
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const replyWithSignerAccounts = async (requestId: number, requestAccounts: boolean, accounts: readonly string[]) => {
			await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
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

		const interactiveRequest = handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
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
		const signerStateToken = sendCallbackToConfirmedSignerOwner(websiteTabConnections, socket.tabId, { method: 'request_signer_to_wallet_switchEthereumChain', result: 2n })
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
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const account = '0x2424242424242424242424242424242424242424'
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)

		const refresh = refreshSignerAccountsFromApprovedWebsitePorts(websiteTabConnections, false)
		await waitForPortMessageCount(messages, 'request_signer_to_eth_accounts', 1)
		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
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
		const signerStateToken = sendCallbackToConfirmedSignerOwner(websiteTabConnections, socket.tabId, { method: 'request_signer_to_wallet_switchEthereumChain', result: 2n })
		assert.notEqual(signerStateToken, false)
		assert.equal(messages.filter((message) => message.method === 'request_signer_to_wallet_switchEthereumChain').length, 1)
		assert.equal(childMessages.some((message) => message.method === 'request_signer_to_wallet_switchEthereumChain'), false)
		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
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
		}, { method: 'request_signer_to_wallet_switchEthereumChain', result: 2n })

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
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const resolution = resolveChainChange(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, {
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
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const resolution = resolveChainChange(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, {
			method: 'popup_changeChainDialog',
			data: { rpcNetwork: requestedRpcNetwork, uniqueRequestIdentifier, accept: true },
		})
		await waitForPortMessageCount(ownerMessages, 'request_signer_to_wallet_switchEthereumChain', 1)
		await new Promise((resolve) => setTimeout(resolve, 0))

		await removeWebsiteTabConnection(websiteTabConnections, approvingSocket, approvingPort)
		await handleInterceptedRequest(ownerPort, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, ownerSocket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 96, requestSocket: ownerSocket },
			method: 'wallet_switchEthereumChain_reply',
			params: [{ accept: true, chainId: '0xaa36a7', signerProviderGeneration: 1 }],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		await Promise.race([
			resolution,
			new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Solicited chain reply did not settle')), 100)),
		])

		const reply = requestMessages.find((message) => message.method === 'wallet_switchEthereumChain' && message.requestId === uniqueRequestIdentifier.requestId)
		assert.equal(reply?.result, null)
	})

	test('does not let another tab chain reply settle the pending dapp switch', async () => {
		installBrowserMock()
		const {
			changeSimulationMode,
			getSettings,
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
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		let requestSettled = false
		const resolution = resolveChainChange(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, {
			method: 'popup_changeChainDialog',
			data: { rpcNetwork: requestedRpcNetwork, uniqueRequestIdentifier, accept: true },
		}).then(() => { requestSettled = true })
		await waitForPortMessageCount(requestMessages, 'request_signer_to_wallet_switchEthereumChain', 1)
		await new Promise((resolve) => setTimeout(resolve, 0))

		await saveCurrentTabId(popupSocket.tabId)
		await popupChangeActiveRpc(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, {
			method: 'popup_changeActiveRpc',
			data: popupRpcNetwork,
		}, await getSettings())
		await waitForPortMessageCount(popupMessages, 'request_signer_to_wallet_switchEthereumChain', 1)
		await handleInterceptedRequest(popupPort, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, popupSocket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 98, requestSocket: popupSocket },
			method: 'wallet_switchEthereumChain_reply',
			params: [{ accept: false, chainId: '0x4268', error: { code: 4001, message: 'Popup tab rejected' }, signerProviderGeneration: 1 }],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		await new Promise((resolve) => setTimeout(resolve, 0))
		assert.equal(requestSettled, false)

		await handleInterceptedRequest(requestPort, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, requestSocket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 99, requestSocket },
			method: 'wallet_switchEthereumChain_reply',
			params: [{ accept: false, chainId: '0xaa36a7', error: { code: 4001, message: 'Dapp tab rejected' }, signerProviderGeneration: 1 }],
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
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const firstResolution = openChangeChainDialog(
			ethereum,
			tokenPriceService,
			resetSimulationServices,
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
		await resolveChainChange(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, {
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
				ethereum,
				tokenPriceService,
				resetSimulationServices,
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
		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 102, requestSocket: socket },
			method: 'wallet_switchEthereumChain_reply',
			params: [{ accept: false, chainId: '0xaa36a7', error: { code: 4001, message: 'First signer rejected' }, signerProviderGeneration: 1 }],
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
				void handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
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
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 9, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

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
			void handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
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
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 17, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

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
				void handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
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
			const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
			const request = {
				interceptorRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 19, requestSocket: socket },
				method: 'wallet_requestPermissions',
				params: [{ eth_accounts: {} }],
			}

			await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

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
