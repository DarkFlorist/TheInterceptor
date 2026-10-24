// Shared state for the confirm-transaction and Gnosis Safe suites that confirmTransactionFlows.test.ts runs in one module instance.
//
// Usage:
//   beforeEach(resetConfirmTransactionTestState)                       // a fresh browser mock, fresh fake Safe state and one stored pending transaction
//   const website = connectWebsite()                                   // an approved website socket; website.postedMessages records what the background posts to it
//   await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, website.websiteTabConnections, accept)
//   assert.equal(hasForwardedSignerRequest(website.postedMessages), true)
//   const restoreStorageGet = interceptStorageGet(async (keys, readStoredItems) => ...)   // gate or fail browser.storage.local.get
import * as funtypes from 'funtypes'
import multiSendLibrary from '../fixtures/safe-libraries/MultiSendCallOnly.json'
import signMessageLibrary from '../fixtures/safe-libraries/SignMessageLib.json'
import { SAFE_MULTI_SEND_CALL_ONLY, SAFE_SIGN_MESSAGE_LIB } from '../../app/ts/safe/safeDelegateCalls.js'
import { SAFE_MESSAGE_ABI } from '../../app/ts/safe/safeMessage.js'
import { encodeFunctionCall, encodeFunctionReturn } from '../../app/ts/utils/abiRuntime.js'
import { withSilencedConsole } from './consoleSilence.js'
import { createSafeTx, SAFE_ABI, safeTxToTypedDataJson } from '../../app/ts/safe/safeCore.js'
import { SAFE_EXECUTION_ABI } from '../../app/ts/safe/safeExecution.js'
import { getSafeTxHash } from '../../app/ts/utils/eip712.js'
import { addressString, bytes32String } from '../../app/ts/utils/bigint.js'
import { EIP712Message } from '../../app/ts/types/eip721.js'
import { privateKeyToAccount } from '../../app/ts/utils/ethereumPrimitives.js'
import { Multicall3ABI } from '../../app/ts/utils/constants.js'
import { UpdateConfirmTransactionDialog, UpdateConfirmTransactionDialogPendingTransactions } from '../../app/ts/types/interceptor-messages.js'
import type { SafeEntry } from '../../app/ts/types/addressBookTypes.js'
import type { SafeOwnerSignature, SafeStackTransaction, SafeTransactionSigningRequest, SafeTransactionStack } from '../../app/ts/types/safeTypes.js'
import type { ConfirmTransactionTransactionSingleVisualization, SimulatedPendingTransaction } from '../../app/ts/types/accessRequest.js'
import type { EthereumJsonRpcRequest, SendTransactionParams } from '../../app/ts/types/JsonRpc-types.js'
import type { SignMessageParams } from '../../app/ts/types/jsonRpc-signing-types.js'
import type { Website } from '../../app/ts/types/websiteAccessTypes.js'
import type { RpcEntry } from '../../app/ts/types/rpc.js'
import type { WebsiteCreatedEthereumTransaction } from '../../app/ts/types/visualizer-types.js'
import type { SignerStateOwner, TabConnection, TabState, WebsiteTabConnections } from '../../app/ts/types/user-interface-types.js'
import type { InterceptedRequest, UniqueRequestIdentifier, WebsiteSocket } from '../../app/ts/utils/requests.js'
import type { IEthereumJSONRpcRequestHandler } from '../../app/ts/simulation/services/EthereumJSONRpcRequestHandler.js'
import type { flushPendingTerminalRepliesForSocket as FlushPendingTerminalRepliesForSocket } from '../../app/ts/background/terminalReplyDelivery.js'
import { createMockPort, installBrowserMock, type BrowserMock, type MockTabSeed, type MockWindowSeed, type StorageKeys } from '../harness/browserMock.js'
import { replaceGlobal } from '../harness/globals.js'
import { waitFor } from '../harness/async.js'
import { importAllPopupMessageHandlers } from './popupMessageHandlerModules.js'
import { requireDefined } from '../harness/assertions.js'

export type { StorageKeys }
type StoredItems = Record<string, unknown>

export const hexToBytes = (hex: string) => Uint8Array.from(Buffer.from(hex.slice(2), 'hex'))

// The window the user browses in. Tabs and popups the extension opens get ids from FIRST_CREATED_ID up, so they never collide with the closed tab and popup ids (1, 2, …) that pending-request fixtures reference.
const BROWSING_WINDOW_ID = 98
const FIRST_CREATED_ID = 99

