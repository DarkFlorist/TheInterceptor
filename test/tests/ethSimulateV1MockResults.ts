// eth_simulateV1 results for mock RPC handlers, built from the node fixtures in test/RPCResponses.ts: the builders return parsed EthSimulateV1Result values, and mock handlers serialize them with serialize(EthSimulateV1Result, ...) before answering, like a node would.
import { EthSimulateV1Result } from '../../app/ts/types/ethSimulate-types.js'
import { decodeFunctionDataStrict, encodeAbiValues, encodeFunctionReturn } from '../../app/ts/utils/abiRuntime.js'
import { dataStringWith0xStart, stringToUint8Array } from '../../app/ts/utils/bigint.js'
import { Multicall3ABI } from '../../app/ts/utils/constants.js'
import { eth_simulateV1_dummy_call_result, eth_simulateV1_dummy_call_result_2calls, eth_simulateV1_get_eth_balance_multicall } from '../RPCResponses.js'
import { parseJsonRpcResult } from './rpcResponseParsing.js'

export type EthSimulateV1BlockResult = EthSimulateV1Result[number]

export const ethSimulateSingleBlockResult = parseJsonRpcResult(eth_simulateV1_dummy_call_result, EthSimulateV1Result)
const ethSimulateSplitBlocksResult = parseJsonRpcResult(eth_simulateV1_dummy_call_result_2calls, EthSimulateV1Result)
const ethSimulateAggregate3Result = parseJsonRpcResult(eth_simulateV1_get_eth_balance_multicall, EthSimulateV1Result)

const AGGREGATE3_SELECTOR = '0x82ad56cb'

// Returns how many balance queries an aggregate3 multicall input batches, or undefined when the input is not an aggregate3 call.
export function getAggregate3BalanceQueryCount(callInput: Uint8Array | undefined) {
	if (callInput === undefined || !dataStringWith0xStart(callInput).startsWith(AGGREGATE3_SELECTOR)) return undefined
	const decoded = decodeFunctionDataStrict(Multicall3ABI, dataStringWith0xStart(callInput))
	if (decoded.functionName !== 'aggregate3') throw new Error('expected aggregate3 call')
	const [balanceQueries] = decoded.args
	if (!Array.isArray(balanceQueries)) throw new Error('expected aggregate3 call list')
	return balanceQueries.length
}

function buildAggregate3BalanceBlock(balanceQueryCount: number): EthSimulateV1BlockResult {
	const aggregate3BalanceBlock = ethSimulateAggregate3Result[ethSimulateAggregate3Result.length - 1]
	const aggregate3Call = aggregate3BalanceBlock?.calls[0]
	if (aggregate3BalanceBlock === undefined) throw new Error('missing aggregate3 simulation fixture block')
	if (aggregate3Call === undefined) throw new Error('missing aggregate3 simulation fixture call')
	return {
		...aggregate3BalanceBlock,
		calls: [{
			...aggregate3Call,
			returnData: stringToUint8Array(encodeFunctionReturn(Multicall3ABI, 'aggregate3', [Array.from({ length: balanceQueryCount }, (_, index) => ({
				success: true,
				returnData: encodeAbiValues(['uint256'], [BigInt(index + 1)]),
			}))])),
		}],
	}
}

// One fixture block per block state call; when aggregate3BalanceQueryCount is set, the last block answers the token balance multicall.
export function createMockEthSimulateV1Result(blockStateCallCount: number, aggregate3BalanceQueryCount: number | undefined): EthSimulateV1Result {
	const singleTransactionBlock = ethSimulateSingleBlockResult[0]
	const followupTransactionBlock = ethSimulateSplitBlocksResult[1]
	if (singleTransactionBlock === undefined) throw new Error('missing single transaction simulation fixture')
	if (followupTransactionBlock === undefined) throw new Error('missing followup simulation fixture block')

	const includesAggregate3BalanceCall = aggregate3BalanceQueryCount !== undefined
	const nonAggregateBlockCount = includesAggregate3BalanceCall ? Math.max(blockStateCallCount - 1, 0) : blockStateCallCount
	const nonAggregateBlocks = Array.from({ length: nonAggregateBlockCount }, (_, blockIndex) => blockIndex === 0 ? singleTransactionBlock : followupTransactionBlock)
	if (!includesAggregate3BalanceCall) return nonAggregateBlocks
	return [...nonAggregateBlocks, buildAggregate3BalanceBlock(aggregate3BalanceQueryCount)]
}

export function createMockEthSimulateV1ResultWithCustomLastBlock(blockStateCallCount: number, customLastBlock: EthSimulateV1BlockResult): EthSimulateV1Result {
	if (blockStateCallCount <= 1) return [customLastBlock]
	const precedingBlocks = createMockEthSimulateV1Result(blockStateCallCount - 1, undefined)
	return [...precedingBlocks, customLastBlock]
}
