import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import type { IEthereumJSONRpcRequestHandler } from '../../app/ts/simulation/services/EthereumJSONRpcRequestHandler.js'
import { appendTransactionsToInput, getSimulatedBlockByHashFromInput, getSimulatedBlockFromInput, getSimulatedTransactionByHashFromInput, mockSignTransaction } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import { EthereumBlockHeader, EthereumSignedTransactionWithBlockData, serialize } from '../../app/ts/types/wire-types.js'
import { EthSimulateV1Result } from '../../app/ts/types/ethSimulate-types.js'
import { GetBlockReturn, type EthereumJsonRpcRequest } from '../../app/ts/types/JsonRpc-types.js'
import { eth_getBlockByNumber_goerli_8443561_false, eth_getBlockByNumber_goerli_8443561_true, eth_getBlockByNumber_7702_invalid_auth_yParity_true, eth_simulateV1_dummy_call_result, eth_transactionByhash0xe10c2a85168046080235fff99e2e14ef1e90c8cf5e9d675f2ca214e49e555e0f } from '../RPCResponses.js'
import { describe, test } from 'bun:test'
import * as assert from 'node:assert'
import { assertIsObject } from '../../app/ts/utils/typescript.js'
import { toResolvedSimulationInput } from '../../app/ts/types/visualizer-types.js'
import { TIME_BETWEEN_BLOCKS } from '../../app/ts/utils/constants.js'
import { readJsonRpcResult } from './rpcResponseParsing.js'

// A mock Goerli node at block 8443561 that answers block and transaction lookups with Nethermind's wire JSON.
const createNethermindFixtureRequestHandler = (): IEthereumJSONRpcRequestHandler => ({
	rpcUrl: 'https://rpc.dark.florist/flipcardtrustone',
	clearCache: () => undefined,
	getChainId: async () => 5n,
	jsonRpcRequest: async (rpcRequest: EthereumJsonRpcRequest) => {
		switch (rpcRequest.method) {
			case 'eth_blockNumber': return `0x${ 8443561n.toString(16) }`
			case 'eth_getBlockByNumber': {
				if (rpcRequest.params[0] === 8443562n) {
					if (rpcRequest.params[1] !== true) throw new Error('Compatibility block only supports full transactions')
					return readJsonRpcResult(eth_getBlockByNumber_7702_invalid_auth_yParity_true)
				}
				if (rpcRequest.params[0] !== 8443561n && rpcRequest.params[0] !== 'latest') throw new Error('Unsupported block number')
				if (rpcRequest.params[1] === true) return readJsonRpcResult(eth_getBlockByNumber_goerli_8443561_true)
				return readJsonRpcResult(eth_getBlockByNumber_goerli_8443561_false)
			}
			case 'eth_getTransactionByHash': {
				if (rpcRequest.params[0] === 0xe10c2a85168046080235fff99e2e14ef1e90c8cf5e9d675f2ca214e49e555e0fn) {
					return readJsonRpcResult(eth_transactionByhash0xe10c2a85168046080235fff99e2e14ef1e90c8cf5e9d675f2ca214e49e555e0f)
				}
				throw new Error('unsupported Hash')
			}
			default: throw new Error(`unsupported method ${ rpcRequest.method }`)
		}
	},
})

const blockNumber = 8443561n
const rpcNetwork = {
	name: 'Goerli',
	chainId: 5n,
	httpsRpc: 'https://rpc.dark.florist/flipcardtrustone',
	currencyName: 'Goerli Testnet ETH',
	currencyTicker: 'GÖETH',
	primary: true,
	minimized: true,
	weth: 0xb4fbf271143f4fbf7b91a5ded31805e42b2208d6n,
}

const ethereum = new EthereumClientService(createNethermindFixtureRequestHandler(), async () => undefined, async () => undefined, rpcNetwork)

const emptySimulationInput = toResolvedSimulationInput([])

const exampleTransaction = {
	type: '1559',
	from: 0xd8da6bf26964af9d7eed9e03e53415d37aa96045n,
	nonce: 0n,
	maxFeePerGas: 1n,
	maxPriorityFeePerGas: 1n,
	gas: 21000n,
	to: 0xda9dfa130df4de4673b89022ee50ff26f6ea73cfn,
	value: 10n,
	input: new Uint8Array(0),
	chainId: 5n,
} as const

