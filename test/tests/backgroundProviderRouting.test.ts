import * as assert from 'assert'
import { describe, test } from 'bun:test'
import type { SimulationStateInput } from '../../app/ts/types/visualizer-types.js'
import { addressString, confirmedSignerOwnership, createEthereumWithGetBlockCounter, createPort, createSafeTx, EthereumJsonRpcRequest, installBrowserMock, loadModules, noopPublishRpcConnectionStatus, safeTxToTypedDataJson, } from './backgroundEthAccountsTestHarness.js'

describe('background eth_accounts', () => {
	test('handles wallet_getCapabilities locally and protects capabilities for other accounts', async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, updateWebsiteAccess, changeSimulationMode, setUseSignersAddressAsActiveAddress, updateTabState } = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x1111111111111111111111111111111111111111n
		const accountString = '0x1111111111111111111111111111111111111111'
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		for (const [requestId, queriedAccount] of [
			[1, accountString],
			[2, '0x2222222222222222222222222222222222222222'],
		] as const) {
			await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
				interceptorRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId, requestSocket: socket },
				method: 'wallet_getCapabilities',
				params: [queriedAccount, ['0x1', '0x2105']],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
		}

		assert.deepEqual(messages.find((message) => message.requestId === 1), {
			interceptorApproved: true,
			requestId: 1,
			bridgeRequestSettled: true,
			type: 'result',
			method: 'wallet_getCapabilities',
			result: {},
		})
		assert.deepEqual(messages.find((message) => message.requestId === 2), {
			interceptorApproved: true,
			requestId: 2,
			bridgeRequestSettled: true,
			type: 'result',
			method: 'wallet_getCapabilities',
			error: { code: 4100, message: 'The requested account has not been authorized by the user.' },
		})

		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: account, activeSigningAddress: account })
		await setUseSignersAddressAsActiveAddress(true)
		await updateTabState(socket.tabId, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: account }))
		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 3, requestSocket: socket },
			method: 'wallet_getCapabilities',
			params: [accountString, ['0x2105']],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.deepEqual(messages.find((message) => message.requestId === 3), {
			interceptorApproved: true,
			requestId: 3,
			type: 'forwardToSigner',
			replyWithSignersReply: true,
			method: 'wallet_getCapabilities',
			params: [accountString, ['0x2105']],
		})
	})

	test('answers Sealwort Safe code and storage inspection without forwarding storage to the signer', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			updateWebsiteAccess,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateUserAddressBookEntries,
		} = await loadModules()
		const websiteOrigin = 'https://darkflorist.github.io'
		const website = { websiteOrigin, icon: undefined, title: 'Sealwort' }
		const safeAddress = 0x1111111111111111111111111111111111111111n
		const safeSignerAddress = 0x2222222222222222222222222222222222222222n
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: safeAddress, activeSigningAddress: safeSignerAddress })
		await setUseSignersAddressAsActiveAddress(false)
		await updateUserAddressBookEntries(() => [{
			type: 'safe',
			name: 'Treasury Safe',
			address: safeAddress,
			chainId: 1n,
			entrySource: 'User',
			useAsActiveAddress: true,
			safeSignerAddress,
			safeVersion: '1.4.1',
		}])
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: safeAddress, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const getBlockCalls = { count: 0 }
		const singletonAddress = 0x41675c099f32341bf84bfc5382af534df5c7461an
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter(getBlockCalls, {
			getCodeResult: new Uint8Array([0x60]),
			getStorageAtResult: singletonAddress,
		})

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 1, requestSocket: socket },
			method: 'eth_getCode',
			params: [addressString(safeAddress), 'latest'],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(getBlockCalls.count, 0)
		assert.deepEqual(messages.at(-1), {
			interceptorApproved: true,
			requestId: 1,
			bridgeRequestSettled: true,
			type: 'result',
			method: 'eth_getCode',
			result: '0x60',
		})

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 2, requestSocket: socket },
			method: 'eth_getStorageAt',
			params: [addressString(safeAddress), '0x0', 'latest'],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(getBlockCalls.count, 0)
		assert.deepEqual(messages.at(-1), {
			interceptorApproved: true,
			requestId: 2,
			bridgeRequestSettled: true,
			type: 'result',
			method: 'eth_getStorageAt',
			result: `0x${ singletonAddress.toString(16).padStart(64, '0') }`,
		})
	})

	test('preserves transaction-free overlays without running transaction preparation', async () => {
		installBrowserMock()
		const { prepareSimulationInputForRpc } = await import('../../app/ts/background/simulationUpdating.js')
		const address = 0x1111111111111111111111111111111111111111n
		const socket = { tabId: 1, connectionName: 0n }
		const website = { websiteOrigin: 'https://sealwort.example', icon: undefined, title: 'Sealwort' }
		const originalRequestParameters = { method: 'personal_sign' as const, params: ['0x68656c6c6f', address] }
		const simulationInput = [{
			stateOverrides: { [addressString(address)]: { balance: 123n } },
			transactions: [],
			signedMessages: [{
				website,
				created: new Date('2026-08-03T00:00:00.000Z'),
				fakeSignedFor: address,
				originalRequestParameters,
				request: {
					...originalRequestParameters,
					interceptorRequest: true,
					usingInterceptorWithoutSigner: false,
					uniqueRequestIdentifier: { requestId: 1, requestSocket: socket },
				},
				simulationMode: true,
				messageIdentifier: 1n,
			}],
			blockTimeManipulation: { type: 'AddToTimestamp' as const, deltaToAdd: 30n, deltaUnit: 'Seconds' as const },
			simulateWithZeroBaseFee: true,
		}] satisfies SimulationStateInput
		const getBlockCalls = { count: 0 }
		const { ethereum } = createEthereumWithGetBlockCounter(getBlockCalls)

		const prepared = await prepareSimulationInputForRpc(simulationInput, ethereum)

		assert.strictEqual(prepared, simulationInput)
		assert.equal(getBlockCalls.count, 0)
		assert.deepEqual(prepared[0]?.signedMessages, simulationInput[0].signedMessages)
		assert.deepEqual(prepared[0]?.stateOverrides, simulationInput[0].stateOverrides)
		assert.deepEqual(prepared[0]?.blockTimeManipulation, simulationInput[0].blockTimeManipulation)
	})

	test('returns invalid params to the webpage for malformed wallet_watchAsset requests', async () => {
		installBrowserMock()
		const { defaultActiveAddresses, handleInterceptedRequest, websiteSocketToString, updateWebsiteAccess, changeSimulationMode, setUseSignersAddressAsActiveAddress } = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: defaultActiveAddresses[0]?.address, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 1, requestSocket: socket },
			method: 'wallet_watchAsset',
			params: [{ type: 'ERC721', options: { address: '0x1111111111111111111111111111111111111111' } }],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.deepEqual(messages.at(-1), {
			interceptorApproved: true,
			requestId: 1,
			bridgeRequestSettled: true,
			type: 'result',
			method: 'wallet_watchAsset',
			error: { code: -32602, message: 'Invalid wallet_watchAsset parameters.' },
		})
	})

	test('returns wallet_watchAsset parse errors before the Safe signing-mode fallback', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			updateWebsiteAccess,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateUserAddressBookEntries,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const safeAddress = 0x1111111111111111111111111111111111111111n
		const safeSignerAddress = 0x2222222222222222222222222222222222222222n
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: safeAddress, activeSigningAddress: safeSignerAddress })
		await setUseSignersAddressAsActiveAddress(false)
		await updateUserAddressBookEntries(() => [{
			type: 'safe',
			name: 'Treasury Safe',
			address: safeAddress,
			chainId: 1n,
			entrySource: 'User',
			useAsActiveAddress: true,
			safeSignerAddress,
			safeVersion: '1.4.1',
		}])
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: safeAddress, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 2, requestSocket: socket },
			method: 'wallet_watchAsset',
			params: [{ type: 'ERC721', options: { address: '0x1111111111111111111111111111111111111111' } }],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.deepEqual(messages.at(-1), {
			interceptorApproved: true,
			requestId: 2,
			bridgeRequestSettled: true,
			type: 'result',
			method: 'wallet_watchAsset',
			error: { code: -32602, message: 'Invalid wallet_watchAsset parameters.' },
		})
	})

	test('reject public calls to internal provider callback methods', async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, updateWebsiteAccess, getTabState, changeSimulationMode, setUseSignersAddressAsActiveAddress } = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		for (const [index, method] of [
			'connected_to_signer',
			'eth_accounts_reply',
			'InterceptorError',
			'signer_chainChanged',
			'signer_reply',
			'wallet_switchEthereumChain_reply',
		].entries()) {
			await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
				interceptorRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: index + 1, requestSocket: socket },
				method,
				params: [],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
			const reply = messages.at(-1)
			assert.equal(reply?.method, method)
			assert.equal(reply?.requestId, index + 1)
			assert.equal(reply?.error?.code, -32601)
		}

		assert.deepEqual((await getTabState(socket.tabId)).signerAccounts, [])
	})

	test('allow marked internal eth_accounts_reply callbacks', async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, updateWebsiteAccess, getTabState, changeSimulationMode, setUseSignersAddressAsActiveAddress } = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x3333333333333333333333333333333333333333n
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 9, requestSocket: socket },
			method: 'eth_accounts_reply',
