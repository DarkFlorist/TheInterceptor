import * as assert from 'assert'
import { describe, test } from 'bun:test'
import type { AddressBookEntry } from '../../app/ts/types/addressBookTypes.js'
import type { PendingTransactionOrSignableMessage } from '../../app/ts/types/accessRequest.js'
import { SafeTx as SafeTxRuntype } from '../../app/ts/types/personal-message-definitions.js'
import type {
	SafeTx,
	VisualizedPersonalSignRequestSafeTx,
} from '../../app/ts/types/personal-message-definitions.js'
import type { RpcEntry } from '../../app/ts/types/rpc.js'
import { serialize } from '../../app/ts/types/wire-types.js'
import { stringifyJSONWithBigInts } from '../../app/ts/utils/bigint.js'

type RuntimeMessage = {
	method?: string
	role?: string
	data?: unknown
}

type BrowserMockGlobals = {
	runtime: {
		lastError: { message?: string } | null | undefined
		sendMessage: (message: RuntimeMessage) => Promise<unknown>
		getManifest: () => { manifest_version: number }
		onMessage: {
			addListener: () => undefined
			removeListener: () => undefined
		}
		onConnect: {
			addListener: () => undefined
			removeListener: () => undefined
		}
	}
	storage: {
		local: {
			get: (
				keys?: string | string[] | Record<string, unknown> | null,
			) => Promise<Record<string, unknown>>
			set: (items: Record<string, unknown>) => Promise<void>
			remove: (keys: string | string[]) => Promise<void>
		}
	}
	tabs: {
		query: () => Promise<unknown[]>
		get: () => Promise<undefined>
		update: () => Promise<undefined>
		onUpdated: {
			addListener: () => undefined
			removeListener: () => undefined
		}
		onRemoved: {
			addListener: () => undefined
			removeListener: () => undefined
		}
	}
	windows: {
		get: () => Promise<undefined>
		update: () => Promise<undefined>
	}
	action: {
		setIcon: () => Promise<undefined>
		setTitle: () => Promise<undefined>
		setBadgeText: () => Promise<undefined>
		setBadgeBackgroundColor: () => Promise<undefined>
	}
	browserAction: {
		setIcon: () => Promise<undefined>
		setTitle: () => Promise<undefined>
		setBadgeText: () => Promise<undefined>
		setBadgeBackgroundColor: () => Promise<undefined>
	}
}

type BrowserMock = {
	reset: () => Promise<void>
	sentMessages: RuntimeMessage[]
}

