import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { createSafeTx } from '../../app/ts/safe/safeCore.js'
import { MessageToPopup } from '../../app/ts/types/interceptor-messages.js'
import type { RpcEntry } from '../../app/ts/types/rpc.js'
import { createPort, createRestoringBrowserMockInstaller, createTestSimulationServicesOwner } from './backgroundEthAccountsTestHarness.js'
import { hasMessageMethod } from './runtimeMessageMatchers.js'
import { createStubEthereumClient } from './stubEthereumClient.js'
import { readProperty } from '../harness/assertions.js'

const installBrowserMock = createRestoringBrowserMockInstaller()

// The popup messages the background sent through browser.runtime.sendMessage, parsed back from their wire format.
const parsePopupMessages = (messages: readonly unknown[]) => messages.flatMap((message) => {
	const parsed = MessageToPopup.safeParse(message)
	return parsed.success ? [parsed.value] : []
})

const getLatestHomePageUpdate = (messages: readonly unknown[]) => parsePopupMessages(messages).flatMap((message) => message.method === 'popup_UpdateHomePage' ? [message] : []).at(-1)

const getLatestHomePageBootstrap = (messages: readonly unknown[]) => parsePopupMessages(messages).flatMap((message) => message.method === 'popup_homePageBootstrap' ? [message] : []).at(-1)

// RPC requests never settle, so home data is assembled from cached state only.
const createUnresponsiveEthereumClient = (rpcNetwork: RpcEntry) => createStubEthereumClient(async () => await new Promise<never>(() => undefined), rpcNetwork)

async function loadModules() {
	const storageVariables = await import('../../app/ts/background/storageVariables.js')
	return {
		...await import('../../app/ts/utils/storageUtils.js'),
		...await import('../../app/ts/background/settings.js'),
		...storageVariables,
		...await import('../../app/ts/background/popupMessageHandlers/home.js'),
		...await import('../../app/ts/background/popupMessageHandlers/settings.js'),
		...await import('../../app/ts/background/backgroundUtils.js'),
		...await import('../../app/ts/simulation/services/priceEstimator.js'),
	}
}

type TestModules = Awaited<ReturnType<typeof loadModules>>