const IsMainPopupWindowOpenRequest = funtypes.ReadonlyObject({ method: funtypes.Literal('popup_isMainPopupWindowOpen') })

// No extension popup is open in these tests, so the background's "is the main popup open?" question gets the popup's negative answer.
const replyToRuntimeMessage = (message: unknown) => IsMainPopupWindowOpenRequest.safeParse(message).success
	? { method: 'popup_isMainPopupWindowOpen', data: { isOpen: false } }
	: undefined

type ConfirmTransactionBrowserOptions = {
	readonly storedItems?: Readonly<StoredItems>
	readonly openTabs?: readonly MockTabSeed[]
	readonly openWindows?: readonly MockWindowSeed[]
}

function installConfirmTransactionBrowserMock({ storedItems = {}, openTabs = [], openWindows = [] }: ConfirmTransactionBrowserOptions = {}) {
	return installBrowserMock({
		extensionId: 'test-extension',
		storage: { local: storedItems },
		tabs: openTabs,
		windows: [{ id: BROWSING_WINDOW_ID, focused: true }, ...openWindows],
		firstCreatedIds: { tab: FIRST_CREATED_ID, window: FIRST_CREATED_ID },
		handlers: { runtimeMessage: replyToRuntimeMessage },
	})
}

replaceGlobal('location', { origin: '' })
// Reassigned by every reset; importers see the current mock through the live ES module binding.
export let browserMock: BrowserMock = installConfirmTransactionBrowserMock()

function reinstallBrowserMock(options: ConfirmTransactionBrowserOptions = {}) {
	browserMock.restore()
	browserMock = installConfirmTransactionBrowserMock(options)
}

// Reopens the browser with these tabs and windows open while keeping every stored item, for tests about requests whose confirmation window or website tab still exists.
export function openBrowserTargets({ tabs = [], windows = [] }: { readonly tabs?: readonly MockTabSeed[], readonly windows?: readonly MockWindowSeed[] }) {
	reinstallBrowserMock({ storedItems: browserMock.readStorage(), openTabs: tabs, openWindows: windows })
}

export const readStoredItem = (key: string): unknown => browserMock.readStorage()[key]

type StorageGetInterceptor = (keys: StorageKeys, readStoredItems: () => Promise<StoredItems>) => Promise<StoredItems>

// Routes every browser.storage.local.get through interceptor, which can delay, fail or pass the read on; returns a function that removes it.
export function interceptStorageGet(interceptor: StorageGetInterceptor) {
	const storageArea = browserMock.browser.storage.local
	const readStoredItems = storageArea.get
	storageArea.get = async (keys) => await interceptor(keys, async () => await readStoredItems(keys))
	return () => { storageArea.get = readStoredItems }
}

type StorageSetInterceptor = (items: Readonly<StoredItems>, writeStoredItems: () => Promise<void>) => Promise<void>

// Routes every browser.storage.local.set through interceptor, which can delay, fail or pass the write on; returns a function that removes it.
export function interceptStorageSet(interceptor: StorageSetInterceptor) {
	const storageArea = browserMock.browser.storage.local
	const writeStoredItems = storageArea.set
	storageArea.set = async (items) => await interceptor(items, async () => await writeStoredItems(items))
	return () => { storageArea.set = writeStoredItems }
}

// Makes browser.runtime.getManifest() report another manifest version; returns a function that restores the installed one.
export function useManifestVersion(manifestVersion: 2 | 3) {
	const runtime = browserMock.browser.runtime
	const getManifest = runtime.getManifest
	runtime.getManifest = () => ({ manifest_version: manifestVersion })
	return () => { runtime.getManifest = getManifest }
}

// Answers browser.tabs.sendMessage with handler instead of Chrome's "no content script" rejection; returns a function that restores the rejection.
export function answerTabMessages(handler: (tabId: number, message: unknown) => unknown) {
	const handlers = browserMock.handlers
	const previousHandler = handlers.tabMessage
	handlers.tabMessage = handler
	return () => { handlers.tabMessage = previousHandler }
}

const parseSentRuntimeMessages =<T>(codec: funtypes.Codec<T>): T[] => browserMock.calls.runtimeSendMessage.flatMap((message) => {
	const parsed = codec.safeParse(message)
	return parsed.success ? [parsed.value] : []
})

// Pending-request list updates the background sent to the confirmation popup, in sending order.
export const getSentPendingTransactionDialogUpdates = () => parseSentRuntimeMessages(UpdateConfirmTransactionDialogPendingTransactions)

