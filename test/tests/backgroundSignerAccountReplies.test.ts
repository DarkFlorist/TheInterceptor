import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import type { WebsiteTabConnections } from '../../app/ts/types/user-interface-types.js'
import { addressString, confirmedSignerOwnership, createEthereumWithGetBlockCounter, createPort, createRestoringBrowserMockInstaller, loadModules, noopPublishRpcConnectionStatus, waitForInternalWindowMessageDelivery, waitForPortMessageCount } from './backgroundEthAccountsTestHarness.js'

const installBrowserMock = createRestoringBrowserMockInstaller()

describe('background signer account replies and account exposure', () => {
	test('falls back to the wallet account when a stored signing Safe is no longer owned', async () => {
		installBrowserMock()
		const {
			changeSimulationMode,
			getActiveAddress,
			getSettings,
			handleInterceptedRequest,
			updateTabState,
			updateUserAddressBookEntries,
			updateWebsiteAccess,
			websiteSocketToString,
		} = await loadModules()
		const websiteOrigin = 'https://stale-safe.example'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const signerAddress = 0x4545454545454545454545454545454545454545n
		const safeAddress = signerAddress
		const formerOwner = 0x4747474747474747474747474747474747474747n
		const socket = { tabId: 197, connectionName: 0n }
		await changeSimulationMode({ simulationMode: false, activeSigningAddress: signerAddress, activeSigningSafeAddress: safeAddress })
		await updateUserAddressBookEntries(() => [{
			type: 'safe',
			name: 'No longer owned Safe',
			address: safeAddress,
			chainId: 1n,
			entrySource: 'User',
			useAsActiveAddress: true,
			safeSignerAddresses: [formerOwner],
		}])
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: signerAddress, access: true }] }])
		await updateTabState(socket.tabId, (previousState) => ({
			...previousState,
			signerAccounts: [signerAddress],
			activeSigningAddress: signerAddress,
			signerChain: 1n,
		}))

		const settings = await getSettings()
		const activeAddress = await getActiveAddress(settings, socket.tabId)
		assert.equal(activeAddress?.address, signerAddress)
		assert.notEqual(activeAddress?.type, 'safe')

		const { port, messages } = createPort(socket.tabId)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 12, requestSocket: socket },
			method: 'eth_accounts',
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.deepEqual(messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 12).at(-1)?.result, [addressString(signerAddress)])
	})

	test('replays account state after already-approved eth_requestAccounts with cached active signer address', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			updateTabState,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4an
		const accountString = '0x4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: account })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		await updateTabState(socket.tabId, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: account }))
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
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
		assert.deepEqual(messages.filter((message) => message.method === 'accountsChanged').map((message) => message.result), [[accountString]])
		assert.deepEqual(messages.filter((message) => message.method === 'accountsChanged').map((message) => message.requestId), [11])
		const requestAccountsReplies = messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 11)
		assert.deepEqual(requestAccountsReplies.at(-1)?.result, [accountString])
		assert.deepEqual(messages.map((message) => message.method), ['accountsChanged', 'eth_accounts'])
	})

	test('replays account state for already-approved eth_requestAccounts on signer-only networks', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
			updateTabState,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4cn
		const accountString = '0x4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c'
		await changeSimulationMode({
			simulationMode: false,
			rpcNetwork: {
				name: 'Signer only',
				chainId: 1n,
				httpsRpc: undefined,
				currencyName: 'Ether?',
				currencyTicker: 'ETH?',
				primary: false,
				minimized: true,
			},
			activeSimulationAddress: undefined,
			activeSigningAddress: account,
		})
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		await updateTabState(socket.tabId, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: account }))
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 16, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(messages.some((message) => message.type === 'forwardToSigner'), false)
		assert.equal(messages.some((message) => message.method === 'request_signer_to_eth_requestAccounts'), false)
		const requestAccountsReplies = messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 16)
		assert.deepEqual(requestAccountsReplies.at(-1)?.result, [accountString])
		assert.equal(messages.some((message) => message.method === 'connect'), false)
		assert.deepEqual(messages.filter((message) => message.method === 'accountsChanged').map((message) => message.result), [[accountString]])
		assert.deepEqual(messages.filter((message) => message.method === 'accountsChanged').map((message) => message.requestId), [16])
		assert.deepEqual(messages.map((message) => message.method), ['accountsChanged', 'eth_accounts'])
	})

	test('does not connect an unapproved port when signer rejects site-approved eth_requestAccounts', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
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
				uniqueRequestIdentifier: { requestId: 102, requestSocket: socket },
				method: 'eth_accounts_reply',
				params: [{ signerProviderGeneration: 1, type: 'error', requestAccounts: true, error: { code: 4001, message: 'User rejected the request.' } }],
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
			uniqueRequestIdentifier: { requestId: 13, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(messages.filter((message) => message.method === 'request_signer_to_eth_requestAccounts').length, 1)
		assert.equal(messages.some((message) => message.method === 'connect'), false)
		assert.equal(messages.some((message) => message.method === 'accountsChanged'), false)
		const requestAccountsReplies = messages.filter((message) => message.method === 'eth_requestAccounts' && message.requestId === 13)
		assert.equal(requestAccountsReplies.at(-1)?.error?.code, 4001)
		assert.equal(requestAccountsReplies.at(-1)?.error?.message, 'User rejected the request.')
	})

	test('does not connect an unapproved port when signer returns empty accounts for site-approved eth_requestAccounts', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
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
				uniqueRequestIdentifier: { requestId: 103, requestSocket: socket },
				method: 'eth_accounts_reply',
				params: [{ signerProviderGeneration: 1, type: 'success', accounts: [], requestAccounts: true }],
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
			uniqueRequestIdentifier: { requestId: 14, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(messages.filter((message) => message.method === 'request_signer_to_eth_requestAccounts').length, 1)
		assert.equal(messages.some((message) => message.method === 'connect'), false)
		assert.equal(messages.some((message) => message.method === 'accountsChanged'), false)
		const requestAccountsReplies = messages.filter((message) => message.method === 'eth_requestAccounts' && message.requestId === 14)
		assert.equal(requestAccountsReplies.at(-1)?.error?.code, 4100)
		assert.equal(requestAccountsReplies.at(-1)?.error?.message, 'The requested method and/or account has not been authorized by the user.')
	})

	test('preserves the signer account-access rejection for approved eth_requestAccounts', async () => {
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
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		let port: browser.runtime.Port
		const { port: createdPort, messages } = createPort(socket.tabId, (message) => {
			if (message.method !== 'request_signer_to_eth_requestAccounts') return
			void (async () => {
				await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
					interceptorRequest: true,
					interceptorInternalRequest: true,
					usingInterceptorWithoutSigner: false,
					uniqueRequestIdentifier: { requestId: 99, requestSocket: socket },
					method: 'eth_accounts_reply',
					params: [{ signerProviderGeneration: 1, type: 'error', requestAccounts: true, error: { code: 4001, message: 'User rejected the request.' } }],
				}, websiteTabConnections, noopPublishRpcConnectionStatus)
			})()
		})
		port = createdPort
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 8, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(messages.filter((message) => message.method === 'request_signer_to_eth_requestAccounts').length, 1)
		const requestAccountsReplies = messages.filter((message) => message.method === 'eth_requestAccounts' && message.requestId === 8)
		assert.equal(requestAccountsReplies.at(-1)?.error?.code, 4001)
		assert.equal(requestAccountsReplies.at(-1)?.error?.message, 'User rejected the request.')
		assert.deepEqual((await getTabState(socket.tabId)).signerAccounts, [])
	})

	test('maps unavailable signer errors only for interactive account connection methods', async () => {
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
		const unavailableSignerError = {
			code: 4900,
			message: 'No signer wallet is available to this page. Enable your wallet extension for this site, then try again.',
		}
		const account = 0x2424242424242424242424242424242424242424n
		const accountString = '0x2424242424242424242424242424242424242424'
		const accountRequests = [
			{ method: 'eth_requestAccounts', signerRequestMethod: 'request_signer_to_eth_requestAccounts', expectedPublicErrorCode: 4001, requestAccounts: true },
			{ method: 'wallet_requestPermissions', signerRequestMethod: 'request_signer_to_eth_requestAccounts', expectedPublicErrorCode: 4001, requestAccounts: true },
			{ method: 'eth_accounts', signerRequestMethod: 'request_signer_to_eth_accounts', expectedPublicErrorCode: 4900, requestAccounts: false },
			{ method: 'wallet_getPermissions', signerRequestMethod: 'request_signer_to_eth_accounts', expectedPublicErrorCode: 4900, requestAccounts: false },
			{ method: 'wallet_getCapabilities', signerRequestMethod: 'request_signer_to_eth_accounts', expectedPublicErrorCode: 4100, requestAccounts: false },
		]
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		let port: browser.runtime.Port
		let internalRequestId = 104
		const { port: createdPort, messages } = createPort(socket.tabId, (message) => {
			const accountRequest = accountRequests.find((candidate) => candidate.signerRequestMethod === message.method)
			if (accountRequest === undefined) return
			internalRequestId += 1
			void handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
				interceptorRequest: true,
				interceptorInternalRequest: true,
				usingInterceptorWithoutSigner: true,
				uniqueRequestIdentifier: { requestId: internalRequestId, requestSocket: socket },
				method: 'eth_accounts_reply',
				params: [{ signerProviderGeneration: 1, type: 'error', requestAccounts: accountRequest.requestAccounts, signerUnavailable: true, error: unavailableSignerError }],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
		})
		port = createdPort
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })

		for (const [requestIndex, accountRequest] of accountRequests.entries()) {
			const requestId = 15 + requestIndex
			await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
				interceptorRequest: true,
				usingInterceptorWithoutSigner: true,
				uniqueRequestIdentifier: { requestId, requestSocket: socket },
				method: accountRequest.method,
				...(accountRequest.method === 'wallet_getCapabilities' ? { params: [accountString] } : {}),
			}, websiteTabConnections, noopPublishRpcConnectionStatus)

			const replies = messages.filter((message) => message.method === accountRequest.method && message.requestId === requestId)
			assert.equal(replies.length, 1)
			assert.deepEqual(
				replies[0]?.error,
				accountRequest.method === 'wallet_getCapabilities'
					? { code: 4100, message: 'The requested method and/or account has not been authorized by the user.' }
					: { ...unavailableSignerError, code: accountRequest.expectedPublicErrorCode },
			)
			assert.equal(messages.some((message) => (message.method === 'connect' || message.method === 'accountsChanged') && message.requestId === requestId), false)
		}
		assert.equal((await getTabState(socket.tabId)).signerAccountError, undefined)
	})

	test('ignores a provider-disconnected completion from a sibling socket', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			sendInternalWindowMessage,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x2424242424242424242424242424242424242424n
		const accountString = '0x2424242424242424242424242424242424242424'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		const siblingSocket = { tabId: 1, connectionName: 1n }
		const { port, messages } = createPort(socket.tabId)
		const { port: siblingPort } = createPort(siblingSocket.tabId, undefined, undefined, siblingSocket.connectionName)
		const connectionKey = websiteSocketToString(socket)
		const siblingConnectionKey = websiteSocketToString(siblingSocket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
			[siblingConnectionKey]: { port: siblingPort, socket: siblingSocket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: true,
			uniqueRequestIdentifier: { requestId: 18, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		const requestPromise = handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)
		await waitForPortMessageCount(messages, 'request_signer_to_eth_requestAccounts', 1)
		sendInternalWindowMessage({
			method: 'window_signer_accounts_changed',
			data: {
				socket: siblingSocket,
				signerStateOwnerGeneration: 1,
				signerProviderGeneration: 1,
				error: { code: 4900, message: 'Sibling signer is unavailable' },
			},
		})
		await waitForInternalWindowMessageDelivery()
		assert.equal(messages.some((message) => message.requestId === 18), false)

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 105, requestSocket: socket },
			method: 'eth_accounts_reply',
			params: [{ signerProviderGeneration: 1, type: 'success', accounts: [accountString], requestAccounts: true }],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		await requestPromise

		const requestAccountsReplies = messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 18)
		assert.equal(requestAccountsReplies.length, 1)
		assert.deepEqual(requestAccountsReplies[0]?.result, [accountString])
	})

	test('does not apply the passive reply timeout to interactive signer approval', async () => {
		installBrowserMock()
		const {
			changeSimulationMode,
			getTabState,
			handleInterceptedRequest,
			refreshSignerAccountsForTab,
			setUseSignersAddressAsActiveAddress,
			websiteSocketToString,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const signerAddress = 0x7575757575757575757575757575757575757575n
		const socket = { tabId: 1, connectionName: 0n }
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })

		let websiteTabConnections: WebsiteTabConnections
		let accountReply: Promise<unknown> | undefined
		const { port, messages } = createPort(socket.tabId, (message) => {
			if (message.method !== 'request_signer_to_eth_requestAccounts') return
			// The signer answers after the 1 ms passive reply timeout; an interactive request must still wait for it.
			accountReply = new Promise((resolve) => {
				setTimeout(() => {
					resolve(handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
						interceptorRequest: true,
						interceptorInternalRequest: true,
						usingInterceptorWithoutSigner: false,
						uniqueRequestIdentifier: { requestId: 402, requestSocket: socket },
						method: 'eth_accounts_reply',
						params: [{ signerProviderGeneration: 1, type: 'success', accounts: [addressString(signerAddress)], requestAccounts: true }],
					}, websiteTabConnections, noopPublishRpcConnectionStatus))
				}, 20)
			})
		})
		websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])

		await refreshSignerAccountsForTab(websiteTabConnections, socket.tabId, true, { passiveReplyTimeoutMs: 1 })
		await accountReply

		assert.equal(messages.filter((message) => message.method === 'request_signer_to_eth_requestAccounts').length, 1)
		assert.deepEqual((await getTabState(socket.tabId)).signerAccounts, [signerAddress])
	})
})
