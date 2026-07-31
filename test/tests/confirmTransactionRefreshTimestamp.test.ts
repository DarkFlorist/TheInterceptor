import * as assert from 'assert'
import { test } from 'bun:test'
import type { flushPendingTerminalRepliesForSocket as flushPendingTerminalRepliesForSocketType } from '../../app/ts/background/terminalReplyDelivery.js'
import { encodeFunctionCall, encodeFunctionReturn } from '../../app/ts/utils/abiRuntime.js'
import { withSilencedConsole } from './consoleSilence.js'
import { createSafeTx, SAFE_ABI, safeTxToTypedDataJson } from '../../app/ts/safe/safeCore.js'
import { SAFE_EXECUTION_ABI } from '../../app/ts/safe/safeExecution.js'
import { getSafeTxHash } from '../../app/ts/utils/eip712.js'
import { addressString, bytes32String } from '../../app/ts/utils/bigint.js'
import { EIP712Message } from '../../app/ts/types/eip721.js'
import { privateKeyToAccount } from '../../app/ts/utils/ethereumPrimitives.js'

type RuntimeMessage = {
	method?: string
	type?: string
	data?: unknown
}

type StorageKeys = string | string[] | Record<string, unknown> | null | undefined

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}

const hexToBytes = (hex: string) => Uint8Array.from(Buffer.from(hex.slice(2), 'hex'))

function createBrowserMock() {
	const storageState: Record<string, unknown> = {}
	const sentMessages: RuntimeMessage[] = []
	const liveTabIds = new Set<number>()
	const liveWindowIds = new Set<number>()
	let manifestVersion = 3
	let tabMessageHandler: ((tabId: number, message: unknown) => unknown | Promise<unknown>) | undefined
	let storageGetHandler: ((keys: StorageKeys, readStoredItems: () => Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined
	let storageSetHandler: ((items: Record<string, unknown>, writeStoredItems: () => void) => Promise<void>) | undefined

	const getItems = (keys?: StorageKeys) => {
		if (keys === undefined || keys === null) return { ...storageState }
		if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => key in storageState).map((key) => [key, storageState[key]]))
		if (typeof keys === 'string') return keys in storageState ? { [keys]: storageState[keys] } : {}
		return Object.fromEntries(Object.entries(keys).map(([key, defaultValue]) => [key, key in storageState ? storageState[key] : defaultValue]))
	}

	const removeItems = (keys: string | string[]) => {
		const entries = Array.isArray(keys) ? keys : [keys]
		for (const key of entries) delete storageState[key]
	}

	const browser = {
		runtime: {
			lastError: null as browser.runtime._LastError | undefined | null,
			async sendMessage(message: RuntimeMessage) {
				sentMessages.push(message)
				if (message.method === 'popup_isMainPopupWindowOpen') {
					return { method: 'popup_isMainPopupWindowOpen', data: { isOpen: false } }
				}
				return undefined
			},
			getManifest: () => ({ manifest_version: manifestVersion }),
			onMessage: { addListener: () => undefined, removeListener: () => undefined },
			onConnect: { addListener: () => undefined, removeListener: () => undefined },
		},
		storage: {
			local: {
				async get(keys?: StorageKeys) {
					if (storageGetHandler !== undefined) return await storageGetHandler(keys, () => getItems(keys))
					return getItems(keys)
				},
				async set(items: Record<string, unknown>) {
					if (storageSetHandler !== undefined) return await storageSetHandler(items, () => Object.assign(storageState, items))
					Object.assign(storageState, items)
				},
				async remove(keys: string | string[]) { removeItems(keys) },
			},
		},
		tabs: {
			async sendMessage(tabId: number, message: unknown) {
				if (tabMessageHandler === undefined) throw new Error('Could not establish connection. Receiving end does not exist.')
				return await tabMessageHandler(tabId, message)
			},
			async query() { return [] },
			async create() { return { id: 99 } },
			async get(tabId: number) {
				if (!liveTabIds.has(tabId)) throw new Error(`No tab with id: ${ tabId }`)
				return { id: tabId }
			},
			async update() { return undefined },
			async remove() { return undefined },
			onUpdated: { addListener: () => undefined, removeListener: () => undefined },
			onRemoved: { addListener: () => undefined, removeListener: () => undefined },
		},
		windows: {
			async get(windowId: number) {
				if (!liveWindowIds.has(windowId)) throw new Error(`No window with id: ${ windowId }`)
				return { id: windowId }
			},
			async update() { return undefined },
			async create() { return { id: 99 } },
			async remove() { return undefined },
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
	}
	Object.defineProperty(globalThis, 'browser', { value: browser, configurable: true, writable: true })
	Object.defineProperty(globalThis, 'chrome', { value: { runtime: { id: 'test-extension' } }, configurable: true, writable: true })
	Object.defineProperty(globalThis, 'location', { value: { origin: '' }, configurable: true, writable: true })

	return {
		sentMessages,
		storageState,
		setManifestVersion(version: number) { manifestVersion = version },
		setLiveTabIds(tabIds: readonly number[]) {
			liveTabIds.clear()
			for (const tabId of tabIds) liveTabIds.add(tabId)
		},
		setLiveWindowIds(windowIds: readonly number[]) {
			liveWindowIds.clear()
			for (const windowId of windowIds) liveWindowIds.add(windowId)
		},
		setStorageGetHandler(handler: typeof storageGetHandler) { storageGetHandler = handler },
		setStorageSetHandler(handler: typeof storageSetHandler) { storageSetHandler = handler },
		setTabMessageHandler(handler: ((tabId: number, message: unknown) => unknown | Promise<unknown>) | undefined) { tabMessageHandler = handler },
		reset() {
			for (const key of Object.keys(storageState)) delete storageState[key]
			sentMessages.length = 0
			browser.runtime.lastError = undefined
			manifestVersion = 3
			liveTabIds.clear()
			liveWindowIds.clear()
			tabMessageHandler = undefined
			storageGetHandler = undefined
			storageSetHandler = undefined
		},
	}
}

async function loadModules() {
	const [
		ethereumClientService,
		priceEstimator,
		simulationModeEthereumClientService,
		constants,
		settings,
		popupMessageHandlers,
		confirmTransaction,
		storageVariables,
		storageUtils,
		backgroundUtils,
		wireTypes,
		ethSimulateTypes,
		messageSending,
		pendingTerminalReplies,
		terminalReplyDelivery,
		providerMessageHandlers,
		safeExecutionRouting,
		safeConfirmationResolver,
	] = await Promise.all([
		import('../../app/ts/simulation/services/EthereumClientService.js'),
		import('../../app/ts/simulation/services/priceEstimator.js'),
		import('../../app/ts/simulation/services/SimulationModeEthereumClientService.js'),
		import('../../app/ts/utils/constants.js'),
		import('../../app/ts/background/settings.js'),
		import('../../app/ts/background/popupMessageHandlers.js'),
		import('../../app/ts/background/windows/confirmTransaction.js'),
		import('../../app/ts/background/storageVariables.js'),
		import('../../app/ts/utils/storageUtils.js'),
		import('../../app/ts/background/backgroundUtils.js'),
		import('../../app/ts/types/wire-types.js'),
		import('../../app/ts/types/ethSimulate-types.js'),
		import('../../app/ts/background/messageSending.js'),
		import('../../app/ts/background/pendingTerminalReplies.js'),
		import('../../app/ts/background/terminalReplyDelivery.js'),
		import('../../app/ts/background/providerMessageHandlers.js'),
		import('../../app/ts/safe/safeExecutionRouting.js'),
		import('../../app/ts/background/safeConfirmationResolver.js'),
	])
	const flushPendingTerminalRepliesForSocket: typeof flushPendingTerminalRepliesForSocketType = terminalReplyDelivery.flushPendingTerminalRepliesForSocket

	return {
		EthereumClientService: ethereumClientService.EthereumClientService,
		TokenPriceService: priceEstimator.TokenPriceService,
		mockSignTransaction: simulationModeEthereumClientService.mockSignTransaction,
		Multicall3ABI: constants.Multicall3ABI,
		defaultActiveAddresses: settings.defaultActiveAddresses,
		refreshPopupConfirmTransactionSimulation: popupMessageHandlers.refreshPopupConfirmTransactionSimulation,
		confirmDialog: popupMessageHandlers.confirmDialog,
		importSafeStack: popupMessageHandlers.importSafeStack,
		requestSafeStackExport: popupMessageHandlers.requestSafeStackExport,
		setActiveSafeSigner: popupMessageHandlers.setActiveSafeSigner,
		resolvePendingTransactionOrMessage: confirmTransaction.resolvePendingTransactionOrMessage,
		formEthSendTransaction: confirmTransaction.formEthSendTransaction,
		getSafeExecutionSignerRoute: safeExecutionRouting.getSafeExecutionSignerRoute,
		prepareSafeExecutionSignerRoute: safeExecutionRouting.prepareSafeExecutionSignerRoute,
		getUnavailableSafeSignerMessage: safeConfirmationResolver.getUnavailableSafeSignerMessage,
		isSafeExecutionRequestForActiveSafe: safeExecutionRouting.isSafeExecutionRequestForActiveSafe,
		openConfirmTransactionDialogForMessage: confirmTransaction.openConfirmTransactionDialogForMessage,
		openConfirmTransactionDialogForTransaction: confirmTransaction.openConfirmTransactionDialogForTransaction,
		onCloseWindowOrTab: confirmTransaction.onCloseWindowOrTab,
		refreshPendingSafeSignerSelectionErrors: confirmTransaction.refreshPendingSafeSignerSelectionErrors,
		resolvePendingRequestsForMissingConfirmationWindows: confirmTransaction.resolvePendingRequestsForMissingConfirmationWindows,
		getPendingTransactionsAndMessages: storageVariables.getPendingTransactionsAndMessages,
		getSafeTransactionStacks: storageVariables.getSafeTransactionStacks,
		getInterceptorTransactionStack: storageVariables.getInterceptorTransactionStack,
		getUserAddressBookEntries: storageVariables.getUserAddressBookEntries,
		appendPendingTransactionOrMessage: storageVariables.appendPendingTransactionOrMessage,
		getPendingTerminalReplies: pendingTerminalReplies.getPendingTerminalReplies,
		prunePendingTerminalRepliesForMissingTabs: pendingTerminalReplies.prunePendingTerminalRepliesForMissingTabs,
		updateInterceptorTransactionStack: storageVariables.updateInterceptorTransactionStack,
		updatePendingTransactionOrMessage: storageVariables.updatePendingTransactionOrMessage,
		updateSafeTransactionStacks: storageVariables.updateSafeTransactionStacks,
		updateTabState: storageVariables.updateTabState,
		updateUserAddressBookEntries: storageVariables.updateUserAddressBookEntries,
		flushPendingTerminalRepliesForSocket,
		flushPendingTerminalRepliesForConnectedPortWithRetry: terminalReplyDelivery.flushPendingTerminalRepliesForConnectedPortWithRetry,
		queueTerminalReply: terminalReplyDelivery.queueTerminalReply,
		attemptQueuedTerminalReplyDelivery: terminalReplyDelivery.attemptQueuedTerminalReplyDelivery,
		queueTerminalReplyAndAttemptDelivery: terminalReplyDelivery.queueTerminalReplyAndAttemptDelivery,
		signerReply: providerMessageHandlers.signerReply,
		ethAccountsReply: providerMessageHandlers.ethAccountsReply,
		browserStorageLocalSet2: storageUtils.browserStorageLocalSet2,
		websiteSocketToString: backgroundUtils.websiteSocketToString,
		serialize: wireTypes.serialize,
		EthereumBytes32: wireTypes.EthereumBytes32,
		EthereumBlockHeader: wireTypes.EthereumBlockHeader,
		EthereumQuantity: wireTypes.EthereumQuantity,
		EthSimulateV1Result: ethSimulateTypes.EthSimulateV1Result,
	}
}

function makeFakeBlock() {
	return {
		author: 0n,
		difficulty: 0n,
		extraData: new Uint8Array(),
		gasLimit: 30_000_000n,
		gasUsed: 21_000n,
		hash: 0x1234n,
		logsBloom: 0n,
		miner: 0n,
		mixHash: 0n,
		nonce: 0n,
		number: 123n,
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

function makeFakeEthSimulateResult(multicallBalance: bigint, multicallAbi: readonly string[], callCount = 1) {
	const balanceResult = encodeFunctionReturn(multicallAbi, 'getEthBalance', [multicallBalance])
	const aggregate3Result = encodeFunctionReturn(multicallAbi, 'aggregate3', [[{ success: true, returnData: balanceResult }]])
	return {
		number: 123n,
		hash: 0x9876n,
		timestamp: 0x65920080n,
		gasLimit: 30_000_000n,
		gasUsed: 21_000n,
		baseFeePerGas: 1n,
		calls: Array.from({ length: callCount }, () => ({
			status: 'success' as const,
			gasUsed: 21_000n,
			logs: [],
			returnData: hexToBytes(aggregate3Result),
		})),
	}
}

const browserMock = createBrowserMock()
const modules = await loadModules()

const fakeRpcNetwork = {
	name: 'Test Chain',
	chainId: 1337n,
	httpsRpc: 'https://example.invalid',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	currencyLogoUri: undefined,
	primary: true,
	minimized: true,
}

test('unavailable Gnosis Safe signer errors identify the expected and exposed accounts', () => {
	assert.equal(
		modules.getUnavailableSafeSignerMessage(0x1234n, 'MetaMask', [0x5678n, 0x9abcn]),
		'The configured Gnosis Safe signer is not available in the connected signer wallet. Expected 0x0000000000000000000000000000000000001234, but MetaMask currently exposes 0x0000000000000000000000000000000000005678, 0x0000000000000000000000000000000000009ABc.',
	)
	assert.equal(
		modules.getUnavailableSafeSignerMessage(0x1234n, 'MetaMask', []),
		'The configured Gnosis Safe signer is not available in the connected signer wallet. Expected 0x0000000000000000000000000000000000001234, but MetaMask currently exposes no accounts.',
	)
})

const fakeBlock = makeFakeBlock()
const safeSelectors = {
	version: encodeFunctionCall(SAFE_ABI, 'VERSION', []).slice(0, 10),
	nonce: encodeFunctionCall(SAFE_ABI, 'nonce', []).slice(0, 10),
	owners: encodeFunctionCall(SAFE_ABI, 'getOwners', []).slice(0, 10),
	threshold: encodeFunctionCall(SAFE_ABI, 'getThreshold', []).slice(0, 10),
	isOwner: encodeFunctionCall(SAFE_ABI, 'isOwner', ['0x0000000000000000000000000000000000000001']).slice(0, 10),
	transactionHash: encodeFunctionCall(SAFE_ABI, 'getTransactionHash', [
		'0x0000000000000000000000000000000000000001',
		0n,
		'0x',
		0n,
		0n,
		0n,
		0n,
		'0x0000000000000000000000000000000000000000',
		'0x0000000000000000000000000000000000000000',
		0n,
	]).slice(0, 10),
}
let fakeSafeVersion = '1.4.1'
let fakeSafeNonce = 0n
let fakeSafeThreshold = 2n
let fakeSafeOwners: bigint[] = []
let fakeSafeOwnerIsValid = true
let fakeSafeTransactionHash = 0n
let fakeSafeOwnerCode = '0x'
let beforeSafeVersionResponse: (() => Promise<void>) | undefined
const requestedRpcMethods: string[] = []
let failEthSimulate = false

function resetFakeSafeContractState() {
	fakeSafeVersion = '1.4.1'
	fakeSafeNonce = 0n
	fakeSafeThreshold = 2n
	fakeSafeOwners = []
	fakeSafeOwnerIsValid = true
	fakeSafeTransactionHash = 0n
	fakeSafeOwnerCode = '0x'
	beforeSafeVersionResponse = undefined
	requestedRpcMethods.length = 0
	failEthSimulate = false
}

const fakeRequestHandler = {
	rpcUrl: fakeRpcNetwork.httpsRpc,
	clearCache() { return undefined },
	async jsonRpcRequest(rpcRequest: { method: string, params?: readonly unknown[] }) {
		requestedRpcMethods.push(rpcRequest.method)
		switch (rpcRequest.method) {
			case 'eth_getBlockByNumber':
				return modules.serialize(modules.EthereumBlockHeader, fakeBlock)
			case 'eth_getTransactionCount':
				return modules.serialize(modules.EthereumQuantity, 0n)
			case 'eth_getBalance':
				return modules.serialize(modules.EthereumQuantity, 0n)
			case 'eth_blockNumber':
				return modules.serialize(modules.EthereumQuantity, 123n)
			case 'eth_getCode':
				return rpcRequest.params?.[0] === activeAddress ? '0x01' : fakeSafeOwnerCode
			case 'eth_gasPrice':
				return modules.serialize(modules.EthereumQuantity, 1n)
			case 'eth_call': {
				const call = rpcRequest.params?.[0]
				if (!isRecord(call) || !(call.data instanceof Uint8Array)) throw new Error('Malformed test eth_call')
				const selector = `0x${ Buffer.from(call.data).toString('hex').slice(0, 8) }`
				switch (selector) {
					case safeSelectors.version:
						await beforeSafeVersionResponse?.()
						return encodeFunctionReturn(SAFE_ABI, 'VERSION', [fakeSafeVersion])
					case safeSelectors.nonce: return encodeFunctionReturn(SAFE_ABI, 'nonce', [fakeSafeNonce])
					case safeSelectors.owners: return encodeFunctionReturn(SAFE_ABI, 'getOwners', [fakeSafeOwners.map(addressString)])
					case safeSelectors.threshold: return encodeFunctionReturn(SAFE_ABI, 'getThreshold', [fakeSafeThreshold])
					case safeSelectors.isOwner: return encodeFunctionReturn(SAFE_ABI, 'isOwner', [fakeSafeOwnerIsValid])
					case safeSelectors.transactionHash: return encodeFunctionReturn(SAFE_ABI, 'getTransactionHash', [bytes32String(fakeSafeTransactionHash)])
					default: throw new Error(`Unexpected eth_call selector: ${ selector }`)
				}
			}
			case 'eth_simulateV1':
				if (failEthSimulate) throw new Error('eth_simulateV1 unavailable')
				return modules.serialize(
					modules.EthSimulateV1Result,
					(Array.isArray(rpcRequest.params?.[0]?.blockStateCalls) ? rpcRequest.params[0].blockStateCalls : [{}]).map((blockStateCall) =>
						makeFakeEthSimulateResult(0n, modules.Multicall3ABI, Array.isArray(blockStateCall.calls) ? blockStateCall.calls.length : 0),
					),
				)
			default:
				throw new Error(`Unexpected RPC method: ${ rpcRequest.method }`)
		}
	},
}
const ethereum = new modules.EthereumClientService(fakeRequestHandler, async () => undefined, async () => undefined, fakeRpcNetwork)
const simulator = {
	ethereum,
	tokenPriceService: new modules.TokenPriceService(ethereum, 60_000),
}

const activeAddress = modules.defaultActiveAddresses[0]?.address
const recipientAddress = modules.defaultActiveAddresses[1]?.address
if (activeAddress === undefined || recipientAddress === undefined) throw new Error('missing default addresses')

const unsignedTransaction = {
	type: '1559' as const,
	from: activeAddress,
	chainId: fakeRpcNetwork.chainId,
	nonce: 0n,
	maxFeePerGas: 1n,
	maxPriorityFeePerGas: 1n,
	gas: 21_000n,
	to: recipientAddress,
	value: 0n,
	input: new Uint8Array(),
	accessList: [],
}
const signedTransaction = modules.mockSignTransaction(unsignedTransaction)
const created = new Date('2024-01-01T00:00:00.000Z')
const oldTimestamp = new Date('2024-01-01T00:00:00.000Z')
const uniqueRequestIdentifier = { requestId: 1, requestSocket: { tabId: 1, connectionName: 0n } }
const popupVisualisation = {
	statusCode: 'success' as const,
	data: {
		activeAddress,
		simulationMode: true,
		simulationStartedTimestamp: created,
		uniqueRequestIdentifier,
		transactionToSimulate: {
			website: { websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
			created,
			originalRequestParameters: {
				method: 'eth_sendTransaction' as const,
				params: [{
					from: activeAddress,
					to: recipientAddress,
					value: 0n,
					gas: 21_000n,
					maxFeePerGas: 1n,
					maxPriorityFeePerGas: 1n,
					input: new Uint8Array(),
				}],
			},
			transactionIdentifier: 1n,
			success: true as const,
			transaction: unsignedTransaction,
		},
		signerName: 'NoSignerDetected',
		addressBookEntries: [],
		tokenPriceEstimates: [],
		namedTokenIds: [],
		simulationState: {
			success: true as const,
			simulationStateInput: [],
			simulatedBlocks: [],
			blockNumber: 123n,
			blockTimestamp: oldTimestamp,
			baseFeePerGas: 0n,
			simulationConductedTimestamp: oldTimestamp,
			rpcNetwork: fakeRpcNetwork,
		},
		visualizedSimulationState: { success: true as const, visualizedBlocks: [] },
	},
}

const pendingTransaction = {
		type: 'Transaction',
		popupOrTabId: { type: 'popup', id: 1 },
		originalRequestParameters: popupVisualisation.data.transactionToSimulate.originalRequestParameters,
		uniqueRequestIdentifier,
		simulationMode: true,
		activeAddress,
		created,
		transactionIdentifier: 1n,
		website: popupVisualisation.data.transactionToSimulate.website,
		approvalStatus: { status: 'WaitingForUser' },
		popupVisualisation,
		transactionOrMessageCreationStatus: 'Simulated',
		transactionToSimulate: popupVisualisation.data.transactionToSimulate,
	} as const

await modules.browserStorageLocalSet2({
	pendingTransactionsAndMessages: [pendingTransaction],
})

await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))

test('refreshing confirm transaction updates the persisted simulation timestamp', async () => {
	browserMock.sentMessages.length = 0
	await modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)
	const [pendingTransaction] = await modules.getPendingTransactionsAndMessages()
	if (pendingTransaction === undefined || pendingTransaction.type !== 'Transaction') throw new Error('missing refreshed pending transaction')
	if (pendingTransaction.popupVisualisation.statusCode !== 'success') throw new Error('unexpected popup visualisation state')
	const refreshedTimestamp = pendingTransaction.popupVisualisation.data.simulationState.simulationConductedTimestamp
	assert.ok(refreshedTimestamp.getTime() > oldTimestamp.getTime())
	assert.equal(browserMock.sentMessages.some((message) => message.method === 'popup_update_confirm_transaction_dialog_pending_transactions'), true)
})

function createDisconnectedPort() {
	let postAttempts = 0
	const event = {
		addListener() { return undefined },
		removeListener() { return undefined },
		hasListener() { return false },
	}
	const port: browser.runtime.Port = {
		name: 'disconnected-test-port',
		disconnect() { return undefined },
		postMessage() {
			postAttempts += 1
			throw new Error('Attempting to use a disconnected port object')
		},
		onMessage: event,
		onDisconnect: event,
	}
	return { port, getPostAttempts: () => postAttempts }
}

function createRecordingPort(postedMessages: unknown[]): browser.runtime.Port {
	const event = {
		addListener() { return undefined },
		removeListener() { return undefined },
		hasListener() { return false },
	}
	return {
		name: 'recording-test-port',
		disconnect() { return undefined },
		postMessage(message: unknown) { postedMessages.push(message) },
		onMessage: event,
		onDisconnect: event,
	}
}

function createWebsitePort(socket: { readonly tabId: number, readonly connectionName: bigint }, frameId: number, postedMessages: unknown[], onPostMessage?: (message: unknown) => void): browser.runtime.Port {
	return {
		...createRecordingPort(postedMessages),
		name: `0x${ socket.connectionName.toString(16) }`,
		sender: { tab: { id: socket.tabId }, frameId },
		postMessage(message: unknown) {
			postedMessages.push(message)
			onPostMessage?.(message)
		},
	}
}

async function waitForPendingTransactionsToClear() {
	const deadline = Date.now() + 2_000
	while ((await modules.getPendingTransactionsAndMessages()).length > 0) {
		if (Date.now() > deadline) throw new Error('Timed out waiting for pending popup-close retry')
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
}

test('accepts a signer reply from the current approved child-frame port', async () => {
	const topSocket = { tabId: 1, connectionName: 40n }
	const childSocket = { tabId: 1, connectionName: 41n }
	const childRequestIdentifier = { requestId: 77, requestSocket: childSocket }
	const topMessages: unknown[] = []
	const childMessages: unknown[] = []
	const topPort = createWebsitePort(topSocket, 0, topMessages)
	const childPort = createWebsitePort(childSocket, 2, childMessages)
	const websiteOrigin = 'https://example.com'
	const websiteTabConnections = new Map([[topSocket.tabId, {
		signerStateOwner: {
			connectionName: topSocket.connectionName,
			confirmed: true,
			generation: 3,
			providerGeneration: 8,
		},
		connections: {
			[modules.websiteSocketToString(topSocket)]: { port: topPort, socket: topSocket, websiteOrigin, approved: true, wantsToConnect: true },
			[modules.websiteSocketToString(childSocket)]: { port: childPort, socket: childSocket, websiteOrigin, approved: true, wantsToConnect: true },
		},
	}]])
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			uniqueRequestIdentifier: childRequestIdentifier,
			simulationMode: false,
			approvalStatus: { status: 'WaitingForSigner' },
		}],
	})

	await modules.signerReply(simulator.ethereum, simulator.tokenPriceService, () => undefined, websiteTabConnections, childPort, {
		method: 'signer_reply',
		params: [{
			success: true,
			signerProviderGeneration: 12,
			forwardRequest: {
				type: 'forwardToSigner',
				replyWithSignersReply: true,
				method: pendingTransaction.originalRequestParameters.method,
				params: pendingTransaction.originalRequestParameters.params,
				requestId: childRequestIdentifier.requestId,
			},
			reply: modules.EthereumBytes32.serialize(signedTransaction.hash),
		}],
		interceptorRequest: true,
		interceptorInternalRequest: true,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier: { requestId: 78, requestSocket: childSocket },
	}, 'hasAccess', activeAddress)

	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.equal(topMessages.length, 0)
	const childReply = childMessages.find((message) => isRecord(message) && message.method === 'eth_sendTransaction' && message.requestId === childRequestIdentifier.requestId)
	if (!isRecord(childReply)) throw new Error('Missing child-frame signer reply')
	assert.equal(childReply.result, modules.EthereumBytes32.serialize(signedTransaction.hash))
})

