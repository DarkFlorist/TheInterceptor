import * as assert from 'assert'
import { describe, test } from 'bun:test'
import type { RpcEntry } from '../../app/ts/types/rpc.js'
import { type BlockTimeManipulation, createSimulatedExecutionInput, type SignedMessageTransaction } from '../../app/ts/types/visualizer-types.js'
import { eth_getBlockByNumber_goerli_8443561_true } from '../RPCResponses.js'

type StorageState = Record<string, unknown>

const makeMockBrowser = () => {
	const storage: StorageState = {}

	const get = async (keys: string | readonly string[]) => {
		const requested = Array.isArray(keys) ? keys : [keys]
		return Object.fromEntries(requested.filter((key) => key in storage).map((key) => [key, storage[key]]))
	}
	const set = async (items: Record<string, unknown>) => {
		Object.assign(storage, items)
	}
	const remove = async (keys: string | readonly string[]) => {
		const requested = Array.isArray(keys) ? keys : [keys]
		for (const key of requested) delete storage[key]
	}

	return {
		storage: {
			local: {
				get,
				set,
				remove,
			},
		},
		runtime: {
			lastError: undefined,
			getManifest: () => ({ manifest_version: 3 }),
			sendMessage: async (message: { method?: string }) => {
				if (message.method === 'popup_isMainPopupWindowOpen') {
					return { method: 'popup_isMainPopupWindowOpen', data: { isOpen: false } }
				}
				return undefined
			},
		},
		tabs: {
			onRemoved: { addListener: () => undefined, removeListener: () => undefined },
			query: async () => [],
			get: async () => undefined,
			update: async () => undefined,
			reload: async () => undefined,
			create: async () => undefined,
			remove: async () => undefined,
			onUpdated: { addListener: () => undefined, removeListener: () => undefined },
		},
		windows: {
			get: async () => undefined,
			update: async () => undefined,
		},
		__storage: storage,
	}
}

const mockBrowser = makeMockBrowser()
Object.defineProperty(globalThis, 'browser', { value: mockBrowser, configurable: true, writable: true })
Object.defineProperty(globalThis, 'chrome', { value: { runtime: { id: 'test-extension' } }, configurable: true, writable: true })

const { getCurrentSimulationInput } = await import('../../app/ts/background/simulationUpdating.js')
const { getInterceptorTransactionStack, updateInterceptorTransactionStack } = await import('../../app/ts/background/storageVariables.js')
const { setTransactionOrMessageBlockTimeManipulator } = await import('../../app/ts/background/popupMessageHandlers.js')
const { mockSignTransaction } = await import('../../app/ts/simulation/services/SimulationModeEthereumClientService.js')
const { DEFAULT_BLOCK_MANIPULATION } = await import('../../app/ts/config/defaults.js')
const { browserStorageLocalSet } = await import('../../app/ts/utils/storageUtils.js')
const { EthereumClientService, getNextBlockTimeStampOverride } = await import('../../app/ts/simulation/services/EthereumClientService.js')
const { JsonRpcResponse } = await import('../../app/ts/types/JsonRpc-types.js')
const { dateToBigintSeconds } = await import('../../app/ts/utils/bigint.js')

const baseTransaction = {
	type: '1559',
	from: 0xd8da6bf26964af9d7eed9e03e53415d37aa96045n,
	nonce: 0n,
	maxFeePerGas: 1n,
	maxPriorityFeePerGas: 1n,
	gas: 21000n,
	to: 0xda9dfa130df4de4673b89022ee50ff26f6ea73cfn,
	value: 10n,
	input: new Uint8Array(0),
	chainId: 1n,
} as const

const makePreSimulationTransaction = (transactionIdentifier: bigint) => ({
	signedTransaction: mockSignTransaction(baseTransaction),
	website: { websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
	created: new Date('2024-01-01T00:00:00.000Z'),
	originalRequestParameters: {
		method: 'eth_sendTransaction' as const,
		params: [{
			from: baseTransaction.from,
			to: baseTransaction.to,
			value: baseTransaction.value,
			gas: baseTransaction.gas,
			maxFeePerGas: baseTransaction.maxFeePerGas,
			maxPriorityFeePerGas: baseTransaction.maxPriorityFeePerGas,
			input: baseTransaction.input,
		}],
	},
	transactionIdentifier,
})

const tx1 = makePreSimulationTransaction(1n)
const tx2 = makePreSimulationTransaction(2n)
const newDelay = { type: 'AddToTimestamp', deltaToAdd: 11n, deltaUnit: 'Seconds' } as const
const zeroDelay: BlockTimeManipulation = { type: 'AddToTimestamp', deltaToAdd: 0n, deltaUnit: 'Seconds' }
const signedMessage: SignedMessageTransaction = {
	website: { websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
	created: new Date('2024-01-01T00:00:00.000Z'),
	fakeSignedFor: baseTransaction.from,
	originalRequestParameters: { method: 'personal_sign', params: ['0x', baseTransaction.from] },
	request: {
		method: 'personal_sign',
		params: ['0x', baseTransaction.from],
		interceptorRequest: true,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier: { requestId: 1, requestSocket: { tabId: 1, connectionName: 1n } },
	},
	simulationMode: true,
	messageIdentifier: 1n,
}

const ethereum = {
	getBlock: async () => ({ timestamp: new Date('2024-01-01T00:00:00.000Z') }),
} as never as Parameters<typeof setTransactionOrMessageBlockTimeManipulator>[0]
const tokenPriceService = {} as never as Parameters<typeof setTransactionOrMessageBlockTimeManipulator>[1]

const resetStack = async () => {
	await updateInterceptorTransactionStack(() => ({
		operations: [
			{ type: 'Transaction', preSimulationTransaction: tx1 },
			{ type: 'TimeManipulation', blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 5n, deltaUnit: 'Seconds' } },
			{ type: 'TimeManipulation', blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 7n, deltaUnit: 'Seconds' } },
			{ type: 'Transaction', preSimulationTransaction: tx2 },
		],
	}))
	delete mockBrowser.__storage.popupVisualisation
	delete mockBrowser.__storage.preSimulationBlockTimeManipulation
	delete mockBrowser.__storage.makeCurrentAddressRich
	delete mockBrowser.__storage.fixedAddressRichList
	delete mockBrowser.__storage.simulationMode
	delete mockBrowser.__storage.independentActiveSimulationAddress
	delete mockBrowser.__storage.activeRpcNetwork
}

