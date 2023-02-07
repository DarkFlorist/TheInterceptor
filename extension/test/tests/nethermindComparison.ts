import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import { SimulationModeEthereumClientService } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import { CHAINS } from '../../app/ts/utils/constants.js'
import { GetBlockReturn, EthereumSignedTransactionWithBlockData, JsonRpcResponse, MulticallRequestParameters, SupportedETHRPCCall } from '../../app/ts/utils/wire-types.js'
import { eth_getBlockByNumber_goerli_8443561_false, eth_getBlockByNumber_goerli_8443561_true, eth_multicall_failure, eth_transactionByhash0xe10c2a85168046080235fff99e2e14ef1e90c8cf5e9d675f2ca214e49e555e0f } from '../nethermindRPCResponses.js'
import { describe, should } from '../micro-should.js'
import * as assert from 'assert'
import * as funtypes from 'funtypes'
import { asObject } from '../../app/ts/utils/typescript.js'

const multicallRPCRequest = funtypes.Object({ method: funtypes.Literal('eth_multicall'), params: MulticallRequestParameters })

function parseRequest(data: string) {
	const jsonRpcResponse = JsonRpcResponse.parse(JSON.parse(data))
	if ('error' in jsonRpcResponse) throw Error(`Ethereum Client Error: ${ jsonRpcResponse.error.message }`)
	return jsonRpcResponse.result
}

class MockEthereumJSONRpcRequestHandler {
	constructor(_endpoint: string) {}

	public readonly jsonRpcRequest = async (method: string, params: readonly unknown[]) => {
		const parsed = funtypes.Union(SupportedETHRPCCall, multicallRPCRequest).parse({ method, params })
		switch (parsed.method) {
			case 'eth_getBlockByNumber': {
				if (parsed.params[0] !== 8443561n && parsed.params[0] !== 'latest') throw new Error('Unsupported block number')
				if (parsed.params[1] === true) return parseRequest(eth_getBlockByNumber_goerli_8443561_true)
				return parseRequest(eth_getBlockByNumber_goerli_8443561_false)
			}
			case 'eth_multicall': return parseRequest(eth_multicall_failure)
			case 'eth_getTransactionByHash': {
				if (parsed.params[0] === 0xe10c2a85168046080235fff99e2e14ef1e90c8cf5e9d675f2ca214e49e555e0fn) {
					return parseRequest(eth_transactionByhash0xe10c2a85168046080235fff99e2e14ef1e90c8cf5e9d675f2ca214e49e555e0f)
				}
				throw new Error(`unsupprted Hash`)
			}
			default: throw new Error(`Not supported RPC request method ${ JSON.stringify({ method, params }) }`)
		}

	}
}

export async function main() {
	const blockNumber = 8443561n
	const chain = '5'
	const ethereum = new EthereumClientService(new MockEthereumJSONRpcRequestHandler(CHAINS[chain].https_rpc), chain, true, () => {})
	const simulationModeNode = new SimulationModeEthereumClientService(ethereum, CHAINS[chain].wss_rpc)

	const exampleTransaction = {
		type: '1559' as const,
		from: 0xd8da6bf26964af9d7eed9e03e53415d37aa96045n,
		nonce: 0n,
		maxFeePerGas: 1n,
		maxPriorityFeePerGas: 1n,
		gas: 21000n,
		to: 0xda9dfa130df4de4673b89022ee50ff26f6ea73cfn,
		value: 10n,
		input: new Uint8Array(0),
		chainId: 5n,
	}

	describe('Nethermind testing', () => {

		should('getBlock with true aligns with Nethermind', async () => {
			const block = await simulationModeNode.getBlock(blockNumber, true)
			const serialized = GetBlockReturn.serialize(block)
			const expected = parseRequest(eth_getBlockByNumber_goerli_8443561_true)
			assert.equal(JSON.stringify(serialized, Object.keys(block).sort()), JSON.stringify(expected, Object.keys(asObject(expected)).sort()))
		})

		should('getBlock with false aligns with Nethermind', async () => {
			const block = await simulationModeNode.getBlock(blockNumber, false)
			const serialized = GetBlockReturn.serialize(block)
			const expected = parseRequest(eth_getBlockByNumber_goerli_8443561_false)
			assert.equal(JSON.stringify(serialized, Object.keys(block).sort()), JSON.stringify(expected, Object.keys(asObject(expected)).sort()))
		})

		should('adding transaction and getting the next block should include all the same fields as Nethermind', async () => {
			const block = await simulationModeNode.getBlock(blockNumber, true)
			await simulationModeNode.appendTransaction(exampleTransaction)
			const nextBlock = await simulationModeNode.getBlock(blockNumber + 1n, true)
			assert.equal(JSON.stringify(Object.keys(nextBlock).sort()), JSON.stringify(Object.keys(block).sort()))

			const requiredFields = Object.keys(asObject(parseRequest(eth_getBlockByNumber_goerli_8443561_true))).sort()
			assert.equal(JSON.stringify(Object.keys(nextBlock).sort()), JSON.stringify(requiredFields))
		})

		should('get transaction by hash aligns with Nethermind', async () => {
			const transaction = await simulationModeNode.getTransactionByHash(0xe10c2a85168046080235fff99e2e14ef1e90c8cf5e9d675f2ca214e49e555e0fn)
			if (transaction === undefined) throw new Error('Transaction is undefined')

			const serialized = EthereumSignedTransactionWithBlockData.serialize(transaction)
			const expected = parseRequest(eth_transactionByhash0xe10c2a85168046080235fff99e2e14ef1e90c8cf5e9d675f2ca214e49e555e0f)
			assert.equal(JSON.stringify(serialized, Object.keys(asObject(serialized)).sort()), JSON.stringify(expected, Object.keys(asObject(expected)).sort()))
		})
	})
}
