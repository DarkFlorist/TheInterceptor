import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import type { SimulationStateInput } from '../../app/ts/types/visualizer-types.js'
import { addressString, confirmedSignerOwnership, createEthereumWithGetBlockCounter, createPort, createRestoringBrowserMockInstaller, createTestSimulationServicesOwner, loadModules, noopPublishRpcConnectionStatus } from './backgroundEthAccountsTestHarness.js'
import { settleWithin } from '../harness/async.js'

const installBrowserMock = createRestoringBrowserMockInstaller()

type SimulationStateInputBlock = SimulationStateInput[number]
type SignedMessageRequestParameters = SimulationStateInputBlock['signedMessages'][number]['originalRequestParameters']

describe('background provider method routing', () => {
	test('resolves an access prompt with the services installed after it opened', async () => {
		installBrowserMock()
		const { requestAccessFromUser, createInterceptedRequestReplay, resolveInterceptorAccess, getPendingAccessRequests, getSettings, websiteSocketToString, changeSimulationMode, setUseSignersAddressAsActiveAddress } = await loadModules()
		const { getActiveAddressEntryForChain } = await import('../../app/ts/background/metadataUtils.js')
		const website = { websiteOrigin: 'https://access-reset.example', icon: undefined, title: undefined }
		const account = 1n
		await setUseSignersAddressAsActiveAddress(false)
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account })
		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(1)
		const connections = new Map([[1, { ...confirmedSignerOwnership(socket), connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin: website.websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		let oldReads = 0
		let newReads = 0
		const original = createEthereumWithGetBlockCounter({ count: 0 }, { getChainId: () => { oldReads++; return 1n } })
		const installed = createEthereumWithGetBlockCounter({ count: 0 }, { getChainId: () => { newReads++; return 1n } })
		const owner = createTestSimulationServicesOwner(original, () => installed)
		const address = await getActiveAddressEntryForChain(account, 1n)
		await requestAccessFromUser(connections, socket, website, {
			interceptorRequest: true, usingInterceptorWithoutSigner: true,
			uniqueRequestIdentifier: { requestId: 992, requestSocket: socket }, method: 'eth_chainId', params: [],
		}, address, await getSettings(), address, createInterceptedRequestReplay(owner, connections, noopPublishRpcConnectionStatus))
		const pending = (await getPendingAccessRequests())[0]
		assert.ok(pending !== undefined)
		owner.reset(installed.ethereum.getRpcEntry())
		await resolveInterceptorAccess(owner, connections, { userReply: 'Approved', requestAccessToAddress: account, originalRequestAccessToAddress: account, accessRequestId: pending.accessRequestId }, noopPublishRpcConnectionStatus)
		assert.equal(oldReads, 0)
		assert.ok(newReads > 0)
		assert.equal(messages.find(message => message.requestId === 992)?.result, '0x1')
		assert.equal((await getPendingAccessRequests()).length, 0)
	})

	test('uses installed services after waiting for website metadata', async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, updateWebsiteAccess, changeSimulationMode, setUseSignersAddressAsActiveAddress } = await loadModules()
		const websiteOrigin = 'https://queued-rpc.example'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 1n
		await setUseSignersAddressAsActiveAddress(false)
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account })
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])
		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(1)
		const connections = new Map([[1, { ...confirmedSignerOwnership(socket), connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		let originalReads = 0
		let installedReads = 0
		const original = createEthereumWithGetBlockCounter({ count: 0 }, { getChainId: () => { originalReads++; return 1n } })
		const installed = createEthereumWithGetBlockCounter({ count: 0 }, { getChainId: () => { installedReads++; return 2n } })
		const owner = createTestSimulationServicesOwner(original, () => installed)
		const metadata = Promise.withResolvers<typeof website>()
		const pending = handleInterceptedRequest(port, websiteOrigin, metadata.promise, owner, socket, {
			interceptorRequest: true, usingInterceptorWithoutSigner: true,
			uniqueRequestIdentifier: { requestId: 991, requestSocket: socket }, method: 'eth_chainId', params: [],
		}, connections, noopPublishRpcConnectionStatus)
		owner.reset(installed.ethereum.getRpcEntry())
		metadata.resolve(website)
		await pending
		assert.equal(originalReads, 0)
		assert.ok(installedReads > 0)
		assert.equal(messages.find(message => message.requestId === 991)?.result, '0x2')
	})

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
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })

		for (const { requestId, queriedAccount } of [
			{ requestId: 1, queriedAccount: accountString },
			{ requestId: 2, queriedAccount: '0x2222222222222222222222222222222222222222' },
		]) {
			await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
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
		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
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
			updateTabState,
			updateUserAddressBookEntries,
		} = await loadModules()
		const websiteOrigin = 'https://darkflorist.github.io'
		const website = { websiteOrigin, icon: undefined, title: 'Sealwort' }
		const safeAddress = 0x1111111111111111111111111111111111111111n
		const safeSignerAddress = 0x2222222222222222222222222222222222222222n
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: safeAddress, activeSigningAddress: safeSignerAddress, activeSigningSafeAddress: safeAddress })
		await setUseSignersAddressAsActiveAddress(false)
		await updateUserAddressBookEntries(() => [{
			type: 'safe',
			name: 'Treasury Safe',
			address: safeAddress,
			chainId: 1n,
			entrySource: 'User',
			useAsActiveAddress: true,
			safeSignerAddresses: [safeSignerAddress],
			safeVersion: '1.4.1',
		}])
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: safeAddress, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		await updateTabState(socket.tabId, (previousState) => ({
			...previousState,
			signerAccounts: [safeSignerAddress],
			activeSigningAddress: safeSignerAddress,
		}))
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const getBlockCalls = { count: 0 }
		const singletonAddress = 0x41675c099f32341bf84bfc5382af534df5c7461an
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter(getBlockCalls, {
			getCodeResult: new Uint8Array([0x60]),
			getStorageAtResult: singletonAddress,
		})

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
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

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
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

	test('asks the inpage bridge to settle forwarded EOA storage reads from the signer reply', async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, updateWebsiteAccess, changeSimulationMode, setUseSignersAddressAsActiveAddress, updateTabState } = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x1111111111111111111111111111111111111111n
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: account })
		await setUseSignersAddressAsActiveAddress(true)
		await updateTabState(1, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: account }))
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
			uniqueRequestIdentifier: { requestId: 1, requestSocket: socket },
			method: 'eth_getStorageAt',
			params: ['0xE592427A0AEce92De3Edee1F18E0157C05861564', '0x0', 'latest'],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.deepEqual(messages.at(-1), {
			interceptorApproved: true,
			requestId: 1,
			type: 'forwardToSigner',
			replyWithSignersReply: true,
			method: 'eth_getStorageAt',
			params: ['0xe592427a0aece92de3edee1f18e0157c05861564', '0x0', 'latest'],
		})
	})

	test('answers a forwarded wallet_addEthereumChain signer reply from a replaced port with the replaced-connection error', async () => {
		installBrowserMock()
		const { signerConnectionReplacedError, websiteSocketToString } = await loadModules()
		const { signerReply } = await import('../../app/ts/background/providerMessageHandlers.js')
		const socket = { tabId: 1, connectionName: 0n }
		const { port: currentPort } = createPort(socket.tabId)
		const { port: replacedPort } = createPort(socket.tabId)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[websiteSocketToString(socket)]: { port: currentPort, socket, websiteOrigin: 'https://example.test', approved: true, wantsToConnect: true },
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const sendSignerReplyFrom = async (port: browser.runtime.Port) => await signerReply(simulationServicesOwner, websiteTabConnections, port, {
			method: 'signer_reply',
			params: [{
				success: true,
				signerProviderGeneration: 1,
				forwardRequest: {
					type: 'forwardToSigner',
					method: 'wallet_addEthereumChain',
					params: [{ chainId: '0x89', chainName: 'Polygon', nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 }, rpcUrls: ['https://polygon.example.test'] }],
					requestId: 4,
				},
				reply: null,
			}],
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 5, requestSocket: socket },
		}, 'hasAccess', undefined)

		// The background does not settle wallet_addEthereumChain itself, so the inpage signer_reply request waits for this answer even when the reply arrives over a replaced port.
		assert.deepEqual(await sendSignerReplyFrom(replacedPort), { type: 'result', method: 'signer_reply', error: signerConnectionReplacedError })
		assert.deepEqual(await sendSignerReplyFrom(currentPort), { type: 'result', method: 'signer_reply', result: null })
	})

	test('preserves transaction-free overlays without running transaction preparation', async () => {
		installBrowserMock()
		const { prepareSimulationInputForRpc } = await import('../../app/ts/background/simulationUpdating.js')
		const address = 0x1111111111111111111111111111111111111111n
		const socket = { tabId: 1, connectionName: 0n }
		const website = { websiteOrigin: 'https://sealwort.example', icon: undefined, title: 'Sealwort' }
		const originalRequestParameters: SignedMessageRequestParameters = { method: 'personal_sign', params: ['0x68656c6c6f', address] }
		const simulationBlock: SimulationStateInputBlock = {
			stateOverrides: { [addressString(address)]: { balance: 123n } },
			transactions: [],
			signedMessages: [{
				website,
				created: new Date('2026-08-03T00:00:00.000Z'),
				activeAddress: address,
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
			blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 30n, deltaUnit: 'Seconds' },
			simulateWithZeroBaseFee: true,
		}
		const simulationInput: SimulationStateInput = [simulationBlock]
		const getBlockCalls = { count: 0 }
		const { ethereum } = createEthereumWithGetBlockCounter(getBlockCalls)

		const prepared = await prepareSimulationInputForRpc(simulationInput, ethereum)

		assert.strictEqual(prepared, simulationInput)
		assert.equal(getBlockCalls.count, 0)
		assert.deepEqual(prepared[0]?.signedMessages, simulationBlock.signedMessages)
		assert.deepEqual(prepared[0]?.stateOverrides, simulationBlock.stateOverrides)
		assert.deepEqual(prepared[0]?.blockTimeManipulation, simulationBlock.blockTimeManipulation)
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
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
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
			updateTabState,
			updateUserAddressBookEntries,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const safeAddress = 0x1111111111111111111111111111111111111111n
		const safeSignerAddress = 0x2222222222222222222222222222222222222222n
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: safeAddress, activeSigningAddress: safeSignerAddress, activeSigningSafeAddress: safeAddress })
		await setUseSignersAddressAsActiveAddress(false)
		await updateUserAddressBookEntries(() => [{
			type: 'safe',
			name: 'Treasury Safe',
			address: safeAddress,
			chainId: 1n,
			entrySource: 'User',
			useAsActiveAddress: true,
			safeSignerAddresses: [safeSignerAddress],
			safeVersion: '1.4.1',
		}])
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: safeAddress, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		await updateTabState(socket.tabId, (previousState) => ({
			...previousState,
			signerAccounts: [safeSignerAddress],
			activeSigningAddress: safeSignerAddress,
		}))
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
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
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })

		for (const [index, method] of [
			'connected_to_signer',
			'eth_accounts_reply',
			'InterceptorError',
			'signer_chainChanged',
			'signer_reply',
			'wallet_switchEthereumChain_reply',
		].entries()) {
			await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
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
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
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
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter(getBlockCalls)
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 1, requestSocket: socket },
			method: 'eth_accounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

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
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 2, requestSocket: socket },
			method: 'eth_accounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

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
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 3, requestSocket: socket },
			method: 'wallet_getPermissions',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

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
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: safeAddress, activeSigningAddress: signerAddress, activeSigningSafeAddress: safeAddress })
		await setUseSignersAddressAsActiveAddress(false)
		await updateUserAddressBookEntries(() => [{
			type: 'safe',
			name: 'Treasury Safe',
			address: safeAddress,
			chainId: 1n,
			entrySource: 'User',
			useAsActiveAddress: true,
			safeSimulationSignerAddress: 0x1919191919191919191919191919191919191919n,
			// Selection uses cached membership; signing still performs fresh on-chain validation before forwarding.
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
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
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
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 4, requestSocket: socket },
			method: 'wallet_getPermissions',
		}

		await settleWithin(handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus), 100, 'wallet_getPermissions did not resolve')

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
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 5, requestSocket: socket },
			method: 'wallet_getPermissions',
		}

		await settleWithin(handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus), 100, 'wallet_getPermissions did not resolve')

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