describe('simulate delay editor', () => {
	test('replacing an existing delay removes adjacent duplicate manipulators', async () => {
		await resetStack()

		await setTransactionOrMessageBlockTimeManipulator(ethereum, tokenPriceService, {
			method: 'popup_setTransactionOrMessageBlockTimeManipulator',
			data: {
				transactionOrMessageIdentifier: { type: 'Transaction', transactionIdentifier: 1n },
				blockTimeManipulation: newDelay,
			},
		})

		const stack = await getInterceptorTransactionStack()
		assert.equal(stack.operations.length, 3)
		assert.equal(stack.operations[0]?.type, 'Transaction')
		assert.equal(stack.operations[1]?.type, 'TimeManipulation')
		assert.equal(stack.operations[2]?.type, 'Transaction')
		if (stack.operations[1]?.type !== 'TimeManipulation') throw new Error('missing time manipulation')
		assert.deepStrictEqual({ ...stack.operations[1].blockTimeManipulation }, newDelay)
	})

	test('getCurrentSimulationInput produces one block transition per remaining delay', async () => {
		await resetStack()

		await setTransactionOrMessageBlockTimeManipulator(ethereum, tokenPriceService, {
			method: 'popup_setTransactionOrMessageBlockTimeManipulator',
			data: {
				transactionOrMessageIdentifier: { type: 'Transaction', transactionIdentifier: 1n },
				blockTimeManipulation: newDelay,
			},
		})

		const simulationInput = await getCurrentSimulationInput()
		assert.equal(simulationInput.length, 2)
		assert.deepStrictEqual(simulationInput.map((block) => ({ ...block.blockTimeManipulation })), [
			{ type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
			newDelay,
		])
	})

	test('signing mode excludes the simulation-mode transaction and delay stack', async () => {
		await resetStack()
		await browserStorageLocalSet({
			simulationMode: false,
			preSimulationBlockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 13n, deltaUnit: 'Seconds' },
		})

		await setTransactionOrMessageBlockTimeManipulator(ethereum, tokenPriceService, {
			method: 'popup_setTransactionOrMessageBlockTimeManipulator',
			data: {
				transactionOrMessageIdentifier: { type: 'Transaction', transactionIdentifier: 1n },
				blockTimeManipulation: newDelay,
			},
		})

		const simulationInput = await getCurrentSimulationInput()
		assert.deepStrictEqual(simulationInput, [])
	})

	test('excludes transactions whose simulation options require another chain', async () => {
		await resetStack()
		await updateInterceptorTransactionStack(() => ({
			operations: [{
				type: 'Transaction',
				preSimulationTransaction: {
					...tx1,
					simulationOptions: {
						requiredChainId: 2n,
						simulateWithZeroBaseFee: true,
					},
				},
			}],
		}))

		assert.deepEqual(await getCurrentSimulationInput(), [])
	})
})

