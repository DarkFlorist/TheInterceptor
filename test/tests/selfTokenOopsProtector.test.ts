import { describe, test } from 'bun:test'
import * as assert from 'node:assert'
import { selfTokenOops } from '../../app/ts/simulation/protectors/selfTokenOops.js'
import type { EthereumUnsignedTransaction } from '../../app/ts/types/wire-types.js'
import { Erc20ABI } from '../../app/ts/utils/abi.js'
import { encodeFunctionCall } from '../../app/ts/utils/abiRuntime.js'
import { addressString } from '../../app/ts/utils/bigint.js'
import { createMockEthereumClient, createTransaction, EOA_ADDRESS, nodeBackedSimulationState, SENDER_ADDRESS, TOKEN_ADDRESS } from './protectorTestHarness.js'

const { ethereum } = createMockEthereumClient()

const runSelfTokenOops = async (transaction: EthereumUnsignedTransaction) => await selfTokenOops(transaction, ethereum, undefined, nodeBackedSimulationState)

describe('selfTokenOops protector', () => {
	test('warns when tokens are transferred to the token contract itself', async () => {
		const input = encodeFunctionCall(Erc20ABI, 'transfer', [addressString(TOKEN_ADDRESS), 100n])

		assert.equal(await runSelfTokenOops(createTransaction({ input })), 'Attempt to send token to itself.')
	})

	test('warns when transferFrom sends tokens to the token contract itself', async () => {
		const input = encodeFunctionCall(Erc20ABI, 'transferFrom', [addressString(SENDER_ADDRESS), addressString(TOKEN_ADDRESS), 100n])

		assert.equal(await runSelfTokenOops(createTransaction({ input })), 'Attempt to send token to itself.')
	})

	test('does not warn when tokens are transferred to another address', async () => {
		const input = encodeFunctionCall(Erc20ABI, 'transfer', [addressString(EOA_ADDRESS), 100n])

		assert.equal(await runSelfTokenOops(createTransaction({ input })), undefined)
	})

	test('does not warn for approvals that name the token contract', async () => {
		const input = encodeFunctionCall(Erc20ABI, 'approve', [addressString(TOKEN_ADDRESS), 100n])

		assert.equal(await runSelfTokenOops(createTransaction({ input })), undefined)
	})

	test('does not warn for transactions without token calldata', async () => {
		assert.equal(await runSelfTokenOops(createTransaction({ to: TOKEN_ADDRESS, value: 1n })), undefined)
	})
})
