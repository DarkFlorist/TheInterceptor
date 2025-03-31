import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import { appendTransactionToInputAndSimulate, getSimulatedBlock, getSimulatedTransactionByHash, mockSignTransaction } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import { EthereumSignedTransactionWithBlockData, serialize } from '../../app/ts/types/wire-types.js'
import { GetBlockReturn, JsonRpcResponse, EthereumJsonRpcRequest } from '../../app/ts/types/JsonRpc-types.js'
import { eth_getBlockByNumber_goerli_8443561_false, eth_getBlockByNumber_goerli_8443561_true, eth_simulateV1_dummy_call_result, eth_simulateV1_dummy_call_result_2calls, eth_simulateV1_get_eth_balance_multicall, eth_transactionByhash0xe10c2a85168046080235fff99e2e14ef1e90c8cf5e9d675f2ca214e49e555e0f } from '../RPCResponses.js'
import { describe, should } from '../micro-should.js'
import * as assert from 'assert'
import { assertIsObject } from '../../app/ts/utils/typescript.js'
import { stringToUint8Array } from '../../app/ts/utils/bigint.js'
import { areEqualUint8Arrays } from '../../app/ts/utils/typed-arrays.js'
import { SimulationState } from '../../app/ts/types/visualizer-types.js'

function parseRequest(data: string) {
	const jsonRpcResponse = JsonRpcResponse.parse(JSON.parse(data))
	if ('error' in jsonRpcResponse) throw Error(`Ethereum Client Error: ${ jsonRpcResponse.error.message }`)
	return jsonRpcResponse.result
}

class MockEthereumJSONRpcRequestHandler {
	public rpcUrl = 'https://rpc.dark.florist/flipcardtrustone'

	public clearCache = () => {}

	public getChainId = async () => 5n

	public readonly jsonRpcRequest = async (rpcRequest: EthereumJsonRpcRequest) => {
		switch (rpcRequest.method) {
			case 'eth_blockNumber': return `0x${ 8443561n.toString(16) }`
			case 'eth_getBlockByNumber': {
				if (rpcRequest.params[0] !== 8443561n && rpcRequest.params[0] !== 'latest') throw new Error('Unsupported block number')
				if (rpcRequest.params[1] === true) return parseRequest(eth_getBlockByNumber_goerli_8443561_true)
				return parseRequest(eth_getBlockByNumber_goerli_8443561_false)
			}
			case 'eth_simulateV1': {
				if (areEqualUint8Arrays(rpcRequest.params[0]?.blockStateCalls[1]?.calls[0]?.input, stringToUint8Array('0x82ad56cb0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000100000000000000000000000000ca11bde05977b3631167028862be2a173976ca110000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000244d2301cc000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa9604500000000000000000000000000000000000000000000000000000000000000000000000000000000ca11bde05977b3631167028862be2a173976ca110000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000244d2301cc000000000000000000000000da9dfa130df4de4673b89022ee50ff26f6ea73cf00000000000000000000000000000000000000000000000000000000'))) {
					// get eth balance query
					return parseRequest(eth_simulateV1_get_eth_balance_multicall)
				}
				if (areEqualUint8Arrays(rpcRequest.params[0]?.blockStateCalls[1]?.calls[0]?.input, stringToUint8Array('0x82ad56cb000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000020000000000000000000000000ca11bde05977b3631167028862be2a173976ca110000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000244d2301cc000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa9604500000000000000000000000000000000000000000000000000000000'))) {
					// get eth balance query
					return parseRequest(eth_simulateV1_get_eth_balance_multicall)
				}
				if (rpcRequest.params[0]?.blockStateCalls.length === 2) {
					return parseRequest(eth_simulateV1_dummy_call_result_2calls)
				}
				return parseRequest(eth_simulateV1_dummy_call_result)
			}
			case 'eth_getTransactionByHash': {
				if (rpcRequest.params[0] === 0xe10c2a85168046080235fff99e2e14ef1e90c8cf5e9d675f2ca214e49e555e0fn) {
					return parseRequest(eth_transactionByhash0xe10c2a85168046080235fff99e2e14ef1e90c8cf5e9d675f2ca214e49e555e0f)
				}
				throw new Error('unsupported Hash')
			}
			default: new Error(`unsupported method ${ rpcRequest.method }`)
		}
		return
	}
}

