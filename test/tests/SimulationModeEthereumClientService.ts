import { ethers, keccak256 } from 'ethers'
import { describe, runIfRoot, should, run } from '../micro-should.js'
import * as assert from 'assert'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import { EthereumSignedTransactionToSignedTransaction, EthereumUnsignedTransactionToUnsignedTransaction, serializeSignedTransactionToBytes, serializeUnsignedTransactionToBytes } from '../../app/ts/utils/ethereum.js'
import { bytes32String } from '../../app/ts/utils/bigint.js'
import { EthereumSignatureParity, EthereumSignedTransaction, EthereumSignedTransaction1559, EthereumSignedTransactionWithBlockData, EthereumUnsignedTransaction } from '../../app/ts/types/wire-types.js'
import { groupEthSimulateV1ResultByInputBlocks, mockSignTransaction } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import { EthTransactionReceiptResponse, JsonRpcResponse, EthereumJsonRpcRequest } from '../../app/ts/types/JsonRpc-types.js'
import { eth_getBlockByNumber_goerli_8443561_false, eth_getBlockByNumber_goerli_8443561_true, eth_simulateV1_dummy_call_result, eth_simulateV1_dummy_call_result_2calls } from '../RPCResponses.js'

function parseRequest(data: string) {
	const jsonRpcResponse = JsonRpcResponse.parse(JSON.parse(data))
	if ('error' in jsonRpcResponse) throw Error(`Ethereum Client Error: ${ jsonRpcResponse.error.message }`)
	return jsonRpcResponse.result
}

function testBytes32(suffix: string) {
	return `0x${suffix.padStart(64, '0')}`
}

