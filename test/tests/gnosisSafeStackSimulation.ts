// @ts-nocheck
import * as assert from 'assert'
import { describe, run, runIfRoot, should } from '../micro-should.js'

type RuntimeMessage = {
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

	globalThis.browser = {
		runtime: {
			lastError: null,
			async sendMessage(message: RuntimeMessage) {
				sentMessages.push(message)
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
				async remove(keys: string | string[]) {
					const entries = Array.isArray(keys) ? keys : [keys]
					for (const key of entries) delete storageState[key]
				},
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
	globalThis.chrome = { runtime: { id: 'test-extension' } }

	return {
		sentMessages,
		async reset() {
			for (const key of Object.keys(storageState)) delete storageState[key]
			sentMessages.length = 0
			globalThis.browser.runtime.lastError = undefined
		},
	}
}

async function loadModules() {
	const [
		simulationUpdating,
		simulationModeEthereumClientService,
		storageVariables,
		storageUtils,
		settings,
		wireTypes,
		ethSimulateTypes,
	] = await Promise.all([
		import('../../app/ts/background/simulationUpdating.js'),
		import('../../app/ts/simulation/services/SimulationModeEthereumClientService.js'),
		import('../../app/ts/background/storageVariables.js'),
		import('../../app/ts/utils/storageUtils.js'),
		import('../../app/ts/background/settings.js'),
		import('../../app/ts/types/wire-types.js'),
		import('../../app/ts/types/ethSimulate-types.js'),
	])

	return {
		...simulationUpdating,
		EthereumClientService: simulationModeEthereumClientService.EthereumClientService,
		mockSignTransaction: simulationModeEthereumClientService.mockSignTransaction,
		updateInterceptorTransactionStack: storageVariables.updateInterceptorTransactionStack,
		browserStorageLocalSet: storageUtils.browserStorageLocalSet,
		defaultActiveAddresses: settings.defaultActiveAddresses,
		defaultRpcs: settings.defaultRpcs,
		serialize: wireTypes.serialize,
		EthereumBlockHeader: wireTypes.EthereumBlockHeader,
		EthereumQuantity: wireTypes.EthereumQuantity,
		EthSimulateV1Result: ethSimulateTypes.EthSimulateV1Result,
	}
}

function makeFakeBlock(number: bigint) {
	return {
		author: 0n,
		difficulty: 0n,
		extraData: new Uint8Array(),
		gasLimit: 30_000_000n,
		gasUsed: 21_000n,
		hash: 0x1000n + number,
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

function makeEthSimulateBlocks(serialize: (parser: unknown, value: unknown) => unknown, EthSimulateV1Result: unknown, callCount: number) {
	return serialize(EthSimulateV1Result, Array.from({ length: callCount }, (_, index) => ({
		number: 123n + BigInt(index),
		hash: 0x2000n + BigInt(index),
		timestamp: 0x65920080n + BigInt(index),
		gasLimit: 30_000_000n,
		gasUsed: 21_000n,
		baseFeePerGas: 1n,
		calls: [{
			status: 'success',
			returnData: '0x',
			gasUsed: 21_000n,
			logs: [],
		}],
	})))
}

async function main() {
	const browserMock = createBrowserMock()
	const modules = await loadModules()
	const activeAddress = modules.defaultActiveAddresses[0]?.address
	const stackRecipient = modules.defaultActiveAddresses[1]?.address
	if (activeAddress === undefined || stackRecipient === undefined) throw new Error('missing default test addresses')

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

	const fakeBlock = makeFakeBlock(123n)
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
				case 'eth_simulateV1': {
					const callCount = (rpcRequest.params?.[0] as { blockStateCalls?: unknown[] } | undefined)?.blockStateCalls?.length
					if (callCount !== 1 && callCount !== 2) throw new Error(`Unexpected call count: ${ String(callCount) }`)
					return makeEthSimulateBlocks(modules.serialize, modules.EthSimulateV1Result, callCount)
				}
				default:
					throw new Error(`Unexpected RPC method: ${ rpcRequest.method }`)
			}
		},
	}

	const ethereum = new modules.EthereumClientService(fakeRequestHandler, async () => undefined, async () => undefined, fakeRpcNetwork)
	const tokenPriceService = {
		estimateEthereumPricesForTokens: async () => [],
	}

	const currentStackTransaction = modules.mockSignTransaction({
		type: '1559' as const,
		from: activeAddress,
		chainId: fakeRpcNetwork.chainId,
		nonce: 0n,
		maxFeePerGas: 1n,
		maxPriorityFeePerGas: 1n,
		gas: 21_000n,
		to: stackRecipient,
		value: 0n,
		input: new Uint8Array(),
		accessList: [],
	})

	await browserMock.reset()
	await modules.browserStorageLocalSet({
		simulationMode: true,
		activeSimulationAddress: activeAddress,
		activeRpcNetwork: fakeRpcNetwork,
		interceptorTransactionStack: {
			operations: [{
				type: 'Transaction',
				preSimulationTransaction: {
					signedTransaction: currentStackTransaction,
					website: { websiteOrigin: 'https://stack.example', icon: undefined, title: undefined },
					created: new Date('2024-01-01T00:00:00.000Z'),
					originalRequestParameters: { method: 'eth_sendTransaction', params: [{}] },
					transactionIdentifier: 1n,
				},
			}],
		},
	})

	const safeMessage = {
		website: { websiteOrigin: 'https://safe.example', icon: undefined, title: undefined },
		created: new Date('2024-01-01T00:00:01.000Z'),
		originalRequestParameters: { method: 'eth_signTypedData_v4', params: [] },
		request: { uniqueRequestIdentifier: { requestId: 1, requestSocket: { tabId: 1, connectionName: 0n } } },
		simulationMode: true,
		messageIdentifier: 2n,
		method: 'eth_signTypedData_v4',
		type: 'SafeTx',
		message: {
			primaryType: 'SafeTx',
			domain: {
				chainId: fakeRpcNetwork.chainId,
				verifyingContract: activeAddress,
			},
			message: {
				to: stackRecipient,
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
		},
		activeAddress: { address: activeAddress },
		gasToken: { address: 0n },
		to: { address: stackRecipient },
		refundReceiver: { address: 0n },
		verifyingContract: { address: activeAddress },
		parsedMessageData: { input: new Uint8Array() },
		parsedMessageDataAddressBookEntries: [],
		messageHash: '0x1',
		domainHash: '0x2',
		safeTxHash: '0x3',
	} as const

	should('simulates a Safe transaction on top of the existing stack', async () => {
		const simulationInput = await modules.getCurrentSimulationInput()
		assert.equal(simulationInput.length, 1)
		assert.equal(simulationInput[0]?.transactions.length, 1)

		const reply = await modules.simulateGnosisSafeMetaTransaction(safeMessage as never, simulationInput, ethereum, tokenPriceService)
		assert.equal(reply.success, true)
		if (!reply.success) throw new Error(reply.errorMessage)

		assert.equal(reply.result.simulationState.rpcNetwork.chainId, fakeRpcNetwork.chainId)
		assert.equal(reply.result.simulationState.simulationStateInput.length, 2)
		assert.equal(reply.result.simulationState.simulationStateInput[0]?.transactions.length, 1)
		assert.equal(reply.result.simulationState.simulationStateInput[1]?.transactions.length, 1)
		assert.equal(reply.result.visualizedSimulationState.success, true)
		if (!reply.result.visualizedSimulationState.success) throw new Error('unexpected Safe visualization failure')
		assert.equal(reply.result.visualizedSimulationState.visualizedBlocks.length, 2)
		assert.equal(reply.result.visualizedSimulationState.visualizedBlocks[0]?.simulatedAndVisualizedTransactions.length, 1)
		assert.equal(reply.result.visualizedSimulationState.visualizedBlocks[1]?.simulatedAndVisualizedTransactions.length, 1)
	})
}

await runIfRoot(async () => {
	await main()
	await run()
}, import.meta)
