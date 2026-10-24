import { describe, test } from 'bun:test'
import * as assert from 'node:assert'
import { addressString, stringToUint8Array } from '../../app/ts/utils/bigint.js'
import { createExecutionSimulationState, createSimulationState, getBaseFeeAdjustedTransactions, getBaseFeeAdjustmentBalances, getSimulatedBalanceFromInput, getSimulatedTransactionCount, getSimulatedTransactionCountFromInput, mockSignTransaction, simulateEstimateGasFromInput } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import { toResolvedSimulationInput, toResolvedSimulationState } from '../../app/ts/types/visualizer-types.js'
import { Erc20ABI } from '../../app/ts/utils/abi.js'
import { encodeFunctionCall } from '../../app/ts/utils/abiRuntime.js'
import { createSimulationModeTestContext, example7702Transaction, exampleTransaction } from './simulationModeEthereumClientServiceTestHelpers.js'

const { requestHandler, ethereum } = createSimulationModeTestContext()

describe('SimulationModeEthereumClientService', () => {
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
		if ('error' in estimateGas) throw new Error(`estimate gas unexpectedly failed: ${ estimateGas.error.message }`)
		assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.lastCallNonce, 1n)
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
			originalRequestParameters: { method: 'eth_sendTransaction', params: [maxFeePerGas === undefined ? {} : { maxFeePerGas }] },
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
			originalRequestParameters: { method: 'eth_sendTransaction', params: [{ type: '7702', authorizationList: [], ...maxFeePerGas === undefined ? {} : { maxFeePerGas } }] },
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

	test('input-based balance preserves pending block tag for empty input', async () => {
		requestHandler.ethGetBalanceCalls.length = 0
		const emptySimulationStateInput = [] as const

		await getSimulatedBalanceFromInput(ethereum, undefined, toResolvedSimulationInput(emptySimulationStateInput), exampleTransaction.from, 'pending')

		assert.deepEqual(requestHandler.ethGetBalanceCalls[0]?.params, [exampleTransaction.from, 'pending'])
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
