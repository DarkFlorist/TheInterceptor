import * as assert from 'assert'
import { describe, test } from 'bun:test'
import type { ResetSimulationServices } from '../../app/ts/simulation/serviceLifecycle.js'
import { EthereumJSONRpcRequestHandler } from '../../app/ts/simulation/services/EthereumJSONRpcRequestHandler.js'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import { TokenPriceService } from '../../app/ts/simulation/services/priceEstimator.js'
import type { RpcEntry } from '../../app/ts/types/rpc.js'

type Listener = () => void
type PortMessage = {
	method?: unknown
	result?: unknown
	requestId?: unknown
	error?: { code?: unknown; message?: unknown }
}

function installBrowserMock() {
	const storageState: Record<string, unknown> = {}
	;(
		globalThis as typeof globalThis & { browser: typeof globalThis.browser }
	).browser = {
		runtime: {
			lastError: null,
			async sendMessage() {
				return undefined
			},
			getManifest: () => ({ manifest_version: 3 }),
			onMessage: {
				addListener: (_listener: Listener) => undefined,
				removeListener: (_listener: Listener) => undefined,
			},
			onConnect: {
				addListener: (_listener: Listener) => undefined,
				removeListener: (_listener: Listener) => undefined,
			},
		},
		storage: {
			local: {
				async get(keys?: string | string[] | Record<string, unknown> | null) {
					if (keys === undefined || keys === null) return { ...storageState }
					if (Array.isArray(keys))
						return Object.fromEntries(
							keys
								.filter((key) => key in storageState)
								.map((key) => [key, storageState[key]]),
						)
					if (typeof keys === 'string')
						return keys in storageState ? { [keys]: storageState[keys] } : {}
					return Object.fromEntries(
						Object.entries(keys).map(([key, defaultValue]) => [
							key,
							key in storageState ? storageState[key] : defaultValue,
						]),
					)
				},
				async set(items: Record<string, unknown>) {
					Object.assign(storageState, items)
				},
				async remove(keys: string | string[]) {
					for (const key of Array.isArray(keys) ? keys : [keys])
						delete storageState[key]
				},
			},
		},
		tabs: {
			async query() {
				return []
			},
			async get() {
				return undefined
			},
			async update() {
				return undefined
			},
			onUpdated: {
				addListener: (_listener: Listener) => undefined,
				removeListener: (_listener: Listener) => undefined,
			},
			onRemoved: {
				addListener: (_listener: Listener) => undefined,
				removeListener: (_listener: Listener) => undefined,
			},
		},
		windows: {
			async get() {
				return undefined
			},
			async update() {
				return undefined
			},
		},
		action: {
			async setIcon() {
				return undefined
			},
			async setTitle() {
				return undefined
			},
			async setBadgeText() {
				return undefined
			},
			async setBadgeBackgroundColor() {
				return undefined
			},
		},
		browserAction: {
			async setIcon() {
				return undefined
			},
			async setTitle() {
				return undefined
			},
			async setBadgeText() {
				return undefined
			},
			async setBadgeBackgroundColor() {
				return undefined
			},
		},
	} as unknown as typeof globalThis.browser
	;(
		globalThis as typeof globalThis & { chrome: { runtime: { id: string } } }
	).chrome = { runtime: { id: 'test-extension' } }
	;(globalThis as typeof globalThis & { location: Location }).location = {
		origin: '',
	} as unknown as Location
}

async function loadModules() {
	return {
		...(await import('../../app/ts/background/background.js')),
		...(await import('../../app/ts/background/backgroundUtils.js')),
		...(await import('../../app/ts/background/settings.js')),
		...(await import('../../app/ts/background/storageVariables.js')),
	}
}

