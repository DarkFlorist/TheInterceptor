// Retained simulation-mode cases use the same mock node as the behavior-focused simulationMode*.test.ts suites.
import { beforeEach, describe, test } from 'bun:test'
import * as assert from 'assert'
import { authorization as eip7702Authorization } from 'micro-eth-signer'
import { isAbiDataDecodeError } from '../../app/ts/utils/ethereumPrimitives.js'
import { addressString, bytes32String, dataStringWith0xStart, stringToUint8Array } from '../../app/ts/utils/bigint.js'
import { serialize } from '../../app/ts/types/wire-types.js'
import { createExecutionSimulationState, createSimulationCallParams, createSimulationState, getBaseFeeAdjustedTransactions, getBaseFeeAdjustmentBalances, getSimulatedBalanceFromInput, getSimulatedBlock, getSimulatedBlockByHashFromInput, getSimulatedBlockFromInput, getSimulatedBlockNumberFromInput, getSimulatedCode, getSimulatedCodeFromInput, getSimulatedFeeHistory, getSimulatedStorageAtFromInput, getSimulatedTransactionByHash, getSimulatedTransactionByHashFromInput, getSimulatedTransactionCount, getSimulatedTransactionCountFromInput, groupEthSimulateV1ResultByInputBlocks, mockSignTransaction, simulateEstimateGas, simulateEstimateGasFromInput, simulatedCall, simulatedCallFromInput } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import { EthereumJsonRpcRequest, } from '../../app/ts/types/JsonRpc-types.js'
import { RPCReply } from '../../app/ts/types/interceptor-messages.js'
import { toResolvedSimulationInput, toResolvedSimulationState } from '../../app/ts/types/visualizer-types.js'
import { Erc20ABI } from '../../app/ts/utils/abi.js'
import { decodeFunctionDataStrict, encodeFunctionCall, } from '../../app/ts/utils/abiRuntime.js'
import { STORAGE_READER_ABI, STORAGE_READER_PRECOMPILE_RELOCATION_ADDRESS } from '../../app/ts/simulation/storageReader.js'
import { getStorageReaderByteCode } from '../../app/ts/utils/ethereumByteCodes.js'

import { createSimulationModeTestContext, blockNumber, rpcNetwork, testBytes32, SHA256_PRECOMPILE_ADDRESS, exampleTransaction, example7702Transaction, createSimulationStateInput, createTwoBlockSimulationStateInput } from './simulationModeEthereumClientServiceTestHelpers.js'