const zeroBytes256 = `0x${'0'.repeat(512)}`

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

	class MockEthereumJSONRpcRequestHandler {
		public rpcUrl = 'https://rpc.dark.florist/flipcardtrustone'

		public clearCache = () => {}

		public getChainId = async () => 5n

		public readonly jsonRpcRequest = async (rpcRequest: EthereumJsonRpcRequest) => {
			switch (rpcRequest.method) {
				case 'eth_blockNumber': return `0x${ blockNumber.toString(16) }`
				case 'eth_getBlockByNumber': {
					if (rpcRequest.params[0] !== blockNumber && rpcRequest.params[0] !== 'latest') throw new Error('Unsupported block number')
					if (rpcRequest.params[1] === true) return parseRequest(eth_getBlockByNumber_goerli_8443561_true)
					return parseRequest(eth_getBlockByNumber_goerli_8443561_false)
				}
				case 'eth_simulateV1': {
					if (rpcRequest.params[0]?.blockStateCalls.length === 2) return parseRequest(eth_simulateV1_dummy_call_result_2calls)
					return parseRequest(eth_simulateV1_dummy_call_result)
				}
				default: throw new Error(`unsupported method ${ rpcRequest.method }`)
			}
		}
	}

	const ethereum = new EthereumClientService(new MockEthereumJSONRpcRequestHandler(), async () => {}, async () => {}, rpcNetwork)

	describe('SimulationModeEthereumClientService', () => {
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
			chainId: 1n,
		} as const

		should('mockSignTransaction should have r=0, s=0 and yParity = "even"', async () => {
			const signed = mockSignTransaction(exampleTransaction)
			assert.equal(signed.type, '1559')
			assert.equal(signed.r, 0n)
			assert.equal(signed.s, 0n)
			if (!('yParity' in signed)) throw new Error('yParity missing')
			if (signed.type === '1559') assert.equal(signed.yParity, 'even')
		})

		should('ethers.recoverAddress should fail for mocked transaction', async () => {
			const signed = EthereumSignedTransactionToSignedTransaction(mockSignTransaction(exampleTransaction))
			assert.equal(signed.type, '1559')
			if (signed.type !== '1559') throw new Error('wrong transaction type')
			const unsigned = EthereumUnsignedTransactionToUnsignedTransaction(exampleTransaction)
			const digest = keccak256(serializeUnsignedTransactionToBytes(unsigned))
			assert.throws(() => ethers.recoverAddress(digest, {
					r: bytes32String(signed.r),
					s: bytes32String(signed.s),
					yParity: signed.yParity === 'even' ? 0 : 1,
				}),
				'Error: invalid point'
			)
		})

		should('ethers.recoverAddress works for positive case', async() => {
			const validTransaction = {
				hash: '0xdd0967ea3bf8bb02c40edac86ff849f200587483c6f139e9f73242bdb1ef6284',
				nonce: '0x15174',
				blockHash: '0x2d98e688a833144b2990b4c7fcd0dfab924ba74c6933aa7142b12b57683b5623',
				blockNumber: '0xf17472',
				transactionIndex: '0x7',
				from: '0x98db3a41bf8bf4ded2c92a84ec0705689ddeef8b',
				to: '0x33f71fc6302e2295615c17cc32e30adecf2f26ec',
				value: '0x3bae8d3cf0a7cd5',
				gasPrice: '0x2ff19bb49',
				maxPriorityFeePerGas: '0x9502f900',
				maxFeePerGas: '0x642021034',
				gas: '0x15f90',
				data: '0x',
				input: '0x',
				chainId: '0x1',
				type: '0x2',
				v: '0x1',
				s: '0x507d8fd16ce7d4e9d4849d93be747e5b1f5a79812870dcf55c342211a620ca2d',
				r: '0x80ea9fe9b5e38cfcd7ae9c6c338971cb270091014a2e2d16882f6773bba789fc',
				yParity: '0x1'
			}

			const signed = EthereumSignedTransactionToSignedTransaction(EthereumSignedTransaction1559.parse(validTransaction))
			const unsigned = EthereumUnsignedTransactionToUnsignedTransaction(EthereumUnsignedTransaction.parse(validTransaction))
			assert.equal(signed.type, '1559')
			if (signed.type !== '1559') throw new Error('wrong transaction type')

			const digest = keccak256(serializeUnsignedTransactionToBytes(unsigned))

			const addr = ethers.recoverAddress(digest, {
				r: bytes32String(signed.r),
				s: bytes32String(signed.s),
				yParity: signed.yParity === 'even' ? 0 : 1,
			})
			assert.equal(BigInt(addr), 0x98db3a41bf8bf4ded2c92a84ec0705689ddeef8bn)
		})

		should('typed transaction v values 0x0 and 0x1 normalize to parity', async () => {
			const base7702Transaction = {
				type: '0x4',
				from: '0x0000000000000000000000000000000000000001',
				nonce: '0x0',
				maxFeePerGas: '0x2',
				maxPriorityFeePerGas: '0x1',
				gas: '0x5208',
				to: '0x0000000000000000000000000000000000000002',
				value: '0x0',
				input: '0x',
				chainId: '0x1',
				authorizationList: [{
					chainId: '0x1',
					address: '0x000000009b1d0af20d8c6d0a44e162d11f9b8f00',
					nonce: '0x0',
					yParity: '0x0',
					r: '0x3',
					s: '0x4',
				}],
				r: '0x1',
				s: '0x2',
				hash: testBytes32('31'),
			} as const

			const evenTransaction = EthereumSignedTransactionToSignedTransaction(EthereumSignedTransaction.parse({
				...base7702Transaction,
				v: '0x0',
			}))
			assert.equal(evenTransaction.type, '7702')
			if (evenTransaction.type !== '7702') throw new Error('wrong transaction type')
			assert.equal(evenTransaction.yParity, 'even')
			assert.equal(evenTransaction.authorizationList[0]?.yParity, 'even')

			const oddTransaction = EthereumSignedTransactionToSignedTransaction(EthereumSignedTransaction.parse({
				...base7702Transaction,
				v: '0x1',
				hash: testBytes32('32'),
				authorizationList: [{
					...base7702Transaction.authorizationList[0],
					yParity: '0x1',
				}],
			}))
			assert.equal(oddTransaction.type, '7702')
			if (oddTransaction.type !== '7702') throw new Error('wrong transaction type')
			assert.equal(oddTransaction.yParity, 'odd')
			assert.equal(oddTransaction.authorizationList[0]?.yParity, 'odd')
		})

		should('typed transaction with block data parses yParity without v', async () => {
			const parsedTransaction = EthereumSignedTransactionWithBlockData.parse({
				type: '0x4',
				from: '0x0000000000000000000000000000000000000001',
				nonce: '0x0',
				gasPrice: '0x1',
				maxFeePerGas: '0x2',
				maxPriorityFeePerGas: '0x1',
				gas: '0x5208',
				to: '0x0000000000000000000000000000000000000002',
				value: '0x0',
				data: '0x',
				input: '0x',
				chainId: '0x1',
				yParity: '0x0',
				s: '0x2',
				r: '0x1',
				hash: testBytes32('33'),
				blockHash: testBytes32('34'),
				blockNumber: '0x1',
				transactionIndex: '0x0',
				authorizationList: [{
					chainId: '0x1',
					address: '0x000000009b1d0af20d8c6d0a44e162d11f9b8f00',
					nonce: '0x0',
					yParity: '0x0',
					r: '0x3',
					s: '0x4',
				}],
			})
			assert.equal(parsedTransaction.type, '7702')
			if (parsedTransaction.type !== '7702') throw new Error('wrong transaction type')
			if (!('yParity' in parsedTransaction)) throw new Error('yParity missing')
			assert.equal(parsedTransaction.yParity, 'even')
			assert.equal('v' in parsedTransaction, false)
		})

		should('typed transaction parsers reject legacy-style v values', async () => {
			const base7702Transaction = {
				type: '0x4',
				from: '0x0000000000000000000000000000000000000001',
				nonce: '0x0',
				maxFeePerGas: '0x2',
				maxPriorityFeePerGas: '0x1',
				gas: '0x5208',
				to: '0x0000000000000000000000000000000000000002',
				value: '0x0',
				input: '0x',
				chainId: '0x1',
				authorizationList: [{
					chainId: '0x1',
					address: '0x000000009b1d0af20d8c6d0a44e162d11f9b8f00',
					nonce: '0x0',
					yParity: '0x0',
					r: '0x3',
					s: '0x4',
				}],
				r: '0x1',
				s: '0x2',
				hash: testBytes32('33'),
			} as const

			assert.throws(() => EthereumSignedTransaction.parse({
				...base7702Transaction,
				v: '0x1b',
			}))
			assert.throws(() => EthereumSignedTransaction.parse({
				...base7702Transaction,
				v: '0x1c',
				hash: testBytes32('34'),
			}))
			assert.throws(() => EthereumSignedTransactionWithBlockData.parse({
				...base7702Transaction,
				gasPrice: '0x1',
				data: '0x',
				blockHash: testBytes32('35'),
				blockNumber: '0x1',
				transactionIndex: '0x0',
				v: '0x1b',
			}))
		})

		should('transaction receipt parses 7702 without authorization list fields', async () => {
			const receipt = EthTransactionReceiptResponse.parse({
				type: '0x4',
				blockHash: testBytes32('41'),
				blockNumber: '0x1',
				transactionHash: testBytes32('42'),
				transactionIndex: '0x0',
				contractAddress: null,
				cumulativeGasUsed: '0x5208',
				gasUsed: '0x5208',
				effectiveGasPrice: '0x1',
				from: '0x0000000000000000000000000000000000000001',
				to: '0x0000000000000000000000000000000000000002',
				logs: [],
				logsBloom: zeroBytes256,
				status: '0x1',
			})
			if (receipt === null) throw new Error('receipt should not be null')
			assert.equal(receipt.type, '7702')
			assert.equal('authorizationList' in receipt, false)
		})

		should('typed transaction serializers use the correct prefix bytes', async () => {
			const unsigned7702 = EthereumUnsignedTransaction.parse({
				type: '0x4',
				from: '0x0000000000000000000000000000000000000001',
				nonce: '0x0',
				maxFeePerGas: '0x2',
				maxPriorityFeePerGas: '0x1',
				gas: '0x5208',
				to: '0x0000000000000000000000000000000000000002',
				value: '0x0',
				input: '0x',
				chainId: '0x1',
				authorizationList: [{
					chainId: '0x1',
					address: '0x000000009b1d0af20d8c6d0a44e162d11f9b8f00',
					nonce: '0x0',
				}],
			})
			const unsigned4844 = EthereumUnsignedTransaction.parse({
				type: '0x3',
				from: '0x0000000000000000000000000000000000000001',
				nonce: '0x0',
				maxFeePerGas: '0x2',
				maxPriorityFeePerGas: '0x1',
				gas: '0x5208',
				to: '0x0000000000000000000000000000000000000002',
				value: '0x0',
				input: '0x',
				chainId: '0x1',
				maxFeePerBlobGas: '0x3',
				blobVersionedHashes: [testBytes32('51')],
			})

			const serializedUnsigned7702 = serializeUnsignedTransactionToBytes(EthereumUnsignedTransactionToUnsignedTransaction(unsigned7702))
			const serializedSigned7702 = serializeSignedTransactionToBytes(EthereumSignedTransactionToSignedTransaction(mockSignTransaction(unsigned7702)))
			const serializedUnsigned4844 = serializeUnsignedTransactionToBytes(EthereumUnsignedTransactionToUnsignedTransaction(unsigned4844))
			const serializedSigned4844 = serializeSignedTransactionToBytes(EthereumSignedTransactionToSignedTransaction(mockSignTransaction(unsigned4844)))

			assert.equal(serializedUnsigned7702[0], 4)
			assert.equal(serializedSigned7702[0], 4)
			assert.equal(serializedUnsigned4844[0], 3)
			assert.equal(serializedSigned4844[0], 3)
		})

		should('EthereumSignatureParity rejects unsupported values', async () => {
			assert.throws(() => EthereumSignatureParity.parse('0x1c'))
			assert.throws(() => EthereumSignatureParity.parse('0x2'))
		})

		should('groupEthSimulateV1ResultByInputBlocks collapses split rpc blocks back into one logical block', async () => {
			const splitSimulationStateInput = [{
				stateOverrides: {},
				transactions: [
					{
						signedTransaction: mockSignTransaction({
							...exampleTransaction,
							nonce: 0n,
							gas: 20_000_000n,
						}),
						website: { websiteOrigin: 'test', icon: undefined, title: undefined },
						created: new Date(),
						originalRequestParameters: { method: 'eth_sendTransaction', params: [{}]},
						transactionIdentifier: 2n,
					},
					{
						signedTransaction: mockSignTransaction({
							...exampleTransaction,
							nonce: 1n,
							gas: 20_000_000n,
						}),
						website: { websiteOrigin: 'test', icon: undefined, title: undefined },
						created: new Date(),
						originalRequestParameters: { method: 'eth_sendTransaction', params: [{}]},
						transactionIdentifier: 3n,
					},
				],
				signedMessages: [],
				blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
				simulateWithZeroBaseFee: false,
			}] as const

			const { prepared, result } = await ethereum.simulatePrepared(splitSimulationStateInput, blockNumber, undefined)
			assert.equal(result.length, 2)
			const grouped = groupEthSimulateV1ResultByInputBlocks(prepared, result)
			assert.equal(grouped.length, 1)
			const groupedBlock = grouped[0]
			if (groupedBlock === undefined) throw new Error('grouped block missing')
			assert.equal(groupedBlock.calls.length, 2)
			assert.equal(groupedBlock.calls[0]?.gasUsed, 0x5208n)
			assert.equal(groupedBlock.calls[1]?.gasUsed, 0x6dd4n)
		})
	})
}

await runIfRoot(async  () => {
	await main()
	await run()
}, import.meta)