// Simulation-state updates the background sent to the confirmation popup, in sending order.
export const getSentConfirmTransactionDialogUpdates = () => parseSentRuntimeMessages(UpdateConfirmTransactionDialog)

// The fields the tests read from messages the background posts to website ports.
const ForwardToSignerMessage = funtypes.ReadonlyObject({ type: funtypes.Literal('forwardToSigner') })
const ForwardedSignerRequest = funtypes.ReadonlyObject({
	type: funtypes.Literal('forwardToSigner'),
	method: funtypes.String,
	params: funtypes.ReadonlyArray(funtypes.Unknown),
})
const WebsiteReplyError = funtypes.ReadonlyObject({ code: funtypes.Number, message: funtypes.String })
const WebsiteReply = funtypes.ReadonlyObject({ requestId: funtypes.Number }).And(funtypes.ReadonlyPartial({
	type: funtypes.String,
	method: funtypes.String,
	result: funtypes.Unknown,
	error: WebsiteReplyError,
}))
type WebsiteReply = funtypes.Static<typeof WebsiteReply>
const WebsiteMethodMessage = funtypes.ReadonlyObject({ method: funtypes.String })

export const isForwardedSignerRequest = (message: unknown) => ForwardToSignerMessage.safeParse(message).success

export const hasForwardedSignerRequest = (postedMessages: readonly unknown[]) => postedMessages.some(isForwardedSignerRequest)

// The first request the background forwarded to the wallet through a website port.
export function requireForwardedSignerRequest(postedMessages: readonly unknown[], description: string) {
	const signerRequest = ForwardedSignerRequest.safeParse(postedMessages.find(isForwardedSignerRequest))
	if (!signerRequest.success) throw new Error(`Missing ${ description }`)
	return signerRequest.value
}

export const isPostedMethod = (message: unknown, method: string) => {
	const parsed = WebsiteMethodMessage.safeParse(message)
	return parsed.success && parsed.value.method === method
}

export const findPostedMessageWithMethod = (postedMessages: readonly unknown[], method: string) => postedMessages.find((message) => isPostedMethod(message, method))

export const hasPostedMethod = (postedMessages: readonly unknown[], method: string) => findPostedMessageWithMethod(postedMessages, method) !== undefined

// The SafeTx fields the tests read from the EIP-712 JSON forwarded to the wallet; chain ids may be encoded as JSON numbers or strings.
const ForwardedSafeTxTypedData = funtypes.ReadonlyObject({
	primaryType: funtypes.String,
	domain: funtypes.ReadonlyObject({ chainId: funtypes.Union(funtypes.String, funtypes.Number), verifyingContract: funtypes.String }),
	message: funtypes.ReadonlyObject({ to: funtypes.String }),
})

export function parseForwardedSafeTxTypedData(typedDataJson: unknown) {
	if (typeof typedDataJson !== 'string') throw new Error('Forwarded EIP-712 typed data is not a JSON string')
	const typedData: unknown = JSON.parse(typedDataJson)
	return ForwardedSafeTxTypedData.parse(typedData)
}

function parseWebsiteReply(message: unknown): WebsiteReply | undefined {
	const parsed = WebsiteReply.safeParse(message)
	return parsed.success ? parsed.value : undefined
}

type WebsiteReplyMatch = {
	readonly requestId: number
	readonly method?: string
	readonly type?: string
}

const matchesWebsiteReply = (reply: WebsiteReply, match: WebsiteReplyMatch) => reply.requestId === match.requestId
	&& (match.method === undefined || reply.method === match.method)
	&& (match.type === undefined || reply.type === match.type)

export const findWebsiteReplies = (postedMessages: readonly unknown[], match: WebsiteReplyMatch) => postedMessages.flatMap((message) => {
	const reply = parseWebsiteReply(message)
	return reply !== undefined && matchesWebsiteReply(reply, match) ? [reply] : []
})

// The reply the website received for one request, for example the dapp's transaction hash or signature.
export function requireWebsiteReply(postedMessages: readonly unknown[], match: WebsiteReplyMatch, description: string) {
	return requireDefined(findWebsiteReplies(postedMessages, match)[0], description)
}

// A rejection or error reply the background posted to a website.
export function requireWebsiteErrorReply(message: unknown, description: string) {
	const reply = parseWebsiteReply(message)
	if (reply?.error === undefined) throw new Error(`Missing ${ description }`)
	return { ...reply, error: reply.error }
}

const createSenderTab = (tabId: number): browser.tabs.Tab => ({ id: tabId, index: 0, windowId: BROWSING_WINDOW_ID, active: true, highlighted: false, pinned: false, incognito: false })