test('forwards a Safe transaction to the configured Safe signer as EIP-712 typed data', async () => {
	resetFakeSafeContractState()
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [recipientAddress],
		activeSigningAddress: recipientAddress,
	}))
	const safeAddressBookEntry = {
		type: 'safe' as const,
		name: 'Treasury Safe',
		address: activeAddress,
		chainId: fakeRpcNetwork.chainId,
		entrySource: 'User' as const,
		useAsActiveAddress: true,
		safeSignerAddress: recipientAddress,
	}
	await modules.updateUserAddressBookEntries(() => [safeAddressBookEntry])
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	const port = createWebsitePort(socket, 0, postedMessages)
	const websiteTabConnections = new Map([[socket.tabId, {
		connections: {
			[modules.websiteSocketToString(socket)]: {
				port,
				socket,
				websiteOrigin: 'https://example.com',
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			simulationMode: false,
			safeTransaction: {
				safeAddress: activeAddress,
				safeSignerAddress: recipientAddress,
				safeVersion: '1.4.1',
				threshold: 2n,
				reviewedSafeState: {
					version: '1.4.1',
					nonce: 0n,
					owners: [],
					threshold: 2n,
				},
				safeTxHash: BigInt(getSafeTxHash(safeTx)),
				safeTx,
			},
		}],
	})

	const alternateSigner = 0x2222222222222222222222222222222222222222n
	await modules.updateUserAddressBookEntries(() => [{ ...safeAddressBookEntry, safeSignerAddress: alternateSigner }])
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier },
	}), false)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	const [changedSignerProposal] = await modules.getPendingTransactionsAndMessages()
	assert.equal(changedSignerProposal?.approvalStatus.status, 'SignerError')
	if (changedSignerProposal?.approvalStatus.status !== 'SignerError') throw new Error('Missing changed-signer Gnosis Safe proposal error')
	assert.match(changedSignerProposal.approvalStatus.message, /configured Gnosis Safe signer changed/u)

	await modules.updateUserAddressBookEntries(() => [safeAddressBookEntry])
	await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (pending) => ({
		...pending,
		approvalStatus: { status: 'WaitingForUser' as const },
	}))
	fakeSafeOwners = [0x1111111111111111111111111111111111111111n]
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier },
	}), false)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	const [changedOwnersProposal] = await modules.getPendingTransactionsAndMessages()
	assert.equal(changedOwnersProposal?.approvalStatus.status, 'SignerError')
	if (changedOwnersProposal?.approvalStatus.status !== 'SignerError') throw new Error('Missing changed-owner Gnosis Safe proposal error')
	assert.match(changedOwnersProposal.approvalStatus.message, /owner set changed/u)

	fakeSafeOwners = []
	await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (pending) => ({
		...pending,
		approvalStatus: { status: 'WaitingForUser' as const },
	}))
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier },
	}), true)

	const signerRequest = postedMessages.find((message) => isRecord(message) && message.type === 'forwardToSigner')
	if (!isRecord(signerRequest) || !Array.isArray(signerRequest.params)) throw new Error('Missing Safe signer request')
	assert.equal(signerRequest.method, 'eth_signTypedData_v4')
	assert.equal(signerRequest.params[0], addressString(recipientAddress))
	assert.equal(typeof signerRequest.params[1], 'string')
	const typedData = JSON.parse(String(signerRequest.params[1]))
	assert.equal(typedData.primaryType, 'SafeTx')
	assert.equal(typedData.domain.chainId, fakeRpcNetwork.chainId.toString())
	assert.equal(typedData.message.to.toLowerCase(), `0x${ recipientAddress.toString(16).padStart(40, '0') }`)
})