describe('refreshHomeData', () => {
	test('sends a fresh home snapshot with the woken retry state', async () => {
		const browserMock = installBrowserMock()
		const modules: TestModules = await loadModules()
		const { browserStorageLocalSet, defaultActiveAddresses, defaultRpcs, setRpcConnectionStatus, refreshHomeData, TokenPriceService } = modules

		const [defaultAddress] = defaultActiveAddresses
		if (defaultAddress === undefined) throw new Error('missing default address')
		const rpcNetwork = defaultRpcs[0]
		if (rpcNetwork === undefined) throw new Error('missing default rpc')

		await browserStorageLocalSet({
			independentActiveSimulationAddress: defaultAddress.address,
			openedPageV2: { page: 'Home' },
			useSignersAddressAsActiveAddress: false,
			websiteAccess: [],
			activeRpcNetwork: rpcNetwork,
			simulationMode: false,
			makeCurrentAddressRich: false,
			fixedAddressRichList: [],
		})
		await setRpcConnectionStatus({
			isConnected: false,
			lastConnnectionAttempt: new Date('2024-01-01T00:00:00.000Z'),
			latestBlock: undefined,
			rpcNetwork,
			retrying: false,
		})

		const ethereum = createUnresponsiveEthereumClient(rpcNetwork)
		const tokenPriceService = new TokenPriceService(ethereum, 0)

		try {
			await refreshHomeData(ethereum, tokenPriceService, new Map(), true, 1, async (_method, rpcConnectionStatus) => await setRpcConnectionStatus(rpcConnectionStatus), false)
		} finally {
			ethereum.cleanup()
		}

		const homeUpdate = getLatestHomePageUpdate(browserMock.runtimeMessages)
		assert.equal(homeUpdate?.homeDataSource, 'fresh')
		assert.equal(homeUpdate?.data?.rpcConnectionStatus?.retrying, true)
	})

	test('refresh path waits for signer accounts when missing but refresh is enabled', async () => {
		const browserMock = installBrowserMock()
		const modules: TestModules = await loadModules()
		const {
			browserStorageLocalSet,
			saveCurrentTabId,
			updateTabState,
			setRpcConnectionStatus,
			refreshHomeData,
			defaultActiveAddresses,
			defaultRpcs,
			websiteSocketToString,
			sendInternalWindowMessage,
			TokenPriceService,
			getTabState,
		} = modules
		const [defaultAddress] = defaultActiveAddresses
		if (defaultAddress === undefined) throw new Error('missing default address')
		const rpcNetwork = defaultRpcs[0]
		if (rpcNetwork === undefined) throw new Error('missing default rpc')
		await browserStorageLocalSet({
			independentActiveSimulationAddress: defaultAddress.address,
			openedPageV2: { page: 'Home' },
			useSignersAddressAsActiveAddress: false,
			websiteAccess: [],
			activeRpcNetwork: rpcNetwork,
			simulationMode: false,
			makeCurrentAddressRich: false,
			fixedAddressRichList: [],
		})
		await setRpcConnectionStatus({
			isConnected: false,
			lastConnnectionAttempt: new Date('2024-01-01T00:00:00.000Z'),
			latestBlock: undefined,
			rpcNetwork,
			retrying: false,
		})
		await saveCurrentTabId(1)
		await updateTabState(1, (previousState) => ({
			...previousState,
			website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
			signerName: 'MetaMask',
			signerAccounts: [],
		}))

		const signerAccount = 0x4444444444444444444444444444444444444444n
		const socket = { tabId: 1, connectionName: 0n }
		let requestCount = 0
		const { port } = createPort(socket.tabId, async (message) => {
			if (message.method !== 'request_signer_to_eth_accounts') return
			requestCount += 1
			void updateTabState(socket.tabId, (previousState) => ({
				...previousState,
				signerAccounts: [signerAccount],
				activeSigningAddress: signerAccount,
			})).then(() => {
				sendInternalWindowMessage({
					method: 'window_signer_accounts_changed',
					data: { socket, signerStateOwnerGeneration: 1, signerProviderGeneration: 1 },
				})
			})
		})
		const websiteTabConnections = new Map([[socket.tabId, {
			signerStateOwner: {
				connectionName: socket.connectionName,
				confirmed: true,
				generation: 1,
				providerGeneration: 1,
			},
			connections: {
				[websiteSocketToString(socket)]: { port, socket, websiteOrigin: 'https://example.com', approved: true, wantsToConnect: true },
			},
		}]])
		const ethereum = createUnresponsiveEthereumClient(rpcNetwork)
		const tokenPriceService = new TokenPriceService(ethereum, 0)

		try {
			await refreshHomeData(ethereum, tokenPriceService, websiteTabConnections, true, 1, async (_method, rpcConnectionStatus) => await setRpcConnectionStatus(rpcConnectionStatus), false)
		} finally {
			ethereum.cleanup()
		}

		const homeUpdate = getLatestHomePageUpdate(browserMock.runtimeMessages)
		const updatedState = await getTabState(1)
		const result = homeUpdate?.data?.tabState?.signerAccounts
		assert.equal(requestCount, 1)
		assert.equal(result?.length, 1)
		assert.equal(result?.[0], signerAccount)
		assert.equal(updatedState.signerAccounts?.[0], signerAccount)
	})

	test('home data falls back to signer accounts for active address when activeSigningAddress is unset', async () => {
		const browserMock = installBrowserMock()
		const modules: TestModules = await loadModules()
		const { browserStorageLocalSet, saveCurrentTabId, updateTabState, updateUserAddressBookEntries, setRpcConnectionStatus, requestNewHomeData, defaultActiveAddresses, defaultRpcs, websiteSocketToString } = modules

		const [defaultAddress] = defaultActiveAddresses
		if (defaultAddress === undefined) throw new Error('missing default address')
		const rpcNetwork = defaultRpcs[0]
		if (rpcNetwork === undefined) throw new Error('missing default rpc')
		await browserStorageLocalSet({
			independentActiveSimulationAddress: defaultAddress.address,
			openedPageV2: { page: 'Home' },
			useSignersAddressAsActiveAddress: false,
			websiteAccess: [],
			activeRpcNetwork: rpcNetwork,
			simulationMode: false,
			makeCurrentAddressRich: false,
			fixedAddressRichList: [{ address: defaultAddress.address, makingRich: true, type: 'UserAdded' }],
		})
		await updateUserAddressBookEntries(() => [
			{ type: 'contact', name: 'Wrong-chain rich address', address: defaultAddress.address, chainId: rpcNetwork.chainId + 1n, entrySource: 'User', useAsActiveAddress: true, askForAddressAccess: true },
			{ type: 'contact', name: 'Current-chain rich address', address: defaultAddress.address, chainId: rpcNetwork.chainId, entrySource: 'User', useAsActiveAddress: true, askForAddressAccess: true },
		])
		await setRpcConnectionStatus({
			isConnected: false,
			lastConnnectionAttempt: new Date('2024-01-01T00:00:00.000Z'),
			latestBlock: undefined,
			rpcNetwork,
			retrying: false,
		})
		await saveCurrentTabId(1)
		const signerAddress = 0x4444444444444444444444444444444444444444n
		await updateTabState(1, (previousState) => ({
			...previousState,
			website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
			signerName: 'MetaMask',
			signerAccounts: [signerAddress],
			activeSigningAddress: undefined,
		}))

		const ethereum = createUnresponsiveEthereumClient(rpcNetwork)
		const socket = { tabId: 1, connectionName: 0n }
		const { port } = createPort(socket.tabId)
		const websiteTabConnections = new Map([[socket.tabId, {
			signerStateOwner: {
				connectionName: socket.connectionName,
				confirmed: true,
				generation: 1,
				providerGeneration: 1,
			},
			connections: {
				[websiteSocketToString(socket)]: { port, socket, websiteOrigin: 'https://example.com', approved: true, wantsToConnect: true },
			},
		}]])

		try {
			await requestNewHomeData(ethereum, websiteTabConnections, false, false, undefined, 1)
		} finally {
			ethereum.cleanup()
		}

		const homeUpdate = getLatestHomePageUpdate(browserMock.runtimeMessages)
		assert.equal(homeUpdate?.data?.activeSigningAddressInThisTab, signerAddress)
		assert.equal(getLatestHomePageUpdate(browserMock.runtimeMessages)?.data?.richList?.[0]?.addressBookEntry.name, 'Current-chain rich address')
		assert.equal(homeUpdate?.data?.tabState?.signerAccounts?.[0], signerAddress)
	})

	test('home bootstrap uses mode-aware active address resolution without a simulation snapshot', async () => {
		const browserMock = installBrowserMock()
		const modules: TestModules = await loadModules()
		const { browserStorageLocalSet, saveCurrentTabId, updateTabState, updateTransactionState, requestHomePageBootstrap, requestNewHomeData, defaultActiveAddresses, defaultRpcs, websiteSocketToString } = modules

		const [defaultAddress] = defaultActiveAddresses
		if (defaultAddress === undefined) throw new Error('missing default address')
		const rpcNetwork = defaultRpcs[0]
		if (rpcNetwork === undefined) throw new Error('missing default rpc')
		const signerAddress = 0x5555555555555555555555555555555555555555n
		await browserStorageLocalSet({
			independentActiveSimulationAddress: defaultAddress.address,
			openedPageV2: { page: 'Home' },
			useSignersAddressAsActiveAddress: false,
			websiteAccess: [],
			activeRpcNetwork: rpcNetwork,
			simulationMode: false,
			userAddressBookEntriesV3: [
				defaultAddress,
				{
					type: 'contact',
					name: 'Named signer contact',
					address: signerAddress,
					entrySource: 'User',
					useAsActiveAddress: false,
				},
			],
		})
		await saveCurrentTabId(1)
		await updateTabState(1, (previousState) => ({
			...previousState,
			signerName: 'MetaMask',
			signerAccounts: [signerAddress],
			activeSigningAddress: undefined,
		}))
		await updateTransactionState((previousState) => ({
			...previousState,
			safeTransactionStacks: [{
				chainId: rpcNetwork.chainId,
				safeAddress: defaultAddress.address,
				safeVersion: '1.4.1',
				baseNonce: 0n,
				threshold: 1n,
				transactions: [{
					safeTx: createSafeTx(rpcNetwork.chainId, defaultAddress.address, {
						to: defaultAddress.address,
						value: 0n,
						input: new Uint8Array(),
					}, 0n),
					safeTxHash: 0n,
					created: new Date('2024-01-01T00:00:00.000Z'),
					websiteOrigin: 'https://example.com',
					transactionIdentifier: 1n,
					signatures: [],
				}],
			}],
		}))
		const socket = { tabId: 1, connectionName: 0n }
		const { port } = createPort(socket.tabId)
		const websiteTabConnections = new Map([[socket.tabId, {
			signerStateOwner: {
				connectionName: socket.connectionName,
				confirmed: true,
				generation: 1,
				providerGeneration: 1,
			},
			connections: {
				[websiteSocketToString(socket)]: { port, socket, websiteOrigin: 'https://example.com', approved: true, wantsToConnect: true },
			},
		}]])

		await requestHomePageBootstrap(websiteTabConnections, 7)

		const bootstrap = getLatestHomePageBootstrap(browserMock.runtimeMessages)
		assert.equal(bootstrap?.popupRefreshGeneration, 7)
		assert.equal(bootstrap?.data?.activeSigningAddressInThisTab, signerAddress)
		assert.equal(bootstrap?.data?.walletSelectedAddressBookEntry?.name, 'Named signer contact')
		assert.equal(bootstrap?.data?.hasSafeTransactionsToExport, true)
		assert.equal(bootstrap?.data?.activeAddresses?.some((entry) => entry.address === signerAddress), false)
		assert.equal(bootstrap?.data?.settings?.simulationMode, false)
		const rawBootstrap = browserMock.runtimeMessages.filter((message) => hasMessageMethod(message, 'popup_homePageBootstrap')).at(-1)
		assert.equal(readProperty(readProperty(rawBootstrap, 'data'), 'visualizedSimulatorState'), undefined)

		await browserStorageLocalSet({ simulationMode: true })
		await requestHomePageBootstrap(websiteTabConnections, 8)

		const simulationBootstrap = getLatestHomePageBootstrap(browserMock.runtimeMessages)
		assert.equal(simulationBootstrap?.popupRefreshGeneration, 8)
		assert.equal(simulationBootstrap?.data?.activeSigningAddressInThisTab, defaultAddress.address)
		assert.equal(simulationBootstrap?.data?.settings?.simulationMode, true)

		const ethereum = createUnresponsiveEthereumClient(rpcNetwork)
		try {
			await requestNewHomeData(ethereum, websiteTabConnections, false, false, undefined, 9)
		} finally {
			ethereum.cleanup()
		}

		const fullHomeData = getLatestHomePageUpdate(browserMock.runtimeMessages)
		assert.equal(fullHomeData?.data?.activeSigningAddressInThisTab, defaultAddress.address)
		assert.equal(fullHomeData?.data?.walletSelectedAddressBookEntry?.name, 'Named signer contact')
	})

	test('home bootstrap hides cached signer addresses without a confirmed signer owner', async () => {
		const browserMock = installBrowserMock()
		const modules: TestModules = await loadModules()
		const { browserStorageLocalSet, saveCurrentTabId, updateTabState, requestHomePageBootstrap, defaultActiveAddresses, defaultRpcs } = modules

		const [defaultAddress] = defaultActiveAddresses
		if (defaultAddress === undefined) throw new Error('missing default address')
		const rpcNetwork = defaultRpcs[0]
		if (rpcNetwork === undefined) throw new Error('missing default rpc')
		const staleSignerAddress = 0x6666666666666666666666666666666666666666n
		await browserStorageLocalSet({
			independentActiveSimulationAddress: defaultAddress.address,
			openedPageV2: { page: 'Home' },
			useSignersAddressAsActiveAddress: false,
			websiteAccess: [],
			activeRpcNetwork: rpcNetwork,
			simulationMode: false,
		})
		await saveCurrentTabId(1)
		await updateTabState(1, (previousState) => ({
			...previousState,
			signerName: 'MetaMask',
			signerAccounts: [staleSignerAddress],
			activeSigningAddress: staleSignerAddress,
		}))

		await requestHomePageBootstrap(new Map(), 10)

		const bootstrap = getLatestHomePageBootstrap(browserMock.runtimeMessages)
		assert.equal(bootstrap?.data?.activeSigningAddressInThisTab, undefined)
		assert.equal(bootstrap?.data?.settings?.simulationMode, false)
	})

	test('bootstrap and full home data share the interceptor-disabled state for the current website', async () => {
		const browserMock = installBrowserMock()
		const modules: TestModules = await loadModules()
		const { browserStorageLocalSet, saveCurrentTabId, updateTabState, requestHomePageBootstrap, requestNewHomeData, defaultActiveAddresses, defaultRpcs } = modules

		const [defaultAddress] = defaultActiveAddresses
		if (defaultAddress === undefined) throw new Error('missing default address')
		const rpcNetwork = defaultRpcs[0]
		if (rpcNetwork === undefined) throw new Error('missing default rpc')
		const website = { websiteOrigin: 'https://disabled.example', icon: undefined, title: 'Disabled Example' }
		await browserStorageLocalSet({
			independentActiveSimulationAddress: defaultAddress.address,
			openedPageV2: { page: 'Home' },
			useSignersAddressAsActiveAddress: false,
			websiteAccess: [{
				website,
				addressAccess: [],
				access: true,
				interceptorDisabled: true,
			}],
			activeRpcNetwork: rpcNetwork,
			simulationMode: false,
			makeCurrentAddressRich: false,
			fixedAddressRichList: [],
		})
		await saveCurrentTabId(1)
		await updateTabState(1, (previousState) => ({
			...previousState,
			website,
		}))

		await requestHomePageBootstrap(new Map(), 11)

		const ethereum = createUnresponsiveEthereumClient(rpcNetwork)
		try {
			await requestNewHomeData(ethereum, new Map(), false, false, undefined, 12)
		} finally {
			ethereum.cleanup()
		}

		const bootstrap = getLatestHomePageBootstrap(browserMock.runtimeMessages)
		const fullHomeData = getLatestHomePageUpdate(browserMock.runtimeMessages)
		assert.equal(bootstrap?.data?.interceptorDisabled, true)
		assert.equal(fullHomeData?.data?.interceptorDisabled, true)
	})

	test('cached home snapshot refreshes signer accounts only when requested', async () => {
		const browserMock = installBrowserMock()
		const modules: TestModules = await loadModules()
		const {
			browserStorageLocalSet,
			saveCurrentTabId,
			updateTabState,
			updateUserAddressBookEntries,
			requestNewHomeData,
			defaultActiveAddresses,
			defaultRpcs,
			websiteSocketToString,
			sendInternalWindowMessage,
			getTabState,
		} = modules
		const [defaultAddress] = defaultActiveAddresses
		if (defaultAddress === undefined) throw new Error('missing default address')
		const rpcNetwork = defaultRpcs[0]
		if (rpcNetwork === undefined) throw new Error('missing default rpc')
		await browserStorageLocalSet({
			independentActiveSimulationAddress: defaultAddress.address,
			openedPageV2: { page: 'Home' },
			useSignersAddressAsActiveAddress: false,
			websiteAccess: [],
			activeRpcNetwork: rpcNetwork,
			simulationMode: false,
			makeCurrentAddressRich: false,
			fixedAddressRichList: [],
		})
		await saveCurrentTabId(1)
		await updateTabState(1, (previousState) => ({
			...previousState,
			website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
			signerName: 'MetaMask',
			signerAccounts: [],
		}))

		const signerAccount = 0x5555555555555555555555555555555555555555n
		const signingSafe = 0x5656565656565656565656565656565656565656n
		await updateUserAddressBookEntries(() => [{
			type: 'safe',
			name: 'Remembered Safe',
			address: signingSafe,
			chainId: rpcNetwork.chainId,
			entrySource: 'User',
			useAsActiveAddress: true,
			safeSignerAddresses: [signerAccount],
		}])
		await browserStorageLocalSet({
			websiteAccess: [{
				website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
				addressAccess: [{ address: signerAccount, access: true }],
				access: true,
			}],
		})
		const socket = { tabId: 1, connectionName: 0n }
		let requestCount = 0
		const { port } = createPort(socket.tabId, async (message) => {
			if (message.method !== 'request_signer_to_eth_accounts') return
			requestCount += 1
			void (async () => {
				await updateTabState(socket.tabId, (previousState) => ({
					...previousState,
					signerAccounts: [signerAccount],
					activeSigningAddress: signerAccount,
				}))
				await browserStorageLocalSet({ activeSigningSafeAddress: signingSafe })
				sendInternalWindowMessage({
					method: 'window_signer_accounts_changed',
					data: { socket, signerStateOwnerGeneration: 1, signerProviderGeneration: 1 },
				})
			})()
		})
		const websiteTabConnections = new Map([[socket.tabId, {
			signerStateOwner: {
				connectionName: socket.connectionName,
				confirmed: true,
				generation: 1,
				providerGeneration: 1,
			},
			connections: {
				[websiteSocketToString(socket)]: { port, socket, websiteOrigin: 'https://example.com', approved: true, wantsToConnect: true },
			},
		}]])
		const ethereum = createUnresponsiveEthereumClient(rpcNetwork)

		try {
			await requestNewHomeData(ethereum, websiteTabConnections, false, false, undefined, 1)
			const fastHomeUpdate = getLatestHomePageUpdate(browserMock.runtimeMessages)
			assert.equal(fastHomeUpdate?.homeDataSource, 'cached')
			assert.equal(fastHomeUpdate?.data?.websiteAccessAddressMetadata?.length, 0)
			assert.equal(requestCount, 0)

			await requestNewHomeData(ethereum, websiteTabConnections, true, true, undefined, 2)
		} finally {
			ethereum.cleanup()
		}

		const homeUpdate = getLatestHomePageUpdate(browserMock.runtimeMessages)
		const updatedState = await getTabState(1)
		const result = homeUpdate?.data?.tabState?.signerAccounts
		assert.equal(requestCount, 1)
		assert.equal(result?.[0], signerAccount)
		assert.equal(homeUpdate?.data?.websiteAccessAddressMetadata?.length, 1)
		assert.equal(updatedState.signerAccounts?.[0], signerAccount)
		assert.equal(homeUpdate?.data?.activeSigningAddressInThisTab, signingSafe)
		assert.equal(homeUpdate?.data?.settings?.activeSigningSafeAddress, signingSafe)
	})

	test('refresh path does not request signer accounts with no approved socket', async () => {
		const browserMock = installBrowserMock()
		const { browserStorageLocalSet, saveCurrentTabId, updateTabState, setRpcConnectionStatus, refreshHomeData, defaultActiveAddresses, defaultRpcs, TokenPriceService } = await loadModules()

		const [defaultAddress] = defaultActiveAddresses
		if (defaultAddress === undefined) throw new Error('missing default address')
		const rpcNetwork = defaultRpcs[0]
		if (rpcNetwork === undefined) throw new Error('missing default rpc')
		await browserStorageLocalSet({
			independentActiveSimulationAddress: defaultAddress.address,
			openedPageV2: { page: 'Home' },
			useSignersAddressAsActiveAddress: false,
			websiteAccess: [],
			activeRpcNetwork: rpcNetwork,
			simulationMode: false,
			makeCurrentAddressRich: false,
			fixedAddressRichList: [],
		})
		await setRpcConnectionStatus({
			isConnected: false,
			lastConnnectionAttempt: new Date('2024-01-01T00:00:00.000Z'),
			latestBlock: undefined,
			rpcNetwork,
			retrying: false,
		})
		await saveCurrentTabId(1)
		await updateTabState(1, (previousState) => ({
			...previousState,
			website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
			signerName: 'MetaMask',
			signerAccounts: [],
		}))

		const ethereum = createUnresponsiveEthereumClient(rpcNetwork)
		const tokenPriceService = new TokenPriceService(ethereum, 0)

		try {
			await refreshHomeData(ethereum, tokenPriceService, new Map(), true, 1, async (_method, rpcConnectionStatus) => await setRpcConnectionStatus(rpcConnectionStatus), false)
		} finally {
			ethereum.cleanup()
		}

		const homeUpdate = getLatestHomePageUpdate(browserMock.runtimeMessages)
		assert.equal(homeUpdate?.data?.tabState?.signerAccounts?.length, 0)
	})

	test('changeSettings refreshes home without triggering signer account refresh', async () => {
		const browserMock = installBrowserMock()
		const { browserStorageLocalSet, saveCurrentTabId, updateTabState, setRpcConnectionStatus, changeSettings, defaultActiveAddresses, defaultRpcs, websiteSocketToString, TokenPriceService } = await loadModules()

		const [defaultAddress] = defaultActiveAddresses
		if (defaultAddress === undefined) throw new Error('missing default address')
		const rpcNetwork = defaultRpcs[0]
		if (rpcNetwork === undefined) throw new Error('missing default rpc')
		await browserStorageLocalSet({
			independentActiveSimulationAddress: defaultAddress.address,
			openedPageV2: { page: 'Home' },
			useSignersAddressAsActiveAddress: false,
			websiteAccess: [{
				website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
				addressAccess: [{ address: defaultAddress.address, access: true }],
				access: true,
			}],
			activeRpcNetwork: rpcNetwork,
			simulationMode: false,
			makeCurrentAddressRich: false,
			fixedAddressRichList: [],
		})
		await setRpcConnectionStatus({
			isConnected: false,
			lastConnnectionAttempt: new Date('2024-01-01T00:00:00.000Z'),
			latestBlock: undefined,
			rpcNetwork,
			retrying: false,
		})
		await saveCurrentTabId(1)
		const signerAddress = 0x4444444444444444444444444444444444444444n
		await updateTabState(1, (previousState) => ({
			...previousState,
			website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
			signerName: 'MetaMask',
			signerAccounts: [signerAddress],
		}))

		const ethereum = createUnresponsiveEthereumClient(rpcNetwork)
		const tokenPriceService = new TokenPriceService(ethereum, 0)
		const socket = { tabId: 1, connectionName: 0n }
		const { messages, port } = createPort(socket.tabId)
		const websiteTabConnections = new Map([[socket.tabId, {
			signerStateOwner: {
				connectionName: socket.connectionName,
				confirmed: true,
				generation: 1,
				providerGeneration: 1,
			},
			connections: {
				[websiteSocketToString(socket)]: { port, socket, websiteOrigin: 'https://example.com', approved: true, wantsToConnect: true },
			},
		}]])

		try {
			await changeSettings(createTestSimulationServicesOwner({ ethereum, tokenPriceService }), websiteTabConnections, { method: 'popup_ChangeSettings', data: { safeAppsCompatibilityMode: false } }, undefined)
		} finally {
			ethereum.cleanup()
		}

		const requestMessages = browserMock.runtimeMessages.filter((message) => hasMessageMethod(message, 'request_signer_to_eth_accounts'))
		const homeUpdate = getLatestHomePageUpdate(browserMock.runtimeMessages)
		assert.equal(requestMessages.length, 0)
		assert.equal(homeUpdate?.data?.activeSigningAddressInThisTab, signerAddress)
		assert.equal(homeUpdate?.data?.websiteAccessAddressMetadata?.length, 1)
		assert.equal(messages.some((message) => message.method === 'safe_apps_compatibility'), false)
	})
})
