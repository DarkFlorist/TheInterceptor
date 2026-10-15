import { describe, test } from 'bun:test'
import * as assert from 'node:assert'
import { isAbiDataDecodeError } from '../../app/ts/utils/ethereumPrimitives.js'
import { addressString, bytes32String, dataStringWith0xStart } from '../../app/ts/utils/bigint.js'
import { serialize } from '../../app/ts/types/wire-types.js'
import { createSimulationState, getSimulatedCode, getSimulatedCodeFromInput, getSimulatedFeeHistory, getSimulatedStorageAtFromInput } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import { EthereumJsonRpcRequest } from '../../app/ts/types/JsonRpc-types.js'
import { RPCReply } from '../../app/ts/types/interceptor-messages.js'
import { toResolvedSimulationInput, toResolvedSimulationState } from '../../app/ts/types/visualizer-types.js'
import { decodeFunctionDataStrict } from '../../app/ts/utils/abiRuntime.js'
import { STORAGE_READER_ABI, STORAGE_READER_PRECOMPILE_RELOCATION_ADDRESS } from '../../app/ts/simulation/storageReader.js'
import { getStorageReaderByteCode } from '../../app/ts/utils/ethereumByteCodes.js'
import { createSimulationModeTestContext, blockNumber, createSimulationStateInput, createTwoBlockSimulationStateInput, SHA256_PRECOMPILE_ADDRESS, testBytes32 } from './simulationModeEthereumClientServiceTestHelpers.js'

const { requestHandler, ethereum, createAbortRecordingEthereum } = createSimulationModeTestContext()

