import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { installBrowserMock } from '../harness/browserMock.js'
import type { PreSimulationTransaction } from '../../app/ts/types/visualizer-types.js'
import { TokenPriceService } from '../../app/ts/simulation/services/priceEstimator.js'
import { getMessageMethod } from './runtimeMessageMatchers.js'
import { createStubEthereumClient } from './stubEthereumClient.js'

const browserMock = installBrowserMock({
	handlers: {
		runtimeMessage: async (message) => getMessageMethod(message) === 'popup_isMainPopupWindowOpen' ? { method: 'popup_isMainPopupWindowOpen', data: { isOpen: false } } : undefined,
	},
})

const { getCurrentSimulationInput } = await import('../../app/ts/background/simulationUpdating.js')
const { getInterceptorTransactionStack, updateInterceptorTransactionStack } = await import('../../app/ts/background/storageVariables.js')
const { setTransactionOrMessageBlockTimeManipulator } = await import('../../app/ts/background/popupMessageHandlers/simulation.js')
const { mockSignTransaction } = await import('../../app/ts/simulation/services/SimulationModeEthereumClientService.js')
const { browserStorageLocalSet } = await import('../../app/ts/utils/storageUtils.js')

const baseTransaction = {
	type: '1559' as const,
	from: 0xd8da6bf26964af9d7eed9e03e53415d37aa96045n,
	nonce: 0n,
	maxFeePerGas: 1n,
	maxPriorityFeePerGas: 1n,
	gas: 21000n,
	to: 0xda9dfa130df4de4673b89022ee50ff26f6ea73cfn,
	value: 10n,
	input: new Uint8Array(0),
	chainId: 1n,
}

const makePreSimulationTransaction = (transactionIdentifier: bigint): PreSimulationTransaction => ({
	signedTransaction: mockSignTransaction(baseTransaction),
	website: { websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
	created: new Date('2024-01-01T00:00:00.000Z'),
	originalRequestParameters: {
		method: 'eth_sendTransaction',
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

// The popup visualisation refresh stops before touching the client because no popup reports itself open, so every RPC request may reject.
const ethereum = createStubEthereumClient()
const tokenPriceService = new TokenPriceService(ethereum, 0)

const resetStack = async () => {
	await updateInterceptorTransactionStack(() => ({
		operations: [
			{ type: 'Transaction', preSimulationTransaction: tx1 },
			{ type: 'TimeManipulation', blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 5n, deltaUnit: 'Seconds' } },
			{ type: 'TimeManipulation', blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 7n, deltaUnit: 'Seconds' } },
			{ type: 'Transaction', preSimulationTransaction: tx2 },
		],
	}))
	await browserMock.browser.storage.local.remove([
		'popupVisualisation',
		'preSimulationBlockTimeManipulation',
		'makeCurrentAddressRich',
		'fixedAddressRichList',
		'simulationMode',
		'independentActiveSimulationAddress',
		'activeRpcNetwork',
	])
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

await updateInterceptorTransactionStack(() => ({ operations: [] }))
