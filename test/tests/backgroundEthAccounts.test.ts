import * as assert from 'assert'
import { describe, test } from 'bun:test'
import type { ResetSimulationServices } from '../../app/ts/simulation/serviceLifecycle.js'
import { EthereumJSONRpcRequestHandler } from '../../app/ts/simulation/services/EthereumJSONRpcRequestHandler.js'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import { TokenPriceService } from '../../app/ts/simulation/services/priceEstimator.js'
import type { RpcEntry } from '../../app/ts/types/rpc.js'
import type { PublishRpcConnectionStatus } from '../../app/ts/background/rpcSlowRequestTracking.js'

type Listener = () => void
type PortMessage = { type?: unknown, method?: unknown, result?: unknown, requestId?: unknown, error?: { code?: unknown, message?: unknown } }
const noopPublishRpcConnectionStatus: PublishRpcConnectionStatus = async () => undefined

function installBrowserMock() {
	const storageState: Record<string, unknown> = {}
	;(globalThis as typeof globalThis & { browser: typeof globalThis.browser }).browser = {
		runtime: {
			lastError: null,
			async sendMessage() {
				return undefined
			},
			getManifest: () => ({ manifest_version: 3 }),
			onMessage: { addListener: (_listener: Listener) => undefined, removeListener: (_listener: Listener) => undefined },
			onConnect: { addListener: (_listener: Listener) => undefined, removeListener: (_listener: Listener) => undefined },
		},
		storage: {
			local: {
				async get(keys?: string | string[] | Record<string, unknown> | null) {
					if (keys === undefined || keys === null) return { ...storageState }
					if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => key in storageState).map((key) => [key, storageState[key]]))
					if (typeof keys === 'string') return keys in storageState ? { [keys]: storageState[keys] } : {}
					return Object.fromEntries(Object.entries(keys).map(([key, defaultValue]) => [key, key in storageState ? storageState[key] : defaultValue]))
				},
				async set(items: Record<string, unknown>) {
					Object.assign(storageState, items)
				},
				async remove(keys: string | string[]) {
					for (const key of Array.isArray(keys) ? keys : [keys]) delete storageState[key]
				},
			},
		},
		tabs: {
			async query() { return [] },
			async create() { return { id: 2, active: true } },
			async get(tabId: number) { return { id: tabId, active: true } },
			async update() { return undefined },
			async remove() { return undefined },
			onUpdated: { addListener: (_listener: Listener) => undefined, removeListener: (_listener: Listener) => undefined },
			onRemoved: { addListener: (_listener: Listener) => undefined, removeListener: (_listener: Listener) => undefined },
		},
		windows: {
			async create() { return { id: 2, focused: true } },
			async get(windowId: number) { return { id: windowId, focused: true } },
			async update() { return undefined },
			async remove() { return undefined },
			onRemoved: { addListener: (_listener: Listener) => undefined, removeListener: (_listener: Listener) => undefined },
		},
		action: {
			async setIcon() { return undefined },
			async setTitle() { return undefined },
			async setBadgeText() { return undefined },
			async setBadgeBackgroundColor() { return undefined },
		},
		browserAction: {
			async setIcon() { return undefined },
			async setTitle() { return undefined },
			async setBadgeText() { return undefined },
			async setBadgeBackgroundColor() { return undefined },
		},
		declarativeNetRequest: {
			async getDynamicRules() { return [] },
			async getSessionRules() { return [] },
			async updateDynamicRules() { return undefined },
			async updateSessionRules() { return undefined },
		},
	} as unknown as typeof globalThis.browser
	;(globalThis as typeof globalThis & { chrome: { runtime: { id: string } } }).chrome = { runtime: { id: 'test-extension' } }
	;(globalThis as typeof globalThis & { location: Location }).location = { origin: '' } as unknown as Location
}

async function loadModules() {
	return {
		...await import('../../app/ts/background/accessManagement.js'),
		...await import('../../app/ts/background/background.js'),
		...await import('../../app/ts/background/backgroundUtils.js'),
		...await import('../../app/ts/background/settings.js'),
		...await import('../../app/ts/background/storageVariables.js'),
		...await import('../../app/ts/background/windows/interceptorAccess.js'),
	}
}

