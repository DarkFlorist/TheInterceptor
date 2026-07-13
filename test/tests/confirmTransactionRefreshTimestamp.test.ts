import * as assert from 'assert'
import { test } from 'bun:test'
import { encodeFunctionReturn } from '../../app/ts/utils/abiRuntime.js'

type RuntimeMessage = {
	method?: string
	type?: string
	data?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}

const hexToBytes = (hex: string) => Uint8Array.from(Buffer.from(hex.slice(2), 'hex'))

function createBrowserMock() {
	const storageState: Record<string, unknown> = {}
	const sentMessages: RuntimeMessage[] = []

	const getItems = (keys?: string | string[] | Record<string, unknown> | null) => {
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
			getManifest: () => ({ manifest_version: 3 }),
			onMessage: { addListener: () => undefined, removeListener: () => undefined },
			onConnect: { addListener: () => undefined, removeListener: () => undefined },
		},
		storage: {
			local: {
				async get(keys?: string | string[] | Record<string, unknown> | null) { return getItems(keys) },
				async set(items: Record<string, unknown>) { Object.assign(storageState, items) },
				async remove(keys: string | string[]) { removeItems(keys) },
			},
		},
		tabs: {
			async query() { return [] },
			async get() { return undefined },
			async update() { return undefined },
			onUpdated: { addListener: () => undefined, removeListener: () => undefined },
			onRemoved: { addListener: () => undefined, removeListener: () => undefined },
		},
		windows: {
			async get() { return undefined },
			async update() { return undefined },
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

	return {
		sentMessages,
		storageState,
		reset() {
			for (const key of Object.keys(storageState)) delete storageState[key]
			sentMessages.length = 0
			browser.runtime.lastError = undefined
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
	])

	return {
		EthereumClientService: ethereumClientService.EthereumClientService,
		TokenPriceService: priceEstimator.TokenPriceService,
		mockSignTransaction: simulationModeEthereumClientService.mockSignTransaction,
		Multicall3ABI: constants.Multicall3ABI,
		defaultActiveAddresses: settings.defaultActiveAddresses,
		refreshPopupConfirmTransactionSimulation: popupMessageHandlers.refreshPopupConfirmTransactionSimulation,
		resolvePendingTransactionOrMessage: confirmTransaction.resolvePendingTransactionOrMessage,
		getPendingTransactionsAndMessages: storageVariables.getPendingTransactionsAndMessages,
		updateInterceptorTransactionStack: storageVariables.updateInterceptorTransactionStack,
		browserStorageLocalSet2: storageUtils.browserStorageLocalSet2,
		websiteSocketToString: backgroundUtils.websiteSocketToString,
		serialize: wireTypes.serialize,
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

const fakeBlock = makeFakeBlock()
const fakeRequestHandler = {
	rpcUrl: fakeRpcNetwork.httpsRpc,
	clearCache() { return undefined },
	async jsonRpcRequest(rpcRequest: { method: string, params?: readonly unknown[] }) {
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
				return '0x'
			case 'eth_gasPrice':
				return modules.serialize(modules.EthereumQuantity, 1n)
			case 'eth_simulateV1':
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

await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