describe('Nethermind testing', () => {

	test('getBlock with true aligns with Nethermind', async () => {
		const block = await getSimulatedBlockFromInput(ethereum, undefined, emptySimulationInput, blockNumber, true)
		if (block === null) throw new Error('Block was null')
		const serialized = GetBlockReturn.serialize(block)
		const expected = readJsonRpcResult(eth_getBlockByNumber_goerli_8443561_true)
		assertIsObject(expected)
		assert.equal(JSON.stringify(serialized, Object.keys(block).sort()), JSON.stringify(expected, Object.keys(expected).sort()))
	})

	test('getBlock with false aligns with Nethermind', async () => {
		const block = await getSimulatedBlockFromInput(ethereum, undefined, emptySimulationInput, blockNumber, false)
		if (block === null) throw new Error('Block was null')
		const serialized = GetBlockReturn.serialize(block)
		const expected = readJsonRpcResult(eth_getBlockByNumber_goerli_8443561_false)
		assertIsObject(expected)
		assert.equal(JSON.stringify(serialized, Object.keys(block).sort()), JSON.stringify(expected, Object.keys(expected).sort()))
	})

	test('getBlock rejects non-spec 7702 authorization parity values', async () => {
		await assert.rejects(async () => await ethereum.getBlock(undefined, 8443562n, true))
	})

	test('adding a transaction and getting the next block returns the Nethermind block fields', async () => {
		const simulationInput = toResolvedSimulationInput(appendTransactionsToInput([], [{
			signedTransaction: mockSignTransaction(exampleTransaction),
			website: { websiteOrigin: 'test', icon: undefined, title: undefined },
			created: new Date(),
			originalRequestParameters: { method: 'eth_sendTransaction', params: [{}]},
			transactionIdentifier: 1n,
		}]))
		const nextBlock = await getSimulatedBlockFromInput(ethereum, undefined, simulationInput, blockNumber + 1n, true)
		if (nextBlock === null) throw new Error('Block was null')
		const serializedNextBlock = GetBlockReturn.serialize(nextBlock)
		const serializedParentBlock = readJsonRpcResult(eth_getBlockByNumber_goerli_8443561_true)
		assertIsObject(serializedNextBlock)
		assertIsObject(serializedParentBlock)
		const parentBlock = EthereumBlockHeader.parse(serializedParentBlock)
		const nodeSimulatedBlock = EthSimulateV1Result.parse(readJsonRpcResult(eth_simulateV1_dummy_call_result))[0]
		if (parentBlock === null || nodeSimulatedBlock === undefined) throw new Error('Nethermind fixture block missing')

		assert.equal(JSON.stringify(Object.keys(serializedNextBlock).sort()), JSON.stringify(Object.keys(serializedParentBlock).sort()))
		// Header fields a node reports for a simulated child of its latest block, given the block overrides the Interceptor sends with eth_simulateV1.
		assert.equal(nextBlock.number, parentBlock.number + 1n)
		assert.equal(nextBlock.parentHash, parentBlock.hash)
		// The default block time manipulation moves each simulated block one slot past its parent.
		assert.equal(nextBlock.timestamp.getTime() - parentBlock.timestamp.getTime(), TIME_BETWEEN_BLOCKS * 1000)
		assert.equal(nextBlock.gasLimit, parentBlock.gasLimit)
		// eth_simulateV1 executes the simulated block with the parent block's base fee and fee recipient.
		assert.equal(nextBlock.baseFeePerGas, parentBlock.baseFeePerGas)
		assert.equal(nextBlock.miner, parentBlock.miner)
		assert.equal(nextBlock.author, parentBlock.miner)
		// After the merge blocks have no difficulty, so the total difficulty stays the parent's.
		assert.equal(nextBlock.difficulty, nodeSimulatedBlock.difficulty)
		assert.equal(nextBlock.totalDifficulty, parentBlock.totalDifficulty)
		assert.deepEqual(nextBlock.uncles, nodeSimulatedBlock.uncles)
		// A simulated block has no withdrawals, so it reports the empty-trie root like the node does.
		assert.deepEqual(nextBlock.withdrawals, nodeSimulatedBlock.withdrawals)
		assert.equal(nextBlock.withdrawalsRoot, nodeSimulatedBlock.withdrawalsRoot)
		const [includedTransaction, ...otherTransactions] = nextBlock.transactions
		if (includedTransaction === undefined || !('blockHash' in includedTransaction)) throw new Error('Expected the simulated block to include the transaction with its block data')
		assert.deepEqual(otherTransactions, [])
		assert.equal(includedTransaction.hash, mockSignTransaction(exampleTransaction).hash)
		assert.equal(includedTransaction.blockHash, nextBlock.hash)
		assert.equal(includedTransaction.blockNumber, nextBlock.number)
		assert.equal(includedTransaction.transactionIndex, 0n)
		// Deliberately not compared, because the input-based block is built without executing it:
		// - hash is synthetic, derived from the simulation input and the block's position in it, so callers can look the block up again.
		// - stateRoot, receiptsRoot, transactionsRoot, logsBloom, mixHash, sha3Uncles, size, extraData and nonce are copied from the parent block.
		// - gasUsed is the sum of the transactions' gas limits, an upper bound of what the node would report.
		const roundTrippedBlock = await getSimulatedBlockByHashFromInput(ethereum, undefined, simulationInput, nextBlock.hash, true)
		assert.equal(roundTrippedBlock?.number, nextBlock.number)
	})

	test('get transaction by hash aligns with Nethermind', async () => {
		const transaction = await getSimulatedTransactionByHashFromInput(ethereum, undefined, emptySimulationInput, 0xe10c2a85168046080235fff99e2e14ef1e90c8cf5e9d675f2ca214e49e555e0fn)
		if (transaction === null) throw new Error('Transaction is not found')

		const serialized = serialize(EthereumSignedTransactionWithBlockData, transaction)
		const expected = readJsonRpcResult(eth_transactionByhash0xe10c2a85168046080235fff99e2e14ef1e90c8cf5e9d675f2ca214e49e555e0f)
		assertIsObject(expected)
		assertIsObject(serialized)
		assert.equal(JSON.stringify(serialized, Object.keys(serialized).sort()), JSON.stringify(expected, Object.keys(expected).sort()))
	})
})
