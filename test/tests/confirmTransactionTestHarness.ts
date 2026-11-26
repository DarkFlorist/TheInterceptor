import { MULTICALL3, Multicall3ABI } from '../../app/ts/utils/constants.js'
import multiSendLibrary from '../fixtures/gnosis-safe-libraries/MultiSendCallOnly.json'
import signMessageLibrary from '../fixtures/gnosis-safe-libraries/SignMessageLib.json'
import { GNOSIS_SAFE_MULTI_SEND_CALL_ONLY, GNOSIS_SAFE_SIGN_MESSAGE_LIB } from '../../app/ts/gnosisSafe/gnosisSafeDelegateCalls.js'
import { GNOSIS_SAFE_MESSAGE_ABI } from '../../app/ts/gnosisSafe/gnosisSafeMessage.js'
import type { flushPendingTerminalRepliesForSocket as flushPendingTerminalRepliesForSocketType } from '../../app/ts/background/terminalReplyDelivery.js'
import { decodeFunctionDataStrict, encodeFunctionCall, encodeFunctionReturn } from '../../app/ts/utils/abiRuntime.js'
import { withSilencedConsole } from './consoleSilence.js'
import { createGnosisSafeTx, GNOSIS_SAFE_ABI, gnosisSafeTxToTypedDataJson } from '../../app/ts/gnosisSafe/gnosisSafeCore.js'
import { GNOSIS_SAFE_EXECUTION_ABI } from '../../app/ts/gnosisSafe/gnosisSafeExecution.js'
import { getGnosisSafeTxHash } from '../../app/ts/utils/eip712.js'
import { addressString, bytes32String } from '../../app/ts/utils/bigint.js'
import { EIP712Message } from '../../app/ts/types/eip721.js'
import { privateKeyToAccount } from '../../app/ts/utils/ethereumPrimitives.js'
import type { GnosisSafeEntry } from '../../app/ts/types/addressBookTypes.js'
import type { GnosisSafeOwnerSignature, GnosisSafeStackTransaction, GnosisSafeTransactionStack } from '../../app/ts/types/gnosisSafeTypes.js'
import { type PendingTransactionOrSignableMessage, PopupPendingTransactionOrSignableMessage } from '../../app/ts/types/accessRequest.js'
import { getCreatedGnosisSafeProposal } from '../../app/ts/gnosisSafe/gnosisSafePendingFlow.js'
import { type UniqueRequestIdentifier, doesUniqueRequestIdentifiersMatch } from '../../app/ts/utils/requests.js'
import { serialize } from '../../app/ts/types/wire-types.js'



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