describe('eth_simulateV1 block timestamps', () => {
	const rpcEntry: RpcEntry = {
		name: 'Testnet',
		chainId: 1n,
		httpsRpc: 'https://example.invalid',
		currencyName: 'Ether',
		currencyTicker: 'ETH',
		primary: true,
		minimized: true,
	}
	const ethereumClientService = new EthereumClientService(
		{
			rpcUrl: rpcEntry.httpsRpc,
			clearCache: () => undefined,
			async getChainId() { return rpcEntry.chainId },
			async jsonRpcRequest(request) {
				if (request.method !== 'eth_getBlockByNumber') throw new Error(`Unexpected RPC method: ${ request.method }`)
				const response = JsonRpcResponse.parse(JSON.parse(eth_getBlockByNumber_goerli_8443561_true))
				if ('error' in response) throw new Error(response.error.message)
				return response.result
			},
		},
		async () => undefined,
		async () => undefined,
		rpcEntry,
	)
	const zeroBaseFeeTransaction = { ...tx1, simulationOptions: { requiredChainId: 1n, simulateWithZeroBaseFee: true } }

	// Seconds each simulated block is ahead of its parent. Nodes reject the whole eth_simulateV1 request unless every step is positive.
	const getCurrentStackBlockTimeSteps = async () => {
		const parentBlock = await ethereumClientService.getBlock(undefined, 1n)
		if (parentBlock === null) throw new Error('missing parent block')
		// Only the block times matter here, so the stack's input runs without simulation overrides.
		const prepared = await ethereumClientService.prepareEthSimulateV1Input(createSimulatedExecutionInput(await getCurrentSimulationInput()), 1n, undefined)
		let previousTime = dateToBigintSeconds(parentBlock.timestamp)
		return prepared.blockOverrides.map((blockOverride) => {
			if (blockOverride.time === undefined) throw new Error('missing block time')
			const time = dateToBigintSeconds(blockOverride.time)
			const step = time - previousTime
			previousTime = time
			return step
		})
	}

	test('a signature after a transaction gets a later block than the transaction', async () => {
		await resetStack()
		await updateInterceptorTransactionStack(() => ({
			operations: [
				{ type: 'Transaction', preSimulationTransaction: tx1 },
				{ type: 'Message', signedMessageTransaction: signedMessage },
			],
		}))

		assert.deepEqual(await getCurrentStackBlockTimeSteps(), [12n, 1n])
	})

	test('a transaction after a zero base fee transaction gets a later block', async () => {
		await resetStack()
		await updateInterceptorTransactionStack(() => ({
			operations: [
				{ type: 'Transaction', preSimulationTransaction: zeroBaseFeeTransaction },
				{ type: 'Transaction', preSimulationTransaction: tx2 },
			],
		}))

		assert.deepEqual(await getCurrentStackBlockTimeSteps(), [12n, 1n])
	})

	test('a simulate delay of zero between transactions gets a later block', async () => {
		await resetStack()
		await updateInterceptorTransactionStack(() => ({
			operations: [
				{ type: 'Transaction', preSimulationTransaction: tx1 },
				{ type: 'TimeManipulation', blockTimeManipulation: zeroDelay },
				{ type: 'Transaction', preSimulationTransaction: tx2 },
			],
		}))

		assert.deepEqual(await getCurrentStackBlockTimeSteps(), [12n, 1n])
	})

	test('a pre-simulation delay of zero puts the first block after the parent block', async () => {
		await resetStack()
		await updateInterceptorTransactionStack(() => ({ operations: [{ type: 'Transaction', preSimulationTransaction: tx1 }] }))
		await browserStorageLocalSet({ preSimulationBlockTimeManipulation: zeroDelay })

		assert.deepEqual(await getCurrentStackBlockTimeSteps(), [1n])
	})

	test('the block split before a signature stays a zero delay so the simulate delay picker keeps showing 0 seconds', async () => {
		await resetStack()
		await updateInterceptorTransactionStack(() => ({
			operations: [
				{ type: 'Transaction', preSimulationTransaction: tx1 },
				{ type: 'Message', signedMessageTransaction: signedMessage },
			],
		}))

		const simulationInput = await getCurrentSimulationInput()
		assert.deepStrictEqual(simulationInput.map((block) => ({ ...block.blockTimeManipulation })), [DEFAULT_BLOCK_MANIPULATION, zeroDelay])
	})

	test('the block split before a plain transaction stays a zero delay so the simulate delay picker keeps showing 0 seconds', async () => {
		await resetStack()
		await updateInterceptorTransactionStack(() => ({
			operations: [
				{ type: 'Transaction', preSimulationTransaction: zeroBaseFeeTransaction },
				{ type: 'Transaction', preSimulationTransaction: tx2 },
			],
		}))

		const simulationInput = await getCurrentSimulationInput()
		assert.deepStrictEqual(simulationInput.map((block) => ({ ...block.blockTimeManipulation })), [DEFAULT_BLOCK_MANIPULATION, zeroDelay])
	})

	test('leaves positive delays and absolute times unchanged', () => {
		const previousTime = new Date('2024-01-01T00:00:00.000Z')
		const getStep = (blockTimeManipulation: BlockTimeManipulation) => dateToBigintSeconds(getNextBlockTimeStampOverride(previousTime, blockTimeManipulation)) - dateToBigintSeconds(previousTime)

		assert.equal(getStep({ type: 'AddToTimestamp', deltaToAdd: 1n, deltaUnit: 'Seconds' }), 1n)
		assert.equal(getStep(DEFAULT_BLOCK_MANIPULATION), 12n)
		assert.equal(getStep({ type: 'AddToTimestamp', deltaToAdd: 2n, deltaUnit: 'Minutes' }), 120n)
		assert.equal(getStep({ type: 'SetTimetamp', timeToSet: dateToBigintSeconds(previousTime) + 500n }), 500n)
		assert.equal(getStep({ type: 'SetTimetamp', timeToSet: dateToBigintSeconds(previousTime) }), 1n)
	})
})

await updateInterceptorTransactionStack(() => ({ operations: [] }))