test('routes a Safe co-signing request through the configured signer of the active Safe', async () => {
	resetFakeSafeContractState()
	const ownerAccount = privateKeyToAccount('0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd')
	const safeSignerAddress = BigInt(ownerAccount.address)
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	fakeSafeTransactionHash = BigInt(getSafeTxHash(safeTx))
	fakeSafeOwners = [safeSignerAddress]
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateUserAddressBookEntries(() => [{
		type: 'safe',
		name: 'Treasury Safe',
		address: activeAddress,
		chainId: fakeRpcNetwork.chainId,
		entrySource: 'User',
		useAsActiveAddress: true,
		safeSignerAddress,
		safeVersion: '1.4.1',
	}])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [safeSignerAddress],
		activeSigningAddress: safeSignerAddress,
		signerChain: fakeRpcNetwork.chainId,
	}))
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	const port = createWebsitePort(socket, 0, postedMessages)
	const websiteTabConnections = new Map([[socket.tabId, {
		connections: {
			[modules.websiteSocketToString(socket)]: {
				port,
				socket,
				websiteOrigin: 'https://sealwort.example',
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])
	const signRequest = {
		method: 'eth_signTypedData_v4' as const,
		params: [activeAddress, EIP712Message.parse(safeTxToTypedDataJson(safeTx))] as const,
	}
	const request = {
		interceptorRequest: true as const,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier,
		...signRequest,
	}
	const website = { websiteOrigin: 'https://sealwort.example', icon: undefined, title: 'Sealwort' }

	assert.deepEqual(await modules.openConfirmTransactionDialogForMessage(
		simulator.ethereum,
		simulator.tokenPriceService,
		request,
		signRequest,
		false,
		activeAddress,
		website,
		websiteTabConnections,
	), { type: 'doNotReply' })

	const [reviewedCoSignRequest] = await modules.getPendingTransactionsAndMessages()
	assert.notEqual(reviewedCoSignRequest?.type === 'SignableMessage' ? reviewedCoSignRequest.safeMessageCoSignSnapshot : undefined, undefined)
	fakeSafeOwners = [...fakeSafeOwners, 0x1111111111111111111111111111111111111111n]
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier },
	}), false)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	const [changedCoSignState] = await modules.getPendingTransactionsAndMessages()
	assert.equal(changedCoSignState?.approvalStatus.status, 'SignerError')
	if (changedCoSignState?.approvalStatus.status !== 'SignerError') throw new Error('Missing changed-state Safe co-signing error')
	assert.match(changedCoSignState.approvalStatus.message, /owner set changed/u)

	fakeSafeOwners = [safeSignerAddress]
	await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (pending) => ({
		...pending,
		approvalStatus: { status: 'WaitingForUser' as const },
	}))
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier },
	}), true)

	const signerRequest = postedMessages.find((message) => isRecord(message) && message.type === 'forwardToSigner')
	if (!isRecord(signerRequest) || !Array.isArray(signerRequest.params)) throw new Error('Missing Safe co-signer request')
	assert.equal(signerRequest.method, 'eth_signTypedData_v4')
	assert.equal(signerRequest.params[0], addressString(safeSignerAddress))
	assert.equal(JSON.parse(String(signerRequest.params[1])).domain.verifyingContract.toLowerCase(), addressString(activeAddress).toLowerCase())

	const signature = await ownerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(safeTx)))
	await modules.updateUserAddressBookEntries((entries) => entries.map((entry) =>
		entry.type === 'safe' && entry.address === activeAddress
			? { ...entry, safeSignerAddress: 0x2222222222222222222222222222222222222222n }
			: entry
	))
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'signerIncluded', signerReply: signature, uniqueRequestIdentifier },
	}), false)
	const changedSignerReply = postedMessages.find((message) =>
		isRecord(message) && message.type === 'result' && message.method === 'eth_signTypedData_v4' && message.requestId === uniqueRequestIdentifier.requestId
	)
	assert.equal(changedSignerReply, undefined)

	await modules.updateUserAddressBookEntries((entries) => entries.map((entry) =>
		entry.type === 'safe' && entry.address === activeAddress ? { ...entry, safeSignerAddress } : entry
	))
	await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (pending) => ({
		...pending,
		approvalStatus: { status: 'WaitingForSigner' as const },
	}))
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'signerIncluded', signerReply: signature, uniqueRequestIdentifier },
	}), true)
	const dappReply = postedMessages.find((message) =>
		isRecord(message) && message.type === 'result' && message.method === 'eth_signTypedData_v4' && message.requestId === uniqueRequestIdentifier.requestId
	)
	if (!isRecord(dappReply)) throw new Error('Missing Safe co-signature reply')
	assert.equal(dappReply.result, signature)
	assert.deepEqual(await modules.getSafeTransactionStacks(), [])
})

test('recognizes only execTransaction calls to the active Safe for direct signer execution', async () => {
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const safeSignerAddress = 0x1234567890123456789012345678901234567890n
	const safeEntry = {
		type: 'safe' as const,
		name: 'Treasury Safe',
		address: activeAddress,
		chainId: fakeRpcNetwork.chainId,
		entrySource: 'User' as const,
		useAsActiveAddress: true,
		safeSignerAddress,
	}
	const transaction = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(activeAddress),
			data: '0x6a76120200',
		}],
	})

	assert.equal(modules.isSafeExecutionRequestForActiveSafe(transaction, safeEntry), true)
	assert.deepEqual(modules.getSafeExecutionSignerRoute(transaction, safeEntry), {
		executor: safeSignerAddress,
		transactionParams: {
			method: 'eth_sendTransaction',
			params: [{
				...transaction.params[0],
				from: safeSignerAddress,
			}],
		},
	})
	assert.equal(modules.isSafeExecutionRequestForActiveSafe(SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(recipientAddress),
			to: addressString(activeAddress),
			data: '0x6a76120200',
		}],
	}), safeEntry), false)
	assert.equal(modules.isSafeExecutionRequestForActiveSafe(SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(recipientAddress),
			data: '0x6a76120200',
		}],
	}), safeEntry), false)
	assert.equal(modules.isSafeExecutionRequestForActiveSafe(SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(activeAddress),
			data: '0xa9059cbb',
		}],
	}), safeEntry), false)
	assert.equal(modules.isSafeExecutionRequestForActiveSafe(transaction, { ...safeEntry, safeSignerAddress: undefined }), false)
	const nonzeroOuterValue = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(activeAddress),
			value: '0x1',
			data: '0x6a76120200',
		}],
	})
	await assert.rejects(
		modules.prepareSafeExecutionSignerRoute(ethereum, nonzeroOuterValue, safeEntry),
		/A direct Gnosis Safe execution transaction must have zero outer ETH value/u,
	)
	fakeSafeThreshold = 3n
	const insufficientSignatures = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(activeAddress),
			data: encodeFunctionCall(SAFE_EXECUTION_ABI, 'execTransaction', [
				addressString(recipientAddress), 0n, '0x', 0n, 0n, 0n, 0n,
				addressString(0n), addressString(0n), `0x${ '00'.repeat(65) }`,
			]),
		}],
	})
	await assert.rejects(
		modules.prepareSafeExecutionSignerRoute(ethereum, insufficientSignatures, safeEntry),
		/cannot satisfy its 3-signature threshold/u,
	)
	fakeSafeThreshold = 2n
	fakeSafeOwners = [safeSignerAddress]
	await assert.rejects(
		modules.prepareSafeExecutionSignerRoute(ethereum, insufficientSignatures, safeEntry),
		/signature format that Interceptor cannot validate/u,
	)
	resetFakeSafeContractState()
})

test('changes the active Safe signer without revalidating the Safe contract', async () => {
	resetFakeSafeContractState()
	const alternateSigner = 0x1234567890123456789012345678901234567890n
	await modules.updateUserAddressBookEntries(() => [{
		type: 'safe',
		name: 'Treasury Safe',
		address: activeAddress,
		chainId: fakeRpcNetwork.chainId,
		entrySource: 'User',
		useAsActiveAddress: false,
		safeSignerAddress: recipientAddress,
		safeSignerAddresses: [recipientAddress, alternateSigner],
	}])

	const reply = await modules.setActiveSafeSigner(
		ethereum,
		simulator.tokenPriceService,
		() => undefined,
		new Map(),
		{
			method: 'popup_setActiveSafeSigner',
			data: {
				chainId: fakeRpcNetwork.chainId,
				safeAddress: activeAddress,
				safeSignerAddress: alternateSigner,
			},
		},
	)

	assert.deepEqual(reply, { type: 'SetActiveSafeSignerReply', ok: true })
	assert.equal((await modules.getUserAddressBookEntries())[0]?.safeSignerAddress, alternateSigner)
	assert.deepEqual(requestedRpcMethods, [])
})

test('routes a completed active Safe execution through its configured signer and rechecks signer changes', async () => {
	resetFakeSafeContractState()
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const safeSignerAddress = recipientAddress
	const existingOwnerAccount = privateKeyToAccount('0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')
	const existingOwnerAddress = BigInt(existingOwnerAccount.address)
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, fakeSafeNonce)
	const existingSignature = await existingOwnerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(safeTx)))
	fakeSafeOwners = [existingOwnerAddress, safeSignerAddress]
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateUserAddressBookEntries(() => [{
		type: 'safe',
		name: 'Treasury Safe',
		address: activeAddress,
		chainId: fakeRpcNetwork.chainId,
		entrySource: 'User',
		useAsActiveAddress: true,
		safeSignerAddress,
	}])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [safeSignerAddress],
		activeSigningAddress: safeSignerAddress,
		signerChain: fakeRpcNetwork.chainId,
	}))
	const transactionParams = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(activeAddress),
			value: '0x0',
			data: encodeFunctionCall(SAFE_EXECUTION_ABI, 'execTransaction', [
				addressString(recipientAddress),
				0n,
				'0x',
				0n,
				0n,
				0n,
				0n,
				addressString(0n),
				addressString(0n),
				existingSignature,
			]),
			gas: '0x5208',
			maxFeePerGas: '0x0',
			maxPriorityFeePerGas: '0x0',
		}],
	})
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	const port = createWebsitePort(socket, 0, postedMessages)
	const websiteTabConnections = new Map([[socket.tabId, {
		connections: {
			[modules.websiteSocketToString(socket)]: {
				port,
				socket,
				websiteOrigin: 'https://sealwort.example',
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])
	const request = {
		interceptorRequest: true as const,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier,
		...transactionParams,
	}

	assert.deepEqual(await modules.openConfirmTransactionDialogForTransaction(
		simulator.ethereum,
		simulator.tokenPriceService,
		request,
		transactionParams,
		false,
		activeAddress,
		{ websiteOrigin: 'https://sealwort.example', icon: undefined, title: 'Sealwort' },
		websiteTabConnections,
	), { type: 'doNotReply' })

	const [pendingExecution] = await modules.getPendingTransactionsAndMessages()
	assert.equal(pendingExecution?.type, 'Transaction')
	if (pendingExecution?.type !== 'Transaction') throw new Error('Missing direct Safe execution request')
	assert.equal(pendingExecution.transactionOrMessageCreationStatus, 'Simulated')
	assert.equal(pendingExecution.safeTransaction, undefined)
	assert.equal(pendingExecution.safeExecutionSignerAddress, safeSignerAddress)
	assert.deepEqual(pendingExecution.safeExecutionOriginalRequestParameters, transactionParams)
	assert.equal(pendingExecution.activeAddress, safeSignerAddress)
	assert.equal(pendingExecution.originalRequestParameters.method, 'eth_sendTransaction')
	if (pendingExecution.originalRequestParameters.method !== 'eth_sendTransaction') throw new Error('Unexpected direct Safe execution method')
	assert.equal(pendingExecution.originalRequestParameters.params[0].from, safeSignerAddress)

	assert.equal(await modules.resolvePendingTransactionOrMessage(
		simulator.ethereum,
		simulator.tokenPriceService,
		websiteTabConnections,
		{
			method: 'popup_confirmDialog',
			data: { action: 'accept', uniqueRequestIdentifier },
		},
		{ selectedSigner: activeAddress, verificationError: undefined },
	), false)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	const [mismatchedExecution] = await modules.getPendingTransactionsAndMessages()
	assert.equal(mismatchedExecution?.approvalStatus.status, 'SignerError')

	await modules.updateTabState(socket.tabId, (state) => ({
		...state,
		signerAccounts: [safeSignerAddress],
		activeSigningAddress: safeSignerAddress,
	}))
	await modules.refreshPendingSafeSignerSelectionErrors(simulator.ethereum, simulator.tokenPriceService, socket.tabId)
	const [recoveredExecution] = await modules.getPendingTransactionsAndMessages()
	assert.equal(recoveredExecution?.approvalStatus.status, 'WaitingForUser')

	fakeSafeNonce += 1n
	assert.equal(await modules.resolvePendingTransactionOrMessage(
		simulator.ethereum,
		simulator.tokenPriceService,
		websiteTabConnections,
		{
			method: 'popup_confirmDialog',
			data: { action: 'accept', uniqueRequestIdentifier },
		},
		{ selectedSigner: safeSignerAddress, verificationError: undefined },
	), false)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	const [staleExecution] = await modules.getPendingTransactionsAndMessages()
	assert.equal(staleExecution?.approvalStatus.status, 'SignerError')
	if (staleExecution?.approvalStatus.status !== 'SignerError') throw new Error('Missing stale Gnosis Safe execution error')
	assert.match(staleExecution.approvalStatus.message, /Gnosis Safe execution could not be prepared/u)

	fakeSafeNonce -= 1n
	await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (pending) => ({
		...pending,
		approvalStatus: { status: 'WaitingForUser' as const },
	}))
	fakeSafeOwners = [...fakeSafeOwners, 0x1111111111111111111111111111111111111111n]
	assert.equal(await modules.resolvePendingTransactionOrMessage(
		simulator.ethereum,
		simulator.tokenPriceService,
		websiteTabConnections,
		{
			method: 'popup_confirmDialog',
			data: { action: 'accept', uniqueRequestIdentifier },
		},
		{ selectedSigner: safeSignerAddress, verificationError: undefined },
	), false)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	const [changedOwnersExecution] = await modules.getPendingTransactionsAndMessages()
	assert.equal(changedOwnersExecution?.approvalStatus.status, 'SignerError')
	if (changedOwnersExecution?.approvalStatus.status !== 'SignerError') throw new Error('Missing changed-owner Gnosis Safe execution error')
	assert.match(changedOwnersExecution.approvalStatus.message, /owner set changed/u)

	fakeSafeOwners = [existingOwnerAddress, safeSignerAddress]
	await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (pending) => ({
		...pending,
		approvalStatus: { status: 'WaitingForUser' as const },
	}))
	assert.equal(await modules.resolvePendingTransactionOrMessage(
		simulator.ethereum,
		simulator.tokenPriceService,
		websiteTabConnections,
		{
			method: 'popup_confirmDialog',
			data: { action: 'accept', uniqueRequestIdentifier },
		},
		{ selectedSigner: safeSignerAddress, verificationError: undefined },
	), true)
	const signerRequest = postedMessages.find((message) => isRecord(message) && message.type === 'forwardToSigner')
	if (!isRecord(signerRequest) || !Array.isArray(signerRequest.params)) throw new Error('Missing direct Safe execution signer request')
	const signerTransaction = signerRequest.params[0]
	if (!isRecord(signerTransaction)) throw new Error('Missing direct Safe execution transaction parameters')
	assert.equal(signerRequest.method, 'eth_sendTransaction')
	assert.equal(signerTransaction.from, addressString(safeSignerAddress))
	assert.equal(signerTransaction.to, addressString(activeAddress))
	const prevalidatedSignerSignature = `0x${ safeSignerAddress.toString(16).padStart(64, '0') }${ '0'.repeat(64) }01`
	const completedSignatures = [
		{ signer: existingOwnerAddress, signature: existingSignature },
		{ signer: safeSignerAddress, signature: prevalidatedSignerSignature },
	]
		.sort((left, right) => left.signer < right.signer ? -1 : left.signer > right.signer ? 1 : 0)
		.map(({ signature }) => signature.slice(2))
		.join('')
	assert.equal(signerTransaction.data, encodeFunctionCall(SAFE_EXECUTION_ABI, 'execTransaction', [
		addressString(recipientAddress),
		0n,
		'0x',
		0n,
		0n,
		0n,
		0n,
		addressString(0n),
		addressString(0n),
		`0x${ completedSignatures }`,
	]))
	assert.equal(postedMessages.some((message) => isRecord(message) && message.method === 'eth_signTypedData_v4'), false)
	assert.deepEqual(await modules.getSafeTransactionStacks(), [])

	const transactionHash = `0x${ 'ab'.repeat(32) }`
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'signerIncluded', signerReply: transactionHash, uniqueRequestIdentifier },
	}), true)
	const dappReply = postedMessages.find((message) =>
		isRecord(message) && message.type === 'result' && message.method === 'eth_sendTransaction' && message.requestId === uniqueRequestIdentifier.requestId
	)
	if (!isRecord(dappReply)) throw new Error('Missing direct Safe execution dapp reply')
	assert.equal(dappReply.result, transactionHash)
})