function createBrowserMock(): BrowserMock {
	const storageState: Record<string, unknown> = {}
	const sentMessages: RuntimeMessage[] = []

	const getItems = (
		keys?: string | string[] | Record<string, unknown> | null,
	) => {
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
	}

	const removeItems = (keys: string | string[]) => {
		for (const key of Array.isArray(keys) ? keys : [keys])
			delete storageState[key]
	}

	const browserMock = {
		runtime: {
			lastError: null,
			async sendMessage(message: RuntimeMessage) {
				sentMessages.push(message)
				if (message.method === 'popup_isMainPopupWindowOpen') {
					return {
						method: 'popup_isMainPopupWindowOpen',
						data: { isOpen: false },
					}
				}
				return undefined
			},
			getManifest: () => ({ manifest_version: 3 }),
			onMessage: {
				addListener: () => undefined,
				removeListener: () => undefined,
			},
			onConnect: {
				addListener: () => undefined,
				removeListener: () => undefined,
			},
		},
		storage: {
			local: {
				async get(keys?: string | string[] | Record<string, unknown> | null) {
					return getItems(keys)
				},
				async set(items: Record<string, unknown>) {
					Object.assign(storageState, items)
				},
				async remove(keys: string | string[]) {
					removeItems(keys)
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
				addListener: () => undefined,
				removeListener: () => undefined,
			},
			onRemoved: {
				addListener: () => undefined,
				removeListener: () => undefined,
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
	} satisfies BrowserMockGlobals

	const installBrowserGlobals = () => {
		Object.defineProperty(globalThis, 'browser', {
			value: browserMock,
			configurable: true,
			writable: true,
		})
		Object.defineProperty(globalThis, 'chrome', {
			value: { runtime: { id: 'test-extension' } },
			configurable: true,
			writable: true,
		})
	}

	installBrowserGlobals()

	return {
		sentMessages,
		async reset() {
			for (const key of Object.keys(storageState)) delete storageState[key]
			sentMessages.length = 0
			installBrowserGlobals()
			browserMock.runtime.lastError = null
		},
	}
}

const browserMock = createBrowserMock()

async function loadModules() {
	const popupMessageHandlers = await import(
		'../../app/ts/background/popupMessageHandlers.js'
	)
	const confirmTransaction = await import(
		'../../app/ts/background/windows/confirmTransaction.js'
	)
	const ethereumClientService = await import(
		'../../app/ts/simulation/services/EthereumClientService.js'
	)
	const priceEstimator = await import(
		'../../app/ts/simulation/services/priceEstimator.js'
	)
	const settings = await import('../../app/ts/background/settings.js')
	const storageUtils = await import('../../app/ts/utils/storageUtils.js')
	const wireTypes = await import('../../app/ts/types/wire-types.js')

	return {
		refreshPopupConfirmTransactionMetadata:
			popupMessageHandlers.refreshPopupConfirmTransactionMetadata,
		updateConfirmTransactionView:
			confirmTransaction.updateConfirmTransactionView,
		EthereumClientService: ethereumClientService.EthereumClientService,
		TokenPriceService: priceEstimator.TokenPriceService,
		defaultActiveAddresses: settings.defaultActiveAddresses,
		browserStorageLocalSet: storageUtils.browserStorageLocalSet,
		browserStorageLocalSet2: storageUtils.browserStorageLocalSet2,
		serialize: wireTypes.serialize,
		EthereumBlockHeader: wireTypes.EthereumBlockHeader,
		EthereumQuantity: wireTypes.EthereumQuantity,
	}
}

const modulesPromise = loadModules()
type TestModules = Awaited<ReturnType<typeof loadModules>>

const serializeForRpc = (
	runtype: { serialize: (value: unknown) => unknown },
	value: unknown,
) => runtype.serialize(value)

function makeFakeBlock(number: bigint) {
	return {
		author: 0n,
		difficulty: 0n,
		extraData: new Uint8Array(),
		gasLimit: 30_000_000n,
		gasUsed: 21_000n,
		hash: 0x1234n + number,
		logsBloom: 0n,
		miner: 0n,
		mixHash: 0n,
		nonce: 0n,
		number,
		parentHash: 0x1n,
		receiptsRoot: 0n,
		sha3Uncles: 0n,
		stateRoot: 0n,
		timestamp: new Date('2024-01-01T00:00:00.000Z'),
		size: 0n,
		totalDifficulty: 0n,
		uncles: [],
		baseFeePerGas: 1n,
		transactionsRoot: 0n,
		transactions: [],
		withdrawals: [],
		withdrawalsRoot: 0n,
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}

function assertWireSafe(value: unknown, seen = new Set<unknown>()) {
	if (typeof value === 'bigint')
		throw new Error('Found bigint in serialized payload')
	if (typeof value === 'function')
		throw new Error('Found function in serialized payload')
	if (typeof value === 'symbol')
		throw new Error('Found symbol in serialized payload')
	if (value instanceof Date) throw new Error('Found Date in serialized payload')
	if (value instanceof Uint8Array)
		throw new Error('Found Uint8Array in serialized payload')
	if (!isRecord(value) && !Array.isArray(value)) return
	if (seen.has(value)) return
	seen.add(value)
	if (Array.isArray(value)) {
		for (const entry of value) assertWireSafe(entry, seen)
		return
	}
	for (const nestedValue of Object.values(value))
		assertWireSafe(nestedValue, seen)
}

function getPendingTransactionsUpdateMessage(
	sentMessages: readonly RuntimeMessage[],
) {
	const message = sentMessages.find(
		(entry) =>
			entry.method ===
			'popup_update_confirm_transaction_dialog_pending_transactions',
	)
	if (message === undefined)
		throw new Error('Expected confirm transaction update message')
	if (!isRecord(message.data))
		throw new Error('Expected confirm transaction message data')
	assert.equal(message.role, 'confirmTransaction')
	return message
}

function getPendingTransactionsUpdate(sentMessages: readonly RuntimeMessage[]) {
	const message = getPendingTransactionsUpdateMessage(sentMessages)
	const pendingTransactions = message.data.pendingTransactionAndSignableMessages
	if (!Array.isArray(pendingTransactions))
		throw new Error('Expected pendingTransactionAndSignableMessages array')
	return pendingTransactions
}

function getFirstSignablePendingMessage(
	sentMessages: readonly RuntimeMessage[],
) {
	const pendingTransactions = getPendingTransactionsUpdate(sentMessages)
	const firstPendingMessage = pendingTransactions[0]
	if (!isRecord(firstPendingMessage))
		throw new Error('Expected first pending message object')
	assert.equal(firstPendingMessage.type, 'SignableMessage')
	return firstPendingMessage
}

function createSafeTxMessage(
	rpcNetwork: RpcEntry,
	activeAddress: AddressBookEntry,
	recipient: AddressBookEntry,
): SafeTx {
	return {
		types: {
			SafeTx: [
				{ name: 'to', type: 'address' },
				{ name: 'value', type: 'uint256' },
				{ name: 'data', type: 'bytes' },
				{ name: 'operation', type: 'uint8' },
				{ name: 'safeTxGas', type: 'uint256' },
				{ name: 'baseGas', type: 'uint256' },
				{ name: 'gasPrice', type: 'uint256' },
				{ name: 'gasToken', type: 'address' },
				{ name: 'refundReceiver', type: 'address' },
				{ name: 'nonce', type: 'uint256' },
			],
			EIP712Domain: [
				{ name: 'chainId', type: 'uint256' },
				{ name: 'verifyingContract', type: 'address' },
			],
		},
		primaryType: 'SafeTx',
		domain: {
			chainId: rpcNetwork.chainId,
			verifyingContract: activeAddress.address,
		},
		message: {
			to: recipient.address,
			value: 0n,
			data: new Uint8Array(),
			operation: 0n,
			safeTxGas: 0n,
			baseGas: 0n,
			gasPrice: 0n,
			gasToken: 0n,
			refundReceiver: 0n,
			nonce: 0n,
		},
	}
}

function createVisualizedSafeTxMessage(
	rpcNetwork: RpcEntry,
	activeAddress: AddressBookEntry,
	recipient: AddressBookEntry,
): VisualizedPersonalSignRequestSafeTx {
	const safeTxMessage = createSafeTxMessage(
		rpcNetwork,
		activeAddress,
		recipient,
	)
	const zeroAddressEntry: AddressBookEntry = {
		address: 0n,
		name: '0x0 Address',
		type: 'contact',
		entrySource: 'Interceptor',
		chainId: rpcNetwork.chainId,
	}

	return {
		activeAddress,
		rpcNetwork,
		simulationMode: true,
		signerName: 'NoSignerDetected',
		quarantineReasons: [],
		quarantine: false,
		account: activeAddress,
		website: {
			websiteOrigin: 'https://safe.example',
			icon: undefined,
			title: undefined,
		},
		created: new Date('2024-01-01T00:00:01.000Z'),
		rawMessage: stringifyJSONWithBigInts(safeTxMessage),
		stringifiedMessage: stringifyJSONWithBigInts(safeTxMessage),
		messageIdentifier: 2n,
		method: 'eth_signTypedData_v4',
		type: 'SafeTx',
		message: safeTxMessage,
		parsedMessageDataAddressBookEntries: [],
		parsedMessageData: { type: 'NonParsed', input: new Uint8Array() },
		gasToken: zeroAddressEntry,
		to: recipient,
		refundReceiver: zeroAddressEntry,
		verifyingContract: activeAddress,
		messageHash: '0x1',
		domainHash: '0x2',
		safeTxHash: '0x3',
	}
}

function createPendingSafeTxMessage(
	modules: TestModules,
	rpcNetwork: RpcEntry,
): PendingTransactionOrSignableMessage {
	const activeAddress = modules.defaultActiveAddresses[0]
	const recipient = modules.defaultActiveAddresses[1]
	if (activeAddress === undefined || recipient === undefined)
		throw new Error('Missing default active addresses for test')

	const visualizedPersonalSignRequest = createVisualizedSafeTxMessage(
		rpcNetwork,
		activeAddress,
		recipient,
	)
	const originalRequestParameters = {
		method: 'eth_signTypedData_v4' as const,
		params: [
			activeAddress.address,
			serialize(SafeTxRuntype, visualizedPersonalSignRequest.message),
		],
	}

	return {
		type: 'SignableMessage',
		popupOrTabId: { type: 'popup', id: 1 },
		originalRequestParameters,
		simulationMode: true,
		uniqueRequestIdentifier: {
			requestId: 1,
			requestSocket: { tabId: 1, connectionName: 0n },
		},
		signedMessageTransaction: {
			website: visualizedPersonalSignRequest.website,
			created: visualizedPersonalSignRequest.created,
			fakeSignedFor: activeAddress.address,
			originalRequestParameters,
			request: {
				method: 'eth_signTypedData_v4',
				params: [
					{ unsafeBigInt: 123n, unsafeBytes: new Uint8Array([1, 2, 3]) },
					new Date('2024-01-01T00:00:02.000Z'),
				],
				interceptorRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: {
					requestId: 1,
					requestSocket: { tabId: 1, connectionName: 0n },
				},
			},
			simulationMode: true,
			messageIdentifier: visualizedPersonalSignRequest.messageIdentifier,
		},
		created: visualizedPersonalSignRequest.created,
		website: visualizedPersonalSignRequest.website,
		activeAddress: activeAddress.address,
		approvalStatus: { status: 'WaitingForUser' },
		transactionOrMessageCreationStatus: 'Simulated',
		visualizedPersonalSignRequest,
	}
}

function assertPopupPendingSafeTxShape(
	sentMessages: readonly RuntimeMessage[],
) {
	assertWireSafe(getPendingTransactionsUpdateMessage(sentMessages))
	const firstPendingMessage = getFirstSignablePendingMessage(sentMessages)
	assert.equal('signedMessageTransaction' in firstPendingMessage, false)
	assert.equal(
		firstPendingMessage.transactionOrMessageCreationStatus,
		'Simulated',
	)
	assert.equal(firstPendingMessage.approvalStatus !== undefined, true)
	assert.equal(firstPendingMessage.uniqueRequestIdentifier !== undefined, true)
	assert.equal(firstPendingMessage.website !== undefined, true)
	assert.equal(
		firstPendingMessage.originalRequestParameters !== undefined,
		true,
	)

	const visualizedPersonalSignRequest =
		firstPendingMessage.visualizedPersonalSignRequest
	if (!isRecord(visualizedPersonalSignRequest))
		throw new Error('Expected visualized personal sign request')
	assert.equal('request' in visualizedPersonalSignRequest, false)
	assert.equal(visualizedPersonalSignRequest.type, 'SafeTx')
	assert.equal(visualizedPersonalSignRequest.signerName, 'NoSignerDetected')
	assert.equal(visualizedPersonalSignRequest.activeAddress !== undefined, true)
	assert.equal(visualizedPersonalSignRequest.website !== undefined, true)
}

describe('SafeTx confirm transaction metadata', () => {
	test('refresh confirm metadata sends popup-safe SafeTx payload', async () => {
		await browserMock.reset()
		const modules = await modulesPromise
		const fakeRpcNetwork: RpcEntry = {
			name: 'Test Chain',
			chainId: 1337n,
			httpsRpc: 'https://example.invalid',
			currencyName: 'Ether',
			currencyTicker: 'ETH',
			currencyLogoUri: undefined,
			primary: true,
			minimized: true,
		}
		const fakeBlock = makeFakeBlock(123n)
		const fakeRequestHandler = {
			rpcUrl: fakeRpcNetwork.httpsRpc,
			clearCache() {
				return undefined
			},
			async jsonRpcRequest(rpcRequest: { method: string }) {
				switch (rpcRequest.method) {
					case 'eth_getBlockByNumber':
						return serializeForRpc(modules.EthereumBlockHeader, fakeBlock)
					case 'eth_blockNumber':
						return serializeForRpc(modules.EthereumQuantity, fakeBlock.number)
					default:
						throw new Error(`Unexpected RPC method: ${rpcRequest.method}`)
				}
			},
		}

		const ethereum = new modules.EthereumClientService(
			fakeRequestHandler,
			async () => undefined,
			async () => undefined,
			fakeRpcNetwork,
		)
		const tokenPriceService = new modules.TokenPriceService(ethereum, 0)
		await modules.browserStorageLocalSet({
			simulationMode: true,
			activeRpcNetwork: fakeRpcNetwork,
			userAddressBookEntriesV3: modules.defaultActiveAddresses,
		})
		await modules.browserStorageLocalSet2({
			pendingTransactionsAndMessages: [
				createPendingSafeTxMessage(modules, fakeRpcNetwork),
			],
		})

		await modules.refreshPopupConfirmTransactionMetadata(
			ethereum,
			tokenPriceService,
			undefined,
		)

		assertPopupPendingSafeTxShape(browserMock.sentMessages)
	})

	test('initial confirm render sends popup-safe SafeTx payload', async () => {
		await browserMock.reset()
		const modules = await modulesPromise
		const fakeRpcNetwork: RpcEntry = {
			name: 'Test Chain',
			chainId: 1337n,
			httpsRpc: 'https://example.invalid',
			currencyName: 'Ether',
			currencyTicker: 'ETH',
			currencyLogoUri: undefined,
			primary: true,
			minimized: true,
		}
		const fakeBlock = makeFakeBlock(456n)
		const fakeRequestHandler = {
			rpcUrl: fakeRpcNetwork.httpsRpc,
			clearCache() {
				return undefined
			},
			async jsonRpcRequest(rpcRequest: { method: string }) {
				switch (rpcRequest.method) {
					case 'eth_getBlockByNumber':
						return serializeForRpc(modules.EthereumBlockHeader, fakeBlock)
					case 'eth_blockNumber':
						return serializeForRpc(modules.EthereumQuantity, fakeBlock.number)
					default:
						throw new Error(`Unexpected RPC method: ${rpcRequest.method}`)
				}
			},
		}

		const ethereum = new modules.EthereumClientService(
			fakeRequestHandler,
			async () => undefined,
			async () => undefined,
			fakeRpcNetwork,
		)
		const tokenPriceService = new modules.TokenPriceService(ethereum, 0)
		await modules.browserStorageLocalSet({
			simulationMode: true,
			activeRpcNetwork: fakeRpcNetwork,
			userAddressBookEntriesV3: modules.defaultActiveAddresses,
		})
		await modules.browserStorageLocalSet2({
			pendingTransactionsAndMessages: [
				createPendingSafeTxMessage(modules, fakeRpcNetwork),
			],
		})

		await modules.updateConfirmTransactionView(ethereum, tokenPriceService)

		assertPopupPendingSafeTxShape(browserMock.sentMessages)
	})
})