params: [{ signerProviderGeneration: 1, type: 'success', accounts: ['0x3333333333333333333333333333333333333333'], requestAccounts: false }],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		const reply = messages.at(-1)
		assert.equal(reply?.method, 'eth_accounts_reply')
		assert.equal(reply?.requestId, 9)
		assert.equal(reply?.result, '0x')
		const tabState = await getTabState(socket.tabId)
		assert.deepEqual(tabState.signerAccounts, [account])
		assert.equal(tabState.activeSigningAddress, account)
	})

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
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
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

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
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
		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
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

		await handleInterceptedRequest(childPort, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, childSocket, {
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
		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
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
				await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
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
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		await updateTabState(socket.tabId, (previousState) => ({
			...previousState,
			signerName: 'Brave',
			signerConnected: true,
			signerAccounts: [braveAccount],
			signerChain: 1n,
			signerAccountError: { code: 4001, message: 'Stale Brave error' },
			activeSigningAddress: braveAccount,
		}))

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
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

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
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
		await handleInterceptedRequest(nextPort, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, nextSocket, {
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
			await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
				interceptorRequest: true,
				interceptorInternalRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 204, requestSocket: socket },
				method: 'eth_accounts_reply',
				params: [{ signerProviderGeneration: 1, type: 'success', accounts: ['0x4141414141414141414141414141414141414141'], requestAccounts: true }],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
			await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
				interceptorRequest: true,
				interceptorInternalRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 205, requestSocket: socket },
				method: 'eth_accounts_reply',
				params: [{ signerProviderGeneration: 1, type: 'error', requestAccounts: true, error: { code: 4001, message: 'Late Brave error' } }],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
			await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
				interceptorRequest: true,
				interceptorInternalRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 206, requestSocket: socket },
				method: 'signer_chainChanged',
				params: ['0x2', 2],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
			const completionDeadline = Date.now() + 100
			while (staleAccountCompletionErrors.length < 2 && Date.now() < completionDeadline) await new Promise((resolve) => setTimeout(resolve, 0))
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
			void handleInterceptedRequest(restoredPort, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, restoredSocket, {
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
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
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

		const accountRequest = handleInterceptedRequest(restoredPort, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, restoredSocket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 300, requestSocket: restoredSocket },
			method: 'eth_accounts',
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		await new Promise((resolve) => setTimeout(resolve, 0))
		assert.equal(messages.some((message) => message.method === 'request_signer_to_eth_accounts'), false)
		assert.equal(messages.some((message) => message.method === 'eth_accounts' && message.requestId === 300), false)

		await handleInterceptedRequest(restoredPort, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, restoredSocket, {
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
				await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
					interceptorRequest: true,
					interceptorInternalRequest: true,
					usingInterceptorWithoutSigner: false,
					uniqueRequestIdentifier: { requestId: 308, requestSocket: socket },
					method: 'connected_to_signer',
					params: [true, 'MetaMask', 2],
				}, websiteTabConnections, noopPublishRpcConnectionStatus)
				await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
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
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
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
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
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
			for (const [requestId, params] of [
				[310, { signerProviderGeneration: 1, type: 'success', accounts: ['0x6262626262626262626262626262626262626262'], requestAccounts: true }],
				[311, { signerProviderGeneration: 1, type: 'error', requestAccounts: true, error: { code: 4900, message: 'Stale error' } }],
			] as const) {
				await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
					interceptorRequest: true,
					interceptorInternalRequest: true,
					usingInterceptorWithoutSigner: false,
					uniqueRequestIdentifier: { requestId, requestSocket: socket },
					method: 'eth_accounts_reply',
					params: [params],
				}, websiteTabConnections, noopPublishRpcConnectionStatus)
			}
			await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
				interceptorRequest: true,
				interceptorInternalRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 312, requestSocket: socket },
				method: 'signer_chainChanged',
				params: ['0x2', 1],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
			const completionDeadline = Date.now() + 100
			while (completionErrors.length < 2 && Date.now() < completionDeadline) await new Promise((resolve) => setTimeout(resolve, 0))
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

	test('keeps a signing-mode Safe selected when the backing wallet changes chain or account', async () => {
		installBrowserMock()
		const {
			changeSimulationMode,
			getActiveAddress,
			getSettings,
			getTabState,
			handleInterceptedRequest,
			setUseSignersAddressAsActiveAddress,
			updateTabState,
			updateUserAddressBookEntries,
			updateWebsiteAccess,
			websiteSocketToString,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const safeAddress = 0x5151515151515151515151515151515151515151n
		const safeSignerAddress = 0x5252525252525252525252525252525252525252n
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: safeAddress, activeSigningAddress: safeSignerAddress })
		await setUseSignersAddressAsActiveAddress(false)
		await updateUserAddressBookEntries(() => [{
			type: 'safe',
			name: 'Treasury Safe',
			address: safeAddress,
			chainId: 1n,
			entrySource: 'User',
			useAsActiveAddress: true,
			safeSignerAddress,
			safeVersion: '1.4.1',
		}])
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: safeAddress, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		await updateTabState(socket.tabId, (previousState) => ({
			...previousState,
			signerAccounts: [safeSignerAddress],
			activeSigningAddress: safeSignerAddress,
			signerChain: 1n,
		}))
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 207, requestSocket: socket },
			method: 'signer_chainChanged',
			params: ['0x2', 1],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		const settings = await getSettings()
		assert.equal(settings.activeRpcNetwork.chainId, 1n)
		assert.equal((await getTabState(socket.tabId)).signerChain, 2n)
		assert.equal((await getActiveAddress(settings, socket.tabId))?.address, safeAddress)
		assert.equal(messages.some((message) => message.method === 'chainChanged'), false)

		const otherSignerAddress = 0x5353535353535353535353535353535353535353n
		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 208, requestSocket: socket },
			method: 'eth_accounts_reply',
			params: [{ signerProviderGeneration: 1, type: 'success', accounts: [addressString(otherSignerAddress)], requestAccounts: false }],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		const settingsAfterAccountChange = await getSettings()
		assert.equal(settingsAfterAccountChange.activeSimulationAddress, safeAddress)
		assert.equal((await getActiveAddress(settingsAfterAccountChange, socket.tabId))?.address, safeAddress)
		assert.equal((await getTabState(socket.tabId)).activeSigningAddress, otherSignerAddress)
		assert.equal(messages.some((message) => message.method === 'accountsChanged' && Array.isArray(message.result) && message.result.includes(addressString(otherSignerAddress))), false)
	})

	test('rejects public message signing while a configured Safe is the dapp-visible account', async () => {
		installBrowserMock()
		const {
			changeSimulationMode,
			getPendingTransactionsAndMessages,
			handleInterceptedRequest,
			setUseSignersAddressAsActiveAddress,
			updateTabState,
			updateUserAddressBookEntries,
			updateWebsiteAccess,
			websiteSocketToString,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const safeAddress = 0x5555555555555555555555555555555555555555n
		const safeSignerAddress = 0x5656565656565656565656565656565656565656n
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: safeAddress, activeSigningAddress: safeSignerAddress })
		await setUseSignersAddressAsActiveAddress(false)
		await updateUserAddressBookEntries(() => [{
			type: 'safe',
			name: 'Treasury Safe',
			address: safeAddress,
			chainId: 1n,
			entrySource: 'User',
			useAsActiveAddress: true,
			safeSignerAddress,
			safeVersion: '1.4.1',
		}])
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: safeAddress, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		await updateTabState(socket.tabId, (previousState) => ({
			...previousState,
			signerAccounts: [safeSignerAddress],
			activeSigningAddress: safeSignerAddress,
			signerChain: 1n,
		}))
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const typedData = JSON.stringify({
			types: {
				EIP712Domain: [],
				Message: [{ name: 'contents', type: 'string' }],
			},
			primaryType: 'Message',
			domain: {},
			message: { contents: 'hello' },
		})

		for (const request of [
			{
				interceptorRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 210, requestSocket: socket },
				method: 'personal_sign',
				params: ['0x68656c6c6f', '0x5555555555555555555555555555555555555555'],
			},
			{
				interceptorRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 211, requestSocket: socket },
				method: 'eth_signTypedData_v4',
				params: ['0x5555555555555555555555555555555555555555', typedData],
			},
		]) {
			await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)
		}

		for (const requestId of [210, 211]) {
			const reply = messages.find((message) => message.requestId === requestId)
			assert.equal(reply?.error?.code, 4200)
			assert.match(reply?.error?.message ?? '', /Safe message signing is not supported/u)
		}
		assert.equal(messages.some((message) => message.type === 'forwardToSigner'), false)
		assert.deepEqual(await getPendingTransactionsAndMessages(), [])
	})

	test('allows only canonical Safe transaction typed data for the active Safe through the Safe signing gate', async () => {
		installBrowserMock()
		const { isSafeTransactionCoSignRequest } = await import('../../app/ts/safe/safeRequestPolicy.js')
		const safeAddress = 0x5555555555555555555555555555555555555555n
		const safeTx = createSafeTx(1n, safeAddress, {
			to: 0x5656565656565656565656565656565656565656n,
			value: 0n,
			input: new Uint8Array(),
		}, 0n)
		const request = EthereumJsonRpcRequest.parse({
			method: 'eth_signTypedData_v4',
			params: [addressString(safeAddress), safeTxToTypedDataJson(safeTx)],
		})

		assert.equal(isSafeTransactionCoSignRequest(request, safeAddress, 1n), true)
		assert.equal(isSafeTransactionCoSignRequest(request, safeAddress + 1n, 1n), false)
		assert.equal(isSafeTransactionCoSignRequest(request, safeAddress, 2n), false)
		assert.equal(isSafeTransactionCoSignRequest({
			...request,
			method: 'eth_signTypedData_v3',
		}, safeAddress, 1n), false)
		for (const unsafeSafeTx of [
			{ ...safeTx, message: { ...safeTx.message, operation: 1n } },
			{ ...safeTx, message: { ...safeTx.message, safeTxGas: 1n } },
		]) {
			assert.equal(isSafeTransactionCoSignRequest(EthereumJsonRpcRequest.parse({
				method: 'eth_signTypedData_v4',
				params: [addressString(safeAddress), safeTxToTypedDataJson(unsafeSafeTx)],
			}), safeAddress, 1n), false)
		}
	})

	test('never forwards Safe signing requests on a signer-only network', async () => {
		installBrowserMock()
		const {
			changeSimulationMode,
			getPendingTransactionsAndMessages,
			handleInterceptedRequest,
			setUseSignersAddressAsActiveAddress,
			updateTabState,
			updateUserAddressBookEntries,
			updateWebsiteAccess,
			websiteSocketToString,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const safeAddress = 0x5959595959595959595959595959595959595959n
		const safeAddressString = '0x5959595959595959595959595959595959595959'
		const safeSignerAddress = 0x6060606060606060606060606060606060606060n
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
			activeSimulationAddress: safeAddress,
			activeSigningAddress: safeSignerAddress,
		})
		await setUseSignersAddressAsActiveAddress(false)
		await updateUserAddressBookEntries(() => [{
			type: 'safe',
			name: 'Treasury Safe',
			address: safeAddress,
			chainId: 1n,
			entrySource: 'User',
			useAsActiveAddress: true,
			safeSignerAddress,
			safeVersion: '1.4.1',
		}])
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: safeAddress, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		await updateTabState(socket.tabId, (previousState) => ({
			...previousState,
			signerAccounts: [safeSignerAddress],
			activeSigningAddress: safeSignerAddress,
			signerChain: 1n,
		}))
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const typedData = JSON.stringify({
			types: {
				EIP712Domain: [],
				Message: [{ name: 'contents', type: 'string' }],
			},
			primaryType: 'Message',
			domain: {},
			message: { contents: 'hello' },
		})

		for (const request of [
			{
				interceptorRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 213, requestSocket: socket },
				method: 'personal_sign',
				params: ['0x68656c6c6f', safeAddressString],
			},
			{
				interceptorRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 214, requestSocket: socket },
				method: 'eth_signTypedData_v4',
				params: [safeAddressString, typedData],
			},
			{
				interceptorRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 215, requestSocket: socket },
				method: 'eth_sign',
				params: [safeAddressString, '0x68656c6c6f'],
			},
			{
				interceptorRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 216, requestSocket: socket },
				method: 'eth_sendTransaction',
				params: [{
					from: safeAddressString,
					to: '0x6161616161616161616161616161616161616161',
					value: '0x0',
				}],
			},
		]) {
			await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)
		}

		for (const requestId of [213, 214, 215]) {
			const reply = messages.find((message) => message.requestId === requestId)
			assert.equal(reply?.error?.code, 4200)
			assert.match(reply?.error?.message ?? '', /Safe message signing is not supported/u)
		}
		const transactionReply = messages.find((message) => message.requestId === 216)
		assert.equal(transactionReply?.error?.code, 4200)
		assert.match(transactionReply?.error?.message ?? '', /require an Interceptor RPC connection/u)
		assert.equal(messages.some((message) => message.type === 'forwardToSigner'), false)
		assert.deepEqual(await getPendingTransactionsAndMessages(), [])
	})

	test('never exposes a configured Safe selected from another chain while signing', async () => {
		installBrowserMock()
		const {
			changeActiveAddressAndChain,
			changeSimulationMode,
			getActiveAddress,
			getSettings,
			handleInterceptedRequest,
			setUseSignersAddressAsActiveAddress,
			updateTabState,
			updateUserAddressBookEntries,
			updateWebsiteAccess,
			websiteSocketToString,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const safeAddress = 0x5757575757575757575757575757575757575757n
		const safeSignerAddress = 0x5858585858585858585858585858585858585858n
		await changeSimulationMode({ simulationMode: false, activeSigningAddress: safeSignerAddress })
		await setUseSignersAddressAsActiveAddress(false)
		await updateUserAddressBookEntries(() => [{
			type: 'safe',
			name: 'Other-chain Safe',
			address: safeAddress,
			chainId: 2n,
			entrySource: 'User',
			useAsActiveAddress: true,
			safeSignerAddress,
			safeVersion: '1.4.1',
		}])
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: safeSignerAddress, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		await updateTabState(socket.tabId, (previousState) => ({
			...previousState,
			signerAccounts: [safeSignerAddress],
			activeSigningAddress: safeSignerAddress,
			signerChain: 1n,
		}))
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		await changeActiveAddressAndChain(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, {
			simulationMode: false,
			activeAddress: safeAddress,
		})
		assert.notEqual((await getActiveAddress(await getSettings(), socket.tabId))?.address, safeAddress)
		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 212, requestSocket: socket },
			method: 'eth_accounts',
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		const reply = messages.find((message) => message.method === 'eth_accounts' && message.requestId === 212)
		assert.equal(Array.isArray(reply?.result) && reply.result.includes('0x5757575757575757575757575757575757575757'), false)
	})

	test('does not reinterpret a selected Safe from another chain as a generic simulation address', async () => {
		installBrowserMock()
		const {
			changeSimulationMode,
			getActiveAddress,
			getActiveAddressesForAllTabs,
			getActiveOrFirstSignerAddress,
			getSettings,
			setUseSignersAddressAsActiveAddress,
			updateTabState,
			updateUserAddressBookEntries,
		} = await loadModules()
		const safeAddress = 0x5959595959595959595959595959595959595959n
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: safeAddress })
		await setUseSignersAddressAsActiveAddress(false)
		await updateUserAddressBookEntries(() => [{
			type: 'safe',
			name: 'Other-chain simulation Safe',
			address: safeAddress,
			chainId: 2n,
			entrySource: 'User',
			useAsActiveAddress: true,
			safeVersion: '1.4.1',
		}])
		await updateTabState(1, (previousState) => previousState)

		const settings = await getSettings()
		assert.notEqual(settings.activeRpcNetwork.chainId, 2n)
		assert.equal(await getActiveAddress(settings, 1), undefined)
		assert.equal(await getActiveOrFirstSignerAddress(settings, 1), undefined)
		assert.equal((await getActiveAddressesForAllTabs(settings)).find(({ tabId }) => tabId === 1)?.activeAddress, undefined)
	})

	test('keeps a Safe selected in signing mode even without a simulation signer', async () => {
		installBrowserMock()
		const {
			changeActiveAddressAndChain,
			changeSimulationMode,
			getActiveAddress,
			getSettings,
			handleInterceptedRequest,
			setUseSignersAddressAsActiveAddress,
			updateTabState,
			updateUserAddressBookEntries,
			updateWebsiteAccess,
			websiteSocketToString,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const safeAddress = 0x5353535353535353535353535353535353535353n
		const safeSignerAddress = 0x5454545454545454545454545454545454545454n
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: safeAddress, activeSigningAddress: safeSignerAddress })
		await setUseSignersAddressAsActiveAddress(false)
		await updateUserAddressBookEntries(() => [{
			type: 'safe',
			name: 'Simulation-only Safe',
			address: safeAddress,
			chainId: 1n,
			entrySource: 'User',
			useAsActiveAddress: true,
			safeVersion: '1.4.1',
		}])
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: safeSignerAddress, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		await updateTabState(socket.tabId, (previousState) => ({
			...previousState,
			signerAccounts: [safeSignerAddress],
			activeSigningAddress: safeSignerAddress,
			signerChain: 1n,
		}))
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		assert.equal((await getActiveAddress(await getSettings(), socket.tabId))?.address, safeAddress)
		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 208, requestSocket: socket },
			method: 'eth_accounts',
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		const ethAccountsReplies = messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 208)
		assert.deepEqual(ethAccountsReplies.at(-1)?.result, [])

		await changeActiveAddressAndChain(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, {
			simulationMode: false,
			activeAddress: safeAddress,
		})
		assert.equal((await getActiveAddress(await getSettings(), socket.tabId))?.address, safeAddress)
		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 209, requestSocket: socket },
			method: 'eth_accounts',
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		const repliesAfterSelectingSafe = messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 209)
		assert.equal(repliesAfterSelectingSafe.some((message) =>
			Array.isArray(message.result) && message.result.includes('0x5353535353535353535353535353535353535353')
		), false)
	})

	test('skip simulation state refresh for eth_accounts in simulation mode', async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, changeSimulationMode, setUseSignersAddressAsActiveAddress, updateWebsiteAccess } = await loadModules()
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
		const getBlockCalls = { count: 0 }
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter(getBlockCalls)
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 1, requestSocket: socket },
			method: 'eth_accounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(getBlockCalls.count, 0)
		assert.equal(messages.some((message) => message.method === 'request_signer_to_eth_accounts'), false)
		const ethAccountsReplies = messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 1)
		assert.deepEqual(ethAccountsReplies.at(-1)?.result, ['0x1111111111111111111111111111111111111111'])
	})

	test('site-approved eth_accounts returns empty accounts until address access is approved', async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, changeSimulationMode, setUseSignersAddressAsActiveAddress, updateWebsiteAccess } = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x1212121212121212121212121212121212121212n
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 2, requestSocket: socket },
			method: 'eth_accounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		const ethAccountsReplies = messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 2)
		assert.deepEqual(ethAccountsReplies.at(-1)?.result, [])
	})

	test('site-approved wallet_getPermissions returns no accounts until address access is approved', async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, changeSimulationMode, setUseSignersAddressAsActiveAddress, updateWebsiteAccess } = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x1313131313131313131313131313131313131313n
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 3, requestSocket: socket },
			method: 'wallet_getPermissions',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		const permissionsReplies = messages.filter((message) => message.method === 'wallet_getPermissions' && message.requestId === 3)
		assert.deepEqual(permissionsReplies.at(-1)?.result, [])
	})

	test('wallet_getCapabilities advertises the active signer for an approved Gnosis Safe account', async () => {
		installBrowserMock()
		const {
			changeSimulationMode,
			handleInterceptedRequest,
			setUseSignersAddressAsActiveAddress,
			updateTabState,
			updateUserAddressBookEntries,
			updateWebsiteAccess,
			websiteSocketToString,
		} = await loadModules()
		const websiteOrigin = 'https://sealwort.example'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const safeAddress = 0x1616161616161616161616161616161616161616n
		const signerAddress = 0x1717171717171717171717171717171717171717n
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: safeAddress, activeSigningAddress: signerAddress })
		await setUseSignersAddressAsActiveAddress(false)
		await updateUserAddressBookEntries(() => [{
			type: 'safe',
			name: 'Treasury Safe',
			address: safeAddress,
			chainId: 1n,
			entrySource: 'User',
			useAsActiveAddress: true,
			safeSimulationSignerAddress: 0x1919191919191919191919191919191919191919n,
			safeSignerAddresses: [signerAddress],
			safeVersion: '1.4.1',
		}])
		await updateWebsiteAccess(() => [{
			website,
			access: true,
			addressAccess: [{ address: safeAddress, access: true }],
		}])

		const socket = { tabId: 1, connectionName: 0n }
		await updateTabState(socket.tabId, (previousState) => ({
			...previousState,
			signerAccounts: [signerAddress],
			activeSigningAddress: signerAddress,
			signerChain: 1n,
		}))
		const { port, messages } = createPort(socket.tabId)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 31, requestSocket: socket },
			method: 'wallet_getCapabilities',
			params: [addressString(safeAddress), ['0x1']],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		const capabilityReply = messages.find((message) => message.method === 'wallet_getCapabilities' && message.requestId === 31)
		assert.deepEqual(capabilityReply?.result, {
			'0x1': {
				gnosisSafeExecution: {
					supported: true,
					version: '1.0.0',
					activeSigner: addressString(signerAddress),
					submissionMethod: 'eth_sendTransaction',
				},
			},
		})
		assert.equal(messages.some((message) => message.type === 'forwardToSigner'), false)

		await updateTabState(socket.tabId, (previousState) => ({
			...previousState,
			signerAccounts: [],
			activeSigningAddress: undefined,
		}))
		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 32, requestSocket: socket },
			method: 'wallet_getCapabilities',
			params: [addressString(safeAddress), ['0x1']],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		const capabilityReplyWithoutWalletOwner = messages.find((message) => message.method === 'wallet_getCapabilities' && message.requestId === 32)
		assert.deepEqual(capabilityReplyWithoutWalletOwner?.result, {})
		assert.equal(messages.some((message) => message.type === 'forwardToSigner'), false)

		await updateTabState(socket.tabId, (previousState) => ({
			...previousState,
			signerAccounts: [0x1919191919191919191919191919191919191919n],
			activeSigningAddress: 0x1919191919191919191919191919191919191919n,
		}))
		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 33, requestSocket: socket },
			method: 'wallet_getCapabilities',
			params: [addressString(safeAddress), ['0x1']],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		const capabilityReplyForNonOwner = messages.find((message) => message.method === 'wallet_getCapabilities' && message.requestId === 33)
		assert.deepEqual(capabilityReplyForNonOwner?.result, {})
		assert.equal(messages.some((message) => message.type === 'forwardToSigner'), false)
	})

	test('wallet_getPermissions returns empty when signer accounts are cached but address access is missing', async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, changeSimulationMode, setUseSignersAddressAsActiveAddress, updateWebsiteAccess, updateTabState } = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x1414141414141414141414141414141414141414n
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(true)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		await updateTabState(socket.tabId, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: undefined }))
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 4, requestSocket: socket },
			method: 'wallet_getPermissions',
		}

		await Promise.race([
			handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus),
			new Promise((_, reject) => setTimeout(() => reject(new Error('wallet_getPermissions did not resolve')), 100)),
		])

		const permissionsReplies = messages.filter((message) => message.method === 'wallet_getPermissions' && message.requestId === 4)
		assert.deepEqual(permissionsReplies.at(-1)?.result, [])
	})

	test('wallet_getPermissions returns the approved account when signer accounts are cached without an active signer address', async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, changeSimulationMode, setUseSignersAddressAsActiveAddress, updateWebsiteAccess, updateTabState } = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x1515151515151515151515151515151515151515n
		const accountString = '0x1515151515151515151515151515151515151515'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(true)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		await updateTabState(socket.tabId, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: undefined }))
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 5, requestSocket: socket },
			method: 'wallet_getPermissions',
		}

		await Promise.race([
			handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus),
			new Promise((_, reject) => setTimeout(() => reject(new Error('wallet_getPermissions did not resolve')), 100)),
		])

		const permissionsReplies = messages.filter((message) => message.method === 'wallet_getPermissions' && message.requestId === 5)
		assert.deepEqual(permissionsReplies.at(-1)?.result, [{
			parentCapability: 'eth_accounts',
			caveats: [{
				type: 'restrictReturnedAccounts',
				value: [accountString],
			}],
			invoker: websiteOrigin,
		}])
	})

})