test('blocks direct Safe execution when the configured signer cannot satisfy the threshold', async () => {
	resetFakeSafeContractState()
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const configuredSigner = recipientAddress
	const existingOwnerAccount = privateKeyToAccount('0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')
	const existingOwnerAddress = BigInt(existingOwnerAccount.address)
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, fakeSafeNonce)
	const existingSignature = await existingOwnerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(safeTx)))
	fakeSafeThreshold = 3n
	fakeSafeOwners = [existingOwnerAddress, configuredSigner, 0x1111111111111111111111111111111111111111n]
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateUserAddressBookEntries(() => [{
		type: 'safe',
		name: 'Treasury Safe',
		address: activeAddress,
		chainId: fakeRpcNetwork.chainId,
		entrySource: 'User',
		useAsActiveAddress: true,
		safeSignerAddress: configuredSigner,
	}])
	const transactionParams = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(activeAddress),
			data: encodeFunctionCall(SAFE_EXECUTION_ABI, 'execTransaction', [
				addressString(recipientAddress),
				0n,
				'0x',
				0n,
				0n,
				0n,
				0n,
				addressString(0n),
				addressString(0n),
				existingSignature,
			]),
		}],
	})
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	const port = createWebsitePort(socket, 0, postedMessages)
	const websiteTabConnections = new Map([[socket.tabId, {
		connections: {
			[modules.websiteSocketToString(socket)]: {
				port,
				socket,
				websiteOrigin: 'https://sealwort.example',
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])

	assert.deepEqual(await withSilencedConsole(async () => await modules.openConfirmTransactionDialogForTransaction(
		simulator.ethereum,
		simulator.tokenPriceService,
		{
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier,
			...transactionParams,
		},
		transactionParams,
		false,
		activeAddress,
		{ websiteOrigin: 'https://sealwort.example', icon: undefined, title: 'Sealwort' },
		websiteTabConnections,
	)), { type: 'doNotReply' })

	const [pendingFailure] = await modules.getPendingTransactionsAndMessages()
	assert.equal(pendingFailure?.transactionOrMessageCreationStatus, 'FailedToSimulate')
	if (pendingFailure?.type !== 'Transaction' || !('transactionToSimulate' in pendingFailure)) throw new Error('Missing failed direct Safe execution confirmation')
	assert.equal(pendingFailure.transactionToSimulate.success, false)
	if (pendingFailure.transactionToSimulate.success) throw new Error('Expected Safe execution preparation failure')
	assert.match(pendingFailure.transactionToSimulate.error.message, /cannot satisfy its 3-signature threshold/u)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
})

test('rejects EIP-7702 authorization lists before creating a Safe proposal', async () => {
	resetFakeSafeContractState()
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateUserAddressBookEntries(() => [{
		type: 'safe',
		name: 'Treasury Safe',
		address: activeAddress,
		chainId: fakeRpcNetwork.chainId,
		entrySource: 'User',
		useAsActiveAddress: true,
		safeSignerAddress: recipientAddress,
		safeVersion: '1.4.1',
	}])
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const transactionParams = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			type: '0x4',
			from: addressString(activeAddress),
			to: addressString(recipientAddress),
			value: '0x0',
			authorizationList: [{
				chainId: '0x1',
				address: '0x0000000000000000000000000000000000000000',
				nonce: '0x0',
				yParity: '0x0',
				r: '0x1',
				s: '0x2',
			}],
		}],
	})
	const postedMessages: unknown[] = []
	const port = createWebsitePort(uniqueRequestIdentifier.requestSocket, 0, postedMessages)
	const websiteTabConnections = new Map([[uniqueRequestIdentifier.requestSocket.tabId, {
		connections: {
			[modules.websiteSocketToString(uniqueRequestIdentifier.requestSocket)]: {
				port,
				socket: uniqueRequestIdentifier.requestSocket,
				websiteOrigin: 'https://example.com',
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])

	const reply = await modules.openConfirmTransactionDialogForTransaction(
		simulator.ethereum,
		simulator.tokenPriceService,
		{
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier,
			method: transactionParams.method,
			params: transactionParams.params,
		},
		transactionParams,
		false,
		activeAddress,
		{ websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
		websiteTabConnections,
	)

	assert.equal(reply.type, 'result')
	assert.equal('error' in reply ? reply.error.code : undefined, 4200)
	assert.match('error' in reply ? reply.error.message : '', /do not support EIP-7702 authorization lists/u)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(await modules.getSafeTransactionStacks(), [])
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	await modules.updateUserAddressBookEntries(() => modules.defaultActiveAddresses)
})

test('shows stale local Safe stack failures in the transaction confirmation', async () => {
	resetFakeSafeContractState()
	fakeSafeNonce = 1n
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateSafeTransactionStacks(() => [{
		chainId: fakeRpcNetwork.chainId,
		safeAddress: activeAddress,
		safeVersion: '1.4.1',
		baseNonce: 0n,
		threshold: 2n,
		transactions: [],
	}])
	await modules.updateUserAddressBookEntries(() => [{
		type: 'safe',
		name: 'Treasury Safe',
		address: activeAddress,
		chainId: fakeRpcNetwork.chainId,
		entrySource: 'User',
		useAsActiveAddress: true,
		safeSignerAddress: recipientAddress,
		safeVersion: '1.4.1',
	}])
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const transactionParams = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(recipientAddress),
			value: '0x0',
			data: '0x',
		}],
	})
	const postedMessages: unknown[] = []
	const port = createWebsitePort(uniqueRequestIdentifier.requestSocket, 0, postedMessages)
	const websiteTabConnections = new Map([[uniqueRequestIdentifier.requestSocket.tabId, {
		connections: {
			[modules.websiteSocketToString(uniqueRequestIdentifier.requestSocket)]: {
				port,
				socket: uniqueRequestIdentifier.requestSocket,
				websiteOrigin: 'https://example.com',
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])

	const reply = await withSilencedConsole(async () => await modules.openConfirmTransactionDialogForTransaction(
		simulator.ethereum,
		simulator.tokenPriceService,
		{
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier,
			method: transactionParams.method,
			params: transactionParams.params,
		},
		transactionParams,
		false,
		activeAddress,
		{ websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
		websiteTabConnections,
	))

	assert.deepEqual(reply, { type: 'doNotReply' })
	const [pendingFailure] = await modules.getPendingTransactionsAndMessages()
	assert.equal(pendingFailure?.transactionOrMessageCreationStatus, 'FailedToSimulate')
	if (pendingFailure?.type !== 'Transaction' || !('transactionToSimulate' in pendingFailure)) throw new Error('Missing failed Safe confirmation')
	assert.equal(pendingFailure.transactionToSimulate.success, false)
	if (pendingFailure.transactionToSimulate.success) throw new Error('Expected Safe preparation failure')
	assert.match(pendingFailure.transactionToSimulate.error.message, /current Gnosis Safe nonce 1 is beyond this stack's final nonce 0/u)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier },
	}), false)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	assert.equal((await modules.getPendingTransactionsAndMessages())[0]?.transactionOrMessageCreationStatus, 'FailedToSimulate')

	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateUserAddressBookEntries(() => modules.defaultActiveAddresses)
})

test('reconciles executed Safe operations before simulating the next proposal', async () => {
	resetFakeSafeContractState()
	const firstSafeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	const secondSafeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 1n,
		input: new Uint8Array(),
	}, 1n)
	const transactions = [firstSafeTx, secondSafeTx].map((safeTx, index) => ({
		safeTx,
		safeTxHash: BigInt(getSafeTxHash(safeTx)),
		created,
		websiteOrigin: 'https://example.com',
		transactionIdentifier: 80n + BigInt(index),
		signatures: [],
	}))
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			uniqueRequestIdentifier: { requestId: 404, requestSocket: uniqueRequestIdentifier.requestSocket },
			safeTransaction: {
				safeAddress: activeAddress,
				safeSignerAddress: recipientAddress,
				safeVersion: '1.4.1',
				threshold: 2n,
				safeTxHash: transactions[0]?.safeTxHash ?? 0n,
				safeTx: firstSafeTx,
			},
		}],
	})
	await modules.updateSafeTransactionStacks(() => [{
		chainId: fakeRpcNetwork.chainId,
		safeAddress: activeAddress,
		safeVersion: '1.4.1',
		baseNonce: 0n,
		threshold: 2n,
		transactions,
	}])
	await modules.updateInterceptorTransactionStack(() => ({
		operations: transactions.map((safeTransaction) => ({
			type: 'Transaction' as const,
			preSimulationTransaction: {
				...pendingTransaction.transactionToSimulate,
				signedTransaction,
				transactionIdentifier: safeTransaction.transactionIdentifier,
				safeTransaction,
			},
		})),
	}))
	await modules.updateUserAddressBookEntries(() => [{
		type: 'safe',
		name: 'Treasury Safe',
		address: activeAddress,
		chainId: fakeRpcNetwork.chainId,
		entrySource: 'User',
		useAsActiveAddress: true,
		safeSignerAddress: recipientAddress,
		safeVersion: '1.4.1',
	}])
	fakeSafeNonce = 1n
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const transactionParams = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(recipientAddress),
			value: '0x2',
			data: '0x',
		}],
	})
	fakeSafeTransactionHash = BigInt(getSafeTxHash(createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 2n,
		input: new Uint8Array(),
	}, 2n)))
	const port = createWebsitePort(uniqueRequestIdentifier.requestSocket, 0, [])
	const websiteTabConnections = new Map([[uniqueRequestIdentifier.requestSocket.tabId, {
		connections: {
			[modules.websiteSocketToString(uniqueRequestIdentifier.requestSocket)]: {
				port,
				socket: uniqueRequestIdentifier.requestSocket,
				websiteOrigin: 'https://example.com',
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])

	assert.deepEqual(await modules.openConfirmTransactionDialogForTransaction(
		simulator.ethereum,
		simulator.tokenPriceService,
		{
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier,
			method: transactionParams.method,
			params: transactionParams.params,
		},
		transactionParams,
		false,
		activeAddress,
		{ websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
		websiteTabConnections,
	), { type: 'doNotReply' })

	const [storedStack] = await modules.getSafeTransactionStacks()
	assert.equal(storedStack?.baseNonce, 1n)
	assert.deepEqual(storedStack?.transactions.map(({ transactionIdentifier }) => transactionIdentifier), [81n])
	const storedOperations = (await modules.getInterceptorTransactionStack()).operations
	assert.deepEqual(storedOperations.map((operation) => operation.type === 'Transaction' ? operation.preSimulationTransaction.transactionIdentifier : undefined), [81n])
	const pendingProposal = (await modules.getPendingTransactionsAndMessages()).find((pending) =>
		pending.uniqueRequestIdentifier.requestId === uniqueRequestIdentifier.requestId
	)
	assert.equal(pendingProposal?.safeTransaction?.safeTx.message.nonce, 2n)

		await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
		await modules.updateSafeTransactionStacks(() => [])
		await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
		await modules.updateUserAddressBookEntries(() => modules.defaultActiveAddresses)
})

test('uses zero-reimbursement Safe semantics in the pre-sign confirmation simulation', async () => {
	resetFakeSafeContractState()
	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
	await (await import('../../app/ts/background/settings.js')).changeSimulationMode({
		simulationMode: false,
		rpcNetwork: fakeRpcNetwork,
	})
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	const safeTxHash = BigInt(getSafeTxHash(safeTx))
	const popupVisualisation = await (await import('../../app/ts/background/background.js')).refreshConfirmTransactionSimulation(
		simulator.ethereum,
		simulator.tokenPriceService,
		activeAddress,
		false,
		uniqueRequestIdentifier,
		pendingTransaction.transactionToSimulate,
		{
			safeAddress: activeAddress,
			safeSignerAddress: recipientAddress,
			safeVersion: '1.4.1',
			threshold: 2n,
			safeTxHash,
			safeTx,
			executionGasLimit: 123_456n,
		},
	)

	assert.equal(popupVisualisation?.statusCode, 'success')
	if (popupVisualisation?.statusCode !== 'success') throw new Error('Safe confirmation simulation failed')
	assert.equal(popupVisualisation.data.simulationState.simulationStateInput.at(-1)?.simulateWithZeroBaseFee, true)
	if (!popupVisualisation.data.visualizedSimulationState.success) {
		throw new Error('Safe confirmation visualization failed')
	}
	const simulatedSafeTransaction = popupVisualisation.data.visualizedSimulationState.visualizedBlocks
		.at(-1)?.simulatedAndVisualizedTransactions.at(-1)
	assert.equal(simulatedSafeTransaction?.safeTransaction?.safeTxHash, safeTxHash)
	assert.equal(simulatedSafeTransaction?.realizedGasPrice, 0n)
	assert.equal(simulatedSafeTransaction?.transaction.gas, 123_456n)
})

test('prepares Safe transaction intent without charging gas to the Safe', async () => {
	resetFakeSafeContractState()
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const transactionParams = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(recipientAddress),
			value: '0x0',
			data: '0xa9059cbb',
			maxFeePerGas: '0x1234',
			maxPriorityFeePerGas: '0x42',
		}],
	})

	const prepared = await modules.formEthSendTransaction(
		simulator.ethereum,
		undefined,
		activeAddress,
		{ websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
		transactionParams,
		created,
		1n,
		false,
		'external-executor',
	)

	assert.equal(prepared.success, true)
	if (!prepared.success) throw new Error('Safe transaction intent preparation failed')
	assert.equal(prepared.transaction.from, activeAddress)
	assert.equal(prepared.transaction.to, recipientAddress)
	assert.equal(prepared.transaction.value, 0n)
	assert.deepEqual(prepared.transaction.input, hexToBytes('0xa9059cbb'))
	assert.equal(prepared.transaction.gas, 32_813n)
	assert.equal(prepared.transaction.maxFeePerGas, 0n)
	assert.equal(prepared.transaction.maxPriorityFeePerGas, 0n)
	assert.equal(requestedRpcMethods.includes('eth_getBalance'), false)
	assert.equal(requestedRpcMethods.includes('eth_estimateGas'), false)
	assert.equal(requestedRpcMethods.includes('eth_simulateV1'), true)
})

test('does not fall back to ordinary gas estimation when Safe simulation state is unavailable', async () => {
	resetFakeSafeContractState()
	failEthSimulate = true
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const transactionParams = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(recipientAddress),
			value: '0x0',
			data: '0xa9059cbb',
		}],
	})

	const prepared = await withSilencedConsole(async () => await modules.formEthSendTransaction(
		simulator.ethereum,
		undefined,
		activeAddress,
		{ websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
		transactionParams,
		created,
		1n,
		false,
		'external-executor',
	))

	assert.equal(prepared.success, false)
	if (prepared.success) throw new Error('Safe gas preparation unexpectedly succeeded')
	assert.match(prepared.error.message, /eth_simulateV1 unavailable|requires the Interceptor simulator/u)
	assert.equal(requestedRpcMethods.includes('eth_getBalance'), false)
	assert.equal(requestedRpcMethods.includes('eth_estimateGas'), false)
})