export function createGnosisSafeAddressBookEntry(overrides: Partial<GnosisSafeEntry> = {}): GnosisSafeEntry {
	return {
		type: 'safe',
		name: 'Treasury Gnosis Safe',
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
	let tabUpdateHandler: ((tabId: number) => Promise<void>) | undefined
	let windowGetHandler: ((windowId: number) => Promise<void>) | undefined
	let windowRemoveHandler: ((windowId: number) => Promise<void>) | undefined
	let windowCreateHandler: (() => Promise<void>) | undefined
	let runtimeSendMessageHandler: ((message: RuntimeMessage) => Promise<void>) | undefined

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
				await runtimeSendMessageHandler?.(message)
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
			async update(tabId: number) {
				await tabUpdateHandler?.(tabId)
				return undefined
			},
			async remove() { return undefined },
			onUpdated: { addListener: () => undefined, removeListener: () => undefined },
			onRemoved: { addListener: () => undefined, removeListener: () => undefined },
		},
		windows: {
			async get(windowId: number) {
				await windowGetHandler?.(windowId)
				if (!liveWindowIds.has(windowId)) throw new Error(`No window with id: ${ windowId }`)
				return { id: windowId }
			},
			async update() { return undefined },
			async create() {
				await windowCreateHandler?.()
				return { id: 99 }
			},
			async remove(windowId: number) {
				await windowRemoveHandler?.(windowId)
				return undefined
			},
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
	const installGlobals = () => {
		Object.defineProperty(globalThis, 'browser', { value: browser, configurable: true, writable: true })
		Object.defineProperty(globalThis, 'chrome', { value: { runtime: { id: 'test-extension' } }, configurable: true, writable: true })
		Object.defineProperty(globalThis, 'location', { value: { origin: '' }, configurable: true, writable: true })
	}
	installGlobals()

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
		setTabUpdateHandler(handler: typeof tabUpdateHandler) { tabUpdateHandler = handler },
		setWindowGetHandler(handler: typeof windowGetHandler) { windowGetHandler = handler },
		setWindowRemoveHandler(handler: typeof windowRemoveHandler) { windowRemoveHandler = handler },
		setWindowCreateHandler(handler: typeof windowCreateHandler) { windowCreateHandler = handler },
		setRuntimeSendMessageHandler(handler: typeof runtimeSendMessageHandler) { runtimeSendMessageHandler = handler },
		reset() {
			// Other test files install their own browser; restore this harness before seeding or observing its storage.
			installGlobals()
			for (const key of Object.keys(storageState)) delete storageState[key]
			sentMessages.length = 0
			browser.runtime.lastError = undefined
			manifestVersion = 3
			liveTabIds.clear()
			liveWindowIds.clear()
			tabMessageHandler = undefined
			storageGetHandler = undefined
			storageSetHandler = undefined
			tabUpdateHandler = undefined
			windowGetHandler = undefined
			windowRemoveHandler = undefined
			windowCreateHandler = undefined
			runtimeSendMessageHandler = undefined
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
		safeCore,
		safeConfirmationPersistence,
		errors,
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
		import('../../app/ts/gnosisSafe/gnosisSafeExecutionRouting.js'),
		import('../../app/ts/background/gnosisSafeConfirmationResolver.js'),
		import('../../app/ts/gnosisSafe/gnosisSafeSimulation.js'),
		import('../../app/ts/gnosisSafe/gnosisSafeCore.js'),
		import('../../app/ts/background/gnosisSafeConfirmationPersistence.js'),
		import('../../app/ts/utils/errors.js'),
	])
	const flushPendingTerminalRepliesForSocket: typeof flushPendingTerminalRepliesForSocketType = terminalReplyDelivery.flushPendingTerminalRepliesForSocket

	return {
		EthereumClientService: ethereumClientService.EthereumClientService,
		TokenPriceService: priceEstimator.TokenPriceService,
		mockSignTransaction: simulationModeEthereumClientService.mockSignTransaction,
		Multicall3ABI: constants.Multicall3ABI,
		defaultActiveAddresses: settings.defaultActiveAddresses,
		changeSimulationMode: settings.changeSimulationMode,
		refreshPopupConfirmTransactionSimulation: popupMessageHandlers.refreshPopupConfirmTransactionSimulation,
		refreshPopupConfirmTransactionMetadata: popupMessageHandlers.refreshPopupConfirmTransactionMetadata,
		popupReadyAndListening: popupMessageHandlers.popupReadyAndListening,
		forceSetGasLimitForTransaction: popupMessageHandlers.forceSetGasLimitForTransaction,
		removeTransactionOrSignedMessage: popupMessageHandlers.removeTransactionOrSignedMessage,
		simulateGovernanceContractExecutionOnPass: popupMessageHandlers.simulateGovernanceContractExecutionOnPass,
		confirmDialog: popupMessageHandlers.confirmDialog,
		getGnosisSafeSignerSelectionFromAccountRefresh: popupMessageHandlers.getGnosisSafeSignerSelectionFromAccountRefresh,
		importGnosisSafeStack: popupMessageHandlers.importGnosisSafeStack,
		requestGnosisSafeStackExport: popupMessageHandlers.requestGnosisSafeStackExport,
		setGnosisSafeSimulationSigner: popupMessageHandlers.setGnosisSafeSimulationSigner,
		fetchSimulationStackRequestConfirmation: popupMessageHandlers.fetchSimulationStackRequestConfirmation,
		resolvePendingTransactionOrMessage: confirmTransaction.resolvePendingTransactionOrMessage,
		toPopupPendingTransactionOrSignableMessage: confirmTransaction.toPopupPendingTransactionOrSignableMessage,
		updateConfirmTransactionView: confirmTransaction.updateConfirmTransactionView,
		formEthSendTransaction: confirmTransaction.formEthSendTransaction,
		getGnosisSafeExecutionSignerRoute: safeExecutionRouting.getGnosisSafeExecutionSignerRoute,
		prepareGnosisSafeExecutionSignerRoute: safeExecutionRouting.prepareGnosisSafeExecutionSignerRoute,
		openConfirmTransactionDialogForMessage: confirmTransaction.openConfirmTransactionDialogForMessage,
		openConfirmTransactionDialogForTransaction: confirmTransaction.openConfirmTransactionDialogForTransaction,
		onCloseWindowOrTab: confirmTransaction.onCloseWindowOrTab,
		refreshPendingGnosisSafeSignerSelectionErrors: confirmTransaction.refreshPendingGnosisSafeSignerSelectionErrors,
		resolvePendingRequestsForMissingConfirmationWindows: confirmTransaction.resolvePendingRequestsForMissingConfirmationWindows,
		resolveGnosisSafeConfirmation: safeConfirmationResolver.resolveGnosisSafeConfirmation,
		createGnosisSafeExecutionPreSimulationTransaction: safeSimulation.createGnosisSafeExecutionPreSimulationTransaction,
		createGnosisSafeSigningSimulationInput: safeSimulation.createGnosisSafeSigningSimulationInput,
		createGnosisSafeContractValidationFailure: safeCore.createGnosisSafeContractValidationFailure,
		resolveGnosisSafeSignerReply: safeConfirmationPersistence.resolveGnosisSafeSignerReply,
		getPendingTransactionsAndMessages: storageVariables.getPendingTransactionsAndMessages,
		getGnosisSafeTransactionStacks: storageVariables.getGnosisSafeTransactionStacks,
		getInterceptorTransactionStack: storageVariables.getInterceptorTransactionStack,
		setFetchSimulationStackRequestPromise: storageVariables.setFetchSimulationStackRequestPromise,
		getUserAddressBookEntries: storageVariables.getUserAddressBookEntries,
		appendPendingTransactionOrMessage: storageVariables.appendPendingTransactionOrMessage,
		getPendingTerminalReplies: pendingTerminalReplies.getPendingTerminalReplies,
		prunePendingTerminalRepliesForMissingTabs: pendingTerminalReplies.prunePendingTerminalRepliesForMissingTabs,
		updateInterceptorTransactionStack: storageVariables.updateInterceptorTransactionStack,
		// Test setup: changes the stored pending request under this id, whatever its approval status.
		updateStoredPendingRequest: async (uniqueRequestIdentifier: UniqueRequestIdentifier, update: Parameters<typeof storageVariables.updatePendingTransactionOrMessageInstance>[1]) => {
			const stored = (await storageVariables.getPendingTransactionsAndMessages()).find((pending) => pending.uniqueRequestIdentifier.requestId === uniqueRequestIdentifier.requestId
				&& pending.uniqueRequestIdentifier.requestSocket.tabId === uniqueRequestIdentifier.requestSocket.tabId
				&& pending.uniqueRequestIdentifier.requestSocket.connectionName === uniqueRequestIdentifier.requestSocket.connectionName)
			if (stored === undefined) throw new Error('No stored pending request to update')
			await storageVariables.updatePendingTransactionOrMessageInstance(stored, update)
		},
		updateSafeTransactionStacks: async (update: (previous: Awaited<ReturnType<typeof storageVariables.getGnosisSafeTransactionStacks>>) => Awaited<ReturnType<typeof storageVariables.getGnosisSafeTransactionStacks>>) => {
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
		browserStorageLocalSet: storageUtils.browserStorageLocalSet,
		websiteSocketToString: backgroundUtils.websiteSocketToString,
		serialize: wireTypes.serialize,
		EthereumBytes32: wireTypes.EthereumBytes32,
		EthereumBlockHeader: wireTypes.EthereumBlockHeader,
		EthereumQuantity: wireTypes.EthereumQuantity,
		EthSimulateV1Result: ethSimulateTypes.EthSimulateV1Result,
		JsonRpcResponseError: errors.JsonRpcResponseError,
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

// The simulator reads contract code during simulation through a call to this helper contract, mirroring the private constant in SimulationModeEthereumClientService.ts.
const SIMULATED_GET_CODE_CONTRACT = 0x1ce438391307f908756fefe0fe220c0f0d51508an
const SIMULATED_GET_CODE_ABI = [{ type: 'function', name: 'at', stateMutability: 'view', inputs: [{ name: 'target', type: 'address' }], outputs: [{ name: 'code', type: 'bytes' }] }] as const

const isSimulatedGetCodeCall = (call: unknown) => isRecord(call) && (typeof call.to === 'bigint' || typeof call.to === 'string') && BigInt(call.to) === SIMULATED_GET_CODE_CONTRACT

// Answers code reads with non-empty code, so simulated calls to contracts such as a Gnosis Safe produce a result, and every other call with a multicall balance result.
export function makeFakeEthSimulateResult(multicallBalance: bigint, multicallAbi: readonly string[], calls: readonly unknown[] = [{}]) {
	const balanceResult = encodeFunctionReturn(multicallAbi, 'getEthBalance', [multicallBalance])
	const aggregate3Result = encodeFunctionReturn(multicallAbi, 'aggregate3', [[{ success: true, returnData: balanceResult }]])
	const getCodeResult = encodeFunctionReturn(SIMULATED_GET_CODE_ABI, 'at', ['0x01'])
	return {
		number: 123n,
		hash: 0x9876n,
		timestamp: 0x65920080n,
		gasLimit: 30_000_000n,
		gasUsed: 21_000n,
		baseFeePerGas: 1n,
		calls: calls.map((call) => ({
			status: 'success' as const,
			gasUsed: 21_000n,
			logs: [],
			returnData: hexToBytes(isSimulatedGetCodeCall(call) ? getCodeResult : aggregate3Result),
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
const getGnosisSafeMetadataCallInput = (call: unknown) => {
	if (!isRecord(call)) return undefined
	const input = call.input instanceof Uint8Array ? call.input : call.data
	if (!(input instanceof Uint8Array)) return undefined
	const selector = `0x${ Buffer.from(input).toString('hex').slice(0, 8) }`
	return [gnosisSafeSelectors.version, gnosisSafeSelectors.nonce, gnosisSafeSelectors.owners, gnosisSafeSelectors.threshold].includes(selector) ? input : undefined
}

export const gnosisSafeSelectors = {
	messageHash: encodeFunctionCall(GNOSIS_SAFE_MESSAGE_ABI, 'getMessageHash', ['0x']).slice(0, 10),
	messageSignature: encodeFunctionCall(GNOSIS_SAFE_MESSAGE_ABI, 'isValidSignature', [`0x${ '00'.repeat(32) }`, '0x']).slice(0, 10),
	version: encodeFunctionCall(GNOSIS_SAFE_ABI, 'VERSION', []).slice(0, 10),
	nonce: encodeFunctionCall(GNOSIS_SAFE_ABI, 'nonce', []).slice(0, 10),
	owners: encodeFunctionCall(GNOSIS_SAFE_ABI, 'getOwners', []).slice(0, 10),
	threshold: encodeFunctionCall(GNOSIS_SAFE_ABI, 'getThreshold', []).slice(0, 10),
	transactionHash: encodeFunctionCall(GNOSIS_SAFE_ABI, 'getTransactionHash', [
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
export const fakeGnosisSafeContract = {
	version: '1.4.1',
	nonce: 0n,
	threshold: 2n,
	owners: [] as bigint[],
	transactionHash: 0n,
	messageHash: 0n,
	messageSignatureValid: true,
	ownerCode: '0x',
	requestedCodeAddresses: [] as bigint[],
	beforeVersionResponse: undefined as (() => Promise<void>) | undefined,
	requestedRpcMethods: [] as string[],
	failEthSimulate: false,
	safeOwnerLookupFailure: undefined as 'expected' | 'unexpected' | undefined,
}

export function resetFakeGnosisSafeContractState() {
	fakeGnosisSafeContract.version = '1.4.1'
	fakeGnosisSafeContract.nonce = 0n
	fakeGnosisSafeContract.threshold = 2n
	fakeGnosisSafeContract.owners = []
	fakeGnosisSafeContract.transactionHash = 0n
	fakeGnosisSafeContract.messageHash = 0n
	fakeGnosisSafeContract.messageSignatureValid = true
	fakeGnosisSafeContract.ownerCode = '0x'
	fakeGnosisSafeContract.requestedCodeAddresses.length = 0
	fakeGnosisSafeContract.beforeVersionResponse = undefined
	fakeGnosisSafeContract.requestedRpcMethods.length = 0
	fakeGnosisSafeContract.failEthSimulate = false
	fakeGnosisSafeContract.safeOwnerLookupFailure = undefined
}

const getFakeGnosisSafeContractReturnData = async (input: Uint8Array) => {
	const selector = `0x${ Buffer.from(input).toString('hex').slice(0, 8) }`
	switch (selector) {
		case gnosisSafeSelectors.version:
			await fakeGnosisSafeContract.beforeVersionResponse?.()
			return encodeFunctionReturn(GNOSIS_SAFE_ABI, 'VERSION', [fakeGnosisSafeContract.version])
		case gnosisSafeSelectors.nonce: return encodeFunctionReturn(GNOSIS_SAFE_ABI, 'nonce', [fakeGnosisSafeContract.nonce])
		case gnosisSafeSelectors.owners:
			if (fakeGnosisSafeContract.safeOwnerLookupFailure === 'expected') throw modules.createGnosisSafeContractValidationFailure('Gnosis Safe owner lookup unavailable')
			if (fakeGnosisSafeContract.safeOwnerLookupFailure === 'unexpected') throw new Error('Unexpected Gnosis Safe owner decoder failure')
			return encodeFunctionReturn(GNOSIS_SAFE_ABI, 'getOwners', [fakeGnosisSafeContract.owners.map(addressString)])
		case gnosisSafeSelectors.threshold: return encodeFunctionReturn(GNOSIS_SAFE_ABI, 'getThreshold', [fakeGnosisSafeContract.threshold])
		case gnosisSafeSelectors.messageHash: return encodeFunctionReturn(GNOSIS_SAFE_MESSAGE_ABI, 'getMessageHash', [bytes32String(fakeGnosisSafeContract.messageHash)])
		case gnosisSafeSelectors.messageSignature: return encodeFunctionReturn(GNOSIS_SAFE_MESSAGE_ABI, 'isValidSignature', [fakeGnosisSafeContract.messageSignatureValid ? '0x1626ba7e' : '0xffffffff'])
		case gnosisSafeSelectors.transactionHash: return encodeFunctionReturn(GNOSIS_SAFE_ABI, 'getTransactionHash', [bytes32String(fakeGnosisSafeContract.transactionHash)])
		default: throw new Error(`Unexpected eth_call selector: ${ selector }`)
	}
}

export const fakeRequestHandler = {
	rpcUrl: fakeRpcNetwork.httpsRpc,
	clearCache() { return undefined },
	async jsonRpcRequest(rpcRequest: { method: string, params?: readonly unknown[] }) {
		fakeGnosisSafeContract.requestedRpcMethods.push(rpcRequest.method)
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
			fakeGnosisSafeContract.requestedCodeAddresses.push(requestedAddress)
			if (requestedAddress === MULTICALL3) return '0x01'
			if (requestedAddress === GNOSIS_SAFE_MULTI_SEND_CALL_ONLY) return multiSendLibrary.deployedBytecode
			if (requestedAddress === GNOSIS_SAFE_SIGN_MESSAGE_LIB) return signMessageLibrary.deployedBytecode
			return requestedAddress === activeAddress ? '0x01' : fakeGnosisSafeContract.ownerCode
		}
			case 'eth_gasPrice':
				return modules.serialize(modules.EthereumQuantity, 1n)
			case 'eth_call': {
				const call = rpcRequest.params?.[0]
				if (!isRecord(call) || !(call.data instanceof Uint8Array)) throw new Error('Malformed test eth_call')
				return await getFakeGnosisSafeContractReturnData(call.data)
			}
			case 'eth_simulateV1':
				if (fakeGnosisSafeContract.failEthSimulate) throw new Error('eth_simulateV1 unavailable')
				return modules.serialize(
					modules.EthSimulateV1Result,
					await Promise.all((Array.isArray(rpcRequest.params?.[0]?.blockStateCalls) ? rpcRequest.params[0].blockStateCalls : [{}]).map(async (blockStateCall) => {
						const calls: readonly unknown[] = Array.isArray(blockStateCall.calls) ? blockStateCall.calls : []
						const result = makeFakeEthSimulateResult(0n, modules.Multicall3ABI, calls)
						// Read Gnosis Safe metadata after the prefix as eth_call does. This fake node does not execute contracts, so stored metadata stays unchanged.
						return { ...result, calls: await Promise.all(result.calls.map(async (callResult, index) => {
							const originalCall = calls[index]
							if (isRecord(originalCall) && BigInt(originalCall.to ?? 0n) === MULTICALL3 && originalCall.input instanceof Uint8Array) {
								const decoded = decodeFunctionDataStrict(Multicall3ABI, originalCall.input)
								if (decoded.functionName === 'aggregate3' && decoded.args[0].every((entry) => BigInt(entry.target) === activeAddress && getGnosisSafeMetadataCallInput({ input: hexToBytes(entry.callData) }) !== undefined)) {
									return { ...callResult, returnData: hexToBytes(encodeFunctionReturn(Multicall3ABI, 'aggregate3', [await Promise.all(decoded.args[0].map(async (entry) => ({ success: true, returnData: await getFakeGnosisSafeContractReturnData(hexToBytes(entry.callData)) })))])) }
								}
							}
							const input = getGnosisSafeMetadataCallInput(originalCall)
							return input === undefined ? callResult : { ...callResult, returnData: hexToBytes(await getFakeGnosisSafeContractReturnData(input)) }
						})) }
					})),
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

const FEE_VALIDATING_BASE_FEE_PER_GAS = 100_000_000_000n
// Pays for a transfer only with a fee cap far below the fee-validating block base fee.
export const TOO_LITTLE_ETH_FOR_FEES = 1_000_000_000_000n

// Like geth's eth_simulateV1 without validation, a call that pays fees must cover the block base fee while a zero-fee call skips the check. Every account holds the given balance.
export function createFeeValidatingSimulator(accountBalance: bigint, rpcNetwork = fakeRpcNetwork) {
	const block = { ...fakeBlock, baseFeePerGas: FEE_VALIDATING_BASE_FEE_PER_GAS }
	const requestHandler = {
		rpcUrl: rpcNetwork.httpsRpc,
		clearCache() { return undefined },
		async jsonRpcRequest(rpcRequest: { method: string, params?: readonly unknown[] }) {
			switch (rpcRequest.method) {
				case 'eth_getBlockByNumber': return modules.serialize(modules.EthereumBlockHeader, block)
				case 'eth_getBalance': return modules.serialize(modules.EthereumQuantity, accountBalance)
				case 'eth_simulateV1': {
					const simulationParams = rpcRequest.params?.[0]
					const blockStateCalls = isRecord(simulationParams) && Array.isArray(simulationParams.blockStateCalls) ? simulationParams.blockStateCalls : []
					return modules.serialize(modules.EthSimulateV1Result, blockStateCalls.map((blockStateCall) => {
						const blockBaseFeePerGas = BigInt(blockStateCall.blockOverrides?.baseFeePerGas ?? block.baseFeePerGas)
						for (const call of blockStateCall.calls) {
							const maxFeePerGas = BigInt(call.maxFeePerGas ?? 0n)
							if (maxFeePerGas === 0n || maxFeePerGas >= blockBaseFeePerGas) continue
							throw new modules.JsonRpcResponseError({ jsonrpc: '2.0', id: 1, error: {
								code: -32000,
								message: `err: max fee per gas less than block base fee: address ${ addressString(BigInt(call.from)) }, maxFeePerGas: ${ maxFeePerGas }, baseFee: ${ blockBaseFeePerGas }`,
							} })
						}
						return { ...makeFakeEthSimulateResult(accountBalance, modules.Multicall3ABI, blockStateCall.calls), baseFeePerGas: blockBaseFeePerGas }
					}))
				}
				default: return await fakeRequestHandler.jsonRpcRequest(rpcRequest)
			}
		},
	}
	const feeValidatingEthereum = new modules.EthereumClientService(requestHandler, async () => undefined, async () => undefined, rpcNetwork)
	return {
		ethereum: feeValidatingEthereum,
		tokenPriceService: new modules.TokenPriceService(feeValidatingEthereum, 60_000),
	}
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
export const gnosisSafeTestOwnerAccount = privateKeyToAccount('0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')
export const gnosisSafeTestOwnerAddress = BigInt(gnosisSafeTestOwnerAccount.address)

export function createGnosisSafeStackTransactionFixture(options: {
	readonly nonce?: bigint
	readonly value?: bigint
	readonly transactionIdentifier?: bigint
	readonly signatures?: readonly GnosisSafeOwnerSignature[]
} = {}): GnosisSafeStackTransaction {
	const safeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: options.value ?? 0n,
		input: new Uint8Array(),
	}, options.nonce ?? 0n)
	return {
		safeTx,
		safeTxHash: BigInt(getGnosisSafeTxHash(safeTx)),
		created,
		websiteOrigin: 'https://example.com',
		transactionIdentifier: options.transactionIdentifier ?? 70n,
		signatures: options.signatures ?? [],
	}
}

export function createGnosisSafeStackFixture(
	transactions: readonly GnosisSafeStackTransaction[],
): GnosisSafeTransactionStack {
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
		confirmationRunId: { lifetime: 'fixture', sequence: 1 },
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
		instanceId: 'harness pending transaction',
		transactionIdentifier: 1n,
		website: popupVisualisation.data.transactionToSimulate.website,
		approvalStatus: { status: 'WaitingForUser' },
		popupVisualisation,
		safeFlow: { kind: 'ordinary' },
		transactionOrMessageCreationStatus: 'Simulated',
		transactionToSimulate: popupVisualisation.data.transactionToSimulate,
	} as const

export type SimulatedTransactionOutcome = { transactionStatus: 'Transaction Succeeded' } | { transactionStatus: 'Transaction Failed', error: { code: number, message: string, decodedErrorMessage: string } }

const createContactEntry = (name: string, address: bigint) => ({ type: 'contact' as const, name, address, entrySource: 'User' as const, chainId: fakeRpcNetwork.chainId })

// The simulated result the popup shows for a transaction, with the given outcome and quarantine flag.
export function createVisualizedTransactionResult(transactionIdentifier: bigint, outcome: SimulatedTransactionOutcome = { transactionStatus: 'Transaction Succeeded' }, quarantine = false) {
	return {
		website: pendingTransaction.website,
		created,
		parsedInputData: { type: 'NonParsed' as const, input: new Uint8Array() },
		transactionIdentifier,
		originalRequestParameters: pendingTransaction.originalRequestParameters,
		tokenBalancesAfter: [],
		tokenPriceEstimates: [],
		tokenPriceQuoteToken: undefined,
		gasSpent: 21_000n,
		realizedGasPrice: 1n,
		quarantine,
		quarantineReasons: quarantine ? ['The recipient is a known scam address.'] : [],
		events: [],
		transaction: { ...unsignedTransaction, from: createContactEntry('Sender', activeAddress), to: createContactEntry('Recipient', recipientAddress), rpcNetwork: fakeRpcNetwork, hash: signedTransaction.hash },
		...outcome,
	}
}

// The pending transaction with a simulated result for it, so the popup can confirm it and the background accepts it; the base fixture has no result and is reject-only.
export function withSimulatedTransactionResult<Pending extends { transactionIdentifier: bigint, popupVisualisation: typeof popupVisualisation }>(pending: Pending, outcome: SimulatedTransactionOutcome = { transactionStatus: 'Transaction Succeeded' }, quarantine = false) {
	return {
		...pending,
		popupVisualisation: {
			...pending.popupVisualisation,
			data: {
				...pending.popupVisualisation.data,
				visualizedSimulationState: {
					success: true as const,
					visualizedBlocks: [{
						simulatedAndVisualizedTransactions: [createVisualizedTransactionResult(pending.transactionIdentifier, outcome, quarantine)],
						visualizedPersonalSignRequests: [],
						blockTimeManipulation: { type: 'AddToTimestamp' as const, deltaToAdd: 0n, deltaUnit: 'Seconds' as const },
					}],
				},
			},
		},
	}
}

// The reviewed-result id the popup sends back for a stored request: the one the background stamped on its popup copy, after the message round trip that copy goes through.
export function getPopupReviewedResultId(pending: PendingTransactionOrSignableMessage) {
	return PopupPendingTransactionOrSignableMessage.parse(serialize(PopupPendingTransactionOrSignableMessage, modules.toPopupPendingTransactionOrSignableMessage(pending))).reviewedResultId
}

// Builds the accept the popup sends for the request as currently stored, naming its reviewed content and the send-anyway override.
export async function createAcceptConfirmation(requestIdentifier: UniqueRequestIdentifier = uniqueRequestIdentifier, forceSend = false) {
	const pending = (await modules.getPendingTransactionsAndMessages()).find((entry) => doesUniqueRequestIdentifiersMatch(entry.uniqueRequestIdentifier, requestIdentifier))
	if (pending === undefined) throw new Error('Expected a stored request to accept')
	return { method: 'popup_confirmDialog' as const, data: { action: 'accept' as const, uniqueRequestIdentifier: requestIdentifier, reviewedResultId: getPopupReviewedResultId(pending), forceSend } }
}
// The Gnosis Safe transaction of a pending transaction that is a created Gnosis Safe proposal.
export const getPendingGnosisSafeProposal = (pending: PendingTransactionOrSignableMessage | undefined) => pending?.type === 'Transaction' ? getCreatedGnosisSafeProposal(pending.safeFlow) : undefined

export async function resetConfirmTransactionTestState() {
	browserMock.reset()
	resetFakeGnosisSafeContractState()
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

export { addressString, bytes32String, createGnosisSafeTx, EIP712Message, getGnosisSafeTxHash, privateKeyToAccount, GNOSIS_SAFE_ABI, GNOSIS_SAFE_EXECUTION_ABI, gnosisSafeTxToTypedDataJson, withSilencedConsole }

// Replayed accepts may arrive after cleanup; the resolver must finish or ignore them before inspecting consent.
export async function createReplayableAcceptConfirmation(requestIdentifier: UniqueRequestIdentifier) {
	const pending = (await modules.getPendingTransactionsAndMessages()).find((entry) => doesUniqueRequestIdentifiersMatch(entry.uniqueRequestIdentifier, requestIdentifier))
	return { method: 'popup_confirmDialog' as const, data: { action: 'accept' as const, uniqueRequestIdentifier: requestIdentifier, reviewedResultId: pending === undefined ? '' : getPopupReviewedResultId(pending), forceSend: true } }
}