const { requestHandler, ethereum, reset } = createSimulationModeTestContext()
beforeEach(reset)
const getBlockNumberFromInput = async (simulationStateInput: Parameters<typeof toResolvedSimulationInput>[0]) => await getSimulatedBlockNumberFromInput(ethereum, undefined, toResolvedSimulationInput(simulationStateInput))
const getBlockFromInput = async (simulationStateInput: Parameters<typeof toResolvedSimulationInput>[0], blockTag: Parameters<typeof getSimulatedBlockFromInput>[3], includeTransactions = false) => await getSimulatedBlockFromInput(ethereum, undefined, toResolvedSimulationInput(simulationStateInput), blockTag, includeTransactions)
const getBlockByHashFromInput = async (simulationStateInput: Parameters<typeof toResolvedSimulationInput>[0], blockHash: bigint, includeTransactions = false) => await getSimulatedBlockByHashFromInput(ethereum, undefined, toResolvedSimulationInput(simulationStateInput), blockHash, includeTransactions)

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
		await getSimulatedBlock(forwardingEthereum, undefined, resolvedState, 'safe', false)
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

		test('sponsored 7702 authorizations increment both the sponsor and authority nonces', async () => {
			const authority = 0x0000000000000000000000000000000000000004n
			const simulationState = await createSimulationState(ethereum, undefined, [{
				stateOverrides: {},
				transactions: [{
					signedTransaction: mockSignTransaction({
						...example7702Transaction,
						authorizationList: [{
							chainId: example7702Transaction.chainId,
							address: 0n,
							nonce: 0n,
							authority,
							r: 1n,
							s: 2n,
							yParity: 'even',
						}],
					}),
					website: { websiteOrigin: 'test', icon: undefined, title: undefined },
					created: new Date(),
					originalRequestParameters: { method: 'eth_sendTransaction', params: [{ type: '7702', authorizationList: [] }]},
					transactionIdentifier: 103n,
				}],
				signedMessages: [],
				blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
				simulateWithZeroBaseFee: false,
			}])
			if (simulationState.success === false) throw new Error('simulation unexpectedly failed')
			const resolvedState = toResolvedSimulationState(simulationState)
			assert.equal(await getSimulatedTransactionCount(ethereum, undefined, resolvedState, example7702Transaction.from), 1n)
			assert.equal(await getSimulatedTransactionCount(ethereum, undefined, resolvedState, authority), 1n)
		})

		test('input-based nonce and estimation account for sponsored 7702 authorities', async () => {
			const authority = 0x0000000000000000000000000000000000000004n
			const simulationStateInput = [{
				stateOverrides: {},
				transactions: [{
					signedTransaction: mockSignTransaction({
						...example7702Transaction,
						authorizationList: [{
							chainId: example7702Transaction.chainId,
							address: 0n,
							nonce: 0n,
							authority,
							r: 1n,
							s: 2n,
							yParity: 'even',
						}],
					}),
					website: { websiteOrigin: 'test', icon: undefined, title: undefined },
					created: new Date(),
					originalRequestParameters: { method: 'eth_sendTransaction', params: [{ type: '7702', authorizationList: [] }]},
					transactionIdentifier: 105n,
				}],
				signedMessages: [],
				blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
				simulateWithZeroBaseFee: false,
			}] as const
			const resolvedInput = toResolvedSimulationInput(simulationStateInput)
			assert.equal(await getSimulatedTransactionCountFromInput(ethereum, undefined, resolvedInput, example7702Transaction.from), 1n)
			assert.equal(await getSimulatedTransactionCountFromInput(ethereum, undefined, resolvedInput, authority), 1n)

			requestHandler.ethSimulateV1Calls.length = 0
			const estimateGas = await simulateEstimateGasFromInput(ethereum, undefined, resolvedInput, {
				from: authority,
				to: exampleTransaction.to,
				value: 0n,
				input: new Uint8Array(),
			})
			if ('error' in estimateGas) throw new Error(`estimate gas unexpectedly failed: ${ estimateGas.message }`)
			assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.lastCallNonce, 1n)
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

		test('getBaseFeeAdjustedTransactions caps priority fee with affordable max fee', async () => {
			requestHandler.balance = 50n
			requestHandler.ethGetBalanceCalls.length = 0
			requestHandler.ethSimulateV1Calls.length = 0
			const parentBlock = await ethereum.getBlock(undefined)
			const transaction = {
				signedTransaction: mockSignTransaction({
					...exampleTransaction,
					nonce: 0n,
					maxFeePerGas: 999n,
					maxPriorityFeePerGas: 100n,
					gas: 10n,
					value: 0n,
				}),
				website: { websiteOrigin: 'test', icon: undefined, title: undefined },
				created: new Date(),
				originalRequestParameters: { method: 'eth_sendTransaction', params: [{}]},
				transactionIdentifier: 20n,
			} as const
			const currentBlock = {
				stateOverrides: {},
				transactions: [transaction],
				signedMessages: [],
				blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
				simulateWithZeroBaseFee: false,
			} as const

			const { balances, transactions: adjusted } = await getBaseFeeAdjustmentBalances(ethereum, undefined, parentBlock, [], currentBlock)
			assert.deepEqual(adjusted, getBaseFeeAdjustedTransactions(parentBlock, currentBlock.transactions, balances))
			const adjustedTransaction = adjusted[0]?.signedTransaction
			if (adjustedTransaction === undefined || adjustedTransaction.type !== '1559') throw new Error('missing adjusted 1559 transaction')
			assert.equal(adjustedTransaction.maxFeePerGas, 5n)
			assert.equal(adjustedTransaction.maxPriorityFeePerGas, 5n)
			assert.equal(requestHandler.ethGetBalanceCalls.length, 1)
			assert.equal(requestHandler.ethSimulateV1Calls.length, 0)
		})

		test('getBaseFeeAdjustedTransactions adjusts type-7702 fee-market transactions', async () => {
			requestHandler.balance = 50n
			requestHandler.ethGetBalanceCalls.length = 0
			requestHandler.ethSimulateV1Calls.length = 0
			const parentBlock = await ethereum.getBlock(undefined)
			const transaction = {
				signedTransaction: mockSignTransaction({
					...example7702Transaction,
					nonce: 0n,
					maxFeePerGas: 999n,
					maxPriorityFeePerGas: 100n,
					gas: 10n,
					value: 0n,
				}),
				website: { websiteOrigin: 'test', icon: undefined, title: undefined },
				created: new Date(),
				originalRequestParameters: { method: 'eth_sendTransaction', params: [{ type: '7702', authorizationList: [] }]},
				transactionIdentifier: 26n,
			} as const
			const currentBlock = {
				stateOverrides: {},
				transactions: [transaction],
				signedMessages: [],
				blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
				simulateWithZeroBaseFee: false,
			} as const

			const { balances, transactions: adjusted } = await getBaseFeeAdjustmentBalances(ethereum, undefined, parentBlock, [], currentBlock)
			assert.deepEqual(adjusted, getBaseFeeAdjustedTransactions(parentBlock, currentBlock.transactions, balances))
			const adjustedTransaction = adjusted[0]?.signedTransaction
			if (adjustedTransaction === undefined || adjustedTransaction.type !== '7702') throw new Error('missing adjusted 7702 transaction')
			assert.equal(adjustedTransaction.maxFeePerGas, 5n)
			assert.equal(adjustedTransaction.maxPriorityFeePerGas, 5n)
			assert.equal(requestHandler.ethGetBalanceCalls.length, 1)
			assert.equal(requestHandler.ethSimulateV1Calls.length, 0)
		})

		test('getBaseFeeAdjustedTransactions skips prefix simulation when conservative balance can afford desired fees', async () => {
			requestHandler.balance = 100_000n
			requestHandler.ethGetBalanceCalls.length = 0
			requestHandler.ethSimulateV1Calls.length = 0
			const parentBlock = await ethereum.getBlock(undefined)
			const makeTransaction = (nonce: bigint, identifier: bigint) => ({
				signedTransaction: mockSignTransaction({
					...exampleTransaction,
					nonce,
					maxFeePerGas: 999n,
					maxPriorityFeePerGas: 100n,
					gas: 10n,
					value: 0n,
				}),
				website: { websiteOrigin: 'test', icon: undefined, title: undefined },
				created: new Date(),
				originalRequestParameters: { method: 'eth_sendTransaction', params: [{}]},
				transactionIdentifier: identifier,
			} as const)
			const currentBlock = {
				stateOverrides: {},
				transactions: [makeTransaction(0n, 21n), makeTransaction(1n, 22n)],
				signedMessages: [],
				blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
				simulateWithZeroBaseFee: false,
			} as const

			const { transactions: adjusted } = await getBaseFeeAdjustmentBalances(ethereum, undefined, parentBlock, [], currentBlock)
			assert.equal(adjusted.length, 2)
			for (const transaction of adjusted) {
				if (transaction.signedTransaction.type !== '1559') throw new Error('wrong transaction type')
				assert.equal(transaction.signedTransaction.maxFeePerGas, 284n)
				assert.equal(transaction.signedTransaction.maxPriorityFeePerGas, 100n)
			}
			assert.equal(requestHandler.ethGetBalanceCalls.length, 1)
			assert.equal(requestHandler.ethSimulateV1Calls.length, 0)
		})

		test('getBaseFeeAdjustmentBalances tracks explicit max fee in conservative balance', async () => {
			requestHandler.balance = 100_000n
			requestHandler.ethGetBalanceCalls.length = 0
			requestHandler.ethSimulateV1Calls.length = 0
			const parentBlock = await ethereum.getBlock(undefined)
			const makeTransaction = (nonce: bigint, identifier: bigint, maxFeePerGas: bigint | undefined) => ({
				signedTransaction: mockSignTransaction({
					...exampleTransaction,
					nonce,
					maxFeePerGas: maxFeePerGas ?? 999n,
					maxPriorityFeePerGas: 100n,
					gas: 10n,
					value: 0n,
				}),
				website: { websiteOrigin: 'test', icon: undefined, title: undefined },
				created: new Date(),
				originalRequestParameters: { method: 'eth_sendTransaction', params: maxFeePerGas === undefined ? [{}] : [{ maxFeePerGas }]},
				transactionIdentifier: identifier,
			} as const)
			const currentBlock = {
				stateOverrides: {},
				transactions: [
					makeTransaction(0n, 23n, undefined),
					makeTransaction(1n, 24n, 200n),
					makeTransaction(2n, 25n, undefined),
				],
				signedMessages: [],
				blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
				simulateWithZeroBaseFee: false,
			} as const

			const { transactions: adjusted } = await getBaseFeeAdjustmentBalances(ethereum, undefined, parentBlock, [], currentBlock)
			assert.equal(adjusted.length, 3)
			assert.equal(requestHandler.ethGetBalanceCalls.length, 1)
			assert.equal(requestHandler.ethSimulateV1Calls.length, 0)
		})

		test('getBaseFeeAdjustmentBalances tracks explicit type-7702 max fee in conservative balance', async () => {
			requestHandler.balance = 100_000n
			requestHandler.ethGetBalanceCalls.length = 0
			requestHandler.ethSimulateV1Calls.length = 0
			const parentBlock = await ethereum.getBlock(undefined)
			const makeTransaction = (nonce: bigint, identifier: bigint, maxFeePerGas: bigint | undefined) => ({
				signedTransaction: mockSignTransaction({
					...example7702Transaction,
					nonce,
					maxFeePerGas: maxFeePerGas ?? 999n,
					maxPriorityFeePerGas: 100n,
					gas: 10n,
					value: 0n,
				}),
				website: { websiteOrigin: 'test', icon: undefined, title: undefined },
				created: new Date(),
				originalRequestParameters: { method: 'eth_sendTransaction', params: maxFeePerGas === undefined ? [{ type: '7702', authorizationList: [] }] : [{ type: '7702', authorizationList: [], maxFeePerGas }]},
				transactionIdentifier: identifier,
			} as const)
			const currentBlock = {
				stateOverrides: {},
				transactions: [
					makeTransaction(0n, 27n, undefined),
					makeTransaction(1n, 28n, 200n),
					makeTransaction(2n, 29n, undefined),
				],
				signedMessages: [],
				blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
				simulateWithZeroBaseFee: false,
			} as const

			const { transactions: adjusted } = await getBaseFeeAdjustmentBalances(ethereum, undefined, parentBlock, [], currentBlock)
			assert.equal(adjusted.length, 3)
			const firstAdjusted = adjusted[0]?.signedTransaction
			const secondAdjusted = adjusted[1]?.signedTransaction
			const thirdAdjusted = adjusted[2]?.signedTransaction
			if (firstAdjusted?.type !== '7702' || secondAdjusted?.type !== '7702' || thirdAdjusted?.type !== '7702') throw new Error('wrong transaction type')
			assert.equal(firstAdjusted.maxFeePerGas, 284n)
			assert.equal(secondAdjusted.maxFeePerGas, 200n)
			assert.equal(thirdAdjusted.maxFeePerGas, 284n)
			assert.equal(requestHandler.ethGetBalanceCalls.length, 1)
			assert.equal(requestHandler.ethSimulateV1Calls.length, 0)
		})

		test('simulateEstimateGasFromInput omits gas when input gas is omitted', async () => {
			requestHandler.ethSimulateV1Calls.length = 0
			const estimateGas = await simulateEstimateGasFromInput(ethereum, undefined, [], {
				from: exampleTransaction.from,
				to: exampleTransaction.to,
				value: exampleTransaction.value,
				input: exampleTransaction.input,
			})
			if ('error' in estimateGas) throw new Error(`estimate gas unexpectedly failed: ${ estimateGas.message }`)
			assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.lastCallGas, undefined)
		})

		test('simulateEstimateGasFromInput uses the node-reported peak gas', async () => {
			requestHandler.simulatedCallGasUsed = 11_332n
			requestHandler.simulatedCallMaxUsedGas = 61_000n
			try {
				const estimateGas = await simulateEstimateGasFromInput(ethereum, undefined, [], {
					from: exampleTransaction.from,
					to: exampleTransaction.to,
					value: 0n,
					input: new Uint8Array(1_000).fill(1),
				})

				if ('error' in estimateGas) throw new Error(`estimate gas unexpectedly failed: ${ estimateGas.message }`)
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

				if ('error' in estimateGas) throw new Error(`estimate gas unexpectedly failed: ${ estimateGas.message }`)
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
				const estimateGas = await simulateEstimateGasFromInput(ethereum, undefined, [], {
					from: exampleTransaction.from,
					to: exampleTransaction.to,
					value: 0n,
					input: new Uint8Array(1_000).fill(1),
				})

				if ('error' in estimateGas) throw new Error(`estimate gas unexpectedly failed: ${ estimateGas.message }`)
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

				if ('error' in estimateGas) throw new Error(`estimate gas unexpectedly failed: ${ estimateGas.message }`)
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
			const estimateGas = await simulateEstimateGasFromInput(ethereum, undefined, [], {
				from: exampleTransaction.from,
				to: exampleTransaction.to,
				value: exampleTransaction.value,
				input: exampleTransaction.input,
				gas: explicitGas,
			})
			if ('error' in estimateGas) throw new Error(`estimate gas unexpectedly failed: ${ estimateGas.message }`)
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

			const fromInputEstimate = await simulateEstimateGasFromInput(ethereum, undefined, [], transaction)
			if ('error' in fromInputEstimate) throw new Error(`estimate gas unexpectedly failed: ${ fromInputEstimate.message }`)
			const fromInputRequest = requestHandler.ethSimulateV1Requests.at(-1)
			assert.deepEqual(fromInputRequest?.params[0].blockStateCalls.at(-1)?.calls[0]?.accessList, accessList)

			const simulationState = await createSimulationState(ethereum, undefined, createSimulationStateInput())
			if (simulationState.success === false) throw new Error('simulation unexpectedly failed')
			const fromStateEstimate = await simulateEstimateGas(ethereum, undefined, toResolvedSimulationState(simulationState), transaction)
			if ('error' in fromStateEstimate) throw new Error(`estimate gas unexpectedly failed: ${ fromStateEstimate.message }`)
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
			const estimateGas = await simulateEstimateGasFromInput(ethereum, undefined, [], {
				type: '7702',
				from: exampleTransaction.from,
				to: exampleTransaction.to,
				value: exampleTransaction.value,
				input: exampleTransaction.input,
				authorizationList: [{
					chainId: BigInt(clearDelegationAuthorization.chainId),
					address: BigInt(clearDelegationAuthorization.address),
					nonce: BigInt(clearDelegationAuthorization.nonce),
					authority: 0x0000000000000000000000000000000000000004n,
					r: BigInt(clearDelegationAuthorization.r),
					s: BigInt(clearDelegationAuthorization.s),
					yParity: clearDelegationAuthorization.yParity === 0 ? 'even' : 'odd',
				}],
			})

			if ('error' in estimateGas) throw new Error(`estimate gas unexpectedly failed: ${ estimateGas.message }`)
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
			await assert.rejects(
				async () => await simulateEstimateGasFromInput(ethereum, undefined, [], {
					type: '7702',
					from: exampleTransaction.from,
					to: exampleTransaction.to,
					value: exampleTransaction.value,
					input: exampleTransaction.input,
					authorizationList: [{
						chainId: 5n,
						address: 0n,
						nonce: 3n,
						authority: 0x0000000000000000000000000000000000000004n,
						r: 0x11n,
						s: 0x22n,
					}],
				}),
				/EIP-7702 authorization signature is missing required fields/
			)
		})

		test('simulateEstimateGas rejects partial signed 7702 authorizations', async () => {
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
					authorizationList: [{
						chainId: 5n,
						address: 0n,
						nonce: 3n,
						authority: 0x0000000000000000000000000000000000000004n,
						r: 0x11n,
						s: 0x22n,
					}],
				}),
				/EIP-7702 authorization signature is missing required fields/
			)
		})

		test('simulatedCallFromInput omits gas when gasLimit is omitted', async () => {
			requestHandler.ethSimulateV1Calls.length = 0
			const callResult = await simulatedCallFromInput(ethereum, undefined, [], {
				from: exampleTransaction.from,
				to: exampleTransaction.to,
				value: exampleTransaction.value,
				input: exampleTransaction.input,
				maxFeePerGas: 0n,
				maxPriorityFeePerGas: 0n,
			})
			if ('error' in callResult) throw new Error(`simulated call unexpectedly failed: ${ callResult.message }`)
			assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.lastCallGas, undefined)
		})

		test('simulatedCallFromInput preserves explicit gasLimit', async () => {
			requestHandler.ethSimulateV1Calls.length = 0
			const gasLimit = 65_432n
			const callResult = await simulatedCallFromInput(ethereum, undefined, [], {
				from: exampleTransaction.from,
				to: exampleTransaction.to,
				value: exampleTransaction.value,
				input: exampleTransaction.input,
				maxFeePerGas: 0n,
				maxPriorityFeePerGas: 0n,
				gasLimit,
			})
			if ('error' in callResult) throw new Error(`simulated call unexpectedly failed: ${ callResult.message }`)
			assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.lastCallGas, gasLimit)
		})

		test('getSimulatedCodeFromInput installs the helper override and omits gas', async () => {
			requestHandler.ethSimulateV1Calls.length = 0
			const simulatedCode = await getSimulatedCodeFromInput(ethereum, undefined, createSimulationStateInput(), 0x1234n)
			assert.equal(simulatedCode.statusCode, 'success')
			if (simulatedCode.statusCode !== 'success') throw new Error('simulated code unexpectedly failed')
			assert.equal(dataStringWith0xStart(simulatedCode.getCodeReturn), '0x1234')
			assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.lastCallGas, undefined)
			assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.hasGetCodeOverride, true)
		})

		test('getSimulatedCodeFromInput propagates malformed code lookup output', async () => {
			requestHandler.malformedGetCodeReturn = true
			try {
				await assert.rejects(async () => await getSimulatedCodeFromInput(ethereum, undefined, createSimulationStateInput(), 0x1234n), isAbiDataDecodeError)
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
				const serializedReply = serialize(RPCReply, reply)
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
			const serializedReply = serialize(RPCReply, reply)
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

		test('simulateEstimateGasFromInput surfaces RPC errors when omitted gas is rejected', async () => {
			requestHandler.ethSimulateV1Calls.length = 0
			requestHandler.rejectOmittedGas = true
			try {
				const estimateGas = await simulateEstimateGasFromInput(ethereum, undefined, [], {
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

			test('input-based balance preserves pending block tag for empty input', async () => {
				requestHandler.ethGetBalanceCalls.length = 0
				const emptySimulationStateInput = [] as const

				await getSimulatedBalanceFromInput(ethereum, undefined, toResolvedSimulationInput(emptySimulationStateInput), exampleTransaction.from, 'pending')

				assert.deepEqual(requestHandler.ethGetBalanceCalls[0]?.params, [exampleTransaction.from, 'pending'])
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
				if (transaction === undefined || !('blockHash' in transaction)) throw new Error('full simulated transaction data missing')

				assert.equal(transaction.blockHash, latestBlock.hash)
				assert.equal(transaction.blockNumber, latestBlock.number)
				assert.equal(transaction.transactionIndex, 0n)
				assert.deepEqual(transaction.data, transaction.input)
				assert.equal(transaction.gasPrice, 1n)
			})

			test('state-based full blocks include transaction block data and realized gas price', async () => {
				const simulationState = await createSimulationState(ethereum, undefined, createSimulationStateInput())
				if (simulationState.success === false) throw new Error('simulation unexpectedly failed')
				const latestBlock = await getSimulatedBlock(ethereum, undefined, toResolvedSimulationState(simulationState), 'latest', true)
				if (latestBlock === null) throw new Error('latest simulated block missing')
				const transaction = latestBlock.transactions[0]
				if (transaction === undefined || !('blockHash' in transaction)) throw new Error('full simulated transaction data missing')

				assert.equal(transaction.blockHash, latestBlock.hash)
				assert.equal(transaction.blockNumber, latestBlock.number)
				assert.equal(transaction.transactionIndex, 0n)
				assert.deepEqual(transaction.data, transaction.input)
				assert.equal(transaction.gasPrice, simulationState.simulatedBlocks[0]?.simulatedTransactions[0]?.realizedGasPrice)
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
				// Exercise the state reader with two included transactions per block and a nonzero base fee.
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
							if (!('blockHash' in transaction)) throw new Error('transaction block data missing')
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

			test('execution-only simulation skips token balance follow-up simulation', async () => {
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
						transactionIdentifier: 10n,
					}],
					signedMessages: [],
					blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
					simulateWithZeroBaseFee: false,
				}] as const

				requestHandler.ethSimulateV1Calls.length = 0
				const fullSimulationState = await createSimulationState(ethereum, undefined, simulationStateInput)
				if (fullSimulationState.success === false) throw new Error('simulation unexpectedly failed')
				assert.equal(requestHandler.ethSimulateV1Calls.some((call) => call.aggregate3BalanceQueryCount !== undefined), true)
				assert.equal(requestHandler.ethSimulateV1Calls.find((call) => call.aggregate3BalanceQueryCount !== undefined)?.lastCallGas, undefined)

				requestHandler.ethSimulateV1Calls.length = 0
				const executionSimulationState = await createExecutionSimulationState(ethereum, undefined, simulationStateInput)
				if (executionSimulationState.success === false) throw new Error('simulation unexpectedly failed')
				assert.equal(requestHandler.ethSimulateV1Calls.length, 1)
				assert.equal(requestHandler.ethSimulateV1Calls.some((call) => call.aggregate3BalanceQueryCount !== undefined), false)
			})

			test('direct ERC20 transfers retain the attempted token balance without relying on matching logs', async () => {
				const token = 0x8888888888888888888888888888888888888888n
				const simulationStateInput = [{
					stateOverrides: {},
					transactions: [{
						signedTransaction: mockSignTransaction({
							...exampleTransaction,
							to: token,
							input: stringToUint8Array(encodeFunctionCall(Erc20ABI, 'transfer', [
								addressString(exampleTransaction.to),
								2n,
							])),
							nonce: 0n,
						}),
						website: { websiteOrigin: 'test', icon: undefined, title: undefined },
						created: new Date(),
						originalRequestParameters: { method: 'eth_sendTransaction', params: [{}] },
						transactionIdentifier: 16n,
					}],
					signedMessages: [],
					blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
					simulateWithZeroBaseFee: false,
				}] as const

				const simulationState = await createSimulationState(ethereum, undefined, simulationStateInput)
				if (simulationState.success === false) throw new Error('simulation unexpectedly failed')
				const tokenBalancesAfter = simulationState.simulatedBlocks[0]?.simulatedTransactions[0]?.tokenBalancesAfter
				assert.notEqual(tokenBalancesAfter, undefined)
				assert.equal(tokenBalancesAfter?.some((balance) => balance.token === token && balance.owner === exampleTransaction.from), true)
			})

			test('malformed direct ERC20 transfer calldata does not break supplemental balance collection', async () => {
				const token = 0x8888888888888888888888888888888888888888n
				const transferSelector = encodeFunctionCall(Erc20ABI, 'transfer', [
					addressString(exampleTransaction.to),
					2n,
				]).slice(0, 10)
				const simulationStateInput = [{
					stateOverrides: {},
					transactions: [{
						signedTransaction: mockSignTransaction({
							...exampleTransaction,
							to: token,
							input: stringToUint8Array(transferSelector),
							nonce: 0n,
						}),
						website: { websiteOrigin: 'test', icon: undefined, title: undefined },
						created: new Date(),
						originalRequestParameters: { method: 'eth_sendTransaction', params: [{}] },
						transactionIdentifier: 17n,
					}],
					signedMessages: [],
					blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
					simulateWithZeroBaseFee: false,
				}] as const

				const simulationState = await createSimulationState(ethereum, undefined, simulationStateInput)
				if (simulationState.success === false) throw new Error('simulation unexpectedly failed')
				const tokenBalancesAfter = simulationState.simulatedBlocks[0]?.simulatedTransactions[0]?.tokenBalancesAfter
				assert.notEqual(tokenBalancesAfter, undefined)
				assert.equal(tokenBalancesAfter?.some((balance) => balance.token === token), false)
			})

		})
