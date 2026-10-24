import { describe, test } from 'bun:test'
import * as assert from 'node:assert'
import { createExecutionSimulationState, createSimulationState, getSimulatedLogs, mockSignTransaction } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import { toResolvedExecutionSimulationState } from '../../app/ts/types/visualizer-types.js'
import { createSimulationModeTestContext, blockNumber, createSimulationStateInput, example7702Transaction, exampleTransaction } from './simulationModeEthereumClientServiceTestHelpers.js'

const { ethereum, getBlockFromInput, getTransactionByHashFromInput, getReceiptFromState, getLogsFromState } = createSimulationModeTestContext()

describe('SimulationModeEthereumClientService', () => {
	test('input-based transaction lookup uses execution block positions after gas splitting', async () => {
		const splitSimulationStateInput = [{
		stateOverrides: {},
		transactions: [
			{
				signedTransaction: mockSignTransaction({
					...exampleTransaction,
					nonce: 0n,
					gas: 20_000_000n,
				}),
				website: { websiteOrigin: 'test', icon: undefined, title: undefined },
				created: new Date(),
				originalRequestParameters: { method: 'eth_sendTransaction', params: [{}]},
				transactionIdentifier: 5n,
			},
			{
				signedTransaction: mockSignTransaction({
					...exampleTransaction,
					nonce: 1n,
					gas: 20_000_000n,
				}),
				website: { websiteOrigin: 'test', icon: undefined, title: undefined },
				created: new Date(),
				originalRequestParameters: { method: 'eth_sendTransaction', params: [{}]},
				transactionIdentifier: 6n,
			},
		],
		signedMessages: [],
		blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
		simulateWithZeroBaseFee: false,
	}] as const

	const secondHash = splitSimulationStateInput[0].transactions[1]?.signedTransaction.hash
	if (secondHash === undefined) throw new Error('second transaction hash missing')
	const found = await getTransactionByHashFromInput(splitSimulationStateInput, secondHash)
	if (found === null) throw new Error('second transaction not found in input-only lookup')

		assert.equal(found.blockNumber, blockNumber + 2n)
		assert.equal(found.transactionIndex, 0n)
	})

	test('state-based receipt uses execution block placement after gas splitting', async () => {
		const splitSimulationStateInput = [{
			stateOverrides: {},
			transactions: [
				{
					signedTransaction: mockSignTransaction({
						...exampleTransaction,
						nonce: 0n,
						gas: 20_000_000n,
					}),
					website: { websiteOrigin: 'test', icon: undefined, title: undefined },
					created: new Date(),
					originalRequestParameters: { method: 'eth_sendTransaction', params: [{}]},
					transactionIdentifier: 10n,
				},
				{
					signedTransaction: mockSignTransaction({
						...exampleTransaction,
						nonce: 1n,
						gas: 20_000_000n,
					}),
					website: { websiteOrigin: 'test', icon: undefined, title: undefined },
					created: new Date(),
					originalRequestParameters: { method: 'eth_sendTransaction', params: [{}]},
					transactionIdentifier: 11n,
				},
			],
			signedMessages: [],
			blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
			simulateWithZeroBaseFee: false,
		}] as const

		const simulationState = await createSimulationState(ethereum, undefined, splitSimulationStateInput)
		if (simulationState.success === false) throw new Error('simulation unexpectedly failed')
		const secondHash = splitSimulationStateInput[0].transactions[1]?.signedTransaction.hash
		if (secondHash === undefined) throw new Error('second transaction hash missing')
		const secondBlock = await getBlockFromInput(splitSimulationStateInput, blockNumber + 2n, true)
		if (secondBlock === null) throw new Error('second simulated block missing')
		const receipt = await getReceiptFromState(simulationState, secondHash)
		if (receipt === null) throw new Error('receipt missing')

		assert.equal(receipt.blockNumber, blockNumber + 2n)
		assert.equal(receipt.blockHash, secondBlock.hash)
		assert.equal(receipt.transactionIndex, 0n)
		assert.equal(receipt.cumulativeGasUsed, receipt.gasUsed)
	})

	test('state-based receipt keeps receipt and log block numbers in sync', async () => {
		const simulationStateInput = [{
			stateOverrides: {},
			transactions: [{
				signedTransaction: mockSignTransaction({
					...exampleTransaction,
					nonce: 0n,
				}),
				website: { websiteOrigin: 'test', icon: undefined, title: undefined },
				created: new Date(),
				originalRequestParameters: { method: 'eth_sendTransaction', params: [{}]},
				transactionIdentifier: 14n,
			}],
			signedMessages: [],
			blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
			simulateWithZeroBaseFee: false,
		}] as const

		const simulationState = await createSimulationState(ethereum, undefined, simulationStateInput)
		if (simulationState.success === false) throw new Error('simulation unexpectedly failed')
		const transactionHash = simulationStateInput[0].transactions[0]?.signedTransaction.hash
		if (transactionHash === undefined) throw new Error('transaction hash missing')
		const receipt = await getReceiptFromState(simulationState, transactionHash)
		if (receipt === null) throw new Error('receipt missing')

		assert.equal(receipt.blockNumber, blockNumber + 1n)
		assert.equal(receipt.logs[0]?.blockNumber, receipt.blockNumber)
	})

	test('state-based 7702 receipt omits authorization list fields', async () => {
		const simulationStateInput = [{
			stateOverrides: {},
			transactions: [{
				signedTransaction: mockSignTransaction({
					...example7702Transaction,
					nonce: 0n,
					authorizationList: [{
						chainId: 1n,
						address: 0x000000009b1d0af20d8c6d0a44e162d11f9b8f00n,
						nonce: 0n,
						authority: example7702Transaction.from,
						r: 1n,
						s: 2n,
						yParity: 'even',
					}],
				}),
				website: { websiteOrigin: 'test', icon: undefined, title: undefined },
				created: new Date(),
				originalRequestParameters: { method: 'eth_sendTransaction', params: [{ type: '7702', authorizationList: [] }]},
				transactionIdentifier: 15n,
			}],
			signedMessages: [],
			blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
			simulateWithZeroBaseFee: false,
		}] as const

		const simulationState = await createSimulationState(ethereum, undefined, simulationStateInput)
		if (simulationState.success === false) throw new Error('simulation unexpectedly failed')
		const transactionHash = simulationStateInput[0].transactions[0]?.signedTransaction.hash
		if (transactionHash === undefined) throw new Error('transaction hash missing')
		const receipt = await getReceiptFromState(simulationState, transactionHash)
		if (receipt === null) throw new Error('receipt missing')

		assert.equal(receipt.type, '7702')
		assert.equal('authorizationList' in receipt, false)
	})

	test('state-based logs honor the first simulated execution block hash after gas splitting', async () => {
		const splitSimulationStateInput = [{
			stateOverrides: {},
			transactions: [
				{
					signedTransaction: mockSignTransaction({
						...exampleTransaction,
						nonce: 0n,
						gas: 20_000_000n,
					}),
					website: { websiteOrigin: 'test', icon: undefined, title: undefined },
					created: new Date(),
					originalRequestParameters: { method: 'eth_sendTransaction', params: [{}]},
					transactionIdentifier: 12n,
				},
				{
					signedTransaction: mockSignTransaction({
						...exampleTransaction,
						nonce: 1n,
						gas: 20_000_000n,
					}),
					website: { websiteOrigin: 'test', icon: undefined, title: undefined },
					created: new Date(),
					originalRequestParameters: { method: 'eth_sendTransaction', params: [{}]},
					transactionIdentifier: 13n,
				},
			],
			signedMessages: [],
			blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
			simulateWithZeroBaseFee: false,
		}] as const

		const simulationState = await createSimulationState(ethereum, undefined, splitSimulationStateInput)
		if (simulationState.success === false) throw new Error('simulation unexpectedly failed')
		const firstBlock = await getBlockFromInput(splitSimulationStateInput, blockNumber + 1n, true)
		if (firstBlock === null) throw new Error('first simulated block missing')
		const logs = await getLogsFromState(simulationState, { blockHash: firstBlock.hash })

		assert.equal(logs.length, 1)
		assert.equal(logs[0]?.blockHash, firstBlock.hash)
		assert.equal(logs[0]?.blockNumber, blockNumber + 1n)
	})

	test('state-based logs merge simulated events into an earliest-to-latest range', async () => {
		const simulationState = await createSimulationState(ethereum, undefined, createSimulationStateInput())
		if (simulationState.success === false) throw new Error('simulation unexpectedly failed')
		const nodeLogFilters: Parameters<typeof ethereum.getLogs>[0][] = []
		const overlayEthereum = new Proxy(ethereum, {
			get(target, property, receiver) {
				switch (property) {
					case 'getBlock': return async (requestAbortController: AbortController | undefined, blockTag: Parameters<typeof target.getBlock>[1], fullObjects: boolean) => {
						if (blockTag === 'earliest') return await target.getBlock(requestAbortController, blockNumber, fullObjects)
						return await target.getBlock(requestAbortController, blockTag, fullObjects)
					}
					case 'getLogs': return async (filter: Parameters<typeof target.getLogs>[0]) => {
						nodeLogFilters.push(filter)
						return []
					}
					default: return Reflect.get(target, property, receiver)
				}
			}
		})

		// Calls getSimulatedLogs directly because the context's getLogsFromState is bound to the plain client, and this test needs the overlay's getBlock and getLogs.
		const logs = await getSimulatedLogs(overlayEthereum, undefined, toResolvedExecutionSimulationState(simulationState), { fromBlock: 'earliest', toBlock: 'latest' })

		assert.equal(logs.length, 1)
		assert.equal(logs[0]?.blockNumber, blockNumber + 1n)
		assert.deepEqual(nodeLogFilters, [{ fromBlock: blockNumber, toBlock: blockNumber }])
	})

	test('execution-only receipt uses execution block placement after gas splitting', async () => {
		const splitSimulationStateInput = [{
			stateOverrides: {},
			transactions: [
				{
					signedTransaction: mockSignTransaction({
						...exampleTransaction,
						nonce: 0n,
						gas: 20_000_000n,
					}),
					website: { websiteOrigin: 'test', icon: undefined, title: undefined },
					created: new Date(),
					originalRequestParameters: { method: 'eth_sendTransaction', params: [{}]},
					transactionIdentifier: 10n,
				},
				{
					signedTransaction: mockSignTransaction({
						...exampleTransaction,
						nonce: 1n,
						gas: 20_000_000n,
					}),
					website: { websiteOrigin: 'test', icon: undefined, title: undefined },
					created: new Date(),
					originalRequestParameters: { method: 'eth_sendTransaction', params: [{}]},
					transactionIdentifier: 11n,
				},
			],
			signedMessages: [],
			blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
			simulateWithZeroBaseFee: false,
		}] as const

		const simulationState = await createExecutionSimulationState(ethereum, undefined, splitSimulationStateInput)
		if (simulationState.success === false) throw new Error('simulation unexpectedly failed')
		const secondHash = splitSimulationStateInput[0].transactions[1]?.signedTransaction.hash
		if (secondHash === undefined) throw new Error('second transaction hash missing')
		const secondBlock = await getBlockFromInput(splitSimulationStateInput, blockNumber + 2n, true)
		if (secondBlock === null) throw new Error('second simulated block missing')
		const receipt = await getReceiptFromState(simulationState, secondHash)
		if (receipt === null) throw new Error('receipt missing')

		assert.equal(receipt.blockNumber, blockNumber + 2n)
		assert.equal(receipt.blockHash, secondBlock.hash)
		assert.equal(receipt.transactionIndex, 0n)
		assert.equal(receipt.cumulativeGasUsed, receipt.gasUsed)
	})

	test('execution-only logs honor the first simulated execution block hash after gas splitting', async () => {
		const splitSimulationStateInput = [{
			stateOverrides: {},
			transactions: [
				{
					signedTransaction: mockSignTransaction({
						...exampleTransaction,
						nonce: 0n,
						gas: 20_000_000n,
					}),
					website: { websiteOrigin: 'test', icon: undefined, title: undefined },
					created: new Date(),
					originalRequestParameters: { method: 'eth_sendTransaction', params: [{}]},
					transactionIdentifier: 12n,
				},
				{
					signedTransaction: mockSignTransaction({
						...exampleTransaction,
						nonce: 1n,
						gas: 20_000_000n,
					}),
					website: { websiteOrigin: 'test', icon: undefined, title: undefined },
					created: new Date(),
					originalRequestParameters: { method: 'eth_sendTransaction', params: [{}]},
					transactionIdentifier: 13n,
				},
			],
			signedMessages: [],
			blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
			simulateWithZeroBaseFee: false,
		}] as const

		const simulationState = await createExecutionSimulationState(ethereum, undefined, splitSimulationStateInput)
		if (simulationState.success === false) throw new Error('simulation unexpectedly failed')
		const firstBlock = await getBlockFromInput(splitSimulationStateInput, blockNumber + 1n, true)
		if (firstBlock === null) throw new Error('first simulated block missing')
		const logs = await getLogsFromState(simulationState, { blockHash: firstBlock.hash })

		assert.equal(logs.length, 1)
		assert.equal(logs[0]?.blockHash, firstBlock.hash)
		assert.equal(logs[0]?.blockNumber, blockNumber + 1n)
	})
})
