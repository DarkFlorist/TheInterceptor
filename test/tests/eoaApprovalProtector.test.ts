import { describe, test } from 'bun:test'
import * as assert from 'node:assert'
import { eoaApproval } from '../../app/ts/simulation/protectors/eoaApproval.js'
import type { SimulationState } from '../../app/ts/types/visualizer-types.js'
import type { EthereumUnsignedTransaction } from '../../app/ts/types/wire-types.js'
import { Erc20ABI, Erc721ABI } from '../../app/ts/utils/abi.js'
import { encodeFunctionCall } from '../../app/ts/utils/abiRuntime.js'
import { addressString } from '../../app/ts/utils/bigint.js'
import { UNISWAP_V2_ROUTER_ADDRESS } from '../../app/ts/utils/constants.js'
import { createMockEthereumClient, createTransaction, EOA_ADDRESS, failedSimulationState, installFreshBrowserMockForEachTest, nodeBackedSimulationState } from './protectorTestHarness.js'

const CONTRACT_SPENDER = UNISWAP_V2_ROUTER_ADDRESS

installFreshBrowserMockForEachTest()

const runEoaApproval = async (input: `0x${ string }`, simulationState: SimulationState = nodeBackedSimulationState) => {
	const { ethereum, requestedMethods } = createMockEthereumClient({ codeByAddress: new Map([[CONTRACT_SPENDER, '0x6080']]) })
	const transaction: EthereumUnsignedTransaction = createTransaction({ input })
	const result = await eoaApproval(transaction, ethereum, undefined, simulationState)
	return { result, requestedMethods }
}

const approveCalldata = (spender: bigint, amount: bigint) => encodeFunctionCall(Erc20ABI, 'approve', [addressString(spender), amount])
const setApprovalForAllCalldata = (operator: bigint, approved: boolean) => encodeFunctionCall(Erc721ABI, 'setApprovalForAll', [addressString(operator), approved])

describe('eoaApproval protector', () => {
	test('warns when approving a token allowance for an address without code', async () => {
		const { result } = await runEoaApproval(approveCalldata(EOA_ADDRESS, 100n))

		assert.equal(result?.includes('approve Externally Owned Account'), true)
	})

	test('does not warn when approving a token allowance for a contract', async () => {
		const { result, requestedMethods } = await runEoaApproval(approveCalldata(CONTRACT_SPENDER, 100n))

		assert.equal(result, undefined)
		assert.deepEqual(requestedMethods, ['eth_getCode'])
	})

	test('allows resetting an allowance to zero without looking up code', async () => {
		const { result, requestedMethods } = await runEoaApproval(approveCalldata(EOA_ADDRESS, 0n))

		assert.equal(result, undefined)
		assert.deepEqual(requestedMethods, [])
	})

	test('warns when granting an address without code approval for all tokens', async () => {
		const { result } = await runEoaApproval(setApprovalForAllCalldata(EOA_ADDRESS, true))

		assert.equal(result, 'This transaction attempts to approve an Externally Owned Account.')
	})

	test('does not warn when granting a contract approval for all tokens', async () => {
		const { result } = await runEoaApproval(setApprovalForAllCalldata(CONTRACT_SPENDER, true))

		assert.equal(result, undefined)
	})

	test('allows revoking approval for all tokens without looking up code', async () => {
		const { result, requestedMethods } = await runEoaApproval(setApprovalForAllCalldata(EOA_ADDRESS, false))

		assert.equal(result, undefined)
		assert.deepEqual(requestedMethods, [])
	})

	test('ignores token calls that are not approvals', async () => {
		const { result, requestedMethods } = await runEoaApproval(encodeFunctionCall(Erc20ABI, 'transfer', [addressString(EOA_ADDRESS), 100n]))

		assert.equal(result, undefined)
		assert.deepEqual(requestedMethods, [])
	})

	test('reports when it cannot verify whether the spender has code', async () => {
		const { result } = await runEoaApproval(approveCalldata(CONTRACT_SPENDER, 100n), failedSimulationState)

		assert.equal(result?.startsWith('Failed to verify whether address'), true)
		assert.equal(result?.includes('(Uniswap V2 Router 02) contains code or not.'), true)
	})
})