test('refreshes pending Safe intent without charging gas to the Safe', async () => {
	resetFakeSafeContractState()
	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
	await (await import('../../app/ts/background/settings.js')).changeSimulationMode({
		simulationMode: false,
		rpcNetwork: fakeRpcNetwork,
	})
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const transactionParams = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(recipientAddress),
			value: '0x0',
			data: '0xa9059cbb',
			maxFeePerGas: '0x1234',
			maxPriorityFeePerGas: '0x42',
		}],
	})
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: hexToBytes('0xa9059cbb'),
	}, 0n)
	const safeTxHash = BigInt(getSafeTxHash(safeTx))
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			originalRequestParameters: transactionParams,
			simulationMode: false,
			transactionToSimulate: {
				...pendingTransaction.transactionToSimulate,
				originalRequestParameters: transactionParams,
			},
			safeTransaction: {
				safeAddress: activeAddress,
				safeSignerAddress: recipientAddress,
				safeVersion: '1.4.1',
				threshold: 2n,
				reviewedSafeState: {
					version: '1.4.1',
					nonce: 0n,
					owners: [],
					threshold: 2n,
				},
				safeTxHash,
				safeTx,
				executionGasLimit: 32_813n,
			},
		}],
	})

	await modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)

	const [refreshed] = await modules.getPendingTransactionsAndMessages()
	if (refreshed?.type !== 'Transaction' || refreshed.transactionOrMessageCreationStatus !== 'Simulated') {
		throw new Error('Pending Safe transaction was not refreshed')
	}
	assert.equal(refreshed.transactionToSimulate.transaction.maxFeePerGas, 0n)
	assert.equal(refreshed.transactionToSimulate.transaction.maxPriorityFeePerGas, 0n)
	assert.equal(refreshed.safeTransaction?.executionGasLimit, 32_813n)
	assert.deepEqual(refreshed.transactionToSimulate.transaction.input, hexToBytes('0xa9059cbb'))
	assert.equal(requestedRpcMethods.includes('eth_getBalance'), false)
	assert.equal(requestedRpcMethods.includes('eth_estimateGas'), false)
	assert.equal(requestedRpcMethods.includes('eth_simulateV1'), true)
})

test('shows a Safe signer mismatch in the confirmation popup and never forwards it', async () => {
	resetFakeSafeContractState()
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
	await (await import('../../app/ts/background/settings.js')).changeSimulationMode({
		simulationMode: false,
		rpcNetwork: fakeRpcNetwork,
	})
	await modules.updateUserAddressBookEntries(() => [{
		type: 'safe',
		name: 'Treasury Safe',
		address: activeAddress,
		chainId: fakeRpcNetwork.chainId,
		entrySource: 'User',
		useAsActiveAddress: true,
		safeSignerAddress: recipientAddress,
		safeVersion: '1.4.1',
	}])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerName: 'MetaMask',
		signerAccounts: [activeAddress],
		activeSigningAddress: activeAddress,
		signerChain: fakeRpcNetwork.chainId,
	}))
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const transactionParams = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(recipientAddress),
			value: '0x0',
			data: '0x',
			gas: '0x5208',
		}],
	})
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	fakeSafeTransactionHash = BigInt(getSafeTxHash(safeTx))
	const postedMessages: unknown[] = []
	const port = createWebsitePort(uniqueRequestIdentifier.requestSocket, 0, postedMessages)
	const websiteTabConnections = new Map([[uniqueRequestIdentifier.requestSocket.tabId, {
		connections: {
			[modules.websiteSocketToString(uniqueRequestIdentifier.requestSocket)]: {
				port,
				socket: uniqueRequestIdentifier.requestSocket,
				websiteOrigin: 'https://example.com',
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])
	const request = {
		interceptorRequest: true as const,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier,
		method: transactionParams.method,
		params: transactionParams.params,
	}

	assert.deepEqual(await modules.openConfirmTransactionDialogForTransaction(
		simulator.ethereum,
		simulator.tokenPriceService,
		request,
		transactionParams,
		false,
		activeAddress,
		{ websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
		websiteTabConnections,
	), { type: 'doNotReply' })

	const [pendingMismatch] = await modules.getPendingTransactionsAndMessages()
	assert.equal(pendingMismatch?.transactionOrMessageCreationStatus, 'Simulated')
	assert.equal(pendingMismatch?.approvalStatus.status, 'SignerError')
	if (pendingMismatch?.approvalStatus.status !== 'SignerError') throw new Error('Missing Safe signer mismatch')
	assert.match(pendingMismatch.approvalStatus.message, /Gnosis Safe signer mismatch/u)
	assert.match(pendingMismatch.approvalStatus.message, /Select 0x[0-9A-Fa-f]{40} in MetaMask, then retry\./u)
	assert.match(pendingMismatch.approvalStatus.message.toLowerCase(), new RegExp(addressString(recipientAddress).toLowerCase(), 'u'))
	assert.match(pendingMismatch.approvalStatus.message.toLowerCase(), new RegExp(addressString(activeAddress).toLowerCase(), 'u'))
	assert.equal(pendingMismatch.type === 'Transaction' && pendingMismatch.safeTransaction !== undefined, true)

	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier },
	}), false)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)

	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateUserAddressBookEntries(() => modules.defaultActiveAddresses)
})

test('refreshes the selected signer before forwarding a Safe transaction', async () => {
	resetFakeSafeContractState()
	const configuredSigner = recipientAddress
	const freshlySelectedSigner = activeAddress
	await modules.updateUserAddressBookEntries(() => [{
		type: 'safe',
		name: 'Treasury Safe',
		address: activeAddress,
		chainId: fakeRpcNetwork.chainId,
		entrySource: 'User',
		useAsActiveAddress: true,
		safeSignerAddress: configuredSigner,
	}])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerName: 'MetaMask',
		signerAccounts: [configuredSigner],
		activeSigningAddress: configuredSigner,
		signerChain: fakeRpcNetwork.chainId,
	}))
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			simulationMode: false,
			safeTransaction: {
				safeAddress: activeAddress,
				safeSignerAddress: configuredSigner,
				safeVersion: '1.4.1',
				threshold: 2n,
				reviewedSafeState: { version: '1.4.1', nonce: 0n, owners: [], threshold: 2n },
				safeTxHash: BigInt(getSafeTxHash(safeTx)),
				safeTx,
			},
		}],
	})
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	let accountReply: Promise<unknown> | undefined
	let websiteTabConnections: Map<number, {
		signerStateOwner: {
			connectionName: bigint
			confirmed: boolean
			generation: number
			providerGeneration: number
		}
		connections: Record<string, {
			port: browser.runtime.Port
			socket: typeof socket
			websiteOrigin: string
			approved: boolean
			wantsToConnect: boolean
		}>
	}>
	let port: browser.runtime.Port
	port = createWebsitePort(socket, 0, postedMessages, (message) => {
		if (!isRecord(message) || message.method !== 'request_signer_to_eth_accounts') return
		accountReply = modules.ethAccountsReply(
			simulator.ethereum,
			simulator.tokenPriceService,
			() => undefined,
			websiteTabConnections,
			port,
			{
				method: 'eth_accounts_reply',
				params: [{
					signerProviderGeneration: 1,
					type: 'success',
					accounts: [addressString(freshlySelectedSigner)],
					requestAccounts: false,
				}],
			},
			'hasAccess',
			activeAddress,
		)
	})
	websiteTabConnections = new Map([[socket.tabId, {
		signerStateOwner: {
			connectionName: socket.connectionName,
			confirmed: true,
			generation: 1,
			providerGeneration: 1,
		},
		connections: {
			[modules.websiteSocketToString(socket)]: {
				port,
				socket,
				websiteOrigin: 'https://example.com',
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])

	await modules.confirmDialog(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier },
	})
	await accountReply

	assert.equal(postedMessages.some((message) => isRecord(message) && message.method === 'request_signer_to_eth_accounts'), true)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	const [refreshedMismatch] = await modules.getPendingTransactionsAndMessages()
	assert.equal(refreshedMismatch?.approvalStatus.status, 'SignerError')
	if (refreshedMismatch?.approvalStatus.status !== 'SignerError') throw new Error('Missing refreshed Safe signer mismatch')
	assert.match(refreshedMismatch.approvalStatus.message.toLowerCase(), new RegExp(addressString(freshlySelectedSigner).toLowerCase(), 'u'))

	await modules.ethAccountsReply(
		simulator.ethereum,
		simulator.tokenPriceService,
		() => undefined,
		websiteTabConnections,
		port,
		{
			method: 'eth_accounts_reply',
			params: [{
				signerProviderGeneration: 1,
				type: 'success',
				accounts: [addressString(configuredSigner)],
				requestAccounts: false,
			}],
		},
		'hasAccess',
		activeAddress,
	)
	const [readyAfterAccountChange] = await modules.getPendingTransactionsAndMessages()
	assert.equal(readyAfterAccountChange?.approvalStatus.status, 'WaitingForUser')
})

test('rebases a later pending Safe proposal after an earlier nonce is rejected', async () => {
	resetFakeSafeContractState()
	const ownerAccount = privateKeyToAccount('0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')
	const safeSignerAddress = BigInt(ownerAccount.address)
	await modules.updateUserAddressBookEntries(() => [{
		type: 'safe',
		name: 'Treasury Safe',
		address: activeAddress,
		chainId: fakeRpcNetwork.chainId,
		entrySource: 'User',
		useAsActiveAddress: true,
		safeSignerAddress,
	}])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [safeSignerAddress],
		activeSigningAddress: safeSignerAddress,
	}))
	const firstIdentifier = { requestId: 31, requestSocket: uniqueRequestIdentifier.requestSocket }
	const secondIdentifier = { requestId: 32, requestSocket: uniqueRequestIdentifier.requestSocket }
	const firstSafeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	const rebasedSafeTx = firstSafeTx
	const secondSafeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 1n)
	const rebasedSafeTxHash = BigInt(getSafeTxHash(rebasedSafeTx))
	fakeSafeTransactionHash = rebasedSafeTxHash
	const makePendingSafeTransaction = (requestIdentifier: typeof firstIdentifier, safeTx: typeof firstSafeTx, transactionIdentifier: bigint) => ({
		...pendingTransaction,
		uniqueRequestIdentifier: requestIdentifier,
		transactionIdentifier,
		simulationMode: false as const,
		approvalStatus: { status: 'WaitingForUser' as const },
		safeTransaction: {
			safeAddress: activeAddress,
			safeSignerAddress,
			safeVersion: '1.4.1',
			threshold: 2n,
			reviewedSafeState: { version: '1.4.1', nonce: 0n, owners: [], threshold: 2n },
			safeTxHash: BigInt(getSafeTxHash(safeTx)),
			safeTx,
		},
	})
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [
			makePendingSafeTransaction(firstIdentifier, firstSafeTx, 31n),
			makePendingSafeTransaction(secondIdentifier, secondSafeTx, 32n),
		],
	})

	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, new Map(), {
		method: 'popup_confirmDialog',
		data: { action: 'reject', errorString: undefined, uniqueRequestIdentifier: firstIdentifier },
	}), false)

	const postedMessages: unknown[] = []
	const socket = secondIdentifier.requestSocket
	const port = createWebsitePort(socket, 0, postedMessages)
	const websiteTabConnections = new Map([[socket.tabId, {
		connections: {
			[modules.websiteSocketToString(socket)]: {
				port,
				socket,
				websiteOrigin: 'https://example.com',
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier: secondIdentifier },
	}), false)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	const [refreshedProposal] = await modules.getPendingTransactionsAndMessages()
	assert.equal(refreshedProposal?.safeTransaction?.safeTx.message.nonce, 0n)
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier: secondIdentifier },
	}), true)
	const signerRequest = postedMessages.find((message) => isRecord(message) && message.type === 'forwardToSigner')
	if (!isRecord(signerRequest) || !Array.isArray(signerRequest.params)) throw new Error('Missing rebased Safe signer request')
	const typedData = EIP712Message.parse(signerRequest.params[1])
	assert.equal(typedData.message.nonce, 0n)

	const signature = await ownerAccount.signTypedData(typedData)
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'signerIncluded', signerReply: signature, uniqueRequestIdentifier: secondIdentifier },
	}), true)
	const [safeStack] = await modules.getSafeTransactionStacks()
	assert.equal(safeStack?.baseNonce, 0n)
	assert.equal(safeStack?.transactions[0]?.safeTxHash, rebasedSafeTxHash)
})

test('rejects a stale forwarded Safe nonce before persistence and rebases it when retried', async () => {
	resetFakeSafeContractState()
	const ownerAccount = privateKeyToAccount('0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')
	const safeSignerAddress = BigInt(ownerAccount.address)
	await modules.updateUserAddressBookEntries(() => [{
		type: 'safe',
		name: 'Treasury Safe',
		address: activeAddress,
		chainId: fakeRpcNetwork.chainId,
		entrySource: 'User',
		useAsActiveAddress: true,
		safeSignerAddress,
	}])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [safeSignerAddress],
		activeSigningAddress: safeSignerAddress,
	}))
	const requestIdentifier = { requestId: 33, requestSocket: uniqueRequestIdentifier.requestSocket }
	const staleSafeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 1n)
	const rebasedSafeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	fakeSafeTransactionHash = BigInt(getSafeTxHash(rebasedSafeTx))
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			uniqueRequestIdentifier: requestIdentifier,
			simulationMode: false,
			approvalStatus: { status: 'WaitingForSigner' },
			safeTransaction: {
				safeAddress: activeAddress,
				safeSignerAddress,
					safeVersion: '1.4.1',
					threshold: 2n,
					reviewedSafeState: { version: '1.4.1', nonce: 0n, owners: [], threshold: 2n },
					safeTxHash: BigInt(getSafeTxHash(staleSafeTx)),
				safeTx: staleSafeTx,
			},
		}],
	})
	const staleSignature = await ownerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(staleSafeTx)))

	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, new Map(), {
		method: 'popup_confirmDialog',
		data: { action: 'signerIncluded', signerReply: staleSignature, uniqueRequestIdentifier: requestIdentifier },
	}), false)
	assert.deepEqual(await modules.getSafeTransactionStacks(), [])
	const [stalePending] = await modules.getPendingTransactionsAndMessages()
	assert.equal(stalePending?.approvalStatus.status, 'SignerError')
	if (stalePending?.approvalStatus.status !== 'SignerError') throw new Error('Missing stale Safe nonce signer error')
	assert.match(stalePending.approvalStatus.message, /next available nonce is 0/u)

	const postedMessages: unknown[] = []
	const socket = requestIdentifier.requestSocket
	const port = createWebsitePort(socket, 0, postedMessages)
	const websiteTabConnections = new Map([[socket.tabId, {
		connections: {
			[modules.websiteSocketToString(socket)]: {
				port,
				socket,
				websiteOrigin: 'https://example.com',
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier: requestIdentifier },
	}), false)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	const [refreshedPending] = await modules.getPendingTransactionsAndMessages()
	assert.equal(refreshedPending?.safeTransaction?.safeTx.message.nonce, 0n)
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier: requestIdentifier },
	}), true)
	const signerRequest = postedMessages.find((message) => isRecord(message) && message.type === 'forwardToSigner')
	if (!isRecord(signerRequest) || !Array.isArray(signerRequest.params)) throw new Error('Missing retried Safe signer request')
	assert.equal(EIP712Message.parse(signerRequest.params[1]).message.nonce, 0n)
})

