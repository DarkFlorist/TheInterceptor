import { describe, test } from 'bun:test'
import * as assert from 'node:assert'
import { createSimulationCallParams, createSimulationState, getSimulatedCode, getSimulatedTransactionCount, getSimulatedTransactionCountFromInput, simulateEstimateGas, simulateEstimateGasFromInput, simulatedCall, simulatedCallFromInput } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import { PASSTHROUGH_STATE, toResolvedSimulationInput, toResolvedSimulationState } from '../../app/ts/types/visualizer-types.js'
import { JsonRpcResponseError } from '../../app/ts/utils/errors.js'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import { authorization as eip7702Authorization } from 'micro-eth-signer'
import { createSimulationModeTestContext, blockNumber, createSimulationStateInput, createTwoBlockSimulationStateInput, exampleTransaction, rpcNetwork } from './simulationModeEthereumClientServiceTestHelpers.js'

const { requestHandler, ethereum } = createSimulationModeTestContext()
const emptySimulationInput = toResolvedSimulationInput([])

describe('SimulationModeEthereumClientService', () => {
	test('simulateEstimateGasFromInput omits gas when input gas is omitted', async () => {
		requestHandler.ethSimulateV1Calls.length = 0
		const estimateGas = await simulateEstimateGasFromInput(ethereum, undefined, emptySimulationInput, {
			from: exampleTransaction.from,
			to: exampleTransaction.to,
			value: exampleTransaction.value,
			input: exampleTransaction.input,
		})
		if ('error' in estimateGas) throw new Error(`estimate gas unexpectedly failed: ${ estimateGas.error.message }`)
		assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.lastCallGas, undefined)
	})

	test('simulateEstimateGasFromInput uses the node-reported peak gas', async () => {
		requestHandler.simulatedCallGasUsed = 11_332n
		requestHandler.simulatedCallMaxUsedGas = 61_000n
		try {
			const estimateGas = await simulateEstimateGasFromInput(ethereum, undefined, emptySimulationInput, {
				from: exampleTransaction.from,
				to: exampleTransaction.to,
				value: 0n,
				input: new Uint8Array(1_000).fill(1),
			})

			if ('error' in estimateGas) throw new Error(`estimate gas unexpectedly failed: ${ estimateGas.error.message }`)
			assert.equal(estimateGas.gas, 76_250n)
		} finally {
			requestHandler.simulatedCallGasUsed = undefined
			requestHandler.simulatedCallMaxUsedGas = undefined
		}
	})

	test('simulateEstimateGas uses the node-reported peak gas', async () => {
		const simulationState = await createSimulationState(ethereum, undefined, createSimulationStateInput())
		if (simulationState.success === false) throw new Error('simulation unexpectedly failed')
		requestHandler.simulatedCallGasUsed = 11_332n
		requestHandler.simulatedCallMaxUsedGas = 61_000n
		try {
			const estimateGas = await simulateEstimateGas(ethereum, undefined, toResolvedSimulationState(simulationState), {
				from: exampleTransaction.from,
				to: exampleTransaction.to,
				value: 0n,
				input: new Uint8Array(1_000).fill(1),
			})

			if ('error' in estimateGas) throw new Error(`estimate gas unexpectedly failed: ${ estimateGas.error.message }`)
			assert.equal(estimateGas.gas, 76_250n)
		} finally {
			requestHandler.simulatedCallGasUsed = undefined
			requestHandler.simulatedCallMaxUsedGas = undefined
		}
	})

	test('simulateEstimateGasFromInput adaptively verifies gas when maxUsedGas is omitted', async () => {
		requestHandler.ethSimulateV1Calls.length = 0
		requestHandler.omitMaxUsedGas = true
		requestHandler.simulatedCallGasUsed = 11_332n
		requestHandler.minimumSuccessfulGasLimit = 113_000n
		try {
			const estimateGas = await simulateEstimateGasFromInput(ethereum, undefined, emptySimulationInput, {
				from: exampleTransaction.from,
				to: exampleTransaction.to,
				value: 0n,
				input: new Uint8Array(1_000).fill(1),
			})

			if ('error' in estimateGas) throw new Error(`estimate gas unexpectedly failed: ${ estimateGas.error.message }`)
			assert.equal(estimateGas.gas, 141_650n)
			assert.deepEqual(requestHandler.ethSimulateV1Calls.map((call) => call.lastCallGas), [undefined, 14_165n, 28_330n, 56_660n, 113_320n])
		} finally {
			requestHandler.omitMaxUsedGas = false
			requestHandler.simulatedCallGasUsed = undefined
			requestHandler.minimumSuccessfulGasLimit = undefined
		}
	})

	test('simulateEstimateGas adaptively verifies gas when maxUsedGas is omitted', async () => {
		const simulationState = await createSimulationState(ethereum, undefined, createSimulationStateInput())
		if (simulationState.success === false) throw new Error('simulation unexpectedly failed')
		requestHandler.ethSimulateV1Calls.length = 0
		requestHandler.omitMaxUsedGas = true
		requestHandler.simulatedCallGasUsed = 11_332n
		requestHandler.minimumSuccessfulGasLimit = 113_000n
		try {
			const estimateGas = await simulateEstimateGas(ethereum, undefined, toResolvedSimulationState(simulationState), {
				from: exampleTransaction.from,
				to: exampleTransaction.to,
				value: 0n,
				input: new Uint8Array(1_000).fill(1),
			})

			if ('error' in estimateGas) throw new Error(`estimate gas unexpectedly failed: ${ estimateGas.error.message }`)
			assert.equal(estimateGas.gas, 141_650n)
			assert.deepEqual(requestHandler.ethSimulateV1Calls.map((call) => call.lastCallGas), [undefined, 14_165n, 28_330n, 56_660n, 113_320n])
		} finally {
			requestHandler.omitMaxUsedGas = false
			requestHandler.simulatedCallGasUsed = undefined
			requestHandler.minimumSuccessfulGasLimit = undefined
		}
	})

	test('simulateEstimateGasFromInput preserves explicit gas', async () => {
		requestHandler.ethSimulateV1Calls.length = 0
		const explicitGas = 54_321n
		const estimateGas = await simulateEstimateGasFromInput(ethereum, undefined, emptySimulationInput, {
			from: exampleTransaction.from,
			to: exampleTransaction.to,
			value: exampleTransaction.value,
			input: exampleTransaction.input,
			gas: explicitGas,
		})
		if ('error' in estimateGas) throw new Error(`estimate gas unexpectedly failed: ${ estimateGas.error.message }`)
		assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.lastCallGas, explicitGas)
	})

	test('eth_call simulation parameters preserve gas, fee, and access-list fields', () => {
		const accessList = [{ address: 0x2n, storageKeys: [0x42n] }] as const
		const params = createSimulationCallParams({
			to: 0x2n,
			gas: 54_321n,
			maxFeePerGas: 99n,
			maxPriorityFeePerGas: 3n,
			accessList,
		}, 0x1n)

		assert.equal(params.gasLimit, 54_321n)
		assert.equal(params.maxFeePerGas, 99n)
		assert.equal(params.maxPriorityFeePerGas, 3n)
		assert.deepEqual(params.accessList, accessList)
	})

	test('gas estimation preserves access lists in both simulation-state paths', async () => {
		const accessList = [{ address: 0x2n, storageKeys: [0x42n] }] as const
		const transaction = {
			from: exampleTransaction.from,
			to: exampleTransaction.to,
			value: exampleTransaction.value,
			input: exampleTransaction.input,
			accessList,
		}

		const fromInputEstimate = await simulateEstimateGasFromInput(ethereum, undefined, emptySimulationInput, transaction)
		if ('error' in fromInputEstimate) throw new Error(`estimate gas unexpectedly failed: ${ fromInputEstimate.error.message }`)
		const fromInputRequest = requestHandler.ethSimulateV1Requests.at(-1)
		assert.deepEqual(fromInputRequest?.params[0].blockStateCalls.at(-1)?.calls[0]?.accessList, accessList)

		const simulationState = await createSimulationState(ethereum, undefined, createSimulationStateInput())
		if (simulationState.success === false) throw new Error('simulation unexpectedly failed')
		const fromStateEstimate = await simulateEstimateGas(ethereum, undefined, toResolvedSimulationState(simulationState), transaction)
		if ('error' in fromStateEstimate) throw new Error(`estimate gas unexpectedly failed: ${ fromStateEstimate.error.message }`)
		const fromStateRequest = requestHandler.ethSimulateV1Requests.at(-1)
		assert.deepEqual(fromStateRequest?.params[0].blockStateCalls.at(-1)?.calls[0]?.accessList, accessList)
	})

	test('simulateEstimateGasFromInput validates and projects signed 7702 authorizations', async () => {
		requestHandler.ethSimulateV1Calls.length = 0
		const clearDelegationAuthorization = eip7702Authorization.sign({
			address: '0x0000000000000000000000000000000000000000',
			chainId: 5n,
			nonce: 3n,
		}, '0x0000000000000000000000000000000000000000000000000000000000000002')
		// Wallet-provided authorizations can carry the recovered authority, which the request type does not declare; it must not be forwarded.
		const authorizationWithAuthority = {
			chainId: BigInt(clearDelegationAuthorization.chainId),
			address: BigInt(clearDelegationAuthorization.address),
			nonce: BigInt(clearDelegationAuthorization.nonce),
			authority: 0x0000000000000000000000000000000000000004n,
			r: BigInt(clearDelegationAuthorization.r),
			s: BigInt(clearDelegationAuthorization.s),
			yParity: clearDelegationAuthorization.yParity === 0 ? 'even' : 'odd',
		} as const
		const estimateGas = await simulateEstimateGasFromInput(ethereum, undefined, emptySimulationInput, {
			type: '7702',
			from: exampleTransaction.from,
			to: exampleTransaction.to,
			value: exampleTransaction.value,
			input: exampleTransaction.input,
			authorizationList: [authorizationWithAuthority],
		})

		if ('error' in estimateGas) throw new Error(`estimate gas unexpectedly failed: ${ estimateGas.error.message }`)
		const [authorization] = requestHandler.ethSimulateV1Calls.at(-1)?.lastCallAuthorizationList ?? []
		if (authorization === undefined) throw new Error('authorization missing')
		assert.deepEqual(authorization, {
			chainId: BigInt(clearDelegationAuthorization.chainId),
			address: BigInt(clearDelegationAuthorization.address),
			nonce: BigInt(clearDelegationAuthorization.nonce),
			r: BigInt(clearDelegationAuthorization.r),
			s: BigInt(clearDelegationAuthorization.s),
			yParity: clearDelegationAuthorization.yParity === 0 ? 'even' : 'odd',
		})
		assert.equal('authority' in authorization, false)
	})

	test('simulateEstimateGasFromInput rejects partial signed 7702 authorizations', async () => {
		// Carries a wallet-provided authority, like the test above, but no yParity.
		const partialAuthorizationWithAuthority = {
			chainId: 5n,
			address: 0n,
			nonce: 3n,
			authority: 0x0000000000000000000000000000000000000004n,
			r: 0x11n,
			s: 0x22n,
		}
		await assert.rejects(
			async () => await simulateEstimateGasFromInput(ethereum, undefined, emptySimulationInput, {
				type: '7702',
				from: exampleTransaction.from,
				to: exampleTransaction.to,
				value: exampleTransaction.value,
				input: exampleTransaction.input,
				authorizationList: [partialAuthorizationWithAuthority],
			}),
			/EIP-7702 authorization signature is missing required fields/
		)
	})

	test('simulateEstimateGas rejects partial signed 7702 authorizations', async () => {
		// The state-based transaction type has no authority field, so the input-shaped authorization is passed as a variable rather than an object literal.
		const partialSignedAuthorization = {
			chainId: 5n,
			address: 0n,
			nonce: 3n,
			authority: 0x0000000000000000000000000000000000000004n,
			r: 0x11n,
			s: 0x22n,
		}
		await assert.rejects(
			async () => await simulateEstimateGas(ethereum, undefined, toResolvedSimulationState({
				success: true,
				simulationStateInput: [],
				simulatedBlocks: [],
				blockNumber,
				blockTimestamp: new Date('2024-01-01T00:00:00.000Z'),
				baseFeePerGas: 1n,
				simulationConductedTimestamp: new Date('2024-01-01T00:00:00.000Z'),
				rpcNetwork,
			}), {
				type: '7702',
				from: exampleTransaction.from,
				to: exampleTransaction.to,
				value: exampleTransaction.value,
				input: exampleTransaction.input,
				authorizationList: [partialSignedAuthorization],
			}),
			/EIP-7702 authorization signature is missing required fields/
		)
	})

	test('simulatedCallFromInput omits gas when gasLimit is omitted', async () => {
		requestHandler.ethSimulateV1Calls.length = 0
		const callResult = await simulatedCallFromInput(ethereum, undefined, emptySimulationInput, {
			from: exampleTransaction.from,
			to: exampleTransaction.to,
			value: exampleTransaction.value,
			input: exampleTransaction.input,
			maxFeePerGas: 0n,
			maxPriorityFeePerGas: 0n,
		})
		if ('error' in callResult) throw new Error(`simulated call unexpectedly failed: ${ callResult.error?.message }`)
		assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.lastCallGas, undefined)
	})

	test('simulatedCallFromInput preserves explicit gasLimit', async () => {
		requestHandler.ethSimulateV1Calls.length = 0
		const gasLimit = 65_432n
		const callResult = await simulatedCallFromInput(ethereum, undefined, emptySimulationInput, {
			from: exampleTransaction.from,
			to: exampleTransaction.to,
			value: exampleTransaction.value,
			input: exampleTransaction.input,
			maxFeePerGas: 0n,
			maxPriorityFeePerGas: 0n,
			gasLimit,
		})
		if ('error' in callResult) throw new Error(`simulated call unexpectedly failed: ${ callResult.error?.message }`)
		assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.lastCallGas, gasLimit)
	})

	test('simulateEstimateGasFromInput surfaces RPC errors when omitted gas is rejected', async () => {
		requestHandler.ethSimulateV1Calls.length = 0
		requestHandler.rejectOmittedGas = true
		try {
			const estimateGas = await simulateEstimateGasFromInput(ethereum, undefined, emptySimulationInput, {
				from: exampleTransaction.from,
				to: exampleTransaction.to,
				value: exampleTransaction.value,
				input: exampleTransaction.input,
			})
			if (!('error' in estimateGas)) throw new Error('estimate gas unexpectedly succeeded')
			assert.equal(estimateGas.error.code, -32000)
			assert.equal(estimateGas.error.message, 'gas required')
			assert.equal(requestHandler.ethSimulateV1Calls.length, 1)
		} finally {
			requestHandler.rejectOmittedGas = false
		}
	})

	test('state-based readers report the RPC error of a failed simulation for simulated block tags', async () => {
		const failedState = toResolvedSimulationState({
			success: false,
			simulationStateInput: createSimulationStateInput(),
			jsonRpcError: { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'simulation failed' } },
			blockNumber,
			blockTimestamp: new Date('2024-01-01T00:00:00.000Z'),
			baseFeePerGas: 1n,
			simulationConductedTimestamp: new Date('2024-01-01T00:00:00.000Z'),
			rpcNetwork,
		})
		const isSimulationFailure = (error: unknown) => error instanceof JsonRpcResponseError && error.message === 'simulation failed'
		const callParams = { from: exampleTransaction.from, to: exampleTransaction.to, value: 0n, input: new Uint8Array(), maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }

		await assert.rejects(getSimulatedTransactionCount(ethereum, undefined, failedState, exampleTransaction.from), isSimulationFailure)
		await assert.rejects(simulateEstimateGas(ethereum, undefined, failedState, { from: exampleTransaction.from, to: exampleTransaction.to }), isSimulationFailure)
		await assert.rejects(simulatedCall(ethereum, undefined, failedState, callParams), isSimulationFailure)
		assert.deepEqual(await getSimulatedCode(ethereum, undefined, failedState, 0x1234n), { statusCode: 'failure' })
		assert.equal(await getSimulatedTransactionCount(ethereum, undefined, failedState, exampleTransaction.from, 'safe'), 0n)
	})

	test('getSimulatedCode passes on RPC errors from reading the node instead of reporting a failed lookup', async () => {
		const nodeError = new JsonRpcResponseError({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'node unavailable' } })
		const failingNodeEthereum = new EthereumClientService({
			rpcUrl: requestHandler.rpcUrl,
			clearCache: requestHandler.clearCache,
			getChainId: requestHandler.getChainId,
			jsonRpcRequest: async (rpcRequest) => {
				if (rpcRequest.method === 'eth_getCode') throw nodeError
				return await requestHandler.jsonRpcRequest(rpcRequest)
			},
		}, async () => undefined, async () => undefined, rpcNetwork)
		const simulatedState = toResolvedSimulationState(await createSimulationState(ethereum, undefined, createSimulationStateInput()))

		await assert.rejects(getSimulatedCode(failingNodeEthereum, undefined, PASSTHROUGH_STATE, 0x1234n), (error: unknown) => error === nodeError)
		await assert.rejects(getSimulatedCode(failingNodeEthereum, undefined, simulatedState, 0x1234n, 'earliest'), (error: unknown) => error === nodeError)
	})

	test('state-based nonce and gas estimation match the input-based path', async () => {
		const simulationStateInput = createTwoBlockSimulationStateInput()
		const simulationState = await createSimulationState(ethereum, undefined, simulationStateInput)
		if (simulationState.success === false) throw new Error('simulation unexpectedly failed')
		const resolvedState = toResolvedSimulationState(simulationState)
		const resolvedInput = toResolvedSimulationInput(simulationStateInput)
		const estimateRequest = { from: exampleTransaction.from, to: exampleTransaction.to, value: 0n, input: new Uint8Array() }

		assert.equal(await getSimulatedTransactionCount(ethereum, undefined, resolvedState, exampleTransaction.from), 2n)
		assert.equal(await getSimulatedTransactionCountFromInput(ethereum, undefined, resolvedInput, exampleTransaction.from), 2n)
		assert.equal(await getSimulatedTransactionCount(ethereum, undefined, resolvedState, exampleTransaction.from, blockNumber + 1n), 1n)
		const fromStateEstimate = await simulateEstimateGas(ethereum, undefined, resolvedState, estimateRequest)
		const fromStateRequest = requestHandler.ethSimulateV1Requests.at(-1)
		const fromInputEstimate = await simulateEstimateGasFromInput(ethereum, undefined, resolvedInput, estimateRequest)
		const fromInputRequest = requestHandler.ethSimulateV1Requests.at(-1)
		assert.deepEqual(fromStateEstimate, fromInputEstimate)
		assert.deepEqual(fromStateRequest, fromInputRequest)
	})
})
