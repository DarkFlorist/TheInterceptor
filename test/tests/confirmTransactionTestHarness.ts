import type { flushPendingTerminalRepliesForSocket as flushPendingTerminalRepliesForSocketType } from '../../app/ts/background/terminalReplyDelivery.js'
import { encodeFunctionCall, encodeFunctionReturn } from '../../app/ts/utils/abiRuntime.js'
import { withSilencedConsole } from './consoleSilence.js'
import { createSafeTx, SAFE_ABI, safeTxToTypedDataJson } from '../../app/ts/safe/safeCore.js'
import { SAFE_EXECUTION_ABI } from '../../app/ts/safe/safeExecution.js'
import { getSafeTxHash } from '../../app/ts/utils/eip712.js'
import { addressString, bytes32String } from '../../app/ts/utils/bigint.js'
import { EIP712Message } from '../../app/ts/types/eip721.js'
import { privateKeyToAccount } from '../../app/ts/utils/ethereumPrimitives.js'
import type { SafeEntry } from '../../app/ts/types/addressBookTypes.js'
import type { SafeOwnerSignature, SafeStackTransaction, SafeTransactionStack } from '../../app/ts/types/safeTypes.js'

export type RuntimeMessage = {
	method?: string
	type?: string
	data?: unknown
}

export type StorageKeys = string | string[] | Record<string, unknown> | null | undefined

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}

export const hexToBytes = (hex: string) => Uint8Array.from(Buffer.from(hex.slice(2), 'hex'))

export function createSafeAddressBookEntry(overrides: Partial<SafeEntry> = {}): SafeEntry {
	return {
		type: 'safe',
		name: 'Treasury Safe',
		address: activeAddress,
		chainId: fakeRpcNetwork.chainId,
		entrySource: 'User',
		useAsActiveAddress: true,
		...overrides,
	}
}

