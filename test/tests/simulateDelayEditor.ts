import * as assert from 'assert'
import { describe, run, runIfRoot, should } from '../micro-should.js'

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
			sendMessage: async () => undefined,
		},
		tabs: {
			onRemoved: { addListener: () => {}, removeListener: () => {} },
			query: async () => [],
			get: async () => undefined,
			update: async () => undefined,
			reload: async () => undefined,
			create: async () => undefined,
			remove: async () => undefined,
			onUpdated: { addListener: () => {}, removeListener: () => {} },
		},
		windows: {
			get: async () => undefined,
			update: async () => undefined,
		},
		__storage: storage,
	}
}

async function main() {
	const mockBrowser = makeMockBrowser()
	// @ts-expect-error test shim for extension APIs
	globalThis.browser = mockBrowser
	// @ts-expect-error test shim for extension APIs
	globalThis.chrome = { runtime: { id: 'test-extension' } }

	const { getCurrentSimulationInput } = await import('../../app/ts/background/simulationUpdating.js')
	const { getInterceptorTransactionStack, updateInterceptorTransactionStack } = await import('../../app/ts/background/storageVariables.js')
	const { setTransactionOrMessageBlockTimeManipulator } = await import('../../app/ts/background/popupMessageHandlers.js')
	const { DEFAULT_BLOCK_MANIPULATION, mockSignTransaction } = await import('../../app/ts/simulation/services/SimulationModeEthereumClientService.js')

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
		originalRequestParameters: { method: 'eth_sendTransaction', params: [{}] },
		transactionIdentifier,
	})

	const tx1 = makePreSimulationTransaction(1n)
	const tx2 = makePreSimulationTransaction(2n)
	const newDelay = { type: 'AddToTimestamp', deltaToAdd: 11n, deltaUnit: 'Seconds' } as const

	const simulator = {
		ethereum: {
			getBlock: async () => ({ timestamp: new Date('2024-01-01T00:00:00.000Z') }),
		},
		tokenPriceService: {},
	} as never

	const resetStack = async () => {
		mockBrowser.__storage.interceptorTransactionStack = {
			operations: [
				{ type: 'Transaction', preSimulationTransaction: tx1 },
				{ type: 'TimeManipulation', blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 5n, deltaUnit: 'Seconds' } },
				{ type: 'TimeManipulation', blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 7n, deltaUnit: 'Seconds' } },
				{ type: 'Transaction', preSimulationTransaction: tx2 },
			],
		}
		delete mockBrowser.__storage.popupVisualisation
		delete mockBrowser.__storage.preSimulationBlockTimeManipulation
		delete mockBrowser.__storage.makeCurrentAddressRich
		delete mockBrowser.__storage.fixedAddressRichList
		delete mockBrowser.__storage.simulationMode
		delete mockBrowser.__storage.activeSimulationAddress
		delete mockBrowser.__storage.activeRpcNetwork
	}

	describe('simulate delay editor', () => {
		should('replacing an existing delay removes adjacent duplicate manipulators', async () => {
			await resetStack()

			await setTransactionOrMessageBlockTimeManipulator(simulator, {
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
			assert.deepStrictEqual(stack.operations[1].blockTimeManipulation, newDelay)
		})

		should('getCurrentSimulationInput produces one block transition per remaining delay', async () => {
			await resetStack()

			await setTransactionOrMessageBlockTimeManipulator(simulator, {
				method: 'popup_setTransactionOrMessageBlockTimeManipulator',
				data: {
					transactionOrMessageIdentifier: { type: 'Transaction', transactionIdentifier: 1n },
					blockTimeManipulation: newDelay,
				},
			})

			const simulationInput = await getCurrentSimulationInput()
			assert.equal(simulationInput.length, 2)
			assert.deepStrictEqual(simulationInput.map((block) => block.blockTimeManipulation), [
				{ type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
				newDelay,
			])
		})

		should('signing mode ignores the pre-simulation first-transaction delay', async () => {
			await resetStack()
			mockBrowser.__storage.simulationMode = false
			mockBrowser.__storage.preSimulationBlockTimeManipulation = { type: 'AddToTimestamp', deltaToAdd: 13n, deltaUnit: 'Seconds' }

			await setTransactionOrMessageBlockTimeManipulator(simulator, {
				method: 'popup_setTransactionOrMessageBlockTimeManipulator',
				data: {
					transactionOrMessageIdentifier: { type: 'Transaction', transactionIdentifier: 1n },
					blockTimeManipulation: newDelay,
				},
			})

			const simulationInput = await getCurrentSimulationInput()
			assert.equal(simulationInput.length, 2)
			assert.deepStrictEqual(simulationInput.map((block) => block.blockTimeManipulation), [
				DEFAULT_BLOCK_MANIPULATION,
				newDelay,
			])
		})
	})

	await updateInterceptorTransactionStack(() => ({ operations: [] }))
}

await runIfRoot(async () => {
	await main()
	await run()
}, import.meta)