describe('SimulationModeEthereumClientService', () => {
	test('getSimulatedCodeFromInput installs the helper override and omits gas', async () => {
		requestHandler.ethSimulateV1Calls.length = 0
		const simulatedCode = await getSimulatedCodeFromInput(ethereum, undefined, toResolvedSimulationInput(createSimulationStateInput()), 0x1234n)
		assert.equal(simulatedCode.statusCode, 'success')
		if (simulatedCode.statusCode !== 'success') throw new Error('simulated code unexpectedly failed')
		assert.equal(dataStringWith0xStart(simulatedCode.getCodeReturn), '0x1234')
		assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.lastCallGas, undefined)
		assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.hasGetCodeOverride, true)
	})

	test('getSimulatedCodeFromInput propagates malformed code lookup output', async () => {
		requestHandler.malformedGetCodeReturn = true
		try {
			await assert.rejects(async () => await getSimulatedCodeFromInput(ethereum, undefined, toResolvedSimulationInput(createSimulationStateInput()), 0x1234n), isAbiDataDecodeError)
		} finally {
			requestHandler.malformedGetCodeReturn = false
		}
	})

	test('getSimulatedCode installs the helper override and propagates malformed output', async () => {
		const simulationState = await createSimulationState(ethereum, undefined, createSimulationStateInput())
		if (simulationState.success === false) throw new Error('simulation unexpectedly failed')
		requestHandler.malformedGetCodeReturn = true
		try {
			await assert.rejects(async () => await getSimulatedCode(ethereum, undefined, toResolvedSimulationState(simulationState), 0x1234n), isAbiDataDecodeError)
			assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.hasGetCodeOverride, true)
		} finally {
			requestHandler.malformedGetCodeReturn = false
		}
	})

	test('getSimulatedStorageAtFromInput reads storage after the simulated state overlay', async () => {
		requestHandler.ethSimulateV1Calls.length = 0
		requestHandler.ethSimulateV1Requests.length = 0
		const address = 0x1234n
		const slot = 0x42n
		const expectedStorageValue = 0x1234n
		const simulationStateInput = createSimulationStateInput()
		const stateWithStorageOverride = [{
			...simulationStateInput[0],
			stateOverrides: {
				[addressString(address)]: {
					stateDiff: { [bytes32String(slot)]: expectedStorageValue },
				},
			},
		}] as const
		const storage = await getSimulatedStorageAtFromInput(
			ethereum,
			undefined,
			toResolvedSimulationInput(stateWithStorageOverride),
			address,
			slot,
		)

		assert.equal(storage, expectedStorageValue)
		assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.blockStateCallCount, 2)
		assert.equal(requestHandler.ethSimulateV1Requests.length, 2)
		const relocationProbe = requestHandler.ethSimulateV1Requests[0]
		const relocationProbeOverride = relocationProbe?.params[0].blockStateCalls.at(-1)?.stateOverrides?.[addressString(address)]
		assert.equal(relocationProbeOverride?.movePrecompileToAddress, STORAGE_READER_PRECOMPILE_RELOCATION_ADDRESS)
		const storageRequest = requestHandler.ethSimulateV1Requests.at(-1)
		const storageBlock = storageRequest?.params[0].blockStateCalls.at(-1)
		const storageCall = storageBlock?.calls[0]
		assert.equal(storageCall?.to, address)
		if (storageCall?.input === undefined) throw new Error('missing storage reader call input')
		const decodedStorageCall = decodeFunctionDataStrict(STORAGE_READER_ABI, dataStringWith0xStart(storageCall.input))
		assert.equal(decodedStorageCall.functionName, 'readSlot')
		assert.deepEqual(decodedStorageCall.args, [bytes32String(slot)])
		const overrideCode = storageBlock?.stateOverrides?.[addressString(address)]?.code
		assert.equal(storageBlock?.stateOverrides?.[addressString(address)]?.movePrecompileToAddress, undefined)
		assert.deepEqual(overrideCode, getStorageReaderByteCode())
	})

	test('getSimulatedStorageAtFromInput relocates a precompile before reading its simulated storage', async () => {
		requestHandler.ethSimulateV1Requests.length = 0
		const slot = 0x42n
		const expectedStorageValue = 0x5678n
		const [simulationBlock] = createSimulationStateInput()
		const simulationStateInput = [{
			...simulationBlock,
			stateOverrides: {
				[addressString(SHA256_PRECOMPILE_ADDRESS)]: {
					stateDiff: { [bytes32String(slot)]: expectedStorageValue },
				},
			},
		}] as const

		const storage = await getSimulatedStorageAtFromInput(
			ethereum,
			undefined,
			toResolvedSimulationInput(simulationStateInput),
			SHA256_PRECOMPILE_ADDRESS,
			slot,
		)

		assert.equal(storage, expectedStorageValue)
		const storageRequest = requestHandler.ethSimulateV1Requests.at(-1)
		const readerOverride = storageRequest?.params[0].blockStateCalls.at(-1)?.stateOverrides?.[addressString(SHA256_PRECOMPILE_ADDRESS)]
		assert.equal(readerOverride?.movePrecompileToAddress, STORAGE_READER_PRECOMPILE_RELOCATION_ADDRESS)
		assert.notEqual(readerOverride?.movePrecompileToAddress, SHA256_PRECOMPILE_ADDRESS)
		assert.deepEqual(readerOverride?.code, getStorageReaderByteCode())
	})

	test('getSimulatedStorageAtFromInput selects the requested simulated block prefix', async () => {
		requestHandler.ethSimulateV1Calls.length = 0
		const address = 0x1234n
		const slot = 0x42n
		const firstBlockStorageValue = 0x1111n
		const secondBlockStorageValue = 0x2222n
		const [firstBlock, secondBlock] = createTwoBlockSimulationStateInput()
		const simulationStateInput = [
			{
				...firstBlock,
				stateOverrides: {
					[addressString(address)]: { stateDiff: { [bytes32String(slot)]: firstBlockStorageValue } },
				},
			},
			{
				...secondBlock,
				stateOverrides: {
					[addressString(address)]: { stateDiff: { [bytes32String(slot)]: secondBlockStorageValue } },
				},
			},
		] as const
		const resolvedInput = toResolvedSimulationInput(simulationStateInput)

		assert.equal(await getSimulatedStorageAtFromInput(ethereum, undefined, resolvedInput, address, slot, blockNumber + 1n), firstBlockStorageValue)
		assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.blockStateCallCount, 2)
		assert.equal(await getSimulatedStorageAtFromInput(ethereum, undefined, resolvedInput, address, slot, 'latest'), secondBlockStorageValue)
		assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.blockStateCallCount, 3)
	})

	test('getSimulatedStorageAtFromInput queries the node for a pre-simulation block', async () => {
		requestHandler.ethGetStorageAtCalls.length = 0
		requestHandler.ethSimulateV1Calls.length = 0
		const address = 0x1234n
		const slot = 0x42n
		const storage = await getSimulatedStorageAtFromInput(
			ethereum,
			undefined,
			toResolvedSimulationInput(createSimulationStateInput()),
			address,
			slot,
			blockNumber,
		)

		assert.equal(storage, 0xbeefn)
		assert.equal(requestHandler.ethGetStorageAtCalls.length, 1)
		const storageRequest = requestHandler.ethGetStorageAtCalls[0]
		if (storageRequest?.method !== 'eth_getStorageAt') throw new Error('Expected an eth_getStorageAt request')
		assert.deepEqual(storageRequest.params, [address, slot, blockNumber])
		assert.equal(requestHandler.ethSimulateV1Calls.length, 0)
	})

	test('Ethereum client storage replies round-trip the accepted empty 0x response', async () => {
		requestHandler.storageResponse = '0x'
		try {
			const storage = await ethereum.getStorageAt(0x1234n, 0x42n, 'latest', undefined)
			assert.equal(storage, 0n)
			const reply: RPCReply = { type: 'result', method: 'eth_getStorageAt', result: storage }
			const serializedReply = serialize<RPCReply, typeof RPCReply>(RPCReply, reply)
			assert.deepEqual(serializedReply, { type: 'result', method: 'eth_getStorageAt', result: testBytes32('0') })
			assert.deepEqual(RPCReply.parse(serializedReply), reply)
		} finally {
			requestHandler.storageResponse = testBytes32('beef')
		}
	})

	test('Ethereum client validates eth_maxPriorityFeePerGas responses and rejects malformed quantities', async () => {
		const priorityFee = await ethereum.getMaxPriorityFeePerGas(undefined)
		assert.equal(priorityFee, 1_000_000_000n)
		assert.equal(EthereumJsonRpcRequest.parse({ method: 'eth_maxPriorityFeePerGas' }).method, 'eth_maxPriorityFeePerGas')
		const reply: RPCReply = { type: 'result', method: 'eth_maxPriorityFeePerGas', result: priorityFee }
		const serializedReply = serialize<RPCReply, typeof RPCReply>(RPCReply, reply)
		assert.deepEqual(serializedReply, { type: 'result', method: 'eth_maxPriorityFeePerGas', result: '0x3b9aca00' })
		assert.deepEqual(RPCReply.parse(serializedReply), reply)
		requestHandler.maxPriorityFeePerGasResponse = '1'
		try {
			await assert.rejects(async () => await ethereum.getMaxPriorityFeePerGas(undefined))
		} finally {
			requestHandler.maxPriorityFeePerGasResponse = '0x3b9aca00'
		}
	})

	test('getSimulatedFeeHistory calculates fractional reward percentiles', async () => {
		const feeHistory = await getSimulatedFeeHistory(ethereum, undefined, {
			method: 'eth_feeHistory',
			params: [1n, 'latest', [0.5, 25.25, 99.999]],
		})

		assert.equal(feeHistory.reward?.[0]?.length, 3)
	})

	test('getSimulatedFeeHistory returns the requested block range from the node', async () => {
		requestHandler.ethFeeHistoryCalls.length = 0
		const feeHistory = await getSimulatedFeeHistory(ethereum, undefined, {
			method: 'eth_feeHistory',
			params: [5n, 'latest', [25, 75]],
		})

		assert.equal(feeHistory.gasUsedRatio.length, 5)
		assert.equal(feeHistory.baseFeePerGas.length, 6)
		assert.equal(feeHistory.reward?.length, 5)
		assert.deepEqual(requestHandler.ethFeeHistoryCalls.at(-1), { method: 'eth_feeHistory', params: [5n, 'latest', [25, 75]] })
	})

	test('state-based code lookups forward the request abort controller to the simulation', async () => {
		const simulationState = await createSimulationState(ethereum, undefined, createSimulationStateInput())
		if (simulationState.success === false) throw new Error('simulation unexpectedly failed')
		const { ethereum: recordingEthereum, rpcCalls } = createAbortRecordingEthereum()
		const requestAbortController = new AbortController()
		const simulatedCode = await getSimulatedCode(recordingEthereum, requestAbortController, toResolvedSimulationState(simulationState), 0x1234n)

		assert.equal(simulatedCode.statusCode, 'success')
		assert.ok(rpcCalls.some((call) => call.method === 'eth_simulateV1'))
		assert.ok(rpcCalls.every((call) => call.requestAbortController === requestAbortController))
	})
})