export function createBrowserMock() {
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

export async function loadModules() {
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
		safeSimulation,
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
		import('../../app/ts/safe/safeSimulation.js'),
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
		setSafeSimulationSigner: popupMessageHandlers.setSafeSimulationSigner,
		fetchSimulationStackRequestConfirmation: popupMessageHandlers.fetchSimulationStackRequestConfirmation,
		resolvePendingTransactionOrMessage: confirmTransaction.resolvePendingTransactionOrMessage,
		formEthSendTransaction: confirmTransaction.formEthSendTransaction,
		getSafeExecutionSignerRoute: safeExecutionRouting.getSafeExecutionSignerRoute,
		prepareSafeExecutionSignerRoute: safeExecutionRouting.prepareSafeExecutionSignerRoute,
		openConfirmTransactionDialogForMessage: confirmTransaction.openConfirmTransactionDialogForMessage,
		openConfirmTransactionDialogForTransaction: confirmTransaction.openConfirmTransactionDialogForTransaction,
		onCloseWindowOrTab: confirmTransaction.onCloseWindowOrTab,
		refreshPendingSafeSignerSelectionErrors: confirmTransaction.refreshPendingSafeSignerSelectionErrors,
		resolvePendingRequestsForMissingConfirmationWindows: confirmTransaction.resolvePendingRequestsForMissingConfirmationWindows,
		resolveSafeConfirmation: safeConfirmationResolver.resolveSafeConfirmation,
		createSafeExecutionPreSimulationTransaction: safeSimulation.createSafeExecutionPreSimulationTransaction,
		getPendingTransactionsAndMessages: storageVariables.getPendingTransactionsAndMessages,
		getSafeTransactionStacks: storageVariables.getSafeTransactionStacks,
		getInterceptorTransactionStack: storageVariables.getInterceptorTransactionStack,
		setFetchSimulationStackRequestPromise: storageVariables.setFetchSimulationStackRequestPromise,
		getUserAddressBookEntries: storageVariables.getUserAddressBookEntries,
		appendPendingTransactionOrMessage: storageVariables.appendPendingTransactionOrMessage,
		getPendingTerminalReplies: pendingTerminalReplies.getPendingTerminalReplies,
		prunePendingTerminalRepliesForMissingTabs: pendingTerminalReplies.prunePendingTerminalRepliesForMissingTabs,
		updateInterceptorTransactionStack: storageVariables.updateInterceptorTransactionStack,
		updatePendingTransactionOrMessage: storageVariables.updatePendingTransactionOrMessage,
		updateSafeTransactionStacks: async (update: (previous: Awaited<ReturnType<typeof storageVariables.getSafeTransactionStacks>>) => Awaited<ReturnType<typeof storageVariables.getSafeTransactionStacks>>) => {
			const updated = await storageVariables.updateTransactionState((previous) => ({
				...previous,
				safeTransactionStacks: update(previous.safeTransactionStacks),
			}))
			return updated.safeTransactionStacks
		},
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

export function makeFakeBlock() {
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

export function makeFakeEthSimulateResult(multicallBalance: bigint, multicallAbi: readonly string[], callCount = 1) {
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

export const browserMock = createBrowserMock()
export const modules = await loadModules()

export const fakeRpcNetwork = {
	name: 'Test Chain',
	chainId: 1337n,
	httpsRpc: 'https://example.invalid',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	currencyLogoUri: undefined,
	primary: true,
	minimized: true,
}

export const fakeBlock = makeFakeBlock()
export const safeSelectors = {
	version: encodeFunctionCall(SAFE_ABI, 'VERSION', []).slice(0, 10),
	nonce: encodeFunctionCall(SAFE_ABI, 'nonce', []).slice(0, 10),
	owners: encodeFunctionCall(SAFE_ABI, 'getOwners', []).slice(0, 10),
	threshold: encodeFunctionCall(SAFE_ABI, 'getThreshold', []).slice(0, 10),
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
export const fakeSafeContract = {
	version: '1.4.1',
	nonce: 0n,
	threshold: 2n,
	owners: [] as bigint[],
	transactionHash: 0n,
	ownerCode: '0x',
	requestedCodeAddresses: [] as bigint[],
	beforeVersionResponse: undefined as (() => Promise<void>) | undefined,
	requestedRpcMethods: [] as string[],
	failEthSimulate: false,
}

export function resetFakeSafeContractState() {
	fakeSafeContract.version = '1.4.1'
	fakeSafeContract.nonce = 0n
	fakeSafeContract.threshold = 2n
	fakeSafeContract.owners = []
	fakeSafeContract.transactionHash = 0n
	fakeSafeContract.ownerCode = '0x'
	fakeSafeContract.requestedCodeAddresses.length = 0
	fakeSafeContract.beforeVersionResponse = undefined
	fakeSafeContract.requestedRpcMethods.length = 0
	fakeSafeContract.failEthSimulate = false
}

export const fakeRequestHandler = {
	rpcUrl: fakeRpcNetwork.httpsRpc,
	clearCache() { return undefined },
	async jsonRpcRequest(rpcRequest: { method: string, params?: readonly unknown[] }) {
		fakeSafeContract.requestedRpcMethods.push(rpcRequest.method)
		switch (rpcRequest.method) {
			case 'eth_getBlockByNumber':
				return modules.serialize(modules.EthereumBlockHeader, fakeBlock)
			case 'eth_getTransactionCount':
				return modules.serialize(modules.EthereumQuantity, 0n)
			case 'eth_getBalance':
				return modules.serialize(modules.EthereumQuantity, 0n)
			case 'eth_blockNumber':
				return modules.serialize(modules.EthereumQuantity, 123n)
		case 'eth_getCode': {
			const rawAddress = rpcRequest.params?.[0]
			if (typeof rawAddress !== 'string' && typeof rawAddress !== 'bigint') throw new Error('Malformed eth_getCode test request')
			const requestedAddress = BigInt(rawAddress)
			fakeSafeContract.requestedCodeAddresses.push(requestedAddress)
			return requestedAddress === activeAddress ? '0x01' : fakeSafeContract.ownerCode
		}
			case 'eth_gasPrice':
				return modules.serialize(modules.EthereumQuantity, 1n)
			case 'eth_call': {
				const call = rpcRequest.params?.[0]
				if (!isRecord(call) || !(call.data instanceof Uint8Array)) throw new Error('Malformed test eth_call')
				const selector = `0x${ Buffer.from(call.data).toString('hex').slice(0, 8) }`
				switch (selector) {
					case safeSelectors.version:
						await fakeSafeContract.beforeVersionResponse?.()
						return encodeFunctionReturn(SAFE_ABI, 'VERSION', [fakeSafeContract.version])
					case safeSelectors.nonce: return encodeFunctionReturn(SAFE_ABI, 'nonce', [fakeSafeContract.nonce])
					case safeSelectors.owners: return encodeFunctionReturn(SAFE_ABI, 'getOwners', [fakeSafeContract.owners.map(addressString)])
					case safeSelectors.threshold: return encodeFunctionReturn(SAFE_ABI, 'getThreshold', [fakeSafeContract.threshold])
					case safeSelectors.transactionHash: return encodeFunctionReturn(SAFE_ABI, 'getTransactionHash', [bytes32String(fakeSafeContract.transactionHash)])
					default: throw new Error(`Unexpected eth_call selector: ${ selector }`)
				}
			}
			case 'eth_simulateV1':
				if (fakeSafeContract.failEthSimulate) throw new Error('eth_simulateV1 unavailable')
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
export const ethereum = new modules.EthereumClientService(fakeRequestHandler, async () => undefined, async () => undefined, fakeRpcNetwork)
export const simulator = {
	ethereum,
	tokenPriceService: new modules.TokenPriceService(ethereum, 60_000),
}

export const activeAddress = modules.defaultActiveAddresses[0]?.address
export const recipientAddress = modules.defaultActiveAddresses[1]?.address
if (activeAddress === undefined || recipientAddress === undefined) throw new Error('missing default addresses')

export const unsignedTransaction = {
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
export const signedTransaction = modules.mockSignTransaction(unsignedTransaction)
export const created = new Date('2024-01-01T00:00:00.000Z')
export const oldTimestamp = new Date('2024-01-01T00:00:00.000Z')
export const uniqueRequestIdentifier = { requestId: 1, requestSocket: { tabId: 1, connectionName: 0n } }
export const safeTestOwnerAccount = privateKeyToAccount('0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')
export const safeTestOwnerAddress = BigInt(safeTestOwnerAccount.address)

export function createSafeStackTransactionFixture(options: {
	readonly nonce?: bigint
	readonly value?: bigint
	readonly transactionIdentifier?: bigint
	readonly signatures?: readonly SafeOwnerSignature[]
} = {}): SafeStackTransaction {
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: options.value ?? 0n,
		input: new Uint8Array(),
	}, options.nonce ?? 0n)
	return {
		safeTx,
		safeTxHash: BigInt(getSafeTxHash(safeTx)),
		created,
		websiteOrigin: 'https://example.com',
		transactionIdentifier: options.transactionIdentifier ?? 70n,
		signatures: options.signatures ?? [],
	}
}

export function createSafeStackFixture(
	transactions: readonly SafeStackTransaction[],
): SafeTransactionStack {
	return {
		chainId: fakeRpcNetwork.chainId,
		safeAddress: activeAddress,
		safeVersion: '1.4.1',
		baseNonce: transactions[0]?.safeTx.message.nonce ?? 0n,
		threshold: 2n,
		transactions,
	}
}
export const popupVisualisation = {
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

export const pendingTransaction = {
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

export async function resetConfirmTransactionTestState() {
	browserMock.reset()
	resetFakeSafeContractState()
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [pendingTransaction] })
	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
}
export function createDisconnectedPort() {
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

export function createRecordingPort(postedMessages: unknown[]): browser.runtime.Port {
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

export function createWebsitePort(socket: { readonly tabId: number, readonly connectionName: bigint }, frameId: number, postedMessages: unknown[], onPostMessage?: (message: unknown) => void): browser.runtime.Port {
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

export async function waitForPendingTransactionsToClear() {
	const deadline = Date.now() + 2_000
	while ((await modules.getPendingTransactionsAndMessages()).length > 0) {
		if (Date.now() > deadline) throw new Error('Timed out waiting for pending popup-close retry')
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
}

export { addressString, bytes32String, createSafeTx, EIP712Message, getSafeTxHash, privateKeyToAccount, SAFE_ABI, SAFE_EXECUTION_ABI, safeTxToTypedDataJson, withSilencedConsole }
