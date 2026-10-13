import { describe, test } from 'bun:test'
import * as assert from 'node:assert'
import { tokenToContract } from '../../app/ts/simulation/protectors/tokenToContract.js'
import type { SimulationState } from '../../app/ts/types/visualizer-types.js'
import type { EthereumUnsignedTransaction } from '../../app/ts/types/wire-types.js'
import { Erc20ABI } from '../../app/ts/utils/abi.js'
import { encodeFunctionCall } from '../../app/ts/utils/abiRuntime.js'
import { addressString } from '../../app/ts/utils/bigint.js'
import { UNISWAP_V2_ROUTER_ADDRESS } from '../../app/ts/utils/constants.js'
import { createMockEthereumClient, createTransaction, EOA_ADDRESS, failedSimulationState, installFreshBrowserMockForEachTest, nodeBackedSimulationState, SENDER_ADDRESS } from './protectorTestHarness.js'

const CONTRACT_RECIPIENT = UNISWAP_V2_ROUTER_ADDRESS

installFreshBrowserMockForEachTest()

const runTokenToContract = async (transaction: EthereumUnsignedTransaction, simulationState: SimulationState = nodeBackedSimulationState) => {
	const { ethereum, requestedMethods } = createMockEthereumClient({ codeByAddress: new Map([[CONTRACT_RECIPIENT, '0x6080']]) })
	const result = await tokenToContract(transaction, ethereum, undefined, simulationState)
	return { result, requestedMethods }
}

const transferCalldata = (recipient: bigint) => encodeFunctionCall(Erc20ABI, 'transfer', [addressString(recipient), 100n])

describe('tokenToContract protector', () => {
	test('warns when tokens are transferred directly to a contract', async () => {
		const { result } = await runTokenToContract(createTransaction({ input: transferCalldata(CONTRACT_RECIPIENT) }))

		assert.equal(result, 'Attempt to send tokens directly to a contract (Uniswap V2 Router 02)')
	})

	test('warns when transferFrom sends tokens directly to a contract', async () => {
		const input = encodeFunctionCall(Erc20ABI, 'transferFrom', [addressString(SENDER_ADDRESS), addressString(CONTRACT_RECIPIENT), 100n])

		const { result } = await runTokenToContract(createTransaction({ input }))

		assert.equal(result, 'Attempt to send tokens directly to a contract (Uniswap V2 Router 02)')
	})

	test('does not warn when tokens are transferred to an address without code', async () => {
		const { result, requestedMethods } = await runTokenToContract(createTransaction({ input: transferCalldata(EOA_ADDRESS) }))

		assert.equal(result, undefined)
		assert.deepEqual(requestedMethods, ['eth_getCode'])
	})

	test('ignores token calls that are not transfers', async () => {
		const input = encodeFunctionCall(Erc20ABI, 'approve', [addressString(CONTRACT_RECIPIENT), 100n])

		const { result, requestedMethods } = await runTokenToContract(createTransaction({ input }))

		assert.equal(result, undefined)
		assert.deepEqual(requestedMethods, [])
	})

	test('does not warn for contract deployments whose init code looks like a transfer', async () => {
		const { result } = await runTokenToContract(createTransaction({ to: null, input: transferCalldata(CONTRACT_RECIPIENT) }))

		assert.equal(result, undefined)
	})

	test('reports when it cannot verify whether the recipient has code', async () => {
		const { result } = await runTokenToContract(createTransaction({ input: transferCalldata(CONTRACT_RECIPIENT) }), failedSimulationState)

		assert.equal(result?.startsWith('Failed to verify whether address'), true)
		assert.equal(result?.includes('(Uniswap V2 Router 02) contains code or not.'), true)
	})
})
