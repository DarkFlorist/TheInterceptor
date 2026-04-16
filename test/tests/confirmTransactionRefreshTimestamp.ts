// @ts-nocheck
import * as assert from 'assert'
import type { MainOrConfirmUiRole } from '../../app/ts/messages/ui.js'
import { Interface } from 'ethers'
import { run, runIfRoot, should } from '../micro-should.js'

type RuntimeMessage = {
	role?: string
	method?: string
	type?: string
	data?: unknown
}

function createBrowserMock() {
	const storageState: Record<string, unknown> = {}
	const sentMessages: RuntimeMessage[] = []

	const getItems = (keys?: string | string[] | Record<string, unknown> | null) => {
		if (keys === undefined || keys === null) return { ...storageState }
		if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, storageState[key]]))
		if (typeof keys === 'string') return { [keys]: storageState[keys] }
		return Object.fromEntries(Object.entries(keys).map(([key, defaultValue]) => [key, key in storageState ? storageState[key] : defaultValue]))
	}

	const removeItems = (keys: string | string[]) => {
		const entries = Array.isArray(keys) ? keys : [keys]
		for (const key of entries) delete storageState[key]
	}

	// @ts-expect-error test shim intentionally overrides extension globals
	globalThis.browser = {
		runtime: {
			lastError: null,
			async sendMessage() { return undefined },
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
	// @ts-expect-error test shim intentionally overrides extension globals
	globalThis.chrome = { runtime: { id: 'test-extension' } }

	return {
		sentMessages,
		storageState,
		async attachUiSession(role: MainOrConfirmUiRole) {
			const { registerUiPort } = await import('../../app/ts/background/uiSessions.js')
			const { getUiPortName } = await import('../../app/ts/messages/ui.js')
			const { MessageToPopup } = await import('../../app/ts/types/interceptor-messages.js')
			const port = {
				name: getUiPortName(role),
				postMessage(message: unknown) {
					if (typeof message !== 'object' || message === null || !('kind' in message) || message.kind !== 'event') return
					if (!('payload' in message) || typeof message.payload !== 'object' || message.payload === null) return
					const { payload } = message
					if (!('role' in payload) || typeof payload.role !== 'string' || !('message' in payload) || typeof payload.message !== 'object' || payload.message === null) return
					const maybePopupMessage = MessageToPopup.safeParse({ role: payload.role, ...payload.message })
					if (!maybePopupMessage.success) return
					sentMessages.push(maybePopupMessage.value)
				},
				onDisconnect: { addListener: () => undefined, removeListener: () => undefined },
				onMessage: { addListener: () => undefined, removeListener: () => undefined },
				disconnect() {},
			} as unknown as browser.runtime.Port
			registerUiPort(port)
		},
		reset() {
			for (const key of Object.keys(storageState)) delete storageState[key]
			sentMessages.length = 0
			// @ts-expect-error test shim intentionally overrides extension globals
			globalThis.browser.runtime.lastError = undefined
		},
	}
}

async function loadModules() {
	const [
		simulationModeEthereumClientService,
		constants,
		settings,
		popupMessageHandlers,
		storageVariables,
		storageUtils,
		wireTypes,
		ethSimulateTypes,
	] = await Promise.all([
		import('../../app/ts/simulation/services/SimulationModeEthereumClientService.js'),
		import('../../app/ts/utils/constants.js'),
		import('../../app/ts/background/settings.js'),
		import('../../app/ts/background/popupMessageHandlers.js'),
		import('../../app/ts/background/storageVariables.js'),
		import('../../app/ts/utils/storageUtils.js'),
		import('../../app/ts/types/wire-types.js'),
		import('../../app/ts/types/ethSimulate-types.js'),
	])

	return {
		EthereumClientService: simulationModeEthereumClientService.EthereumClientService,
		mockSignTransaction: simulationModeEthereumClientService.mockSignTransaction,
		Multicall3ABI: constants.Multicall3ABI,
		defaultActiveAddresses: settings.defaultActiveAddresses,
		refreshPopupConfirmTransactionSimulation: popupMessageHandlers.refreshPopupConfirmTransactionSimulation,
		getPendingTransactionsAndMessages: storageVariables.getPendingTransactionsAndMessages,
		updateInterceptorTransactionStack: storageVariables.updateInterceptorTransactionStack,
		browserStorageLocalSet2: storageUtils.browserStorageLocalSet2,
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

function makeFakeEthSimulateResult(multicallBalance: bigint, multicallAbi: readonly string[]) {
	const multicallInterface = new Interface(multicallAbi)
	const balanceResult = multicallInterface.encodeFunctionResult('getEthBalance', [multicallBalance])
	const aggregate3Result = multicallInterface.encodeFunctionResult('aggregate3', [[{ success: true, returnData: balanceResult }]])
	return {
		number: 123n,
		hash: 0x9876n,
		timestamp: 0x65920080n,
		gasLimit: 30_000_000n,
		gasUsed: 21_000n,
		baseFeePerGas: 1n,
		calls: [{
			status: '0x1' as const,
			gasUsed: 21_000n,
			logs: [],
			returnData: aggregate3Result,
		}],
	}
}

async function main() {
	const browserMock = createBrowserMock()
	await browserMock.attachUiSession('confirmTransaction')
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
		clearCache() {},
		async jsonRpcRequest(rpcRequest: { method: string, params?: readonly unknown[] }) {
			switch (rpcRequest.method) {
				case 'eth_getBlockByNumber':
					return modules.serialize(modules.EthereumBlockHeader, fakeBlock)
				case 'eth_getTransactionCount':
					return modules.serialize(modules.EthereumQuantity, 0n)
				case 'eth_getBalance':
					return modules.serialize(modules.EthereumQuantity, 0n)
				case 'eth_getCode':
					return '0x'
				case 'eth_gasPrice':
					return modules.serialize(modules.EthereumQuantity, 1n)
				case 'eth_simulateV1':
					return modules.serialize(modules.EthSimulateV1Result, [makeFakeEthSimulateResult(0n, modules.Multicall3ABI)])
				default:
					throw new Error(`Unexpected RPC method: ${ rpcRequest.method }`)
			}
		},
	}
	const ethereum = new modules.EthereumClientService(fakeRequestHandler, async () => undefined, async () => undefined, fakeRpcNetwork)
	const simulator = {
		ethereum,
		tokenPriceService: {
			estimateEthereumPricesForTokens: async () => [],
		},
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
				transaction: signedTransaction,
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

	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
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
		}],
	})

	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))

	should('refreshing confirm transaction updates the persisted simulation timestamp', async () => {
		browserMock.sentMessages.length = 0
		// @ts-expect-error test shim uses a minimal simulator object
		await modules.refreshPopupConfirmTransactionSimulation(simulator)
		const [pendingTransaction] = await modules.getPendingTransactionsAndMessages()
		if (pendingTransaction === undefined || pendingTransaction.type !== 'Transaction') throw new Error('missing refreshed pending transaction')
		if (pendingTransaction.popupVisualisation.statusCode !== 'success') throw new Error('unexpected popup visualisation state')
		const refreshedTimestamp = pendingTransaction.popupVisualisation.data.simulationState.simulationConductedTimestamp
		assert.ok(refreshedTimestamp.getTime() > oldTimestamp.getTime())
		assert.equal(browserMock.sentMessages.some((message) => message.method === 'popup_update_confirm_transaction_dialog_pending_transactions'), true)
	})

	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
}

await runIfRoot(async () => {
	await main()
	await run()
}, import.meta)
