import { describe, test } from 'bun:test'
import * as assert from 'node:assert'
import { chainIdMismatch } from '../../app/ts/simulation/protectors/chainIdMismatch.js'
import type { EthereumUnsignedTransaction } from '../../app/ts/types/wire-types.js'
import { createMockEthereumClient, createTransaction, EOA_ADDRESS, NANOETH, nodeBackedSimulationState, SENDER_ADDRESS } from './protectorTestHarness.js'

const { ethereum } = createMockEthereumClient()

const legacyTransactionWithoutChainId: EthereumUnsignedTransaction = {
	type: 'legacy',
	from: SENDER_ADDRESS,
	nonce: 0n,
	gasPrice: NANOETH,
	gas: 21_000n,
	to: EOA_ADDRESS,
	value: 1n,
	input: new Uint8Array(),
}

const runChainIdMismatch = async (transaction: EthereumUnsignedTransaction) => await chainIdMismatch(transaction, ethereum, undefined, nodeBackedSimulationState)

describe('chainIdMismatch protector', () => {
	test('does not warn when the transaction targets the connected chain', async () => {
		assert.equal(await runChainIdMismatch(createTransaction()), undefined)
	})

	test('warns with both chain names when the transaction targets another chain', async () => {
		const result = await runChainIdMismatch({ ...createTransaction(), chainId: 11155111n })

		assert.equal(result, 'This transaction is for a different chain (Sepolia) than what you are currently connected to (Ethereum Mainnet).')
	})

	test('falls back to the numeric chain id for unknown chains', async () => {
		const result = await runChainIdMismatch({ ...createTransaction(), chainId: 987654321987n })

		assert.equal(result, 'This transaction is for a different chain (Chain: 987654321987) than what you are currently connected to (Ethereum Mainnet).')
	})

	test('does not warn for legacy transactions without a chain id', async () => {
		assert.equal(await runChainIdMismatch(legacyTransactionWithoutChainId), undefined)
	})

	test('warns for legacy transactions that carry a mismatching chain id', async () => {
		const result = await runChainIdMismatch({ ...legacyTransactionWithoutChainId, chainId: 10n })

		assert.equal(result, 'This transaction is for a different chain (OP Mainnet) than what you are currently connected to (Ethereum Mainnet).')
	})
})
