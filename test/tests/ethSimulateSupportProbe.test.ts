import { describe, test } from 'bun:test'
import * as assert from 'assert'
import { ETH_SIMULATE_SUPPORT_PROBE, ethSimulateSupportProbeReturnedEthLog } from '../../app/ts/simulation/ethSimulateSupportProbe.js'
import { addressString } from '../../app/ts/utils/bigint.js'
import { ETHEREUM_LOGS_LOGGER_ADDRESS, EIP7708_SYSTEM_ADDRESS, TRANSFER_LOG } from '../../app/ts/utils/constants.js'

const word = (value: bigint) => `0x${ value.toString(16).padStart(64, '0') }`
const createRpcLog = (address: bigint, from: bigint, to: bigint) => ({ address: addressString(address), topics: [TRANSFER_LOG, word(from), word(to)], data: word(1n), blockHash: word(0xa3n), blockNumber: '0x1', logIndex: '0x0' })
const createRpcReply = (call: unknown) => [{ number: '0x1', hash: word(0xa3n), timestamp: '0x1', gasLimit: '0x1c9c380', gasUsed: '0x5208', baseFeePerGas: '0x9', calls: [call] }]
const createSuccessfulCall = (logs: readonly unknown[]) => ({ status: '0x1', returnData: '0x', gasUsed: '0x5208', logs })

const getProbeCall = () => {
	const call = ETH_SIMULATE_SUPPORT_PROBE.blockStateCalls[0]?.calls[0]
	if (call?.from === undefined || call.to === undefined || call.to === null) throw new Error('the probe must transfer between two accounts')
	return { from: call.from, to: call.to }
}

// EIP-7708 logs a value transfer "to a different account", and Sepolia nodes return no log for a self-transfer.
const replyOfNodeWithEip7708 = ({ from, to }: ReturnType<typeof getProbeCall>) => createRpcReply(createSuccessfulCall(from === to ? [] : [createRpcLog(EIP7708_SYSTEM_ADDRESS, from, to)]))
const replyOfNodeWithTracerLogs = ({ from, to }: ReturnType<typeof getProbeCall>) => createRpcReply(createSuccessfulCall([createRpcLog(ETHEREUM_LOGS_LOGGER_ADDRESS, from, to)]))

describe('eth_simulateV1 support probe', () => {
	test('a node with EIP-7708 active passes', () => {
		assert.equal(ethSimulateSupportProbeReturnedEthLog(replyOfNodeWithEip7708(getProbeCall())), true)
	})

	test('a node reporting transfers through the tracer log passes', () => {
		assert.equal(ethSimulateSupportProbeReturnedEthLog(replyOfNodeWithTracerLogs(getProbeCall())), true)
	})

	test('a node returning no ETH log is still rejected', () => {
		assert.equal(ethSimulateSupportProbeReturnedEthLog(createRpcReply(createSuccessfulCall([]))), false)
	})

	test('a failed call and an unparseable reply are still rejected', () => {
		assert.equal(ethSimulateSupportProbeReturnedEthLog(createRpcReply({ status: '0x0', returnData: '0x', gasUsed: '0x0', error: { code: -32000, message: 'failed' } })), false)
		assert.equal(ethSimulateSupportProbeReturnedEthLog('not a simulation result'), false)
	})
})
