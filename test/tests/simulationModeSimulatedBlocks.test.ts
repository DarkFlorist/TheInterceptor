import { describe, test } from 'bun:test'
import * as assert from 'node:assert'
import { createSimulationState, getSimulatedBlock, getSimulatedBlockFromInput, getSimulatedCode, getSimulatedTransactionByHash, getSimulatedTransactionByHashFromInput, getSimulatedTransactionCount, groupEthSimulateV1ResultByInputBlocks, mockSignTransaction, simulatedCall, simulatedCallFromInput } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import { toResolvedSimulationInput, toResolvedSimulationState } from '../../app/ts/types/visualizer-types.js'
import { createSimulationModeTestContext, blockNumber, createSimulationStateInput, createTwoBlockSimulationStateInput, exampleTransaction } from './simulationModeEthereumClientServiceTestHelpers.js'

const { ethereum, getBlockNumberFromInput, getBlockFromInput, getBlockByHashFromInput } = createSimulationModeTestContext()

describe('SimulationModeEthereumClientService', () => {
	test('forwards safe and earliest block tags instead of applying the simulation overlay', async () => {
		const simulationState = await createSimulationState(ethereum, undefined, createSimulationStateInput())
		if (simulationState.success === false) throw new Error('simulation unexpectedly failed')
		const forwardedTags: { method: string, blockTag: unknown }[] = []
		const forwardingEthereum = new Proxy(ethereum, {
			get(target, property, receiver) {
				switch(property) {
					case 'getTransactionCount': return async (_address: bigint, blockTag: unknown) => {
						forwardedTags.push({ method: property, blockTag })
						return 0n
					}
					case 'getCode': return async (_address: bigint, blockTag: unknown) => {
						forwardedTags.push({ method: property, blockTag })
						return new Uint8Array()
					}
					case 'getBlock': return async (requestAbortController: AbortController | undefined, blockTag: Parameters<typeof target.getBlock>[1], fullObjects: boolean) => {
						if (blockTag === 'safe' || blockTag === 'earliest') {
							forwardedTags.push({ method: property, blockTag })
							return null
						}
						return await target.getBlock(requestAbortController, blockTag, fullObjects)
					}
					case 'getLogs': return async (filter: { fromBlock?: unknown }) => {
						forwardedTags.push({ method: property, blockTag: filter.fromBlock })
						return []
					}
					case 'call': return async (_transaction: unknown, blockTag: unknown) => {
						forwardedTags.push({ method: property, blockTag })
						return new Uint8Array()
					}
					default: return Reflect.get(target, property, receiver)
				}
			}
		})
		const resolvedState = toResolvedSimulationState(simulationState)

		await getSimulatedTransactionCount(forwardingEthereum, undefined, resolvedState, exampleTransaction.from, 'safe')
		await getSimulatedCode(forwardingEthereum, undefined, resolvedState, exampleTransaction.to, 'earliest')
		await getSimulatedBlockFromInput(forwardingEthereum, undefined, toResolvedSimulationInput(createSimulationStateInput()), 'safe', false)
		const callParams = {
			from: exampleTransaction.from,
			to: exampleTransaction.to,
			value: exampleTransaction.value,
			input: exampleTransaction.input,
			maxFeePerGas: exampleTransaction.maxFeePerGas,
			maxPriorityFeePerGas: exampleTransaction.maxPriorityFeePerGas,
		}
		await simulatedCallFromInput(forwardingEthereum, undefined, toResolvedSimulationInput(createSimulationStateInput()), callParams, 'safe')
		await simulatedCall(forwardingEthereum, undefined, resolvedState, callParams, 'earliest')

		assert.deepEqual(forwardedTags, [
			{ method: 'getTransactionCount', blockTag: 'safe' },
			{ method: 'getCode', blockTag: 'earliest' },
			{ method: 'getBlock', blockTag: 'safe' },
			{ method: 'call', blockTag: 'safe' },
			{ method: 'call', blockTag: 'earliest' },
		])
	})

	test('groupEthSimulateV1ResultByInputBlocks collapses split rpc blocks back into one logical block', async () => {
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
					transactionIdentifier: 2n,
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
					transactionIdentifier: 3n,
				},
			],
			signedMessages: [],
			blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
			simulateWithZeroBaseFee: false,
		}] as const

		const { prepared, result } = await ethereum.simulatePrepared(splitSimulationStateInput, blockNumber, undefined)
		assert.equal(result.length, 2)
		const grouped = groupEthSimulateV1ResultByInputBlocks(prepared, result)
		assert.equal(grouped.length, 1)
		const groupedBlock = grouped[0]
		if (groupedBlock === undefined) throw new Error('grouped block missing')
		assert.equal(groupedBlock.calls.length, 2)
		assert.equal(groupedBlock.calls[0]?.gasUsed, 0x5208n)
		assert.equal(groupedBlock.calls[1]?.gasUsed, 0x6dd4n)
	})

	test('input-based block number counts split execution blocks', async () => {
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
				transactionIdentifier: 2n,
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
				transactionIdentifier: 3n,
			},
		],
		signedMessages: [],
		blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
		simulateWithZeroBaseFee: false,
	}] as const

		assert.equal(await getBlockNumberFromInput(splitSimulationStateInput), blockNumber + 2n)
	})

	test('input-based block number returns parent block number for empty input', async () => {
		const emptySimulationStateInput = [] as const

		assert.equal(await getBlockNumberFromInput(emptySimulationStateInput), blockNumber)
	})

	test('input-based simulated block hash is deterministic and round-trips through getBlockByHash', async () => {
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
			transactionIdentifier: 4n,
		}],
		signedMessages: [],
		blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
		simulateWithZeroBaseFee: false,
	}] as const

	const latestBlock = await getBlockFromInput(simulationStateInput, 'latest', true)
	if (latestBlock === null) throw new Error('latest simulated block missing')
	const sameBlock = await getBlockFromInput(simulationStateInput, 'latest', true)
	if (sameBlock === null) throw new Error('latest simulated block missing on second read')
	const roundTripped = await getBlockByHashFromInput(simulationStateInput, latestBlock.hash, true)
	if (roundTripped === null) throw new Error('round-tripped block missing')

	assert.equal(latestBlock.hash, sameBlock.hash)
		assert.equal(roundTripped.hash, latestBlock.hash)
		assert.equal(roundTripped.number, latestBlock.number)
	})

	test('input-based full blocks include transaction block data and realized gas price', async () => {
		const latestBlock = await getBlockFromInput(createSimulationStateInput(), 'latest', true)
		if (latestBlock === null) throw new Error('latest simulated block missing')
		const transaction = latestBlock.transactions[0]
		if (transaction === undefined || typeof transaction === 'bigint' || !('blockHash' in transaction)) throw new Error('full simulated transaction data missing')

		assert.equal(transaction.blockHash, latestBlock.hash)
		assert.equal(transaction.blockNumber, latestBlock.number)
		assert.equal(transaction.transactionIndex, 0n)
		assert.deepEqual(transaction.data, transaction.input)
		assert.equal(transaction.gasPrice, 1n)
	})

	test('full blocks agree with transaction lookups across blocks, indexes, and fee caps', async () => {
		const input = createTwoBlockSimulationStateInput().map((block, blockIndex) => ({
			...block,
			transactions: [1n, 1_000_000_000_000n].map((maxFeePerGas, transactionIndex) => ({
				...block.transactions[0],
				transactionIdentifier: BigInt(blockIndex * 2 + transactionIndex),
				signedTransaction: mockSignTransaction({
					...exampleTransaction,
					nonce: BigInt(blockIndex * 2 + transactionIndex),
					input: new Uint8Array([0x12, 0x34]),
					maxFeePerGas,
					maxPriorityFeePerGas: 1n,
				}),
			})),
		}))
		const template = await createSimulationState(ethereum, undefined, createTwoBlockSimulationStateInput())
		if (template.success === false) throw new Error('simulation unexpectedly failed')
		// Exercise the state reader with two included transactions per block and a nonzero base fee; simulateEstimateGas still reads blocks through it.
		const state = toResolvedSimulationState({
			...template,
			simulatedBlocks: template.simulatedBlocks.map((block, blockIndex) => ({
				...block,
				blockBaseFeePerGas: 10n,
				simulatedTransactions: (input[blockIndex]?.transactions ?? []).map((transaction, transactionIndex) => {
					const simulatedTransaction = block.simulatedTransactions[0]
					if (simulatedTransaction === undefined) throw new Error('template transaction missing')
					return { ...simulatedTransaction, preSimulationTransaction: transaction, realizedGasPrice: transactionIndex === 0 ? 1n : 11n }
				}),
			})),
		})
		for (const blockIndex of [0, 1]) {
			const number = blockNumber + BigInt(blockIndex) + 1n
			for (const source of ['input', 'state']) {
				const block = source === 'input'
					? await getBlockFromInput(input, number, true)
					: await getSimulatedBlock(ethereum, undefined, state, number, true)
				if (block === null) throw new Error('full block missing')
				assert.equal(block.transactions.length, 2)
				assert.equal(block.number, number)
				assert.ok(block.baseFeePerGas !== undefined && block.baseFeePerGas > 0n)
				for (const [transactionIndex, transaction] of block.transactions.entries()) {
					if (typeof transaction === 'bigint' || !('blockHash' in transaction)) throw new Error('transaction block data missing')
					const lookup = source === 'input'
						? await getSimulatedTransactionByHashFromInput(ethereum, undefined, toResolvedSimulationInput(input), transaction.hash)
						: await getSimulatedTransactionByHash(ethereum, undefined, state, transaction.hash)
					assert.deepStrictEqual(transaction, lookup)
					assert.equal(transaction.blockHash, block.hash)
					assert.equal(transaction.blockNumber, number)
					assert.equal(transaction.transactionIndex, BigInt(transactionIndex))
					assert.deepStrictEqual(transaction.data, new Uint8Array([0x12, 0x34]))
					assert.equal(transaction.gasPrice, transactionIndex === 0 ? 1n : block.baseFeePerGas + 1n)
					assert.ok(transaction.v === 0n || transaction.v === 1n)
				}
			}
		}
	})

	test('input-based simulated block hash changes when transaction contents change', async () => {
		const baseSimulationStateInput = [{
			stateOverrides: {},
			transactions: [{
				signedTransaction: mockSignTransaction({
					...exampleTransaction,
					nonce: 0n,
				}),
				website: { websiteOrigin: 'test', icon: undefined, title: undefined },
				created: new Date(),
				originalRequestParameters: { method: 'eth_sendTransaction', params: [{}]},
				transactionIdentifier: 7n,
			}],
			signedMessages: [],
			blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
			simulateWithZeroBaseFee: false,
		}] as const

		const changedSimulationStateInput = [{
			...baseSimulationStateInput[0],
			transactions: [{
				...baseSimulationStateInput[0].transactions[0],
				signedTransaction: mockSignTransaction({
					...exampleTransaction,
					nonce: 1n,
				}),
			}],
		}] as const

		const firstBlock = await getBlockFromInput(baseSimulationStateInput, 'latest', true)
		const secondBlock = await getBlockFromInput(changedSimulationStateInput, 'latest', true)
		if (firstBlock === null || secondBlock === null) throw new Error('simulated block missing')

		assert.notEqual(firstBlock.hash, secondBlock.hash)
	})

	test('input-based execution blocks link together after gas splitting', async () => {
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
					transactionIdentifier: 8n,
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
					transactionIdentifier: 9n,
				},
			],
			signedMessages: [],
			blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
			simulateWithZeroBaseFee: false,
		}] as const

		const firstBlock = await getBlockFromInput(splitSimulationStateInput, blockNumber + 1n, true)
		const secondBlock = await getBlockFromInput(splitSimulationStateInput, blockNumber + 2n, true)
		if (firstBlock === null || secondBlock === null) throw new Error('split execution block missing')

		assert.equal(secondBlock.parentHash, firstBlock.hash)
		assert.equal(secondBlock.number, firstBlock.number + 1n)
	})

})