// A website content-script port: it records what the background posts and reports the tab and frame it belongs to.
export function createWebsitePort(socket: WebsiteSocket, frameId: number, onPostMessage?: (message: unknown) => void) {
	return createMockPort({ name: `0x${ socket.connectionName.toString(16) }`, sender: { tab: createSenderTab(socket.tabId), frameId }, onPostMessage })
}

// A port that records posted messages without belonging to a particular website frame.
export const createRecordingPort = (onPostMessage?: (message: unknown) => void) => createMockPort({ name: 'recording-test-port', onPostMessage })

// A port whose website already went away: every post throws like Chrome's disconnected port, and the attempts are counted.
export function createDisconnectedPort() {
	const mockPort = createMockPort({ name: 'disconnected-test-port' })
	mockPort.disconnectFromOtherEnd()
	let postAttempts = 0
	const postMessage = mockPort.port.postMessage
	mockPort.port.postMessage = (message) => {
		postAttempts += 1
		postMessage(message)
	}
	return { port: mockPort.port, getPostAttempts: () => postAttempts }
}

// The approved connection the background keeps for one website socket.
export function createTabConnection(port: browser.runtime.Port, { socket = uniqueRequestIdentifier.requestSocket, websiteOrigin = 'https://example.com', signerStateOwner }: { readonly socket?: WebsiteSocket, readonly websiteOrigin?: string, readonly signerStateOwner?: SignerStateOwner } = {}): TabConnection {
	return {
		signerStateOwner,
		connections: { [modules.websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true } },
	}
}

export function createWebsiteTabConnections(port: browser.runtime.Port, options: { readonly socket?: WebsiteSocket, readonly websiteOrigin?: string, readonly signerStateOwner?: SignerStateOwner } = {}): WebsiteTabConnections {
	const socket = options.socket ?? uniqueRequestIdentifier.requestSocket
	return new Map([[socket.tabId, createTabConnection(port, options)]])
}

// A signer state owner whose wallet connection the website already confirmed.
export const createConfirmedSignerStateOwner = (socket: WebsiteSocket, generation: number, providerGeneration: number): SignerStateOwner => ({
	connectionName: socket.connectionName,
	confirmed: true,
	generation,
	providerGeneration,
})

type WebsiteConnectionOptions = {
	readonly socket?: WebsiteSocket
	readonly frameId?: number
	readonly websiteOrigin?: string
	readonly signerStateOwner?: SignerStateOwner
	readonly onPostMessage?: (message: unknown) => void
}

// Connects one approved website socket and returns its port, the messages the background posts to it, and the connection map the background reads.
export function connectWebsite({ socket = uniqueRequestIdentifier.requestSocket, frameId = 0, websiteOrigin = 'https://example.com', signerStateOwner, onPostMessage }: WebsiteConnectionOptions = {}) {
	const websitePort = createWebsitePort(socket, frameId, onPostMessage)
	return {
		port: websitePort.port,
		postedMessages: websitePort.postedMessages,
		websiteTabConnections: createWebsiteTabConnections(websitePort.port, { socket, websiteOrigin, signerStateOwner }),
	}
}

// The provider request a website sent with these JSON-RPC parameters. InterceptedRequest types params as a mutable unknown[], so the parsed readonly params are copied.
export const createInterceptedRequest = (parameters: { readonly method: string, readonly params: readonly unknown[] }, requestIdentifier: UniqueRequestIdentifier = uniqueRequestIdentifier) => ({
	interceptorRequest: true,
	usingInterceptorWithoutSigner: false,
	uniqueRequestIdentifier: requestIdentifier,
	method: parameters.method,
	params: [...parameters.params],
}) satisfies InterceptedRequest