test('persists and simulates a valid Safe owner signature before replying with the canonical Safe hash', async () => {
	resetFakeSafeContractState()
	const ownerAccount = privateKeyToAccount('0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')
	const safeSignerAddress = BigInt(ownerAccount.address)
	const safeAddressBookEntry = {
		type: 'safe' as const,
		name: 'Treasury Safe',
		address: activeAddress,
		chainId: fakeRpcNetwork.chainId,
		entrySource: 'User' as const,
		useAsActiveAddress: true,
		safeSignerAddress,
	}
	await modules.updateUserAddressBookEntries(() => [safeAddressBookEntry])
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	const safeTxHash = BigInt(getSafeTxHash(safeTx))
	const signature = await ownerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(safeTx)))
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	const port = createWebsitePort(socket, 0, postedMessages)
	const websiteTabConnections = new Map([[socket.tabId, {
		connections: {
			[modules.websiteSocketToString(socket)]: {
				port,
				socket,
				websiteOrigin: 'https://example.com',
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
	await (await import('../../app/ts/background/settings.js')).changeSimulationMode({
		simulationMode: false,
		rpcNetwork: fakeRpcNetwork,
	})
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			simulationMode: false,
			approvalStatus: { status: 'WaitingForSigner' },
			safeTransaction: {
				safeAddress: activeAddress,
				safeSignerAddress,
				safeVersion: '1.4.1',
				threshold: 2n,
				reviewedSafeState: {
					version: '1.4.1',
					nonce: 0n,
					owners: [],
					threshold: 2n,
				},
				safeTxHash,
				safeTx,
			},
		}],
	})

	await modules.updateUserAddressBookEntries(() => [{
		...safeAddressBookEntry,
		safeSignerAddress: 0x2222222222222222222222222222222222222222n,
	}])
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'signerIncluded', signerReply: signature, uniqueRequestIdentifier },
	}), false)
	assert.deepEqual(await modules.getSafeTransactionStacks(), [])

	await modules.updateUserAddressBookEntries(() => [safeAddressBookEntry])
	await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (pending) => ({
		...pending,
		approvalStatus: { status: 'WaitingForSigner' as const },
	}))
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'signerIncluded', signerReply: signature, uniqueRequestIdentifier },
	}), true)

	const safeStacks = await modules.getSafeTransactionStacks()
	assert.equal(safeStacks.length, 1)
	assert.equal(safeStacks[0]?.transactions[0]?.safeTxHash, safeTxHash)
	assert.equal(safeStacks[0]?.transactions[0]?.signatures[0]?.signer, safeSignerAddress)
	const interceptorStack = await modules.getInterceptorTransactionStack()
	const optimisticTransaction = interceptorStack.operations.find((operation) =>
		operation.type === 'Transaction' && operation.preSimulationTransaction.safeTransaction?.safeTxHash === safeTxHash
	)
	assert.notEqual(optimisticTransaction, undefined)
	if (optimisticTransaction?.type !== 'Transaction') throw new Error('Missing optimistic Safe transaction')
	assert.equal(optimisticTransaction.preSimulationTransaction.signedTransaction.type, '1559')
	if (optimisticTransaction.preSimulationTransaction.signedTransaction.type !== '1559') throw new Error('Safe simulation transaction is not EIP-1559')
	assert.equal(optimisticTransaction.preSimulationTransaction.signedTransaction.maxFeePerGas, 0n)
	assert.equal(optimisticTransaction.preSimulationTransaction.signedTransaction.maxPriorityFeePerGas, 0n)
	const simulationInput = await (await import('../../app/ts/background/simulationUpdating.js')).getCurrentSimulationInput()
	const safeSimulationBlock = simulationInput.find((block) => block.transactions.some((transaction) =>
		transaction.safeTransaction?.safeTxHash === safeTxHash
	))
	assert.equal(safeSimulationBlock?.simulateWithZeroBaseFee, true)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	const dappReply = postedMessages.find((message) =>
		isRecord(message) && message.method === 'eth_sendTransaction' && message.requestId === uniqueRequestIdentifier.requestId
	)
	if (!isRecord(dappReply)) throw new Error('Missing Safe transaction dapp reply')
	assert.equal(dappReply.result, modules.EthereumBytes32.serialize(safeTxHash))
})

test('invalid Safe owner signatures retain the request as a signer error without creating a Safe stack', async () => {
	resetFakeSafeContractState()
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	await modules.updateSafeTransactionStacks(() => [])
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			simulationMode: false,
			approvalStatus: { status: 'WaitingForSigner' },
			safeTransaction: {
				safeAddress: activeAddress,
				safeSignerAddress: recipientAddress,
				safeVersion: '1.4.1',
				threshold: 2n,
				safeTxHash: BigInt(getSafeTxHash(safeTx)),
				safeTx,
			},
		}],
	})

	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, new Map(), {
		method: 'popup_confirmDialog',
		data: { action: 'signerIncluded', signerReply: '0x1234', uniqueRequestIdentifier },
	}), false)

	const retainedRequests = await modules.getPendingTransactionsAndMessages()
	assert.equal(retainedRequests.length, 1)
	const retainedRequest = retainedRequests[0]
	assert.equal(retainedRequest?.approvalStatus.status, 'SignerError')
	if (retainedRequest?.approvalStatus.status !== 'SignerError') throw new Error('missing Safe signature error')
	assert.match(retainedRequest.approvalStatus.message, /owner signature was rejected/u)
	assert.deepEqual(await modules.getSafeTransactionStacks(), [])
})

test('extension Safe stack import merges owner signatures into proposal and optimistic metadata', async () => {
	resetFakeSafeContractState()
	const ownerAccount = privateKeyToAccount('0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')
	const ownerAddress = BigInt(ownerAccount.address)
	fakeSafeOwners = [ownerAddress]
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	const safeTxHash = BigInt(getSafeTxHash(safeTx))
	const signature = await ownerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(safeTx)))
	const localTransaction = {
		safeTx,
		safeTxHash,
		created,
		websiteOrigin: 'https://example.com',
		transactionIdentifier: 70n,
		signatures: [],
	}
	const localStack = {
		chainId: fakeRpcNetwork.chainId,
		safeAddress: activeAddress,
		safeVersion: '1.4.1',
		baseNonce: 0n,
		threshold: 2n,
		transactions: [localTransaction],
	}
	await modules.updateSafeTransactionStacks(() => [localStack])
	await modules.updateInterceptorTransactionStack(() => ({
		operations: [{
			type: 'Transaction',
			preSimulationTransaction: {
				...pendingTransaction.transactionToSimulate,
				signedTransaction,
				safeTransaction: localTransaction,
			},
		}],
	}))
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	const importedStack = {
		...localStack,
		transactions: [{
			...localTransaction,
			signatures: [{ signer: ownerAddress, signature }],
		}],
	}

	const reply = await modules.importSafeStack(simulator.ethereum, simulator.tokenPriceService, {
		data: {
			name: 'Interceptor Safe Stack',
			version: '1.0.0',
			stacks: [importedStack],
		},
	})

	assert.deepEqual(reply, { type: 'ImportSafeStackReply', ok: true })
	assert.equal((await modules.getSafeTransactionStacks())[0]?.transactions[0]?.signatures[0]?.signer, ownerAddress)
	const optimisticOperation = (await modules.getInterceptorTransactionStack()).operations[0]
	assert.equal(optimisticOperation?.type, 'Transaction')
	if (optimisticOperation?.type !== 'Transaction') throw new Error('Missing imported optimistic Safe transaction')
	assert.equal(optimisticOperation.preSimulationTransaction.safeTransaction?.signatures[0]?.signer, ownerAddress)
})

test('Safe stack import preserves a proposal appended while live validation is pending', async () => {
	resetFakeSafeContractState()
	const ownerAccount = privateKeyToAccount('0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')
	const ownerAddress = BigInt(ownerAccount.address)
	fakeSafeOwners = [ownerAddress]
	const firstSafeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	const firstSafeTxHash = BigInt(getSafeTxHash(firstSafeTx))
	const signature = await ownerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(firstSafeTx)))
	const firstTransaction = {
		safeTx: firstSafeTx,
		safeTxHash: firstSafeTxHash,
		created,
		websiteOrigin: 'https://example.com',
		transactionIdentifier: 73n,
		signatures: [],
	}
	const localStack = {
		chainId: fakeRpcNetwork.chainId,
		safeAddress: activeAddress,
		safeVersion: '1.4.1',
		baseNonce: 0n,
		threshold: 2n,
		transactions: [firstTransaction],
	}
	await modules.updateSafeTransactionStacks(() => [localStack])
	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))

	let signalValidationStarted: (() => void) | undefined
	const validationStarted = new Promise<void>((resolve) => {
		signalValidationStarted = resolve
	})
	let resumeValidation: (() => void) | undefined
	const validationMayResume = new Promise<void>((resolve) => {
		resumeValidation = resolve
	})
	beforeSafeVersionResponse = async () => {
		signalValidationStarted?.()
		await validationMayResume
	}
	const importPromise = modules.importSafeStack(simulator.ethereum, simulator.tokenPriceService, {
		data: {
			name: 'Interceptor Safe Stack',
			version: '1.0.0',
			stacks: [{
				...localStack,
				transactions: [{
					...firstTransaction,
					signatures: [{ signer: ownerAddress, signature }],
				}],
			}],
		},
	})

	try {
		await validationStarted
		const secondSafeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
			to: recipientAddress,
			value: 1n,
			input: new Uint8Array(),
		}, 1n)
		const secondTransaction = {
			...firstTransaction,
			safeTx: secondSafeTx,
			safeTxHash: BigInt(getSafeTxHash(secondSafeTx)),
			transactionIdentifier: 74n,
		}
		await modules.updateSafeTransactionStacks((previousStacks) => previousStacks.map((stack) => ({
			...stack,
			transactions: [...stack.transactions, secondTransaction],
		})))
		resumeValidation?.()
		const reply = await importPromise
		assert.deepEqual(reply, { type: 'ImportSafeStackReply', ok: true })

		const storedTransactions = (await modules.getSafeTransactionStacks())[0]?.transactions
		assert.equal(storedTransactions?.length, 2)
		assert.equal(storedTransactions?.[0]?.signatures[0]?.signer, ownerAddress)
		assert.equal(storedTransactions?.[1]?.safeTxHash, secondTransaction.safeTxHash)
	} finally {
		resumeValidation?.()
		beforeSafeVersionResponse = undefined
	}
})

test('extension Safe stack import reconciles executed transactions and rejects altered, non-owner, and duplicate-signature exports', async () => {
	resetFakeSafeContractState()
	const ownerAccount = privateKeyToAccount('0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')
	const ownerAddress = BigInt(ownerAccount.address)
	fakeSafeOwners = [ownerAddress]
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	const safeTxHash = BigInt(getSafeTxHash(safeTx))
	const signature = await ownerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(safeTx)))
	const localTransaction = {
		safeTx,
		safeTxHash,
		created,
		websiteOrigin: 'https://example.com',
		transactionIdentifier: 71n,
		signatures: [],
	}
	const localStack = {
		chainId: fakeRpcNetwork.chainId,
		safeAddress: activeAddress,
		safeVersion: '1.4.1',
		baseNonce: 0n,
		threshold: 2n,
		transactions: [localTransaction],
	}
	const importData = (transactions: readonly typeof localTransaction[]) => ({
		data: {
			name: 'Interceptor Safe Stack' as const,
			version: '1.0.0' as const,
			stacks: [{ ...localStack, transactions }],
		},
	})
	const resetLocalStack = async () => {
		await modules.updateSafeTransactionStacks(() => [localStack])
		await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
	}

	await resetLocalStack()
	fakeSafeNonce = 1n
	const staleReply = await modules.importSafeStack(simulator.ethereum, simulator.tokenPriceService, importData([localTransaction]))
	assert.deepEqual(staleReply, { type: 'ImportSafeStackReply', ok: true })
	assert.deepEqual(await modules.getSafeTransactionStacks(), [])

	resetFakeSafeContractState()
	fakeSafeOwners = [ownerAddress]
	await resetLocalStack()
	const extraSafeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 1n,
		input: new Uint8Array(),
	}, 1n)
	const alteredReply = await modules.importSafeStack(simulator.ethereum, simulator.tokenPriceService, importData([
		localTransaction,
		{ ...localTransaction, safeTx: extraSafeTx, safeTxHash: BigInt(getSafeTxHash(extraSafeTx)), transactionIdentifier: 72n },
	]))
	assert.equal(alteredReply.ok, false)
	if (alteredReply.ok) throw new Error('Expected changed transaction list failure')
	assert.match(alteredReply.message, /transaction list was changed/u)

	await resetLocalStack()
	fakeSafeOwnerIsValid = false
	const nonOwnerReply = await modules.importSafeStack(simulator.ethereum, simulator.tokenPriceService, importData([{
		...localTransaction,
		signatures: [{ signer: ownerAddress, signature }],
	}]))
	assert.equal(nonOwnerReply.ok, false)
	if (nonOwnerReply.ok) throw new Error('Expected non-owner signature failure')
	assert.match(nonOwnerReply.message, /is not an owner of Gnosis Safe/u)

	await resetLocalStack()
	fakeSafeOwnerIsValid = true
	fakeSafeOwnerCode = '0x6000'
	const contractOwnerReply = await modules.importSafeStack(simulator.ethereum, simulator.tokenPriceService, importData([{
		...localTransaction,
		signatures: [{ signer: ownerAddress, signature }],
	}]))
	assert.equal(contractOwnerReply.ok, false)
	if (contractOwnerReply.ok) throw new Error('Expected contract-owner signature failure')
	assert.match(contractOwnerReply.message, /supports EOA owners only/u)

	await resetLocalStack()
	fakeSafeOwnerCode = '0x'
	const duplicateSignature = { signer: ownerAddress, signature }
	const duplicateReply = await modules.importSafeStack(simulator.ethereum, simulator.tokenPriceService, importData([{
		...localTransaction,
		signatures: [duplicateSignature, duplicateSignature],
	}]))
	assert.equal(duplicateReply.ok, false)
	if (duplicateReply.ok) throw new Error('Expected duplicate signature failure')
	assert.match(duplicateReply.message, /duplicate owner signatures/u)

	const duplicateStackReply = await modules.importSafeStack(simulator.ethereum, simulator.tokenPriceService, {
		data: {
			name: 'Interceptor Safe Stack',
			version: '1.0.0',
			stacks: [localStack, localStack],
		},
	})
	assert.equal(duplicateStackReply.ok, false)
	if (duplicateStackReply.ok) throw new Error('Expected duplicate Safe stack failure')
	assert.match(duplicateStackReply.message, /duplicate entries for the same Gnosis Safe and chain/u)

	const delegateCallSafeTx = {
		...safeTx,
		message: { ...safeTx.message, operation: 1n },
	}
	const delegateCallReply = await modules.importSafeStack(simulator.ethereum, simulator.tokenPriceService, importData([{
		...localTransaction,
		safeTx: delegateCallSafeTx,
		safeTxHash: BigInt(getSafeTxHash(delegateCallSafeTx)),
	}]))
	assert.equal(delegateCallReply.ok, false)
	if (delegateCallReply.ok) throw new Error('Expected delegatecall Safe stack failure')
	assert.match(delegateCallReply.message, /CALL operations only/u)
})

test('extension Safe stack export rejects an empty selected-chain stack', async () => {
	await modules.updateSafeTransactionStacks(() => [])

	const emptyReply = await modules.requestSafeStackExport(simulator.ethereum, simulator.tokenPriceService)

	assert.equal(emptyReply.ok, false)
	if (emptyReply.ok) throw new Error('Expected empty Safe export failure')
	assert.match(emptyReply.message, /no Gnosis Safe proposals to export/u)

	await modules.updateSafeTransactionStacks(() => [{
		chainId: fakeRpcNetwork.chainId,
		safeAddress: activeAddress,
		safeVersion: '1.4.1',
		baseNonce: 0n,
		threshold: 2n,
		transactions: [],
	}])
	const emptyRecordReply = await modules.requestSafeStackExport(simulator.ethereum, simulator.tokenPriceService)
	assert.equal(emptyRecordReply.ok, false)
	if (emptyRecordReply.ok) throw new Error('Expected empty Safe record export failure')
	assert.match(emptyRecordReply.message, /no Gnosis Safe proposals to export/u)
})