function createPort(tabId: number, onPostMessage?: (message: PortMessage) => void) {
	const messages: PortMessage[] = []
	const port = {
		name: '0x0',
		sender: { tab: { id: tabId } },
		postMessage(message: unknown) {
			const typedMessage = message as PortMessage
			messages.push(typedMessage)
			onPostMessage?.(typedMessage)
		},
	} as unknown as browser.runtime.Port
	return { port, messages }
}

function createEthereumWithGetBlockCounter(getBlockCalls: { count: number }, initialBlockPolling = true) {
	const rpcEntry: RpcEntry = {
		name: 'Test RPC',
		chainId: 1n,
		httpsRpc: 'http://127.0.0.1:8545',
		currencyName: 'Ether',
		currencyTicker: 'ETH',
		primary: true,
		minimized: false,
	}
	let blockPolling = initialBlockPolling
	const ethereum = new Proxy(
		new EthereumClientService(
			new EthereumJSONRpcRequestHandler(rpcEntry.httpsRpc),
			async () => undefined,
			async () => undefined,
			rpcEntry,
	),
		{
			get(target, property, receiver) {
				if (property === 'isBlockPolling') return () => blockPolling
				if (property === 'setBlockPolling') return (enabled: boolean) => {
					blockPolling = enabled
				}
				if (property === 'getBlock') {
					return async () => {
						getBlockCalls.count += 1
						return null
					}
				}
				return Reflect.get(target, property, receiver)
			},
		},
	)
	return {
		ethereum,
		tokenPriceService: new TokenPriceService(ethereum, 60_000),
		resetSimulationServices: (() => undefined) satisfies ResetSimulationServices,
	}
}

