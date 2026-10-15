import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { MessageToPopup } from '../../app/ts/types/interceptor-messages.js'
import type { InterceptedRequest } from '../../app/ts/utils/requests.js'
import { waitFor } from '../harness/async.js'
import { addressString, confirmedSignerOwnership, createEthereumWithGetBlockCounter, createPort, createRestoringBrowserMockInstaller, createSafeTx, EthereumJsonRpcRequest, loadModules, noopPublishRpcConnectionStatus, type PortMessage, safeTxToTypedDataJson } from './backgroundEthAccountsTestHarness.js'

const installBrowserMock = createRestoringBrowserMockInstaller()

// The error message of a port reply, or '' when the reply has none, so assert.match reports the missing message as a mismatch.
const readErrorMessage = (reply: PortMessage | undefined) => typeof reply?.error?.message === 'string' ? reply.error.message : ''

describe('background Safe signing gates and wallet account fallback', () => {
	test('falls back from an active Safe to a newly selected wallet account without a saved preference', async () => {
		installBrowserMock()
		const {
			changeSimulationMode,
			getActiveAddress,
			getSettings,
			getSigningAddressPreferences,
			getTabState,
			handleInterceptedRequest,
			rememberSigningAddressPreference,
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
		await rememberSigningAddressPreference({ signerAddress: safeSignerAddress, selection: 'safe', safeAddress, chainId: 1n })
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
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
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

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 208, requestSocket: socket },
			method: 'eth_accounts_reply',
			params: [{ signerProviderGeneration: 1, type: 'success', accounts: [], requestAccounts: false }],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		const settingsAfterDisconnect = await getSettings()
		assert.equal(settingsAfterDisconnect.activeSigningSafeAddress, undefined)
		assert.equal((await getActiveAddress(settingsAfterDisconnect, socket.tabId)), undefined)

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 209, requestSocket: socket },
			method: 'eth_accounts_reply',
			params: [{ signerProviderGeneration: 1, type: 'success', accounts: [addressString(safeSignerAddress)], requestAccounts: false }],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		assert.equal((await getActiveAddress(await getSettings(), socket.tabId))?.address, safeAddress)

		const otherSignerAddress = 0x5353535353535353535353535353535353535353n
		assert.equal((await getSigningAddressPreferences()).some((preference) => preference.signerAddress === otherSignerAddress), false)
		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 210, requestSocket: socket },
			method: 'eth_accounts_reply',
			params: [{ signerProviderGeneration: 1, type: 'success', accounts: [addressString(otherSignerAddress)], requestAccounts: false }],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		const settingsAfterAccountChange = await getSettings()
		assert.equal(settingsAfterAccountChange.activeSimulationAddress, safeAddress)
		assert.equal(settingsAfterAccountChange.activeSigningSafeAddress, undefined)
		assert.equal((await getActiveAddress(settingsAfterAccountChange, socket.tabId))?.address, otherSignerAddress)
		assert.equal((await getTabState(socket.tabId)).activeSigningAddress, otherSignerAddress)
		assert.equal(messages.some((message) => message.method === 'accountsChanged' && Array.isArray(message.result) && message.result.includes(addressString(otherSignerAddress))), false)
	})

	test('restores each signer account\'s last Safe-or-EOA choice when MetaMask accounts change', async () => {
		const { runtimeMessages } = installBrowserMock()
		const {
			changeSimulationMode,
			createInternalMessageListener,
			getActiveAddress,
			getSettings,
			handleInterceptedRequest,
			INTERNAL_CHANNEL_NAME,
			rememberSigningAddressPreference,
			setUseSignersAddressAsActiveAddress,
			updateTabState,
			updateUserAddressBookEntries,
			websiteSocketToString,
		} = await loadModules()
		const safeAddress = 0x5454545454545454545454545454545454545454n
		const safeOwner = 0x5555555555555555555555555555555555555555n
		const directEoa = 0x5656565656565656565656565656565656565656n
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: directEoa })
		await setUseSignersAddressAsActiveAddress(true, directEoa)
		await updateUserAddressBookEntries(() => [{
			type: 'safe',
			name: 'Remembered Safe',
			address: safeAddress,
			chainId: 1n,
			entrySource: 'User',
			useAsActiveAddress: true,
			safeSignerAddresses: [safeOwner],
		}])
		await rememberSigningAddressPreference({ signerAddress: safeOwner, selection: 'safe', safeAddress, chainId: 1n })
		await rememberSigningAddressPreference({ signerAddress: directEoa, selection: 'signer' })

		const socket = { tabId: 1, connectionName: 0n }
		await updateTabState(socket.tabId, (previousState) => ({
			...previousState,
			signerAccounts: [directEoa],
			activeSigningAddress: directEoa,
			signerChain: 1n,
		}))
		const { port } = createPort(socket.tabId)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin: 'https://remembered.example', approved: true, wantsToConnect: true },
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const selectSignerAccount = async (account: bigint, requestId: number) => await handleInterceptedRequest(port, 'https://remembered.example', { websiteOrigin: 'https://remembered.example', icon: undefined, title: undefined }, simulationServicesOwner, socket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId, requestSocket: socket },
			method: 'eth_accounts_reply',
			params: [{ signerProviderGeneration: 1, type: 'success', accounts: [addressString(account)], requestAccounts: false }],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		const settingsSeenByAccountChangeWaiters: Array<bigint | undefined> = []
		const completionChannel = new BroadcastChannel(INTERNAL_CHANNEL_NAME)
		const completionListener = createInternalMessageListener((message) => {
			if (message.method !== 'window_signer_accounts_changed') return
			void getSettings().then((currentSettings) => settingsSeenByAccountChangeWaiters.push(currentSettings.activeSigningSafeAddress))
		})
		completionChannel.addEventListener('message', completionListener)
		await selectSignerAccount(safeOwner, 209)
		await waitFor(() => settingsSeenByAccountChangeWaiters.length > 0, { description: 'an account-change waiter reading the settings' })
		completionChannel.removeEventListener('message', completionListener)
		completionChannel.close()
		assert.deepEqual(settingsSeenByAccountChangeWaiters, [safeAddress])
		let settings = await getSettings()
		assert.equal(settings.activeSigningSafeAddress, safeAddress)
		assert.equal((await getActiveAddress(settings, socket.tabId))?.address, safeAddress)
		const signingAddressUpdate = runtimeMessages
			.map((message) => MessageToPopup.safeParse(message))
			.findLast((parsed) => parsed.success && parsed.value.method === 'popup_activeSigningAddressChanged')
		if (signingAddressUpdate?.success !== true || signingAddressUpdate.value.method !== 'popup_activeSigningAddressChanged') throw new Error('Expected signing-address popup update')
		assert.equal(signingAddressUpdate.value.data.activeSigningAddress, safeAddress)
		assert.equal(signingAddressUpdate.value.data.activeSigningSafeAddress, safeAddress)

		await selectSignerAccount(directEoa, 210)
		settings = await getSettings()
		assert.equal(settings.activeSigningSafeAddress, undefined)
		assert.equal((await getActiveAddress(settings, socket.tabId))?.address, directEoa)

		await selectSignerAccount(safeOwner, 211)
		settings = await getSettings()
		assert.equal(settings.activeSigningSafeAddress, safeAddress)
		assert.equal((await getActiveAddress(settings, socket.tabId))?.address, safeAddress)
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
			signerChain: 1n,
		}))
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
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
			await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)
		}

		for (const requestId of [210, 211]) {
			const reply = messages.find((message) => message.requestId === requestId)
			assert.equal(reply?.error?.code, 4200)
			assert.match(readErrorMessage(reply), /Safe message signing request is not supported/u)
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
		assert.equal(isSafeTransactionCoSignRequest(EthereumJsonRpcRequest.parse({
			method: 'eth_signTypedData_v3',
			params: [addressString(safeAddress), safeTxToTypedDataJson(safeTx)],
		}), safeAddress, 1n), false)
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
			activeSigningSafeAddress: safeAddress,
		})
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
			signerChain: 1n,
		}))
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
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
			await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)
		}

		for (const requestId of [213, 214, 215]) {
			const reply = messages.find((message) => message.requestId === requestId)
			assert.equal(reply?.error?.code, 4200)
			assert.match(readErrorMessage(reply), /Safe message signing request is not supported/u)
		}
		const transactionReply = messages.find((message) => message.requestId === 216)
		assert.equal(transactionReply?.error?.code, 4200)
		assert.match(readErrorMessage(transactionReply), /require an Interceptor RPC connection/u)
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
			safeSignerAddresses: [safeSignerAddress],
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
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })

		await changeActiveAddressAndChain(simulationServicesOwner, websiteTabConnections, {
			simulationMode: false,
			activeAddress: safeAddress,
			signingAddressSelection: 'safe',
		})
		assert.notEqual((await getActiveAddress(await getSettings(), socket.tabId))?.address, safeAddress)
		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
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

	test('falls back to the wallet account when a signing Safe lacks cached owner membership', async () => {
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
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: safeAddress, activeSigningAddress: safeSignerAddress, activeSigningSafeAddress: safeAddress })
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
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })

		assert.equal((await getActiveAddress(await getSettings(), socket.tabId))?.address, safeSignerAddress)
		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 208, requestSocket: socket },
			method: 'eth_accounts',
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		const ethAccountsReplies = messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 208)
		assert.deepEqual(ethAccountsReplies.at(-1)?.result, [addressString(safeSignerAddress)])

		await changeActiveAddressAndChain(simulationServicesOwner, websiteTabConnections, {
			simulationMode: false,
			activeAddress: safeAddress,
			signingAddressSelection: 'safe',
		})
		assert.equal((await getActiveAddress(await getSettings(), socket.tabId))?.address, safeSignerAddress)
		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 209, requestSocket: socket },
			method: 'eth_accounts',
		}, websiteTabConnections, noopPublishRpcConnectionStatus)
		const repliesAfterSelectingSafe = messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 209)
		assert.equal(repliesAfterSelectingSafe.some((message) =>
			Array.isArray(message.result) && message.result.includes('0x5353535353535353535353535353535353535353')
		), false)

		await changeActiveAddressAndChain(simulationServicesOwner, websiteTabConnections, {
			simulationMode: false,
			activeAddress: undefined,
			signingAddressSelection: 'signer',
		})
		assert.equal((await getSettings()).activeSimulationAddress, safeAddress)
		await changeActiveAddressAndChain(simulationServicesOwner, websiteTabConnections, {
			simulationMode: true,
		})
		assert.equal((await getSettings()).activeSimulationAddress, safeAddress)
	})

	for (const access of ['denied', 'origin', 'tab']) test(`requires website authorization in addition to a confirmed signer (${ access })`, async () => {
		installBrowserMock()
		const { signerChainChanged } = await import('../../app/ts/background/providerMessageHandlers.js')
		const { changeSimulationMode, getSettings, getTabState, updateTabState, websiteSocketToString, getPendingAccessRequests } = await loadModules()
		await changeSimulationMode({ simulationMode: false, activeSigningAddress: 1n })
		const socket = { tabId: 1, connectionName: 0n }
		await updateTabState(1, previous => ({ ...previous, signerAccounts: [1n], activeSigningAddress: 1n, signerChain: 1n }))
		const { port } = createPort(1)
		const connections = new Map([[1, { ...confirmedSignerOwnership(socket), connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin: 'https://callback-authorization.example', approved: access === 'tab', wantsToConnect: false },
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const before = { settings: await getSettings(), tab: await getTabState(1), prompts: await getPendingAccessRequests() }
		const chainChange: InterceptedRequest = {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 1, requestSocket: socket },
			method: 'signer_chainChanged',
			params: ['0x2', 1],
		}
		await signerChainChanged(simulationServicesOwner, connections, port, chainChange, access === 'origin' ? 'hasAccess' : 'noAccess', 1n)
		if (access === 'denied') {
			assert.deepEqual({ settings: await getSettings(), tab: await getTabState(1), prompts: await getPendingAccessRequests() }, before)
		} else {
			assert.equal((await getSettings()).activeRpcNetwork.chainId, 2n)
			assert.equal((await getTabState(1)).signerChain, 2n)
		}
	})

	test('uses trusted signer state for simulation chain changes without website address access', async () => {
		installBrowserMock()
		const {
			changeSimulationMode,
			getSettings,
			handleInterceptedRequest,
			setUseSignersAddressAsActiveAddress,
			updateTabState,
			updateWebsiteAccess,
			websiteSocketToString,
		} = await loadModules()
		const websiteOrigin = 'https://site-only-access.example'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const previousSimulationAddress = 0x6161616161616161616161616161616161616161n
		const signerAddress = 0x6262626262626262626262626262626262626262n
		const socket = { tabId: 1, connectionName: 0n }
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: previousSimulationAddress, activeSigningAddress: signerAddress })
		await setUseSignersAddressAsActiveAddress(true)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [] }])
		await updateTabState(socket.tabId, (previousState) => ({
			...previousState,
			signerAccounts: [signerAddress],
			activeSigningAddress: signerAddress,
			signerChain: 1n,
		}))
		const { port } = createPort(socket.tabId)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })

		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 212, requestSocket: socket },
			method: 'signer_chainChanged',
			params: ['0x2', 1],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		const settings = await getSettings()
		assert.equal(settings.activeRpcNetwork.chainId, 2n)
		assert.equal(settings.activeSimulationAddress, signerAddress)
	})

	test('follows wallet chain changes when the stored signing Safe is no longer owned', async () => {
		installBrowserMock()
		const {
			changeSimulationMode,
			getActiveAddress,
			getSettings,
			handleInterceptedRequest,
			updateTabState,
			updateUserAddressBookEntries,
			websiteSocketToString,
		} = await loadModules()
		const websiteOrigin = 'https://stale-safe-chain.example'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const signerAddress = 0x6363636363636363636363636363636363636363n
		const safeAddress = 0x6464646464646464646464646464646464646464n
		const formerOwner = 0x6565656565656565656565656565656565656565n
		const socket = { tabId: 1, connectionName: 0n }
		await changeSimulationMode({ simulationMode: false, activeSigningAddress: signerAddress, activeSigningSafeAddress: safeAddress })
		await updateUserAddressBookEntries(() => [{
			type: 'safe',
			name: 'Stale signing Safe',
			address: safeAddress,
			chainId: 1n,
			entrySource: 'User',
			useAsActiveAddress: true,
			safeSignerAddresses: [formerOwner],
		}])
		await updateTabState(socket.tabId, (previousState) => ({
			...previousState,
			signerAccounts: [signerAddress],
			activeSigningAddress: signerAddress,
			signerChain: 1n,
		}))
		const { port } = createPort(socket.tabId)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })

		assert.equal((await getActiveAddress(await getSettings(), socket.tabId))?.address, signerAddress)
		await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 213, requestSocket: socket },
			method: 'signer_chainChanged',
			params: ['0x2', 1],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		const settings = await getSettings()
		assert.equal(settings.activeRpcNetwork.chainId, 2n)
		assert.equal(settings.activeSigningSafeAddress, undefined)
		assert.equal((await getActiveAddress(settings, socket.tabId))?.address, signerAddress)
	})
})