test('extension Safe stack export revalidates current Safe state before returning JSON', async () => {
	resetFakeSafeContractState()
	const ownerAccount = privateKeyToAccount('0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')
	const ownerAddress = BigInt(ownerAccount.address)
	fakeSafeOwners = [ownerAddress]
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	const safeTxHash = BigInt(getSafeTxHash(safeTx))
	const signature = await ownerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(safeTx)))
	await modules.updateSafeTransactionStacks(() => [{
		chainId: fakeRpcNetwork.chainId,
		safeAddress: activeAddress,
		safeVersion: '1.4.1',
		baseNonce: 0n,
		threshold: 2n,
		transactions: [{
			safeTx,
			safeTxHash,
			created,
			websiteOrigin: 'https://example.com',
			transactionIdentifier: 73n,
			signatures: [{ signer: ownerAddress, signature }],
		}],
	}])

	const validReply = await modules.requestSafeStackExport(simulator.ethereum, simulator.tokenPriceService)
	assert.equal(validReply.ok, true)
	if (!validReply.ok) throw new Error('Expected valid Safe export')
	assert.equal(JSON.parse(validReply.safeStackJson).stacks.length, 1)

	const secondSafeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 1n,
		input: new Uint8Array(),
	}, 1n)
	const secondSafeTxHash = BigInt(getSafeTxHash(secondSafeTx))
	const secondSignature = await ownerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(secondSafeTx)))
	await modules.updateSafeTransactionStacks((stacks) => stacks.map((stack) => ({
		...stack,
		transactions: [...stack.transactions, {
			...stack.transactions[0],
			safeTx: secondSafeTx,
			safeTxHash: secondSafeTxHash,
			transactionIdentifier: 74n,
			signatures: [{ signer: ownerAddress, signature: secondSignature }],
		}],
	})))
	const [stackBeforeReconciliation] = await modules.getSafeTransactionStacks()
	if (stackBeforeReconciliation === undefined) throw new Error('Missing Safe stack before export reconciliation')
	await modules.updateInterceptorTransactionStack(() => ({
		operations: stackBeforeReconciliation.transactions.map((safeTransaction) => ({
			type: 'Transaction' as const,
			preSimulationTransaction: {
				...pendingTransaction.transactionToSimulate,
				signedTransaction,
				transactionIdentifier: safeTransaction.transactionIdentifier,
				safeTransaction,
			},
		})),
	}))
	fakeSafeNonce = 1n
	const reconciledReply = await modules.requestSafeStackExport(simulator.ethereum, simulator.tokenPriceService)
	assert.equal(reconciledReply.ok, true)
	if (!reconciledReply.ok) throw new Error('Expected reconciled Safe export')
	const reconciledExport = JSON.parse(reconciledReply.safeStackJson)
	assert.equal(reconciledExport.stacks[0]?.baseNonce, '0x1')
	assert.equal(reconciledExport.stacks[0]?.transactions.length, 1)
	assert.equal(reconciledExport.stacks[0]?.transactions[0]?.safeTx.message.nonce, '1')
	const [storedReconciledStack] = await modules.getSafeTransactionStacks()
	assert.equal(storedReconciledStack?.baseNonce, 1n)
	assert.deepEqual(storedReconciledStack?.transactions.map(({ transactionIdentifier }) => transactionIdentifier), [74n])
	const reconciledOperations = (await modules.getInterceptorTransactionStack()).operations
	assert.deepEqual(reconciledOperations.map((operation) => operation.type === 'Transaction' ? operation.preSimulationTransaction.transactionIdentifier : undefined), [74n])

	fakeSafeNonce = 0n
	await modules.updateSafeTransactionStacks(() => [{
		chainId: fakeRpcNetwork.chainId,
		safeAddress: activeAddress,
		safeVersion: '1.4.1',
		baseNonce: 0n,
		threshold: 2n,
		transactions: [{
			safeTx,
			safeTxHash,
			created,
			websiteOrigin: 'https://example.com',
			transactionIdentifier: 73n,
			signatures: [{ signer: ownerAddress, signature }],
		}],
	}])
	fakeSafeOwnerCode = '0x6000'
	const contractOwnerReply = await modules.requestSafeStackExport(simulator.ethereum, simulator.tokenPriceService)
	assert.equal(contractOwnerReply.ok, false)
	if (contractOwnerReply.ok) throw new Error('Expected contract-owner Safe export failure')
	assert.match(contractOwnerReply.message, /supports EOA owners only/u)

	fakeSafeOwnerCode = '0x'
	const delegateCallSafeTx = {
		...safeTx,
		message: { ...safeTx.message, operation: 1n },
	}
	await modules.updateSafeTransactionStacks((stacks) => stacks.map((stack) => ({
		...stack,
		transactions: stack.transactions.map((transaction) => ({
			...transaction,
			safeTx: delegateCallSafeTx,
			safeTxHash: BigInt(getSafeTxHash(delegateCallSafeTx)),
			signatures: [],
		})),
	})))
	const delegateCallReply = await modules.requestSafeStackExport(simulator.ethereum, simulator.tokenPriceService)
	assert.equal(delegateCallReply.ok, false)
	if (delegateCallReply.ok) throw new Error('Expected delegatecall Safe export failure')
	assert.match(delegateCallReply.message, /CALL operations only/u)
})

test('failed signer delivery keeps the request and replaces the waiting spinner with a wallet-neutral error', async () => {
	await browser.storage.local.set({ simulationMode: false })
	const disconnectedPort = createDisconnectedPort()
	const socketKey = modules.websiteSocketToString(uniqueRequestIdentifier.requestSocket)
	const connectionCases = [
		{ connections: new Map(), expectedPostAttempts: 0 },
		{ connections: new Map([[uniqueRequestIdentifier.requestSocket.tabId, { connections: {
			[socketKey]: {
				port: disconnectedPort.port,
				socket: uniqueRequestIdentifier.requestSocket,
				websiteOrigin: 'https://example.com',
				approved: true,
				wantsToConnect: true,
			},
		} }]]), expectedPostAttempts: 1 },
	]

	for (const connectionCase of connectionCases) {
		browserMock.sentMessages.length = 0
		await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [{
			...pendingTransaction,
			simulationMode: false,
			approvalStatus: { status: 'WaitingForUser' },
		}] })

		const delivered = await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, connectionCase.connections, {
			method: 'popup_confirmDialog',
			data: { action: 'accept', uniqueRequestIdentifier },
		})
		const retainedRequests = await modules.getPendingTransactionsAndMessages()
		const retainedRequest = retainedRequests[0]

		assert.equal(delivered, false)
		assert.equal(retainedRequests.length, 1)
		assert.equal(retainedRequest?.approvalStatus.status, 'SignerError')
		if (retainedRequest?.approvalStatus.status !== 'SignerError') throw new Error('missing signer delivery error')
		assert.match(retainedRequest.approvalStatus.message, /request reached your wallet/)
		const pendingUpdates = browserMock.sentMessages.filter((message) => message.method === 'popup_update_confirm_transaction_dialog_pending_transactions')
		assert.equal(pendingUpdates.length, 2)
		const finalUpdateData = pendingUpdates.at(-1)?.data
		if (!isRecord(finalUpdateData) || !Array.isArray(finalUpdateData.pendingTransactionAndSignableMessages)) throw new Error('missing final pending transaction popup update')
		const finalUpdatedRequest = finalUpdateData.pendingTransactionAndSignableMessages[0]
		if (!isRecord(finalUpdatedRequest) || !isRecord(finalUpdatedRequest.approvalStatus)) throw new Error('missing approval status in final popup update')
		assert.equal(finalUpdatedRequest.approvalStatus.status, 'SignerError')
		assert.equal(disconnectedPort.getPostAttempts(), connectionCase.expectedPostAttempts)
	}
})

test('reject and result replies remain durable after their pending request is removed', async () => {
	delete browserMock.storageState.pendingTerminalReplies
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	const socketKey = modules.websiteSocketToString(socket)
	const disconnectedConnections = new Map()
	const terminalReplies = [
		{
			name: 'reject',
			confirmation: { method: 'popup_confirmDialog' as const, data: { action: 'reject' as const, errorString: undefined, uniqueRequestIdentifier } },
			transaction: pendingTransaction,
		},
		{
			name: 'result',
			confirmation: { method: 'popup_confirmDialog' as const, data: { action: 'signerIncluded' as const, signerReply: modules.EthereumBytes32.serialize(signedTransaction.hash), uniqueRequestIdentifier } },
			transaction: { ...pendingTransaction, simulationMode: false as const },
		},
	]

	for (const terminalReply of terminalReplies) {
		await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [terminalReply.transaction] })
		assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, disconnectedConnections, terminalReply.confirmation), false, terminalReply.name)
		assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [], terminalReply.name)
		assert.equal((await modules.getPendingTerminalReplies()).length, 1, terminalReply.name)

		const websiteTabConnections = new Map([[socket.tabId, { connections: {
			[socketKey]: {
				port: createRecordingPort(postedMessages),
				socket,
				websiteOrigin: 'https://example.com',
				approved: true,
				wantsToConnect: true,
			},
		} }]])
		assert.equal(await modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, socket), 1, terminalReply.name)
		assert.deepEqual(await modules.getPendingTerminalReplies(), [], terminalReply.name)
	}
	assert.equal(postedMessages.length, 2)
})

test('terminal replies are persisted before removing the pending rejection or result request', async () => {
	const terminalReplies = [
		{
			name: 'reject',
			confirmation: { method: 'popup_confirmDialog' as const, data: { action: 'reject' as const, errorString: undefined, uniqueRequestIdentifier } },
			transaction: pendingTransaction,
		},
		{
			name: 'result',
			confirmation: { method: 'popup_confirmDialog' as const, data: { action: 'signerIncluded' as const, signerReply: modules.EthereumBytes32.serialize(signedTransaction.hash), uniqueRequestIdentifier } },
			transaction: { ...pendingTransaction, simulationMode: false as const },
		},
	]

	try {
		for (const terminalReply of terminalReplies) {
			delete browserMock.storageState.pendingTerminalReplies
			await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [terminalReply.transaction] })
			let signalPersistenceStarted: (() => void) | undefined
			const persistenceStarted = new Promise<void>((resolve) => { signalPersistenceStarted = resolve })
			let releasePersistence: (() => void) | undefined
			const allowPersistence = new Promise<void>((resolve) => { releasePersistence = resolve })
			browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
				if ('pendingTerminalReplies' in items) {
					signalPersistenceStarted?.()
					await allowPersistence
				}
				writeStoredItems()
			})

			const resolution = modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, new Map(), terminalReply.confirmation)
			await persistenceStarted
			assert.equal((await modules.getPendingTransactionsAndMessages()).length, 1, terminalReply.name)
			releasePersistence?.()
			assert.equal(await resolution, false, terminalReply.name)
			assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [], terminalReply.name)
			assert.equal((await modules.getPendingTerminalReplies()).length, 1, terminalReply.name)
		}
	} finally {
		browserMock.setStorageSetHandler(undefined)
	}
})

test('MV2 popup close rejects its captured requests without deleting a concurrently appended request', async () => {
	const postedMessages: unknown[] = []
	const replacementPort = createRecordingPort(postedMessages)
	const disconnectedPort = createDisconnectedPort()
	const socketKey = modules.websiteSocketToString(uniqueRequestIdentifier.requestSocket)
	const websiteTabConnections = new Map([[uniqueRequestIdentifier.requestSocket.tabId, { connections: {
		[socketKey]: {
			port: disconnectedPort.port,
			socket: uniqueRequestIdentifier.requestSocket,
			websiteOrigin: 'https://example.com',
			approved: true,
			wantsToConnect: true,
		},
	} }]])
	const secondCapturedRequest = {
		...pendingTransaction,
		simulationMode: false,
		approvalStatus: { status: 'WaitingForUser' },
		uniqueRequestIdentifier: { ...uniqueRequestIdentifier, requestId: 2 },
		transactionIdentifier: 2n,
	} as const
	const concurrentlyAppendedRequest = {
		...secondCapturedRequest,
		popupOrTabId: { type: 'popup' as const, id: 2 },
		uniqueRequestIdentifier: { ...uniqueRequestIdentifier, requestId: 3 },
		transactionIdentifier: 3n,
	}
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [{
		...pendingTransaction,
		simulationMode: false,
		approvalStatus: { status: 'WaitingForUser' },
	}, secondCapturedRequest] })
	let reconnectRequests = 0
	browserMock.setManifestVersion(2)
	browserMock.setTabMessageHandler(async () => {
		reconnectRequests += 1
		await modules.appendPendingTransactionOrMessage(concurrentlyAppendedRequest)
		websiteTabConnections.set(uniqueRequestIdentifier.requestSocket.tabId, { connections: {
			[socketKey]: {
				port: replacementPort,
				socket: uniqueRequestIdentifier.requestSocket,
				websiteOrigin: 'https://example.com',
				approved: true,
				wantsToConnect: true,
			},
		} })
		await modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, uniqueRequestIdentifier.requestSocket)
		return { reconnected: true }
	})

	try {
		await modules.onCloseWindowOrTab({ type: 'popup', id: 1 }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections)
	} finally {
		browserMock.setManifestVersion(3)
		browserMock.setTabMessageHandler(undefined)
	}

	const remainingRequests = await modules.getPendingTransactionsAndMessages()
	assert.deepEqual(remainingRequests.map((request) => request.uniqueRequestIdentifier.requestId), [3])
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
	assert.equal(disconnectedPort.getPostAttempts(), 1)
	assert.equal(reconnectRequests, 1)
	assert.equal(postedMessages.length, 2)
	for (const [index, rejection] of postedMessages.entries()) {
		if (!isRecord(rejection) || !isRecord(rejection.error)) throw new Error('missing dapp rejection after popup close')
		assert.equal(rejection.requestId, index + 1)
		assert.equal(rejection.method, 'eth_sendTransaction')
		assert.equal(rejection.error.code, 4001)
		assert.equal(rejection.error.message, 'User denied transaction signature')
	}
})

test('popup close keeps the pending request when durable rejection enqueue fails', async () => {
	delete browserMock.storageState.pendingTerminalReplies
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	const socketKey = modules.websiteSocketToString(socket)
	const websiteTabConnections = new Map([[socket.tabId, { connections: {
		[socketKey]: {
			port: createRecordingPort(postedMessages),
			socket,
			websiteOrigin: 'https://example.com',
			approved: true,
			wantsToConnect: true,
		},
	} }]])
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [{
		...pendingTransaction,
		simulationMode: false,
		approvalStatus: { status: 'WaitingForUser' },
	}] })
	let terminalReplyReadFailuresRemaining = 1
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (terminalReplyReadFailuresRemaining > 0 && Array.isArray(keys) && keys.includes('pendingTerminalReplies')) {
			terminalReplyReadFailuresRemaining -= 1
			throw new Error('storage temporarily unavailable')
		}
		return readStoredItems()
	})

	await withSilencedConsole(async () => await modules.onCloseWindowOrTab({ type: 'popup', id: 1 }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections))
	assert.equal((await modules.getPendingTransactionsAndMessages()).length, 1)
	assert.equal(postedMessages.length, 0)
	assert.equal(browserMock.storageState.pendingTerminalReplies, undefined)

	browserMock.setStorageGetHandler(undefined)
	await waitForPendingTransactionsToClear()
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
	assert.equal(postedMessages.length, 1)
	const rejection = postedMessages[0]
	if (!isRecord(rejection) || !isRecord(rejection.error)) throw new Error('missing popup-close rejection after storage recovery')
	assert.equal(rejection.error.code, 4001)
})

test('popup close retries outbox cleanup without reposting after direct delivery', async () => {
	delete browserMock.storageState.pendingTerminalReplies
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	const socketKey = modules.websiteSocketToString(socket)
	let failNextTerminalReplyRead = false
	const recordingPort = createRecordingPort(postedMessages)
	const cleanupFailingPort: browser.runtime.Port = {
		...recordingPort,
		postMessage(message: unknown) {
			recordingPort.postMessage(message)
			failNextTerminalReplyRead = true
		},
	}
	const websiteTabConnections = new Map([[socket.tabId, { connections: {
		[socketKey]: {
			port: cleanupFailingPort,
			socket,
			websiteOrigin: 'https://example.com',
			approved: true,
			wantsToConnect: true,
		},
	} }]])
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [{
		...pendingTransaction,
		simulationMode: false,
		approvalStatus: { status: 'WaitingForUser' },
	}] })
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (failNextTerminalReplyRead && Array.isArray(keys) && keys.includes('pendingTerminalReplies')) {
			failNextTerminalReplyRead = false
			throw new Error('storage cleanup temporarily unavailable')
		}
		return readStoredItems()
	})

	await withSilencedConsole(async () => await modules.onCloseWindowOrTab({ type: 'popup', id: 1 }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections))
	assert.equal(postedMessages.length, 1)
	assert.equal((await modules.getPendingTransactionsAndMessages()).length, 1)
	assert.equal((await modules.getPendingTerminalReplies()).length, 1)

	await waitForPendingTransactionsToClear()
	assert.equal(postedMessages.length, 1)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
	browserMock.setStorageGetHandler(undefined)
})