describe('background eth_accounts', () => {
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
		const websiteTabConnections = new Map([[socket.tabId, { connections: {
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
		const websiteTabConnections = new Map([[socket.tabId, { connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 9, requestSocket: socket },
			method: 'eth_accounts_reply',
			params: [{ type: 'success', accounts: ['0x3333333333333333333333333333333333333333'], requestAccounts: false }],
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
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { connections: {
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

	test('awaits retry-state publishing before replying to a waking RPC request', async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, changeSimulationMode, setUseSignersAddressAsActiveAddress, updateWebsiteAccess, setRpcConnectionStatus, getRpcConnectionStatus } = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x1111111111111111111111111111111111111111n
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 }, false)
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
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 }, false)
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
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId, (message) => {
			if (message.method !== 'request_signer_to_eth_accounts') return
			void (async () => {
				await updateTabState(socket.tabId, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: account }))
				sendInternalWindowMessage({ method: 'window_signer_accounts_changed', data: { socket } })
			})()
		})
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { connections: {
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
					params: [{ type: 'success', accounts: [accountString], requestAccounts: true }],
				}, websiteTabConnections, noopPublishRpcConnectionStatus)
			}
			if (message.method === 'eth_accounts' && message.requestId === 9) {
				void getTabState(socket.tabId).then((tabState) => {
					stateAtDappReply.push(tabState.activeSigningAddress)
				})
			}
		})
		const port = createdPort
		const { port: siblingPort, messages: siblingMessages } = createPort(siblingSocket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const siblingConnectionKey = websiteSocketToString(siblingSocket)
		const websiteTabConnections = new Map([[socket.tabId, { connections: {
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
		const connectMessages = messages.filter((message) => message.method === 'connect')
		const connectIndex = messages.findIndex((message) => message.method === 'connect')
		const accountChangedMessages = messages.filter((message) => message.method === 'accountsChanged')
		const accountChangedIndex = messages.findIndex((message) => message.method === 'accountsChanged')
		assert.notEqual(requestAccountsReplyIndex, -1)
		assert.notEqual(connectIndex, -1)
		assert.notEqual(accountChangedIndex, -1)
		assert.equal(connectIndex < accountChangedIndex, true)
		assert.equal(accountChangedIndex < requestAccountsReplyIndex, true)
		assert.deepEqual(connectMessages.map((message) => message.result), [['0x1']])
		assert.deepEqual(connectMessages.map((message) => message.requestId), [9])
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
				params: [{ type: 'success', accounts: [accountString], requestAccounts: true }],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
		})
		const port = createdPort
		const { port: siblingPort, messages: siblingMessages } = createPort(siblingSocket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const siblingConnectionKey = websiteSocketToString(siblingSocket)
		const websiteTabConnections = new Map([[socket.tabId, { connections: {
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

		assert.deepEqual(messages.filter((message) => message.method === 'connect').map((message) => message.requestId), [17])
		assert.deepEqual(messages.filter((message) => message.method === 'accountsChanged').map((message) => message.requestId), [17])
		assert.deepEqual(messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 17).map((message) => message.result), [[accountString]])
		assert.deepEqual(messages.filter((message) => message.method !== 'eth_accounts_reply').map((message) => message.method), ['request_signer_to_eth_requestAccounts', 'connect', 'accountsChanged', 'eth_accounts'])
		assert.deepEqual(siblingMessages.filter((message) => message.method === 'accountsChanged').map((message) => message.requestId), [undefined])
		assert.deepEqual(siblingMessages.filter((message) => message.method === 'accountsChanged').map((message) => message.result), [[accountString]])
	})

	test('replays account state before resolving wallet_requestPermissions after signer refresh', async () => {
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
		const account = 0x4646464646464646464646464646464646464646n
		const accountString = '0x4646464646464646464646464646464646464646'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port: createdPort, messages } = createPort(socket.tabId, (message) => {
			if (message.method !== 'request_signer_to_eth_requestAccounts') return
			void handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
				interceptorRequest: true,
				interceptorInternalRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 104, requestSocket: socket },
				method: 'eth_accounts_reply',
				params: [{ type: 'success', accounts: [accountString], requestAccounts: true }],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
		})
		const port = createdPort
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 19, requestSocket: socket },
			method: 'wallet_requestPermissions',
			params: [{ eth_accounts: {} }],
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		const permissionResult = [{ parentCapability: 'eth_accounts', caveats: [], invoker: websiteOrigin }]
		assert.deepEqual(messages.filter((message) => message.method === 'connect').map((message) => message.requestId), [19])
		assert.deepEqual(messages.filter((message) => message.method === 'accountsChanged').map((message) => message.requestId), [19])
		assert.deepEqual(messages.filter((message) => message.method === 'wallet_requestPermissions' && message.requestId === 19).map((message) => message.result), [permissionResult])
		assert.deepEqual(messages.filter((message) => message.method !== 'eth_accounts_reply').map((message) => message.method), ['request_signer_to_eth_requestAccounts', 'connect', 'accountsChanged', 'wallet_requestPermissions'])
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
		const websiteTabConnections = new Map([[socket.tabId, { connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 11, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(messages.some((message) => message.method === 'request_signer_to_eth_requestAccounts'), false)
		assert.deepEqual(messages.filter((message) => message.method === 'connect').map((message) => message.result), [['0x1']])
		assert.deepEqual(messages.filter((message) => message.method === 'connect').map((message) => message.requestId), [11])
		assert.deepEqual(messages.filter((message) => message.method === 'accountsChanged').map((message) => message.result), [[accountString]])
		assert.deepEqual(messages.filter((message) => message.method === 'accountsChanged').map((message) => message.requestId), [11])
		const requestAccountsReplies = messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 11)
		assert.deepEqual(requestAccountsReplies.at(-1)?.result, [accountString])
		assert.deepEqual(messages.map((message) => message.method), ['connect', 'accountsChanged', 'eth_accounts'])
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
		const websiteTabConnections = new Map([[socket.tabId, { connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 16, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(messages.some((message) => message.type === 'forwardToSigner'), false)
		assert.equal(messages.some((message) => message.method === 'request_signer_to_eth_requestAccounts'), false)
		const requestAccountsReplies = messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 16)
		assert.deepEqual(requestAccountsReplies.at(-1)?.result, [accountString])
		assert.deepEqual(messages.filter((message) => message.method === 'connect').map((message) => message.result), [['0x1']])
		assert.deepEqual(messages.filter((message) => message.method === 'connect').map((message) => message.requestId), [16])
		assert.deepEqual(messages.filter((message) => message.method === 'accountsChanged').map((message) => message.result), [[accountString]])
		assert.deepEqual(messages.filter((message) => message.method === 'accountsChanged').map((message) => message.requestId), [16])
		assert.deepEqual(messages.map((message) => message.method), ['connect', 'accountsChanged', 'eth_accounts'])
	})

	test('does not expose an active address in connected_to_signer replies', async () => {
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
		const account = 0x4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4bn
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: account })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])

		const socket = { tabId: 1, connectionName: 0n }
		await updateTabState(socket.tabId, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: account }))
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 12, requestSocket: socket },
			method: 'connected_to_signer',
			params: [true, 'MetaMask'],
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		const connectedReplies = messages.filter((message) => message.method === 'connected_to_signer' && message.requestId === 12)
		assert.deepEqual(connectedReplies.at(-1)?.result, { metamaskCompatibilityMode: false })
	})

	test('opens address access dialog after signer account discovery for site-approved eth_requestAccounts', async () => {
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
		const account = 0x5555555555555555555555555555555555555555n
		const accountString = '0x5555555555555555555555555555555555555555'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId, (message) => {
			if (message.method !== 'request_signer_to_eth_requestAccounts') return
			void handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
				interceptorRequest: true,
				interceptorInternalRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 100, requestSocket: socket },
				method: 'eth_accounts_reply',
				params: [{ type: 'success', accounts: [accountString], requestAccounts: true }],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
		})
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 10, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(messages.filter((message) => message.method === 'request_signer_to_eth_requestAccounts').length, 1)
		assert.equal(messages.some((message) => message.method === 'connect'), false)
		assert.equal(messages.some((message) => message.method === 'accountsChanged'), false)
		assert.equal(messages.some((message) => message.method === 'eth_requestAccounts' && message.requestId === 10), false)
		const pendingRequests = await getPendingAccessRequests()
		assert.equal(pendingRequests.length, 1)
		assert.equal(pendingRequests[0]?.request?.method, 'eth_requestAccounts')
		assert.equal(pendingRequests[0]?.requestAccessToAddress?.address, account)
		assert.equal(pendingRequests[0]?.originalRequestAccessToAddress?.address, account)
	})

	test('uses cached signer account for address access when active signing address is missing', async () => {
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
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x6666666666666666666666666666666666666666n
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])
		await updateTabState(1, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: undefined }))

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 11, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(messages.some((message) => message.method === 'request_signer_to_eth_requestAccounts'), false)
		assert.equal(messages.some((message) => message.method === 'connect'), false)
		assert.equal(messages.some((message) => message.method === 'accountsChanged'), false)
		assert.equal(messages.some((message) => message.method === 'eth_requestAccounts' && message.requestId === 11), false)
		const pendingRequests = await getPendingAccessRequests()
		assert.equal(pendingRequests.length, 1)
		assert.equal(pendingRequests[0]?.request?.method, 'eth_requestAccounts')
		assert.equal(pendingRequests[0]?.requestAccessToAddress?.address, account)
		assert.equal(pendingRequests[0]?.originalRequestAccessToAddress?.address, account)
		const pendingRequest = pendingRequests[0]
		if (pendingRequest === undefined) throw new Error('Missing pending request')
		await resolveInterceptorAccess(
			ethereum,
			tokenPriceService,
			resetSimulationServices,
			websiteTabConnections,
			{
				userReply: 'Approved',
				websiteOrigin,
				requestAccessToAddress: pendingRequest.requestAccessToAddress?.address,
				originalRequestAccessToAddress: pendingRequest.originalRequestAccessToAddress?.address,
				accessRequestId: pendingRequest.accessRequestId,
			},
			noopPublishRpcConnectionStatus,
		)
		assert.equal(messages.some((message) => message.method === 'accountsChanged' && Array.isArray(message.result) && message.result.length === 0), false)
		assert.deepEqual(messages.filter((message) => message.method === 'eth_accounts' && message.requestId === 11).at(-1)?.result, ['0x6666666666666666666666666666666666666666'])
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
				await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
					interceptorRequest: true,
					interceptorInternalRequest: true,
					usingInterceptorWithoutSigner: false,
					uniqueRequestIdentifier: { requestId: 101, requestSocket: socket },
					method: 'eth_accounts_reply',
					params: [{ type: 'success', accounts: [accountString], requestAccounts: true }],
				}, websiteTabConnections, noopPublishRpcConnectionStatus)
			})()
		})
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 12, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(messages.filter((message) => message.method === 'request_signer_to_eth_requestAccounts').length, 1)
		assert.equal(messages.some((message) => message.method === 'connect'), false)
		assert.equal(messages.some((message) => message.method === 'accountsChanged'), false)
		assert.equal((await getPendingAccessRequests()).length, 0)
		const requestAccountsReplies = messages.filter((message) => message.method === 'eth_requestAccounts' && message.requestId === 12)
		assert.equal(requestAccountsReplies.at(-1)?.error?.code, 4100)
		assert.equal(requestAccountsReplies.at(-1)?.error?.message, 'The requested method and/or account has not been authorized by the user.')
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
			void handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
				interceptorRequest: true,
				interceptorInternalRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 102, requestSocket: socket },
				method: 'eth_accounts_reply',
				params: [{ type: 'error', requestAccounts: true, error: { code: 4001, message: 'User rejected the request.' } }],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
		})
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 13, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(messages.filter((message) => message.method === 'request_signer_to_eth_requestAccounts').length, 1)
		assert.equal(messages.some((message) => message.method === 'connect'), false)
		assert.equal(messages.some((message) => message.method === 'accountsChanged'), false)
		const requestAccountsReplies = messages.filter((message) => message.method === 'eth_requestAccounts' && message.requestId === 13)
		assert.equal(requestAccountsReplies.at(-1)?.error?.code, 4100)
		assert.equal(requestAccountsReplies.at(-1)?.error?.message, 'The requested method and/or account has not been authorized by the user.')
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
			void handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
				interceptorRequest: true,
				interceptorInternalRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 103, requestSocket: socket },
				method: 'eth_accounts_reply',
				params: [{ type: 'success', accounts: [], requestAccounts: true }],
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
		})
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 14, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(messages.filter((message) => message.method === 'request_signer_to_eth_requestAccounts').length, 1)
		assert.equal(messages.some((message) => message.method === 'connect'), false)
		assert.equal(messages.some((message) => message.method === 'accountsChanged'), false)
		const requestAccountsReplies = messages.filter((message) => message.method === 'eth_requestAccounts' && message.requestId === 14)
		assert.equal(requestAccountsReplies.at(-1)?.error?.code, 4100)
		assert.equal(requestAccountsReplies.at(-1)?.error?.message, 'The requested method and/or account has not been authorized by the user.')
	})

	test('resolves approved eth_requestAccounts when signer rejects the account request', async () => {
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
				await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
					interceptorRequest: true,
					interceptorInternalRequest: true,
					usingInterceptorWithoutSigner: false,
					uniqueRequestIdentifier: { requestId: 99, requestSocket: socket },
					method: 'eth_accounts_reply',
					params: [{ type: 'error', requestAccounts: true, error: { code: 4001, message: 'User rejected the request.' } }],
				}, websiteTabConnections, noopPublishRpcConnectionStatus)
			})()
		})
		port = createdPort
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 8, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(messages.filter((message) => message.method === 'request_signer_to_eth_requestAccounts').length, 1)
		const requestAccountsReplies = messages.filter((message) => message.method === 'eth_requestAccounts' && message.requestId === 8)
		assert.equal(requestAccountsReplies.at(-1)?.error?.code, 4100)
		assert.equal(requestAccountsReplies.at(-1)?.error?.message, 'The requested method and/or account has not been authorized by the user.')
		assert.deepEqual((await getTabState(socket.tabId)).signerAccounts, [])
	})

	test('keeps sibling connection events when popup approval resolves eth_requestAccounts', async () => {
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
		const account = 0x6868686868686868686868686868686868686868n
		const accountString = '0x6868686868686868686868686868686868686868'
		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: account })
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])
		await updateTabState(1, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: account }))

		const socket = { tabId: 1, connectionName: 0n }
		const siblingSocket = { tabId: 1, connectionName: 1n }
		const { port, messages } = createPort(socket.tabId)
		const { port: siblingPort, messages: siblingMessages } = createPort(siblingSocket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const siblingConnectionKey = websiteSocketToString(siblingSocket)
		const websiteTabConnections = new Map([[socket.tabId, { connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
			[siblingConnectionKey]: { port: siblingPort, socket: siblingSocket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 18, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(messages.some((message) => message.method === 'connect'), false)
		assert.equal(messages.some((message) => message.method === 'accountsChanged'), false)
		assert.equal(siblingMessages.length, 0)
		const pendingRequests = await getPendingAccessRequests()
		assert.equal(pendingRequests.length, 1)
		const pendingRequest = pendingRequests[0]
		if (pendingRequest === undefined) throw new Error('Missing pending request')
		await resolveInterceptorAccess(
			ethereum,
			tokenPriceService,
			resetSimulationServices,
			websiteTabConnections,
			{
				userReply: 'Approved',
				websiteOrigin,
				requestAccessToAddress: pendingRequest.requestAccessToAddress?.address,
				originalRequestAccessToAddress: pendingRequest.originalRequestAccessToAddress?.address,
				accessRequestId: pendingRequest.accessRequestId,
			},
			noopPublishRpcConnectionStatus,
		)

		const requestLifecycleMessages = messages.filter((message) => message.method === 'connect' || message.method === 'accountsChanged' || message.method === 'chainChanged')
		assert.deepEqual(requestLifecycleMessages.map((message) => message.method), ['connect', 'accountsChanged'])
		assert.deepEqual(requestLifecycleMessages.map((message) => message.requestId), [18, 18])
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
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])
		await updateTabState(1, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: account }))

		const socket = { tabId: 1, connectionName: 0n }
		const { port } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([[socket.tabId, { connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 21, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus)

		const pendingRequest = (await getPendingAccessRequests())[0]
		if (pendingRequest === undefined) throw new Error('Missing pending request')
		await resolveInterceptorAccess(
			ethereum,
			tokenPriceService,
			resetSimulationServices,
			websiteTabConnections,
			{
				userReply: 'Approved',
				requestAccessToAddress: undefined,
				originalRequestAccessToAddress: undefined,
				accessRequestId: pendingRequest.accessRequestId,
			},
			noopPublishRpcConnectionStatus,
		)

		const access = (await getSettings()).websiteAccess.find((entry) => entry.website.websiteOrigin === websiteOrigin)
		assert.equal(access?.access, true)
		assert.deepEqual(access?.addressAccess, [{ address: account, access: true }])
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
		const websiteTabConnections = new Map([[socket.tabId, { connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 10, requestSocket: socket },
			method: 'wallet_revokePermissions',
			params: [{ eth_accounts: {} }],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(messages.some((message) => message.method === 'disconnect'), true)
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
		const websiteTabConnections = new Map([[socket.tabId, { connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
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

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
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
		const websiteTabConnections = new Map([[socket.tabId, { connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
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
		const websiteTabConnections = new Map([[socket.tabId, { connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 13, requestSocket: socket },
			method: 'wallet_revokePermissions',
			params: [{ eth_accounts: {} }],
		}, websiteTabConnections, noopPublishRpcConnectionStatus)

		assert.equal(websiteTabConnections.get(socket.tabId)?.connections[connectionKey]?.approved, false)
		assert.equal(websiteTabConnections.get(socket.tabId)?.connections[connectionKey]?.wantsToConnect, false)
		await updateWebsiteApprovalAccesses(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, await getSettings(), true)
		assert.equal((await getPendingAccessRequests()).length, 0)

		await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
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
		const websiteTabConnections = new Map([[socket.tabId, { connections: {
			[connectionKey]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { ethereum, tokenPriceService, resetSimulationServices } = createEthereumWithGetBlockCounter({ count: 0 })
		const unsupportedParams: unknown[] = [
			[],
			[{ wallet_switchEthereumChain: {} }],
			[{ wallet_snap: {} }],
			[{ eth_accounts: {}, wallet_snap: {} }],
			[{ eth_accounts: { foo: 1 } }],
		]
		for (const [index, params] of unsupportedParams.entries()) {
			const requestId = 13 + index
			await handleInterceptedRequest(port, websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, {
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

	test('stored websites without an active decision remain promptable instead of denied', async () => {
		installBrowserMock()
		const { hasAccess, hasAddressAccess } = await loadModules()
		const websiteOrigin = 'https://example.test'
		const address = { address: 0x1111111111111111111111111111111111111111n, askForAddressAccess: true, type: 'contact', name: 'Test Address' } as const

		assert.equal(hasAccess([{ website: { websiteOrigin, icon: undefined, title: undefined }, addressAccess: undefined }], websiteOrigin), 'askAccess')
		assert.equal(hasAddressAccess([{ website: { websiteOrigin, icon: undefined, title: undefined }, addressAccess: undefined }], websiteOrigin, address), 'askAccess')
		assert.equal(hasAccess([], websiteOrigin), 'askAccess')
		assert.equal(hasAddressAccess([], websiteOrigin, address), 'askAccess')
	})
})