async function loadModules() {
	const [
		ethereumClientService,
		priceEstimator,
		simulationModeEthereumClientService,
		settings,
		popupMessageHandlers,
		confirmTransaction,
		storageVariables,
		storageUtils,
		backgroundUtils,
		wireTypes,
		ethSimulateTypes,
		pendingTerminalReplies,
		terminalReplyDelivery,
		providerMessageHandlers,
		safeExecutionRouting,
		safeConfirmationResolver,
		safeSimulation,
		safeCore,
		safeConfirmationPersistence,
		simulationUpdating,
	] = await Promise.all([
		import('../../app/ts/simulation/services/EthereumClientService.js'),
		import('../../app/ts/simulation/services/priceEstimator.js'),
		import('../../app/ts/simulation/services/SimulationModeEthereumClientService.js'),
		import('../../app/ts/background/settings.js'),
		importAllPopupMessageHandlers(),
		import('../../app/ts/background/windows/confirmTransaction.js'),
		import('../../app/ts/background/storageVariables.js'),
		import('../../app/ts/utils/storageUtils.js'),
		import('../../app/ts/background/backgroundUtils.js'),
		import('../../app/ts/types/wire-types.js'),
		import('../../app/ts/types/ethSimulate-types.js'),
		import('../../app/ts/background/pendingTerminalReplies.js'),
		import('../../app/ts/background/terminalReplyDelivery.js'),
		import('../../app/ts/background/providerMessageHandlers.js'),
		import('../../app/ts/safe/safeExecutionRouting.js'),
		import('../../app/ts/background/safeConfirmationResolver.js'),
		import('../../app/ts/safe/safeSimulation.js'),
		import('../../app/ts/safe/safeCore.js'),
		import('../../app/ts/background/safeConfirmationPersistence.js'),
		import('../../app/ts/background/simulationUpdating.js'),
	])
	// Typed through a static type import because knip does not count members read from a dynamically imported module as uses of an export that only these suites call.
	const flushPendingTerminalRepliesForSocket: typeof FlushPendingTerminalRepliesForSocket = terminalReplyDelivery.flushPendingTerminalRepliesForSocket

	return {
		EthereumClientService: ethereumClientService.EthereumClientService,
		TokenPriceService: priceEstimator.TokenPriceService,
		mockSignTransaction: simulationModeEthereumClientService.mockSignTransaction,
		defaultActiveAddresses: settings.defaultActiveAddresses,
		changeSimulationMode: settings.changeSimulationMode,
		getSettings: settings.getSettings,
		refreshPopupConfirmTransactionSimulation: popupMessageHandlers.refreshPopupConfirmTransactionSimulation,
		refreshPopupConfirmTransactionMetadata: popupMessageHandlers.refreshPopupConfirmTransactionMetadata,
		confirmDialog: popupMessageHandlers.confirmDialog,
		getSafeSignerSelectionFromAccountRefresh: popupMessageHandlers.getSafeSignerSelectionFromAccountRefresh,
		importSafeStack: popupMessageHandlers.importSafeStack,
		requestSafeStackExport: popupMessageHandlers.requestSafeStackExport,
		setSafeSimulationSigner: popupMessageHandlers.setSafeSimulationSigner,
		fetchSimulationStackRequestConfirmation: popupMessageHandlers.fetchSimulationStackRequestConfirmation,
		resolvePendingTransactionOrMessage: confirmTransaction.resolvePendingTransactionOrMessage,
		getReviewRevision: confirmTransaction.getReviewRevision,
		updateConfirmTransactionView: confirmTransaction.updateConfirmTransactionView,
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
		createSafeSigningSimulationInput: safeSimulation.createSafeSigningSimulationInput,
		createSafeContractValidationFailure: safeCore.createSafeContractValidationFailure,
		resolveSafeSignerReply: safeConfirmationPersistence.resolveSafeSignerReply,
		getCurrentSimulationInput: simulationUpdating.getCurrentSimulationInput,
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
		browserStorageLocalSet: storageUtils.browserStorageLocalSet,
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

function makeFakeEthSimulateResult(multicallBalance: bigint, callCount = 1) {
	const balanceResult = encodeFunctionReturn(Multicall3ABI, 'getEthBalance', [multicallBalance])
	const aggregate3Result = encodeFunctionReturn(Multicall3ABI, 'aggregate3', [[{ success: true, returnData: balanceResult }]])
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
} satisfies RpcEntry

const fakeBlock = makeFakeBlock()
const safeSelectors = {
	messageHash: encodeFunctionCall(SAFE_MESSAGE_ABI, 'getMessageHash', ['0x']).slice(0, 10),
	messageSignature: encodeFunctionCall(SAFE_MESSAGE_ABI, 'isValidSignature', [`0x${ '00'.repeat(32) }`, '0x']).slice(0, 10),
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

// What the fake RPC answers for the active Gnosis Safe contract; tests change it to model on-chain Safe state and RPC failures.
type FakeSafeContractState = {
	version: string
	nonce: bigint
	threshold: bigint
	owners: bigint[]
	transactionHash: bigint
	messageHash: bigint
	messageSignatureValid: boolean
	ownerCode: string
	requestedCodeAddresses: bigint[]
	beforeVersionResponse: (() => Promise<void>) | undefined
	requestedRpcMethods: string[]
	failEthSimulate: boolean
	safeOwnerLookupFailure: 'expected' | 'unexpected' | undefined
}

const createFakeSafeContractState = (): FakeSafeContractState => ({
	version: '1.4.1',
	nonce: 0n,
	threshold: 2n,
	owners: [],
	transactionHash: 0n,
	messageHash: 0n,
	messageSignatureValid: true,
	ownerCode: '0x',
	requestedCodeAddresses: [],
	beforeVersionResponse: undefined,
	requestedRpcMethods: [],
	failEthSimulate: false,
	safeOwnerLookupFailure: undefined,
})

export const fakeSafeContract = createFakeSafeContractState()

export function resetFakeSafeContractState() {
	Object.assign(fakeSafeContract, createFakeSafeContractState())
}

async function answerSafeContractCall(rpcRequest: Extract<EthereumJsonRpcRequest, { readonly method: 'eth_call' }>) {
	const callData = rpcRequest.params[0].data
	if (callData === undefined) throw new Error('Malformed test eth_call')
	const selector = `0x${ Buffer.from(callData).toString('hex').slice(0, 8) }`
	switch (selector) {
		case safeSelectors.version:
			await fakeSafeContract.beforeVersionResponse?.()
			return encodeFunctionReturn(SAFE_ABI, 'VERSION', [fakeSafeContract.version])
		case safeSelectors.nonce: return encodeFunctionReturn(SAFE_ABI, 'nonce', [fakeSafeContract.nonce])
		case safeSelectors.owners:
			if (fakeSafeContract.safeOwnerLookupFailure === 'expected') throw modules.createSafeContractValidationFailure('Safe owner lookup unavailable')
			if (fakeSafeContract.safeOwnerLookupFailure === 'unexpected') throw new Error('Unexpected Safe owner decoder failure')
			return encodeFunctionReturn(SAFE_ABI, 'getOwners', [fakeSafeContract.owners.map(addressString)])
		case safeSelectors.threshold: return encodeFunctionReturn(SAFE_ABI, 'getThreshold', [fakeSafeContract.threshold])
		case safeSelectors.messageHash: return encodeFunctionReturn(SAFE_MESSAGE_ABI, 'getMessageHash', [bytes32String(fakeSafeContract.messageHash)])
		case safeSelectors.messageSignature: return encodeFunctionReturn(SAFE_MESSAGE_ABI, 'isValidSignature', [fakeSafeContract.messageSignatureValid ? '0x1626ba7e' : '0xffffffff'])
		case safeSelectors.transactionHash: return encodeFunctionReturn(SAFE_ABI, 'getTransactionHash', [bytes32String(fakeSafeContract.transactionHash)])
		default: throw new Error(`Unexpected eth_call selector: ${ selector }`)
	}
}

function answerCodeRequest(requestedAddress: bigint) {
	fakeSafeContract.requestedCodeAddresses.push(requestedAddress)
	if (requestedAddress === SAFE_MULTI_SEND_CALL_ONLY) return multiSendLibrary.deployedBytecode
	if (requestedAddress === SAFE_SIGN_MESSAGE_LIB) return signMessageLibrary.deployedBytecode
	return requestedAddress === activeAddress ? '0x01' : fakeSafeContract.ownerCode
}

const fakeRequestHandler: IEthereumJSONRpcRequestHandler = {
	rpcUrl: fakeRpcNetwork.httpsRpc,
	clearCache() { return undefined },
	getChainId: async () => fakeRpcNetwork.chainId,
	async jsonRpcRequest(rpcRequest: EthereumJsonRpcRequest) {
		fakeSafeContract.requestedRpcMethods.push(rpcRequest.method)
		switch (rpcRequest.method) {
			case 'eth_getBlockByNumber': return modules.EthereumBlockHeader.serialize(fakeBlock)
			case 'eth_getTransactionCount': return modules.serialize(modules.EthereumQuantity, 0n)
			case 'eth_getBalance': return modules.serialize(modules.EthereumQuantity, 0n)
			case 'eth_blockNumber': return modules.serialize(modules.EthereumQuantity, 123n)
			case 'eth_getCode': return answerCodeRequest(rpcRequest.params[0])
			case 'eth_gasPrice': return modules.serialize(modules.EthereumQuantity, 1n)
			case 'eth_call': return await answerSafeContractCall(rpcRequest)
			case 'eth_simulateV1':
				if (fakeSafeContract.failEthSimulate) throw new Error('eth_simulateV1 unavailable')
				return modules.EthSimulateV1Result.serialize(rpcRequest.params[0].blockStateCalls.map((blockStateCall) => makeFakeEthSimulateResult(0n, blockStateCall.calls.length)))
			default: throw new Error(`Unexpected RPC method: ${ rpcRequest.method }`)
		}
	},
}
export const ethereum = new modules.EthereumClientService(fakeRequestHandler, async () => undefined, async () => undefined, fakeRpcNetwork)
export const simulator = {
	ethereum,
	tokenPriceService: new modules.TokenPriceService(ethereum, 60_000),
}

export const activeAddress = requireDefined(modules.defaultActiveAddresses[0]?.address, 'default active address')
export const recipientAddress = requireDefined(modules.defaultActiveAddresses[1]?.address, 'default recipient address')

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
export const signedTransaction = modules.mockSignTransaction(unsignedTransaction)
export const created = new Date('2024-01-01T00:00:00.000Z')
export const oldTimestamp = new Date('2024-01-01T00:00:00.000Z')
export const uniqueRequestIdentifier = { requestId: 1, requestSocket: { tabId: 1, connectionName: 0n } } satisfies UniqueRequestIdentifier
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

// A Gnosis Safe transaction from the active Safe to the recipient, as a website would propose it.
export const createSafeTxToRecipient = ({ nonce = 0n, value = 0n, input = new Uint8Array() }: { readonly nonce?: bigint, readonly value?: bigint, readonly input?: Uint8Array } = {}) => createSafeTx(fakeRpcNetwork.chainId, activeAddress, { to: recipientAddress, value, input }, nonce)

const transactionToSimulate = {
	website: { websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
	created,
	originalRequestParameters: {
		method: 'eth_sendTransaction',
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
	success: true,
	transaction: unsignedTransaction,
} satisfies WebsiteCreatedEthereumTransaction

export const popupVisualisation = {
	statusCode: 'success',
	data: {
		activeAddress,
		simulationMode: true,
		simulationStartedTimestamp: created,
		uniqueRequestIdentifier,
		transactionToSimulate,
		signerName: 'NoSignerDetected',
		addressBookEntries: [],
		tokenPriceEstimates: [],
		namedTokenIds: [],
		simulationState: {
			success: true,
			simulationStateInput: [],
			simulatedBlocks: [],
			blockNumber: 123n,
			blockTimestamp: oldTimestamp,
			baseFeePerGas: 0n,
			simulationConductedTimestamp: oldTimestamp,
			rpcNetwork: fakeRpcNetwork,
		},
		visualizedSimulationState: { success: true, visualizedBlocks: [] },
	},
} satisfies ConfirmTransactionTransactionSingleVisualization

export const pendingTransaction = {
	type: 'Transaction',
	popupOrTabId: { type: 'popup', id: 1 },
	originalRequestParameters: transactionToSimulate.originalRequestParameters,
	uniqueRequestIdentifier,
	simulationMode: true,
	activeAddress,
	created,
	transactionIdentifier: 1n,
	website: transactionToSimulate.website,
	approvalStatus: { status: 'WaitingForUser' },
	popupVisualisation,
	transactionOrMessageCreationStatus: 'Simulated',
	transactionToSimulate,
} satisfies SimulatedPendingTransaction

// A website's request to sign the SafeTx typed data with signingAccount; it is a Safe co-signing request when signingAccount is the active Safe.
export const createSafeTxSignRequest = (safeTx: ReturnType<typeof createSafeTx>, { signingAccount = activeAddress, method = 'eth_signTypedData_v4' }: { readonly signingAccount?: bigint, readonly method?: 'eth_signTypedData_v3' | 'eth_signTypedData_v4' } = {}) => ({
	method,
	params: [signingAccount, EIP712Message.parse(safeTxToTypedDataJson(safeTx))] as const,
})

type SafeTransactionRequestOptions = {
	readonly safeTx?: ReturnType<typeof createSafeTx>
	readonly safeSignerAddress?: bigint
	readonly threshold?: bigint
	// The owners the user reviewed; adds the reviewed Safe state snapshot that signer refreshes and signer replies compare with the live Safe.
	readonly reviewedOwners?: readonly bigint[]
	readonly reviewedNonce?: bigint
	readonly executionGasLimit?: bigint
}

// The active Safe's signing request for safeTx, owned by safeSignerAddress, as a reviewed confirmation stores it.
export function createSafeTransactionRequest({ safeTx = createSafeTxToRecipient(), safeSignerAddress = recipientAddress, threshold = 2n, reviewedOwners, reviewedNonce = 0n, executionGasLimit }: SafeTransactionRequestOptions = {}): SafeTransactionSigningRequest {
	return {
		safeAddress: activeAddress,
		safeSignerAddress,
		safeVersion: '1.4.1',
		threshold,
		...(reviewedOwners === undefined ? {} : { reviewedSafeState: { version: '1.4.1', nonce: reviewedNonce, owners: reviewedOwners, threshold } }),
		safeTxHash: BigInt(getSafeTxHash(safeTx)),
		safeTx,
		...(executionGasLimit === undefined ? {} : { executionGasLimit }),
	}
}

// The pending transaction fixture as a signing-mode Gnosis Safe proposal in the confirmation dialog.
export const createPendingSafeProposal = (safeTransaction: SafeTransactionSigningRequest, approvalStatus: { readonly status: 'WaitingForUser' | 'WaitingForSigner' } = { status: 'WaitingForUser' }) => ({
	...pendingTransaction,
	simulationMode: false,
	approvalStatus,
	safeTransaction,
}) satisfies SimulatedPendingTransaction

// The wallet's successful eth_accounts reply that a website's content script relays to the background.
export const createEthAccountsReply = (accounts: readonly bigint[]) => createInterceptedRequest({
	method: 'eth_accounts_reply',
	params: [{ signerProviderGeneration: 1, type: 'success', accounts: accounts.map(addressString), requestAccounts: false }],
})

// Records the accounts the website's wallet exposes, as its eth_accounts replies would; the first account is the wallet-selected signer.
export async function setWalletAccounts(accounts: readonly bigint[], walletState: Partial<Pick<TabState, 'signerName' | 'signerChain'>> = {}) {
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		...walletState,
		signerAccounts: accounts,
		activeSigningAddress: accounts[0],
	}))
}

// Switches the extension to signing mode with the active Gnosis Safe as the signing account.
export async function enableSafeSigningMode() {
	await modules.changeSimulationMode({ simulationMode: false, rpcNetwork: fakeRpcNetwork, activeSigningSafeAddress: activeAddress })
}

// Runs action while the fake Safe's getOwners call fails, either as an expected contract-validation failure or as an unexpected decoder error.
export async function withSafeOwnerLookupFailure<T>(failure: 'expected' | 'unexpected', action: () => Promise<T>) {
	fakeSafeContract.safeOwnerLookupFailure = failure
	try {
		return await action()
	} finally {
		fakeSafeContract.safeOwnerLookupFailure = undefined
	}
}

type ConfirmationOptions = {
	readonly simulationMode?: boolean
	readonly signingAddress?: bigint
}

// Opens the confirmation dialog for a website's signing request, as the background does when the request arrives.
export async function openMessageConfirmation(parameters: SignMessageParams, website: Website, websiteTabConnections: WebsiteTabConnections, { simulationMode = false, signingAddress = activeAddress }: ConfirmationOptions = {}) {
	return await modules.openConfirmTransactionDialogForMessage(simulator.ethereum, simulator.tokenPriceService, createInterceptedRequest(parameters), { kind: 'message', parameters }, simulationMode, signingAddress, website, websiteTabConnections)
}

// Opens the confirmation dialog for a website's eth_sendTransaction request, as the background does when the request arrives.
export async function openTransactionConfirmation(parameters: SendTransactionParams, website: Website, websiteTabConnections: WebsiteTabConnections, { simulationMode = false, signingAddress = activeAddress }: ConfirmationOptions = {}) {
	return await modules.openConfirmTransactionDialogForTransaction(simulator.ethereum, simulator.tokenPriceService, createInterceptedRequest(parameters), { kind: 'transaction', parameters }, simulationMode, signingAddress, website, websiteTabConnections)
}

export const acceptConfirmation = { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier } } as const

export async function resetConfirmTransactionTestState() {
	reinstallBrowserMock()
	resetFakeSafeContractState()
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [pendingTransaction] })
	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
}

export async function waitForPendingTransactionsToClear() {
	await waitFor(async () => (await modules.getPendingTransactionsAndMessages()).length === 0, { timeoutMs: 2_000, intervalMs: 10, description: 'the pending popup-close retry' })
}

export { addressString, createSafeTx, EIP712Message, getSafeTxHash, privateKeyToAccount, SAFE_EXECUTION_ABI, safeTxToTypedDataJson, withSilencedConsole }
