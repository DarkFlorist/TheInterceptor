import { describe, test } from 'bun:test'
import * as assert from 'node:assert'
import { feeOops } from '../../app/ts/simulation/protectors/feeOops.js'
import type { EthereumUnsignedTransaction } from '../../app/ts/types/wire-types.js'
import { createMockEthereumClient, EOA_ADDRESS, mainnetRpcEntry, NANOETH, nodeBackedSimulationState, SENDER_ADDRESS } from './protectorTestHarness.js'

const NETWORK_GAS_PRICE = 20n * NANOETH

const baseTransaction = {
	from: SENDER_ADDRESS,
	nonce: 0n,
	gas: 21_000n,
	to: EOA_ADDRESS,
	value: 1n,
	input: new Uint8Array(),
}

const createPriorityFeeTransactions = (maxPriorityFeePerGas: bigint): readonly EthereumUnsignedTransaction[] => {
	const feeFields = { ...baseTransaction, chainId: mainnetRpcEntry.chainId, maxFeePerGas: maxPriorityFeePerGas + 100n * NANOETH, maxPriorityFeePerGas }
	return [
		{ ...feeFields, type: '1559' },
		{ ...feeFields, type: '4844', maxFeePerBlobGas: NANOETH, blobVersionedHashes: [] },
		{ ...feeFields, type: '7702', authorizationList: [] },
	]
}

const createGasPriceTransactions = (gasPrice: bigint): readonly EthereumUnsignedTransaction[] => [
	{ ...baseTransaction, type: 'legacy', gasPrice },
	{ ...baseTransaction, type: '2930', chainId: mainnetRpcEntry.chainId, gasPrice },
]

const runFeeOops = async (transaction: EthereumUnsignedTransaction) => {
	const { ethereum, requestedMethods } = createMockEthereumClient({ gasPrice: NETWORK_GAS_PRICE })
	const result = await feeOops(transaction, ethereum, undefined, nodeBackedSimulationState)
	return { result, requestedMethods }
}

describe('feeOops protector', () => {
	test('does not warn about priority fees below 10 nanoeth/gas and never asks the node for a gas price', async () => {
		for (const transaction of createPriorityFeeTransactions(10n * NANOETH - 1n)) {
			const { result, requestedMethods } = await runFeeOops(transaction)

			assert.equal(result, undefined, transaction.type)
			assert.deepEqual(requestedMethods, [], transaction.type)
		}
	})

	test('warns about priority fees of 10 nanoeth/gas or more for every priority fee transaction type', async () => {
		for (const transaction of createPriorityFeeTransactions(10n * NANOETH)) {
			const { result } = await runFeeOops(transaction)

			assert.equal(result, 'Attempt to send a transaction with an outrageous fee (10 nanoeth/gas)', transaction.type)
		}
	})

	test('reports the priority fee in whole nanoeth/gas', async () => {
		const [transaction] = createPriorityFeeTransactions(1234n * NANOETH + 999n)
		if (transaction === undefined) throw new Error('missing 1559 transaction')

		const { result } = await runFeeOops(transaction)

		assert.equal(result, 'Attempt to send a transaction with an outrageous fee (1234 nanoeth/gas)')
	})

	test('does not warn when a gas price transaction pays less than 10 times the network gas price', async () => {
		for (const transaction of createGasPriceTransactions(10n * NETWORK_GAS_PRICE - 1n)) {
			const { result, requestedMethods } = await runFeeOops(transaction)

			assert.equal(result, undefined, transaction.type)
			assert.deepEqual(requestedMethods, ['eth_gasPrice'], transaction.type)
		}
	})

	test('warns when a gas price transaction pays 10 times the network gas price or more', async () => {
		for (const transaction of createGasPriceTransactions(10n * NETWORK_GAS_PRICE)) {
			const { result } = await runFeeOops(transaction)

			assert.equal(result?.startsWith('Attempt to send a transaction with an outrageous fee.'), true, transaction.type)
		}
	})
})