test('MV2 reconnect cleanup failure retries without reposting the rejection', async () => {
	delete browserMock.storageState.pendingTerminalReplies
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	const socketKey = modules.websiteSocketToString(socket)
	const disconnectedPort = createDisconnectedPort()
	let failNextTerminalReplyRead = false
	const replacementRecordingPort = createRecordingPort(postedMessages)
	const replacementPort: browser.runtime.Port = {
		...replacementRecordingPort,
		postMessage(message: unknown) {
			replacementRecordingPort.postMessage(message)
			failNextTerminalReplyRead = true
		},
	}
	const websiteTabConnections = new Map([[socket.tabId, { connections: {
		[socketKey]: {
			port: disconnectedPort.port,
			socket,
			websiteOrigin: 'https://example.com',
			approved: true,
			wantsToConnect: true,
		},
	} }]])
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [{
		...pendingTransaction,
		simulationMode: false,
		approvalStatus: { status: 'WaitingForUser' },
	}] })
	browserMock.setManifestVersion(2)
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (failNextTerminalReplyRead && Array.isArray(keys) && keys.includes('pendingTerminalReplies')) {
			failNextTerminalReplyRead = false
			throw new Error('storage cleanup temporarily unavailable')
		}
		return readStoredItems()
	})
	browserMock.setTabMessageHandler(async () => {
		websiteTabConnections.set(socket.tabId, { connections: {
			[socketKey]: {
				port: replacementPort,
				socket,
				websiteOrigin: 'https://example.com',
				approved: true,
				wantsToConnect: true,
			},
		} })
		await modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, socket)
		return { reconnected: true }
	})

	try {
		await withSilencedConsole(async () => await modules.onCloseWindowOrTab({ type: 'popup', id: 1 }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections))
		assert.equal(postedMessages.length, 1)
		assert.equal((await modules.getPendingTransactionsAndMessages()).length, 1)
		assert.equal((await modules.getPendingTerminalReplies()).length, 1)

		await waitForPendingTransactionsToClear()
		assert.equal(postedMessages.length, 1)
		assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
		assert.deepEqual(await modules.getPendingTerminalReplies(), [])
	} finally {
		browserMock.setManifestVersion(3)
		browserMock.setStorageGetHandler(undefined)
		browserMock.setTabMessageHandler(undefined)
	}
})

test('startup recovery rejects orphaned requests and preserves requests with live confirmation windows', async () => {
	delete browserMock.storageState.pendingTerminalReplies
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	const socketKey = modules.websiteSocketToString(socket)
	const websiteTabConnections = new Map([[socket.tabId, { connections: {
		[socketKey]: {
			port: createRecordingPort(postedMessages),
			socket,
			websiteOrigin: 'https://example.com',
			approved: true,
			wantsToConnect: true,
		},
	} }]])
	const livePopupId = 2
	const livePendingTransaction = {
		...pendingTransaction,
		popupOrTabId: { type: 'popup' as const, id: livePopupId },
		uniqueRequestIdentifier: { ...uniqueRequestIdentifier, requestId: uniqueRequestIdentifier.requestId + 1 },
	}
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [pendingTransaction, livePendingTransaction] })
	browserMock.setLiveWindowIds([livePopupId])

	await modules.resolvePendingRequestsForMissingConfirmationWindows(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections)
	const remainingTransactions = await modules.getPendingTransactionsAndMessages()
	assert.deepEqual(remainingTransactions.map((transaction) => transaction.uniqueRequestIdentifier.requestId), [livePendingTransaction.uniqueRequestIdentifier.requestId])
	assert.equal(postedMessages.length, 1)
	const rejection = postedMessages[0]
	if (!isRecord(rejection) || !isRecord(rejection.error)) throw new Error('missing startup orphan rejection')
	assert.equal(rejection.error.code, 4001)

	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	browserMock.setLiveWindowIds([])
})

test('startup recovery removes the unreachable rejection created for an orphaned request from a missing tab', async () => {
	delete browserMock.storageState.pendingTerminalReplies
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [pendingTransaction] })
	browserMock.setLiveTabIds([])
	browserMock.setLiveWindowIds([])

	await modules.resolvePendingRequestsForMissingConfirmationWindows(simulator.ethereum, simulator.tokenPriceService, new Map())
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.equal((await modules.getPendingTerminalReplies()).length, 1)

	assert.equal(await modules.prunePendingTerminalRepliesForMissingTabs(), 1)
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
})

test('popup-close rejection remains queued after reconnect timeout and flushes on the exact socket', async () => {
	const postedMessages: unknown[] = []
	const replacementPort = createRecordingPort(postedMessages)
	const disconnectedPort = createDisconnectedPort()
	const socket = uniqueRequestIdentifier.requestSocket
	const socketKey = modules.websiteSocketToString(socket)
	const websiteTabConnections = new Map([[socket.tabId, { connections: {
		[socketKey]: {
			port: disconnectedPort.port,
			socket,
			websiteOrigin: 'https://example.com',
			approved: true,
			wantsToConnect: true,
		},
	} }]])
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [{
		...pendingTransaction,
		simulationMode: false,
		approvalStatus: { status: 'WaitingForUser' },
	}] })
	browserMock.setManifestVersion(2)
	browserMock.setTabMessageHandler(async () => ({ reconnected: true }))

	try {
		await modules.onCloseWindowOrTab({ type: 'popup', id: 1 }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections)
		await new Promise((resolve) => setTimeout(resolve, 1_050))
		assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
		assert.equal((await modules.getPendingTerminalReplies()).length, 1)
		assert.deepEqual(postedMessages, [])

		websiteTabConnections.set(socket.tabId, { connections: {
			[socketKey]: {
				port: replacementPort,
				socket,
				websiteOrigin: 'https://example.com',
				approved: true,
				wantsToConnect: true,
			},
		} })
		assert.equal(await modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, socket), 1)
		assert.deepEqual(await modules.getPendingTerminalReplies(), [])
		assert.equal(postedMessages.length, 1)
		const rejection = postedMessages[0]
		if (!isRecord(rejection) || !isRecord(rejection.error)) throw new Error('missing queued popup-close rejection')
		assert.equal(rejection.requestId, uniqueRequestIdentifier.requestId)
		assert.equal(rejection.error.code, 4001)
	} finally {
		browserMock.setManifestVersion(3)
		browserMock.setTabMessageHandler(undefined)
	}
})

test('same-request terminal reply producers coalesce into one delivery', async () => {
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	const socketKey = modules.websiteSocketToString(socket)
	const websiteTabConnections = new Map([[socket.tabId, { connections: {
		[socketKey]: {
			port: createRecordingPort(postedMessages),
			socket,
			websiteOrigin: 'https://example.com',
			approved: true,
			wantsToConnect: true,
		},
	} }]])
	const terminalReply = {
		...pendingTransaction.originalRequestParameters,
		type: 'result' as const,
		error: { code: 4001, message: 'User denied transaction signature' },
		uniqueRequestIdentifier,
	}

	assert.deepEqual(await Promise.all([
		modules.queueTerminalReplyAndAttemptDelivery(websiteTabConnections, terminalReply),
		modules.queueTerminalReplyAndAttemptDelivery(websiteTabConnections, terminalReply),
	]), [true, true])
	assert.equal(postedMessages.length, 1)
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
})

test('socket flush overlapping terminal reply persistence delivers exactly once', async () => {
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	const socketKey = modules.websiteSocketToString(socket)
	const websiteTabConnections = new Map<number, { connections: Record<string, {
		port: browser.runtime.Port,
		socket: typeof socket,
		websiteOrigin: string,
		approved: boolean,
		wantsToConnect: boolean,
	}> }>()
	const terminalReply = {
		...pendingTransaction.originalRequestParameters,
		type: 'result' as const,
		error: { code: 4001, message: 'User denied transaction signature' },
		uniqueRequestIdentifier,
	}

	const production = modules.queueTerminalReplyAndAttemptDelivery(websiteTabConnections, terminalReply)
	websiteTabConnections.set(socket.tabId, { connections: {
		[socketKey]: {
			port: createRecordingPort(postedMessages),
			socket,
			websiteOrigin: 'https://example.com',
			approved: true,
			wantsToConnect: true,
		},
	} })
	const flush = modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, socket)
	await Promise.all([production, flush])

	assert.equal(postedMessages.length, 1)
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
})

test('socket flush during terminal reply queueing keeps the completion marker for the original delivery attempt', async () => {
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	const socketKey = modules.websiteSocketToString(socket)
	const terminalReply = {
		...pendingTransaction.originalRequestParameters,
		type: 'result' as const,
		error: { code: 4001, message: 'User denied transaction signature' },
		uniqueRequestIdentifier,
	}
	const websiteTabConnections = new Map([[socket.tabId, { connections: {
		[socketKey]: {
			port: createRecordingPort(postedMessages),
			socket,
			websiteOrigin: 'https://example.com',
			approved: true,
			wantsToConnect: true,
		},
	} }]])

	await modules.queueTerminalReply(terminalReply)
	assert.equal(await modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, socket), 1)
	assert.equal(await modules.attemptQueuedTerminalReplyDelivery(websiteTabConnections, terminalReply), true)
	assert.equal(postedMessages.length, 1)
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
})

test('corrupt terminal reply storage recovers and delivers the next rejection once', async () => {
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	const socketKey = modules.websiteSocketToString(socket)
	const websiteTabConnections = new Map([[socket.tabId, { connections: {
		[socketKey]: {
			port: createRecordingPort(postedMessages),
			socket,
			websiteOrigin: 'https://example.com',
			approved: true,
			wantsToConnect: true,
		},
	} }]])
	const terminalReply = {
		...pendingTransaction.originalRequestParameters,
		type: 'result' as const,
		error: { code: 4001, message: 'User denied transaction signature' },
		uniqueRequestIdentifier,
	}
	browserMock.storageState.pendingTerminalReplies = { malformed: true }
	browserMock.storageState.popupRefreshGeneration = 17

	assert.equal(await withSilencedConsole(async () => await modules.queueTerminalReplyAndAttemptDelivery(websiteTabConnections, terminalReply)), true)

	assert.equal(postedMessages.length, 1)
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
	assert.equal(browserMock.storageState.popupRefreshGeneration, 17)
	const diagnostics = browserMock.storageState.interceptorErrorDiagnostics
	assert.ok(Array.isArray(diagnostics))
	assert.equal(diagnostics.at(-1)?.code, 'pending_terminal_replies_corrupt')
})

test('connected socket retries a transient terminal reply storage read failure without another reconnect', async () => {
	delete browserMock.storageState.pendingTerminalReplies
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	const socketKey = modules.websiteSocketToString(socket)
	const terminalReply = {
		...pendingTransaction.originalRequestParameters,
		type: 'result' as const,
		error: { code: 4001, message: 'User denied transaction signature' },
		uniqueRequestIdentifier,
	}
	await modules.queueTerminalReplyAndAttemptDelivery(new Map(), terminalReply)
	const storedReplyBeforeFailure = structuredClone(browserMock.storageState.pendingTerminalReplies)
	const websiteTabConnections = new Map([[socket.tabId, { connections: {
		[socketKey]: {
			port: createRecordingPort(postedMessages),
			socket,
			websiteOrigin: 'https://example.com',
			approved: true,
			wantsToConnect: true,
		},
	} }]])
	let storageFailuresRemaining = 1
	browserMock.setStorageGetHandler(async (_keys, readStoredItems) => {
		if (storageFailuresRemaining > 0) {
			storageFailuresRemaining -= 1
			throw new Error('storage temporarily unavailable')
		}
		return readStoredItems()
	})
	const connectedPort = websiteTabConnections.get(socket.tabId)?.connections[socketKey]?.port
	if (connectedPort === undefined) throw new Error('missing connected terminal reply test port')

	assert.equal(await withSilencedConsole(async () => await modules.flushPendingTerminalRepliesForConnectedPortWithRetry(websiteTabConnections, socket, connectedPort)), 0)
	assert.deepEqual(browserMock.storageState.pendingTerminalReplies, storedReplyBeforeFailure)
	assert.equal(postedMessages.length, 0)

	const deadline = Date.now() + 2_000
	while (postedMessages.length === 0) {
		if (Date.now() > deadline) throw new Error('Timed out waiting for connected socket terminal reply retry')
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
	browserMock.setStorageGetHandler(undefined)
	assert.equal(postedMessages.length, 1)
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
})

test('concurrent terminal reply flushes serialize storage reads and deliver once', async () => {
	delete browserMock.storageState.pendingTerminalReplies
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	const socketKey = modules.websiteSocketToString(socket)
	const terminalReply = {
		...pendingTransaction.originalRequestParameters,
		type: 'result' as const,
		error: { code: 4001, message: 'User denied transaction signature' },
		uniqueRequestIdentifier,
	}
	await modules.queueTerminalReplyAndAttemptDelivery(new Map(), terminalReply)
	const websiteTabConnections = new Map([[socket.tabId, { connections: {
		[socketKey]: {
			port: createRecordingPort(postedMessages),
			socket,
			websiteOrigin: 'https://example.com',
			approved: true,
			wantsToConnect: true,
		},
	} }]])
	let storageReadCount = 0
	let signalFirstReadStarted: (() => void) | undefined
	const firstReadStarted = new Promise<void>((resolve) => { signalFirstReadStarted = resolve })
	let releaseFirstRead: (() => void) | undefined
	const firstReadCanFinish = new Promise<void>((resolve) => { releaseFirstRead = resolve })
	browserMock.setStorageGetHandler(async (_keys, readStoredItems) => {
		storageReadCount += 1
		if (storageReadCount === 1) {
			signalFirstReadStarted?.()
			await firstReadCanFinish
		}
		return readStoredItems()
	})

	const firstFlush = modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, socket)
	await firstReadStarted
	const secondFlush = modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, socket)
	await Promise.resolve()
	assert.equal(storageReadCount, 1)
	releaseFirstRead?.()
	assert.deepEqual(await Promise.all([firstFlush, secondFlush]), [1, 0])

	browserMock.setStorageGetHandler(undefined)
	assert.equal(postedMessages.length, 1)
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
})

test('startup pruning removes terminal replies for missing tabs and preserves live tabs', async () => {
	delete browserMock.storageState.pendingTerminalReplies
	const missingTabReply = {
		...pendingTransaction.originalRequestParameters,
		type: 'result' as const,
		error: { code: 4001, message: 'User denied transaction signature' },
		uniqueRequestIdentifier,
	}
	const liveTabId = uniqueRequestIdentifier.requestSocket.tabId + 1
	const liveTabReply = {
		...missingTabReply,
		uniqueRequestIdentifier: {
			requestId: uniqueRequestIdentifier.requestId + 1,
			requestSocket: { ...uniqueRequestIdentifier.requestSocket, tabId: liveTabId },
		},
	}
	const noConnections = new Map()
	await modules.queueTerminalReplyAndAttemptDelivery(noConnections, missingTabReply)
	await modules.queueTerminalReplyAndAttemptDelivery(noConnections, liveTabReply)
	browserMock.storageState.popupRefreshGeneration = 23
	browserMock.setLiveTabIds([liveTabId])

	assert.equal(await modules.prunePendingTerminalRepliesForMissingTabs(), 1)
	const remainingReplies = await modules.getPendingTerminalReplies()
	assert.equal(remainingReplies.length, 1)
	assert.equal(remainingReplies[0]?.uniqueRequestIdentifier.requestSocket.tabId, liveTabId)
	assert.equal(browserMock.storageState.popupRefreshGeneration, 23)
	delete browserMock.storageState.pendingTerminalReplies
})

await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
