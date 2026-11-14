import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { type AppendedTransactionRpcBlock, estimateGasInRpcBlockItRunsIn } from '../../app/ts/simulation/services/simulationGasEstimation.js'

type GasEstimate = { error: { code: number, message: string, data: string } } | { gas: bigint }

const failure = (message: string): GasEstimate => ({ error: { code: -1, message, data: '0x' } })
const unplaceableEstimate = failure('unplaceable')

// Runs the protocol with fixed estimates per RPC block and a placement rule, recording which blocks it estimated in.
async function place(estimates: Record<AppendedTransactionRpcBlock, GasEstimate>, runsInLastRpcBlockUpTo: bigint, lastRpcBlockHasRoom = true) {
	const estimatedIn: AppendedTransactionRpcBlock[] = []
	const estimate = await estimateGasInRpcBlockItRunsIn({
		lastRpcBlockHasRoom,
		estimateIn: async (rpcBlock) => {
			estimatedIn.push(rpcBlock)
			return estimates[rpcBlock]
		},
		getRpcBlockItRunsIn: async (gas) => gas <= runsInLastRpcBlockUpTo ? 'lastRpcBlock' : 'nextRpcBlock',
		unplaceableEstimate,
	})
	return { estimate, estimatedIn }
}

describe('estimating a transaction appended after the simulation input in the RPC block it runs in', () => {
	test('keeps an estimate in the last RPC block that runs there', async () => {
		assert.deepEqual(await place({ lastRpcBlock: { gas: 50n }, nextRpcBlock: { gas: 60n } }, 100n), { estimate: { gas: 50n }, estimatedIn: ['lastRpcBlock'] })
	})

	test('estimates only in the next RPC block when the last one has no room', async () => {
		assert.deepEqual(await place({ lastRpcBlock: { gas: 50n }, nextRpcBlock: { gas: 160n } }, 0n, false), { estimate: { gas: 160n }, estimatedIn: ['nextRpcBlock'] })
	})

	test('uses the next RPC block\'s estimate after a failure in the last one only when the transaction runs in the next one with it', async () => {
		assert.deepEqual((await place({ lastRpcBlock: failure('out of gas'), nextRpcBlock: { gas: 160n } }, 100n)).estimate, { gas: 160n })
		// With 60 gas preparation keeps the transaction in the last RPC block, where it fails.
		assert.deepEqual((await place({ lastRpcBlock: failure('out of gas'), nextRpcBlock: { gas: 60n } }, 100n)).estimate, failure('out of gas'))
	})

	test('re-estimates once where an estimate runs, and never returns an estimate for a block it does not run in', async () => {
		// The estimate in the last RPC block is too large to run there, so it is estimated again in the next one, where it runs.
		assert.deepEqual(await place({ lastRpcBlock: { gas: 150n }, nextRpcBlock: { gas: 170n } }, 100n), { estimate: { gas: 170n }, estimatedIn: ['lastRpcBlock', 'nextRpcBlock'] })
		// The second estimate would run back in the last RPC block, so neither block has an estimate that runs in it.
		assert.deepEqual((await place({ lastRpcBlock: { gas: 150n }, nextRpcBlock: { gas: 90n } }, 100n)).estimate, unplaceableEstimate)
	})
})