export async function main() {
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

	const ethereum = new EthereumClientService(new MockEthereumJSONRpcRequestHandler(), async () => {}, async () => {}, rpcNetwork)

	const simulationState: SimulationState = {
		blockNumber: blockNumber,
		blockTimestamp: new Date(0),
		rpcNetwork: rpcNetwork,
		baseFeePerGas: 0n,
		simulationConductedTimestamp: new Date(0),
		simulatedBlocks: []
	}

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

		should('getBlock with true aligns with Nethermind', async () => {
			const block = await getSimulatedBlock(ethereum, undefined, simulationState, blockNumber, true)
			if (block === null) throw new Error('Block was null')
			const serialized = GetBlockReturn.serialize(block)
			const expected = parseRequest(eth_getBlockByNumber_goerli_8443561_true)
			assertIsObject(expected)
			assert.equal(JSON.stringify(serialized, Object.keys(block).sort()), JSON.stringify(expected, Object.keys(expected).sort()))
		})

		should('getBlock with false aligns with Nethermind', async () => {
			const block = await getSimulatedBlock(ethereum, undefined, simulationState, blockNumber, false)
			if (block === null) throw new Error('Block was null')
			const serialized = GetBlockReturn.serialize(block)
			const expected = parseRequest(eth_getBlockByNumber_goerli_8443561_false)
			assertIsObject(expected)
			assert.equal(JSON.stringify(serialized, Object.keys(block).sort()), JSON.stringify(expected, Object.keys(expected).sort()))
		})

		should('adding transaction and getting the next block should include all the same fields as Nethermind', async () => {
			const block = await getSimulatedBlock(ethereum, undefined, simulationState, blockNumber, true)
			if (block === null) throw new Error('Block was null')
			const newState = await appendTransactionToInputAndSimulate(ethereum, undefined, simulationState, [{
				signedTransaction: mockSignTransaction(exampleTransaction),
				website: { websiteOrigin: 'test', icon: undefined, title: undefined },
				created: new Date(),
				originalRequestParameters: { method: 'eth_sendTransaction', params: [{}]},
				transactionIdentifier: 1n,
			}])
			const nextBlock = await getSimulatedBlock(ethereum, undefined, newState, blockNumber + 2n, true)
			if (nextBlock === null) throw new Error('Block was null')
			assert.equal(JSON.stringify(Object.keys(nextBlock).sort()), JSON.stringify(Object.keys(block).sort()))

			const expected = parseRequest(eth_getBlockByNumber_goerli_8443561_true)
			assertIsObject(expected)
			const requiredFields = Object.keys(expected).sort()
			assert.equal(JSON.stringify(Object.keys(nextBlock).sort()), JSON.stringify(requiredFields))
		})

		should('get transaction by hash aligns with Nethermind', async () => {
			const transaction = await getSimulatedTransactionByHash(ethereum, undefined, simulationState, 0xe10c2a85168046080235fff99e2e14ef1e90c8cf5e9d675f2ca214e49e555e0fn)
			if (transaction === null) throw new Error('Transaction is not found')

			const serialized = serialize(EthereumSignedTransactionWithBlockData, transaction)
			const expected = parseRequest(eth_transactionByhash0xe10c2a85168046080235fff99e2e14ef1e90c8cf5e9d675f2ca214e49e555e0f)
			assertIsObject(expected)
			assertIsObject(serialized)
			assert.equal(JSON.stringify(serialized, Object.keys(serialized).sort()), JSON.stringify(expected, Object.keys(expected).sort()))
		})
	})
}
