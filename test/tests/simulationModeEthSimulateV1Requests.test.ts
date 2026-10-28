import { describe, test } from 'bun:test'
import * as assert from 'node:assert'
import { bytes32String } from '../../app/ts/utils/bigint.js'
import { ethSimulateV1FromInput } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import { toResolvedSimulationInput } from '../../app/ts/types/visualizer-types.js'
import { JsonRpcResponseError } from '../../app/ts/utils/errors.js'
import { createSimulationModeTestContext, blockNumber, createDappEthSimulateV1Request, createSimulationStateInput, createTwoBlockSimulationStateInput, testBytes32 } from './simulationModeEthereumClientServiceTestHelpers.js'

const { requestHandler, ethereum, createEthereumWithThrowingSimulationPreparation, getBlockNumberFromInput, getBlockFromInput } = createSimulationModeTestContext()

describe('SimulationModeEthereumClientService', () => {
	test('input-based eth_simulateV1 prepends simulated stack for latest parent block', async () => {
		requestHandler.ethSimulateV1Calls.length = 0
		const simulationStateInput = createSimulationStateInput()
		const simulatedLatestBlock = await getBlockFromInput(simulationStateInput, 'latest')
		if (simulatedLatestBlock === null) throw new Error('missing simulated latest block')

		const result = await ethSimulateV1FromInput(ethereum, undefined, toResolvedSimulationInput(simulationStateInput), createDappEthSimulateV1Request())

		assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.blockStateCallCount, 2)
		assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.traceTransfers, false)
		assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.validation, false)
		assert.equal(result.length, 1)
		assert.equal(result[0]?.calls.length, 1)
		assert.equal(result[0]?.parentHash, simulatedLatestBlock.hash)
	})

	test('input-based eth_simulateV1 rejects validation true when a simulated stack prefix is needed', async () => {
		requestHandler.ethSimulateV1Calls.length = 0

		await assert.rejects(
			async () => await ethSimulateV1FromInput(ethereum, undefined, toResolvedSimulationInput(createSimulationStateInput()), createDappEthSimulateV1Request('latest', true)),
			(error: unknown) => {
				assert.ok(error instanceof JsonRpcResponseError)
				assert.equal(error.code, -32602)
				assert.match(error.message, /validation: true/)
				return true
			},
		)
		assert.equal(requestHandler.ethSimulateV1Calls.length, 0)
	})

	test('input-based eth_simulateV1 does not prepend simulated stack for explicit real parent block', async () => {
		requestHandler.ethSimulateV1Calls.length = 0

		const result = await ethSimulateV1FromInput(ethereum, undefined, toResolvedSimulationInput(createSimulationStateInput()), createDappEthSimulateV1Request(blockNumber))

		assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.blockStateCallCount, 1)
		assert.equal(result.length, 1)
	})

	test('input-based eth_simulateV1 preserves validation true for explicit real parent block passthrough', async () => {
		requestHandler.ethSimulateV1Calls.length = 0

		const result = await ethSimulateV1FromInput(ethereum, undefined, toResolvedSimulationInput(createSimulationStateInput()), createDappEthSimulateV1Request(blockNumber, true))

		assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.blockStateCallCount, 1)
		assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.validation, true)
		assert.equal(result.length, 1)
	})

	test('input-based eth_simulateV1 real parent block passthrough does not prepare the simulation stack', async () => {
		requestHandler.ethSimulateV1Calls.length = 0
		const throwingClient = createEthereumWithThrowingSimulationPreparation()

		const result = await ethSimulateV1FromInput(throwingClient.ethereum, undefined, toResolvedSimulationInput(createSimulationStateInput()), createDappEthSimulateV1Request(blockNumber))

		assert.equal(throwingClient.getPrepareCallCount(), 0)
		assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.blockStateCallCount, 1)
		assert.equal(result.length, 1)
	})

	test('input-based eth_simulateV1 prepends simulated stack for explicit simulated parent block', async () => {
		requestHandler.ethSimulateV1Calls.length = 0
		const simulationStateInput = createSimulationStateInput()
		const simulatedLatestBlock = await getBlockFromInput(simulationStateInput, 'latest')
		if (simulatedLatestBlock === null) throw new Error('missing simulated latest block')

		const result = await ethSimulateV1FromInput(ethereum, undefined, toResolvedSimulationInput(simulationStateInput), createDappEthSimulateV1Request(blockNumber + 1n))

		assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.blockStateCallCount, 2)
		assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.parentBlockTag, blockNumber)
		assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.validation, false)
		assert.equal(result.length, 1)
		assert.equal(result[0]?.parentHash, simulatedLatestBlock.hash)
	})

	test('input-based eth_simulateV1 prepends only relevant simulated stack prefix for explicit simulated parent block', async () => {
		requestHandler.ethSimulateV1Calls.length = 0
		const simulationStateInput = createTwoBlockSimulationStateInput()
		const firstSimulatedBlock = await getBlockFromInput(simulationStateInput, blockNumber + 1n)
		if (firstSimulatedBlock === null) throw new Error('missing first simulated block')

		assert.equal(await getBlockNumberFromInput(simulationStateInput), blockNumber + 2n)

		const result = await ethSimulateV1FromInput(ethereum, undefined, toResolvedSimulationInput(simulationStateInput), createDappEthSimulateV1Request(blockNumber + 1n))

		assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.blockStateCallCount, 2)
		assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.parentBlockTag, blockNumber)
		assert.equal(result.length, 1)
		assert.equal(result[0]?.parentHash, firstSimulatedBlock.hash)
	})

	test('input-based eth_simulateV1 preserves explicit parent block hashes', async () => {
		requestHandler.ethSimulateV1Calls.length = 0
		const parentBlockHash = testBytes32('abcd')

		const result = await ethSimulateV1FromInput(ethereum, undefined, toResolvedSimulationInput(createSimulationStateInput()), createDappEthSimulateV1Request(parentBlockHash))

		assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.blockStateCallCount, 1)
		assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.parentBlockTag, parentBlockHash)
		assert.equal(result.length, 1)
	})

	test('input-based eth_simulateV1 real parent block hash passthrough does not prepare the simulation stack', async () => {
		requestHandler.ethSimulateV1Calls.length = 0
		const parentBlockHash = testBytes32('abcd')
		const throwingClient = createEthereumWithThrowingSimulationPreparation()

		const result = await ethSimulateV1FromInput(throwingClient.ethereum, undefined, toResolvedSimulationInput(createSimulationStateInput()), createDappEthSimulateV1Request(parentBlockHash))

		assert.equal(throwingClient.getPrepareCallCount(), 0)
		assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.blockStateCallCount, 1)
		assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.parentBlockTag, parentBlockHash)
		assert.equal(result.length, 1)
	})

	test('input-based eth_simulateV1 parent block hash classification failure forwards the dapp request', async () => {
		requestHandler.ethSimulateV1Calls.length = 0
		const parentBlockHash = testBytes32('c0de')
		requestHandler.ethGetBlockByHashErrorsByHash.set(BigInt(parentBlockHash), new Error('block hash lookup failed'))
		const throwingClient = createEthereumWithThrowingSimulationPreparation()
		try {
			const result = await ethSimulateV1FromInput(throwingClient.ethereum, undefined, toResolvedSimulationInput(createSimulationStateInput()), createDappEthSimulateV1Request(parentBlockHash))

			assert.equal(throwingClient.getPrepareCallCount(), 0)
			assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.blockStateCallCount, 1)
			assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.parentBlockTag, parentBlockHash)
			assert.equal(result.length, 1)
		} finally {
			requestHandler.ethGetBlockByHashErrorsByHash.clear()
		}
	})

	test('input-based eth_simulateV1 unknown parent block hash falls back when simulation stack preparation fails', async () => {
		requestHandler.ethSimulateV1Calls.length = 0
		const parentBlockHash = testBytes32('beef')
		const throwingClient = createEthereumWithThrowingSimulationPreparation()

		const result = await ethSimulateV1FromInput(throwingClient.ethereum, undefined, toResolvedSimulationInput(createSimulationStateInput()), createDappEthSimulateV1Request(parentBlockHash))

		assert.equal(throwingClient.getPrepareCallCount(), 1)
		assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.blockStateCallCount, 1)
		assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.parentBlockTag, parentBlockHash)
		assert.equal(result.length, 1)
	})

	test('input-based eth_simulateV1 prepends simulated stack for explicit simulated parent block hashes', async () => {
		requestHandler.ethSimulateV1Calls.length = 0
		const simulationStateInput = createSimulationStateInput()
		const simulatedLatestBlock = await getBlockFromInput(simulationStateInput, 'latest')
		if (simulatedLatestBlock === null) throw new Error('missing simulated latest block')

		const result = await ethSimulateV1FromInput(ethereum, undefined, toResolvedSimulationInput(simulationStateInput), createDappEthSimulateV1Request(bytes32String(simulatedLatestBlock.hash)))

		assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.blockStateCallCount, 2)
		assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.parentBlockTag, blockNumber)
		assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.validation, false)
		assert.equal(result.length, 1)
		assert.equal(result[0]?.parentHash, simulatedLatestBlock.hash)
	})

	test('input-based eth_simulateV1 treats a missing parent block as latest', async () => {
		requestHandler.ethSimulateV1Calls.length = 0
		const simulationStateInput = createSimulationStateInput()
		const simulatedLatestBlock = await getBlockFromInput(simulationStateInput, 'latest')
		if (simulatedLatestBlock === null) throw new Error('missing simulated latest block')

		const result = await ethSimulateV1FromInput(ethereum, undefined, toResolvedSimulationInput(simulationStateInput), createDappEthSimulateV1Request(undefined))

		assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.blockStateCallCount, 2)
		assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.parentBlockTag, blockNumber)
		assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.validation, false)
		assert.equal(result.length, 1)
		assert.equal(result[0]?.parentHash, simulatedLatestBlock.hash)
	})
})
