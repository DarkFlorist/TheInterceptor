import { describe, test } from 'bun:test'
import * as assert from 'node:assert'
import { eoaCalldata } from '../../app/ts/simulation/protectors/eoaCalldata.js'
import type { SimulationState } from '../../app/ts/types/visualizer-types.js'
import type { EthereumUnsignedTransaction } from '../../app/ts/types/wire-types.js'
import { addressStringWithout0x } from '../../app/ts/utils/bigint.js'
import { UNISWAP_V2_ROUTER_ADDRESS } from '../../app/ts/utils/constants.js'
import { createMockEthereumClient, createTransaction, EOA_ADDRESS, failedSimulationState, installFreshBrowserMockForEachTest, nodeBackedSimulationState } from './protectorTestHarness.js'

const CONTRACT_ADDRESS = UNISWAP_V2_ROUTER_ADDRESS
const DELEGATED_EOA_ADDRESS = 0x4444444444444444444444444444444444444444n
const CALLDATA = '0xdeadbeef'

installFreshBrowserMockForEachTest()

const codeByAddress = new Map<bigint, `0x${ string }`>([
	[CONTRACT_ADDRESS, '0x6080'],
	[DELEGATED_EOA_ADDRESS, `0xef0100${ addressStringWithout0x(CONTRACT_ADDRESS) }`],
])

const runEoaCalldata = async (transaction: EthereumUnsignedTransaction, simulationState: SimulationState = nodeBackedSimulationState) => {
	const { ethereum, requestedMethods } = createMockEthereumClient({ codeByAddress })
	const result = await eoaCalldata(transaction, ethereum, undefined, simulationState)
	return { result, requestedMethods }
}

describe('eoaCalldata protector', () => {
	test('warns when calldata is sent to an address without code', async () => {
		const { result } = await runEoaCalldata(createTransaction({ to: EOA_ADDRESS, input: CALLDATA }))

		assert.equal(result, 'Transaction to an Externally Owned Account contains calldata.')
	})

	test('does not warn when calldata is sent to a contract', async () => {
		const { result } = await runEoaCalldata(createTransaction({ to: CONTRACT_ADDRESS, input: CALLDATA }))

		assert.equal(result, undefined)
	})

	test('does not warn when calldata is sent to an EIP-7702 delegated account', async () => {
		const { result } = await runEoaCalldata(createTransaction({ to: DELEGATED_EOA_ADDRESS, input: CALLDATA }))

		assert.equal(result, undefined)
	})

	test('does not look up code for plain ether transfers', async () => {
		const { result, requestedMethods } = await runEoaCalldata(createTransaction({ to: EOA_ADDRESS, value: 1n }))

		assert.equal(result, undefined)
		assert.deepEqual(requestedMethods, [])
	})

	test('does not look up code for contract deployments', async () => {
		const { result, requestedMethods } = await runEoaCalldata(createTransaction({ to: null, input: CALLDATA }))

		assert.equal(result, undefined)
		assert.deepEqual(requestedMethods, [])
	})

	test('reports when it cannot verify whether the recipient has code', async () => {
		const { result } = await runEoaCalldata(createTransaction({ to: CONTRACT_ADDRESS, input: CALLDATA }), failedSimulationState)

		assert.equal(result?.startsWith('Failed to verify whether address'), true)
		assert.equal(result?.includes('(Uniswap V2 Router 02) contains code or not.'), true)
	})
})