function createPort(
	tabId: number,
	onPostMessage?: (message: PortMessage) => void,
) {
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

function createEthereumWithGetBlockCounter(getBlockCalls: { count: number }) {
	const rpcEntry: RpcEntry = {
		name: 'Test RPC',
		chainId: 1n,
		httpsRpc: 'http://127.0.0.1:8545',
		currencyName: 'Ether',
		currencyTicker: 'ETH',
		primary: true,
		minimized: false,
	}
	const ethereum = new Proxy(
		new EthereumClientService(
			new EthereumJSONRpcRequestHandler(rpcEntry.httpsRpc),
			async () => undefined,
			async () => undefined,
			rpcEntry,
		),
		{
			get(target, property, receiver) {
				if (property === 'isBlockPolling') return () => true
				if (property === 'setBlockPolling')
					return (_enabled: boolean) => undefined
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
		resetSimulationServices: (() =>
			undefined) satisfies ResetSimulationServices,
	}
}

describe('background eth_accounts', () => {
	test('reject public calls to internal provider callback methods', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			updateWebsiteAccess,
			getTabState,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		await changeSimulationMode({
			simulationMode: true,
			activeSimulationAddress: undefined,
			activeSigningAddress: undefined,
		})
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [
			{ website, access: true, addressAccess: undefined },
		])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([
			[
				socket.tabId,
				{
					connections: {
						[connectionKey]: {
							port,
							socket,
							websiteOrigin,
							approved: true,
							wantsToConnect: true,
						},
					},
				},
			],
		])
		const { ethereum, tokenPriceService, resetSimulationServices } =
			createEthereumWithGetBlockCounter({ count: 0 })

		for (const [index, method] of [
			'connected_to_signer',
			'eth_accounts_reply',
			'InterceptorError',
			'signer_chainChanged',
			'signer_reply',
			'wallet_switchEthereumChain_reply',
		].entries()) {
			await handleInterceptedRequest(
				port,
				websiteOrigin,
				website,
				ethereum,
				tokenPriceService,
				resetSimulationServices,
				socket,
				{
					interceptorRequest: true,
					usingInterceptorWithoutSigner: false,
					uniqueRequestIdentifier: {
						requestId: index + 1,
						requestSocket: socket,
					},
					method,
					params: [],
				},
				websiteTabConnections,
			)
			const reply = messages.at(-1)
			assert.equal(reply?.method, method)
			assert.equal(reply?.requestId, index + 1)
			assert.equal(reply?.error?.code, -32601)
		}

		assert.deepEqual((await getTabState(socket.tabId)).signerAccounts, [])
	})

	test('allow marked internal eth_accounts_reply callbacks', async () => {
		installBrowserMock()
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			updateWebsiteAccess,
			getTabState,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x3333333333333333333333333333333333333333n
		await changeSimulationMode({
			simulationMode: true,
			activeSimulationAddress: undefined,
			activeSigningAddress: undefined,
		})
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [
			{ website, access: true, addressAccess: undefined },
		])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([
			[
				socket.tabId,
				{
					connections: {
						[connectionKey]: {
							port,
							socket,
							websiteOrigin,
							approved: true,
							wantsToConnect: true,
						},
					},
				},
			],
		])
		const { ethereum, tokenPriceService, resetSimulationServices } =
			createEthereumWithGetBlockCounter({ count: 0 })

		await handleInterceptedRequest(
			port,
			websiteOrigin,
			website,
			ethereum,
			tokenPriceService,
			resetSimulationServices,
			socket,
			{
				interceptorRequest: true,
				interceptorInternalRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 9, requestSocket: socket },
				method: 'eth_accounts_reply',
				params: [
					{
						type: 'success',
						accounts: ['0x3333333333333333333333333333333333333333'],
						requestAccounts: false,
					},
				],
			},
			websiteTabConnections,
		)

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
		const {
			handleInterceptedRequest,
			websiteSocketToString,
			changeSimulationMode,
			setUseSignersAddressAsActiveAddress,
			updateWebsiteAccess,
		} = await loadModules()
		const websiteOrigin = 'https://example.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 0x1111111111111111111111111111111111111111n
		await changeSimulationMode({
			simulationMode: true,
			activeSimulationAddress: account,
			activeSigningAddress: undefined,
		})
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [
			{ website, access: true, addressAccess: undefined },
		])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([
			[
				socket.tabId,
				{
					connections: {
						[connectionKey]: {
							port,
							socket,
							websiteOrigin,
							approved: true,
							wantsToConnect: true,
						},
					},
				},
			],
		])
		const getBlockCalls = { count: 0 }
		const { ethereum, tokenPriceService, resetSimulationServices } =
			createEthereumWithGetBlockCounter(getBlockCalls)
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 1, requestSocket: socket },
			method: 'eth_accounts',
		}

		await handleInterceptedRequest(
			port,
			websiteOrigin,
			website,
			ethereum,
			tokenPriceService,
			resetSimulationServices,
			socket,
			request,
			websiteTabConnections,
		)

		assert.equal(getBlockCalls.count, 0)
		assert.equal(
			messages.some(
				(message) => message.method === 'request_signer_to_eth_accounts',
			),
			false,
		)
		const ethAccountsReplies = messages.filter(
			(message) => message.method === 'eth_accounts' && message.requestId === 1,
		)
		assert.deepEqual(ethAccountsReplies.at(-1)?.result, [
			'0x1111111111111111111111111111111111111111',
		])
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
		await changeSimulationMode({
			simulationMode: false,
			activeSimulationAddress: undefined,
			activeSigningAddress: undefined,
		})
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [
			{ website, access: true, addressAccess: undefined },
		])

		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId, (message) => {
			if (message.method !== 'request_signer_to_eth_accounts') return
			void (async () => {
				await updateTabState(socket.tabId, (previousState) => ({
					...previousState,
					signerAccounts: [account],
					activeSigningAddress: account,
				}))
				sendInternalWindowMessage({
					method: 'window_signer_accounts_changed',
					data: { socket },
				})
			})()
		})
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([
			[
				socket.tabId,
				{
					connections: {
						[connectionKey]: {
							port,
							socket,
							websiteOrigin,
							approved: true,
							wantsToConnect: true,
						},
					},
				},
			],
		])
		const { ethereum, tokenPriceService, resetSimulationServices } =
			createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 7, requestSocket: socket },
			method: 'eth_accounts',
		}

		await handleInterceptedRequest(
			port,
			websiteOrigin,
			website,
			ethereum,
			tokenPriceService,
			resetSimulationServices,
			socket,
			request,
			websiteTabConnections,
		)

		assert.equal(
			messages.filter(
				(message) => message.method === 'request_signer_to_eth_accounts',
			).length,
			1,
		)
		assert.equal(
			messages.some(
				(message) => message.method === 'request_signer_to_eth_requestAccounts',
			),
			false,
		)
		const ethAccountsReplies = messages.filter(
			(message) => message.method === 'eth_accounts' && message.requestId === 7,
		)
		assert.deepEqual(ethAccountsReplies.at(-1)?.result, [
			'0x2222222222222222222222222222222222222222',
		])
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
		await changeSimulationMode({
			simulationMode: false,
			activeSimulationAddress: undefined,
			activeSigningAddress: undefined,
		})
		await setUseSignersAddressAsActiveAddress(false)
		await updateWebsiteAccess(() => [
			{ website, access: true, addressAccess: undefined },
		])

		const socket = { tabId: 1, connectionName: 0n }
		let port: browser.runtime.Port
		const { port: createdPort, messages } = createPort(
			socket.tabId,
			(message) => {
				if (message.method !== 'request_signer_to_eth_requestAccounts') return
				void (async () => {
					await handleInterceptedRequest(
						port,
						websiteOrigin,
						website,
						ethereum,
						tokenPriceService,
						resetSimulationServices,
						socket,
						{
							interceptorRequest: true,
							interceptorInternalRequest: true,
							usingInterceptorWithoutSigner: false,
							uniqueRequestIdentifier: { requestId: 99, requestSocket: socket },
							method: 'eth_accounts_reply',
							params: [
								{
									type: 'error',
									requestAccounts: true,
									error: { code: 4001, message: 'User rejected the request.' },
								},
							],
						},
						websiteTabConnections,
					)
				})()
			},
		)
		port = createdPort
		const connectionKey = websiteSocketToString(socket)
		const websiteTabConnections = new Map([
			[
				socket.tabId,
				{
					connections: {
						[connectionKey]: {
							port,
							socket,
							websiteOrigin,
							approved: true,
							wantsToConnect: true,
						},
					},
				},
			],
		])
		const { ethereum, tokenPriceService, resetSimulationServices } =
			createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 8, requestSocket: socket },
			method: 'eth_requestAccounts',
		}

		await handleInterceptedRequest(
			port,
			websiteOrigin,
			website,
			ethereum,
			tokenPriceService,
			resetSimulationServices,
			socket,
			request,
			websiteTabConnections,
		)

		assert.equal(
			messages.filter(
				(message) => message.method === 'request_signer_to_eth_requestAccounts',
			).length,
			1,
		)
		const requestAccountsReplies = messages.filter(
			(message) =>
				message.method === 'eth_requestAccounts' && message.requestId === 8,
		)
		assert.equal(requestAccountsReplies.at(-1)?.error?.code, 4100)
		assert.equal(
			requestAccountsReplies.at(-1)?.error?.message,
			'The requested method and/or account has not been authorized by the user.',
		)
		assert.deepEqual((await getTabState(socket.tabId)).signerAccounts, [])
	})
})
