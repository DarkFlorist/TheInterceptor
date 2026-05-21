import { describe, test } from 'bun:test'
import * as assert from 'assert'
import { recoverAddress } from 'viem'
import { keccak256 } from 'viem/utils'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import { EthereumSignedTransactionToSignedTransaction, EthereumUnsignedTransactionToUnsignedTransaction, serializeSignedTransactionToBytes, serializeUnsignedTransactionToBytes } from '../../app/ts/utils/ethereum.js'
import { bytes32String, dataStringWith0xStart } from '../../app/ts/utils/bigint.js'
import { EthereumSignatureParity, EthereumSignedTransaction, EthereumSignedTransaction1559, EthereumSignedTransactionWithBlockData, EthereumUnsignedTransaction } from '../../app/ts/types/wire-types.js'
import { createExecutionSimulationState, createSimulationState, getSimulatedBlockByHashFromInput, getSimulatedBlockFromInput, getSimulatedBlockNumberFromInput, getSimulatedCodeFromInput, getSimulatedLogs, getSimulatedTransactionByHashFromInput, getSimulatedTransactionReceipt, groupEthSimulateV1ResultByInputBlocks, mockSignTransaction, simulateEstimateGasFromInput, simulatedCallFromInput } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import { EthTransactionReceiptResponse, JsonRpcResponse, type EthereumJsonRpcRequest } from '../../app/ts/types/JsonRpc-types.js'
import type { EthSimulateV1Result } from '../../app/ts/types/ethSimulate-types.js'
import { toResolvedExecutionSimulationState, toResolvedSimulationInput } from '../../app/ts/types/visualizer-types.js'
import { Multicall3ABI } from '../../app/ts/utils/constants.js'
import { decodeFunctionDataStrict, encodeAbiValues, encodeFunctionCall, encodeFunctionReturn } from '../../app/ts/utils/abiRuntime.js'
import { eth_getBlockByNumber_goerli_8443561_false, eth_getBlockByNumber_goerli_8443561_true, eth_simulateV1_dummy_call_result, eth_simulateV1_dummy_call_result_2calls, eth_simulateV1_get_eth_balance_multicall } from '../RPCResponses.js'
import { JsonRpcResponseError } from '../../app/ts/utils/errors.js'

function parseRequest<T>(data: string): T {
	const jsonRpcResponse = JsonRpcResponse.parse(JSON.parse(data))
	if ('error' in jsonRpcResponse) throw Error(`Ethereum Client Error: ${ jsonRpcResponse.error.message }`)
	return jsonRpcResponse.result as T
}

const ethSimulateSingleBlockResult = parseRequest<EthSimulateV1Result>(eth_simulateV1_dummy_call_result)
const ethSimulateSplitBlocksResult = parseRequest<EthSimulateV1Result>(eth_simulateV1_dummy_call_result_2calls)
const ethSimulateAggregate3Result = parseRequest<EthSimulateV1Result>(eth_simulateV1_get_eth_balance_multicall)
const getCodeAbi = [{
	type: 'function',
	name: 'at',
	stateMutability: 'view',
	inputs: [{ name: 'target', type: 'address' }],
	outputs: [{ name: 'code', type: 'bytes' }],
}] as const
const getCodeSelector = encodeFunctionCall(getCodeAbi, 'at', ['0x0000000000000000000000000000000000000000']).slice(0, 10)

function buildAggregate3BalanceBlock(balanceQueryCount: number) {
	const aggregate3BalanceBlock = ethSimulateAggregate3Result[ethSimulateAggregate3Result.length - 1]
	const aggregate3Call = aggregate3BalanceBlock?.calls[0]
	if (aggregate3BalanceBlock === undefined) throw new Error('missing aggregate3 simulation fixture block')
	if (aggregate3Call === undefined) throw new Error('missing aggregate3 simulation fixture call')
	return {
		...aggregate3BalanceBlock,
		calls: [{
			...aggregate3Call,
			returnData: encodeFunctionReturn(Multicall3ABI, 'aggregate3', [Array.from({ length: balanceQueryCount }, (_, index) => ({
				success: true,
				returnData: encodeAbiValues(['uint256'], [BigInt(index + 1)]),
			}))]),
		}],
	}
}

function createMockEthSimulateV1Result(blockStateCallCount: number, aggregate3BalanceQueryCount: number | undefined) {
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

function createMockEthSimulateV1ResultWithCustomLastBlock(blockStateCallCount: number, customLastBlock: EthSimulateV1Result[number]) {
	if (blockStateCallCount <= 1) return [customLastBlock]
	const precedingBlocks = createMockEthSimulateV1Result(blockStateCallCount - 1, undefined)
	return [...precedingBlocks, customLastBlock]
}

function testBytes32(suffix: string) {
	return `0x${suffix.padStart(64, '0')}`
}

const zeroBytes256 = `0x${'0'.repeat(512)}`

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
		public rejectOmittedGas = false
		public readonly ethSimulateV1Calls: { blockStateCallCount: number, aggregate3BalanceQueryCount: number | undefined, lastCallGas: bigint | undefined }[] = []

		public clearCache = () => undefined

		public getChainId = async () => 5n

		public readonly jsonRpcRequest = async (rpcRequest: EthereumJsonRpcRequest) => {
			switch (rpcRequest.method) {
				case 'eth_blockNumber': return `0x${ blockNumber.toString(16) }`
				case 'eth_getTransactionCount': return '0x0'
				case 'eth_getBlockByNumber': {
					if (rpcRequest.params[0] !== blockNumber && rpcRequest.params[0] !== 'latest') throw new Error('Unsupported block number')
					if (rpcRequest.params[1] === true) return parseRequest(eth_getBlockByNumber_goerli_8443561_true)
					return parseRequest(eth_getBlockByNumber_goerli_8443561_false)
				}
				case 'eth_simulateV1': {
					const lastCall = rpcRequest.params[0]?.blockStateCalls.at(-1)?.calls[0]
					const lastCallInput = lastCall?.input
					const lastCallGas = lastCall?.gas
					const aggregate3BalanceQueryCount = lastCallInput !== undefined && dataStringWith0xStart(lastCallInput).startsWith('0x82ad56cb')
						? (() => {
							const decoded = decodeFunctionDataStrict(Multicall3ABI, dataStringWith0xStart(lastCallInput))
							if (decoded.functionName !== 'aggregate3') throw new Error('expected aggregate3 call')
							return decoded.args[0].length
						})()
						: undefined
					const blockStateCallCount = rpcRequest.params[0]?.blockStateCalls.length ?? 0
					this.ethSimulateV1Calls.push({ blockStateCallCount, aggregate3BalanceQueryCount, lastCallGas })
					if (this.rejectOmittedGas && lastCallGas === undefined) {
						throw new JsonRpcResponseError({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'gas required' } })
					}
					if (lastCallInput !== undefined && dataStringWith0xStart(lastCallInput).startsWith(getCodeSelector)) {
						const singleTransactionBlock = ethSimulateSingleBlockResult[0]
						const singleCall = singleTransactionBlock?.calls[0]
						if (singleTransactionBlock === undefined || singleCall === undefined) throw new Error('missing single transaction simulation fixture')
						return createMockEthSimulateV1ResultWithCustomLastBlock(blockStateCallCount, {
							...singleTransactionBlock,
							calls: [{
								...singleCall,
								returnData: encodeFunctionReturn(getCodeAbi, 'at', ['0x1234']),
							}],
						})
					}
					return createMockEthSimulateV1Result(blockStateCallCount, aggregate3BalanceQueryCount)
				}
				default: throw new Error(`unsupported method ${ rpcRequest.method }`)
			}
		}
	}

	const requestHandler = new MockEthereumJSONRpcRequestHandler()
	const ethereum = new EthereumClientService(requestHandler, async () => undefined, async () => undefined, rpcNetwork)
	const getBlockNumberFromInput = async (simulationStateInput: Parameters<typeof toResolvedSimulationInput>[0]) => await getSimulatedBlockNumberFromInput(ethereum, undefined, toResolvedSimulationInput(simulationStateInput))
	const getBlockFromInput = async (simulationStateInput: Parameters<typeof toResolvedSimulationInput>[0], blockTag: Parameters<typeof getSimulatedBlockFromInput>[3], includeTransactions = false) => await getSimulatedBlockFromInput(ethereum, undefined, toResolvedSimulationInput(simulationStateInput), blockTag, includeTransactions)
	const getBlockByHashFromInput = async (simulationStateInput: Parameters<typeof toResolvedSimulationInput>[0], blockHash: bigint, includeTransactions = false) => await getSimulatedBlockByHashFromInput(ethereum, undefined, toResolvedSimulationInput(simulationStateInput), blockHash, includeTransactions)
	const getTransactionByHashFromInput = async (simulationStateInput: Parameters<typeof toResolvedSimulationInput>[0], hash: bigint) => await getSimulatedTransactionByHashFromInput(ethereum, undefined, toResolvedSimulationInput(simulationStateInput), hash)
	const getReceiptFromState = async (simulationState: Parameters<typeof toResolvedExecutionSimulationState>[0], hash: bigint) => await getSimulatedTransactionReceipt(ethereum, undefined, toResolvedExecutionSimulationState(simulationState), hash)
	const getLogsFromState = async (simulationState: Parameters<typeof toResolvedExecutionSimulationState>[0], filter: Parameters<typeof getSimulatedLogs>[3]) => await getSimulatedLogs(ethereum, undefined, toResolvedExecutionSimulationState(simulationState), filter)

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

		const createSimulationStateInput = () => [{
			stateOverrides: {},
			transactions: [{
				signedTransaction: mockSignTransaction({
					...exampleTransaction,
					nonce: 0n,
				}),
				website: { websiteOrigin: 'test', icon: undefined, title: undefined },
				created: new Date(),
				originalRequestParameters: { method: 'eth_sendTransaction', params: [{}]},
				transactionIdentifier: 100n,
			}],
			signedMessages: [],
			blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
			simulateWithZeroBaseFee: false,
		}] as const

		const createSimulationStateInputWithGas = (gas: bigint): Parameters<typeof toResolvedSimulationInput>[0] => [{
			stateOverrides: {},
			transactions: [{
				signedTransaction: mockSignTransaction({
					...exampleTransaction,
					nonce: 0n,
					gas,
				}),
				website: { websiteOrigin: 'test', icon: undefined, title: undefined },
				created: new Date(),
				originalRequestParameters: { method: 'eth_sendTransaction', params: [{}]},
				transactionIdentifier: 101n,
			}],
			signedMessages: [],
			blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
			simulateWithZeroBaseFee: false,
		}]

		const createSplitSimulationStateInput = (): Parameters<typeof toResolvedSimulationInput>[0] => [{
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
					transactionIdentifier: 102n,
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
					transactionIdentifier: 103n,
				},
			],
			signedMessages: [],
			blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
			simulateWithZeroBaseFee: false,
		}]

		test('mockSignTransaction should have r=0, s=0 and yParity = "even"', async () => {
			const signed = mockSignTransaction(exampleTransaction)
			assert.equal(signed.type, '1559')
			assert.equal(signed.r, 0n)
			assert.equal(signed.s, 0n)
			if (!('yParity' in signed)) throw new Error('yParity missing')
			if (signed.type === '1559') assert.equal(signed.yParity, 'even')
		})

		test('recoverAddress should fail for mocked transaction', async () => {
			const signed = EthereumSignedTransactionToSignedTransaction(mockSignTransaction(exampleTransaction))
			assert.equal(signed.type, '1559')
			if (signed.type !== '1559') throw new Error('wrong transaction type')
			const unsigned = EthereumUnsignedTransactionToUnsignedTransaction(exampleTransaction)
			const digest = keccak256(serializeUnsignedTransactionToBytes(unsigned))
			await assert.rejects(async () => await recoverAddress({
				hash: digest,
				signature: {
					r: bytes32String(signed.r),
					s: bytes32String(signed.s),
					yParity: signed.yParity === 'even' ? 0 : 1,
				},
			}))
		})

		test('recoverAddress works for positive case', async() => {
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

			const addr = await recoverAddress({
				hash: digest,
				signature: {
				r: bytes32String(signed.r),
				s: bytes32String(signed.s),
				yParity: signed.yParity === 'even' ? 0 : 1,
				},
			})
			assert.equal(BigInt(addr), 0x98db3a41bf8bf4ded2c92a84ec0705689ddeef8bn)
		})

		test('typed transaction v values 0x0 and 0x1 normalize to parity', async () => {
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

		test('typed transaction with block data parses yParity without v', async () => {
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

		test('typed transaction parsers reject legacy-style v values', async () => {
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

		test('transaction receipt parses 7702 without authorization list fields', async () => {
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

		test('typed transaction serializers use the correct prefix bytes', async () => {
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

		test('EthereumSignatureParity rejects unsupported values', async () => {
			assert.throws(() => EthereumSignatureParity.parse('0x1c'))
			assert.throws(() => EthereumSignatureParity.parse('0x2'))
		})

		test('groupEthSimulateV1ResultByInputBlocks collapses split rpc blocks back into one logical block', async () => {
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

		test('simulateEstimateGasFromInput omits gas when input gas is omitted', async () => {
			requestHandler.ethSimulateV1Calls.length = 0
			const estimateGas = await simulateEstimateGasFromInput(ethereum, undefined, [], {
				from: exampleTransaction.from,
				to: exampleTransaction.to,
				value: exampleTransaction.value,
				input: exampleTransaction.input,
			})
			if ('error' in estimateGas) throw new Error(`estimate gas unexpectedly failed: ${ estimateGas.message }`)
			assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.lastCallGas, undefined)
		})

		test('simulateEstimateGasFromInput preserves explicit gas', async () => {
			requestHandler.ethSimulateV1Calls.length = 0
			const explicitGas = 54_321n
			const estimateGas = await simulateEstimateGasFromInput(ethereum, undefined, [], {
				from: exampleTransaction.from,
				to: exampleTransaction.to,
				value: exampleTransaction.value,
				input: exampleTransaction.input,
				gas: explicitGas,
			})
			if ('error' in estimateGas) throw new Error(`estimate gas unexpectedly failed: ${ estimateGas.message }`)
			assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.lastCallGas, explicitGas)
		})

		test('simulatedCallFromInput omits gas when gasLimit is omitted', async () => {
			requestHandler.ethSimulateV1Calls.length = 0
			const callResult = await simulatedCallFromInput(ethereum, undefined, [], {
				from: exampleTransaction.from,
				to: exampleTransaction.to,
				value: exampleTransaction.value,
				input: exampleTransaction.input,
				maxFeePerGas: 0n,
				maxPriorityFeePerGas: 0n,
			})
			if ('error' in callResult) throw new Error(`simulated call unexpectedly failed: ${ callResult.message }`)
			assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.lastCallGas, undefined)
		})

		test('simulatedCallFromInput preserves explicit gasLimit', async () => {
			requestHandler.ethSimulateV1Calls.length = 0
			const gasLimit = 65_432n
			const callResult = await simulatedCallFromInput(ethereum, undefined, [], {
				from: exampleTransaction.from,
				to: exampleTransaction.to,
				value: exampleTransaction.value,
				input: exampleTransaction.input,
				maxFeePerGas: 0n,
				maxPriorityFeePerGas: 0n,
				gasLimit,
			})
			if ('error' in callResult) throw new Error(`simulated call unexpectedly failed: ${ callResult.message }`)
			assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.lastCallGas, gasLimit)
		})

		test('getSimulatedCodeFromInput omits gas for synthetic code lookup calls', async () => {
			requestHandler.ethSimulateV1Calls.length = 0
			const simulatedCode = await getSimulatedCodeFromInput(ethereum, undefined, createSimulationStateInput(), 0x1234n)
			assert.equal(simulatedCode.statusCode, 'success')
			if (simulatedCode.statusCode !== 'success') throw new Error('simulated code unexpectedly failed')
			assert.equal(dataStringWith0xStart(simulatedCode.getCodeReturn), '0x1234')
			assert.equal(requestHandler.ethSimulateV1Calls.at(-1)?.lastCallGas, undefined)
		})

		test('simulateEstimateGasFromInput surfaces RPC errors when omitted gas is rejected', async () => {
			requestHandler.ethSimulateV1Calls.length = 0
			requestHandler.rejectOmittedGas = true
			try {
				const estimateGas = await simulateEstimateGasFromInput(ethereum, undefined, [], {
					from: exampleTransaction.from,
					to: exampleTransaction.to,
					value: exampleTransaction.value,
					input: exampleTransaction.input,
				})
				if (!('error' in estimateGas)) throw new Error('estimate gas unexpectedly succeeded')
				assert.equal(estimateGas.error.code, -32000)
				assert.equal(estimateGas.error.message, 'gas required')
				assert.equal(requestHandler.ethSimulateV1Calls.length, 1)
			} finally {
				requestHandler.rejectOmittedGas = false
			}
		})

			test('input-based block number counts split execution blocks', async () => {
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

				assert.equal(await getBlockNumberFromInput(splitSimulationStateInput), blockNumber + 2n)
			})

			test('input-based block number ignores the default empty simulation block', async () => {
				const emptySimulationStateInput = [{
					stateOverrides: {},
					transactions: [],
					signedMessages: [],
					blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
					simulateWithZeroBaseFee: false,
				}] as const

				assert.equal(await getBlockNumberFromInput(emptySimulationStateInput), blockNumber)
			})

			test('input-based simulated block hash is deterministic and round-trips through getBlockByHash', async () => {
				const simulationStateInput = [{
				stateOverrides: {},
				transactions: [{
					signedTransaction: mockSignTransaction({
						...exampleTransaction,
						nonce: 0n,
					}),
					website: { websiteOrigin: 'test', icon: undefined, title: undefined },
					created: new Date(),
					originalRequestParameters: { method: 'eth_sendTransaction', params: [{}]},
					transactionIdentifier: 4n,
				}],
				signedMessages: [],
				blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
				simulateWithZeroBaseFee: false,
			}] as const

			const latestBlock = await getBlockFromInput(simulationStateInput, 'latest', true)
			if (latestBlock === null) throw new Error('latest simulated block missing')
			const sameBlock = await getBlockFromInput(simulationStateInput, 'latest', true)
			if (sameBlock === null) throw new Error('latest simulated block missing on second read')
			const roundTripped = await getBlockByHashFromInput(simulationStateInput, latestBlock.hash, true)
			if (roundTripped === null) throw new Error('round-tripped block missing')

			assert.equal(latestBlock.hash, sameBlock.hash)
				assert.equal(roundTripped.hash, latestBlock.hash)
				assert.equal(roundTripped.number, latestBlock.number)
			})

			test('input-based simulated block gasUsed comes from eth_simulateV1 result', async () => {
				requestHandler.ethSimulateV1Calls.length = 0
				const simulationStateInput = createSimulationStateInputWithGas(100_000n)

				const latestBlock = await getBlockFromInput(simulationStateInput, 'latest', true)
				if (latestBlock === null) throw new Error('latest simulated block missing')

				assert.equal(latestBlock.gasUsed, 0x5208n)
				assert.equal(requestHandler.ethSimulateV1Calls.length, 1)
			})

			test('input-based getBlockByHash gasUsed comes from eth_simulateV1 result', async () => {
				requestHandler.ethSimulateV1Calls.length = 0
				const simulationStateInput = createSimulationStateInputWithGas(100_000n)

				const latestBlock = await getBlockFromInput(simulationStateInput, 'latest', true)
				if (latestBlock === null) throw new Error('latest simulated block missing')
				const roundTripped = await getBlockByHashFromInput(simulationStateInput, latestBlock.hash, true)
				if (roundTripped === null) throw new Error('round-tripped block missing')

				assert.equal(roundTripped.gasUsed, 0x5208n)
				assert.equal(requestHandler.ethSimulateV1Calls.length, 2)
			})

			test('input-based split execution block gasUsed comes from each eth_simulateV1 result block', async () => {
				requestHandler.ethSimulateV1Calls.length = 0
				const simulationStateInput = createSplitSimulationStateInput()

				const firstExecutionBlock = await getBlockFromInput(simulationStateInput, blockNumber + 1n, true)
				const secondExecutionBlock = await getBlockFromInput(simulationStateInput, blockNumber + 2n, true)
				if (firstExecutionBlock === null || secondExecutionBlock === null) throw new Error('simulated split execution block missing')

				assert.equal(firstExecutionBlock.gasUsed, 0x5208n)
				assert.equal(secondExecutionBlock.gasUsed, 0x6dd4n)
				assert.equal(requestHandler.ethSimulateV1Calls.length, 2)
			})

			test('input-based simulated block hash changes when transaction contents change', async () => {
				const baseSimulationStateInput = [{
					stateOverrides: {},
					transactions: [{
						signedTransaction: mockSignTransaction({
							...exampleTransaction,
							nonce: 0n,
						}),
						website: { websiteOrigin: 'test', icon: undefined, title: undefined },
						created: new Date(),
						originalRequestParameters: { method: 'eth_sendTransaction', params: [{}]},
						transactionIdentifier: 7n,
					}],
					signedMessages: [],
					blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
					simulateWithZeroBaseFee: false,
				}] as const

				const changedSimulationStateInput = [{
					...baseSimulationStateInput[0],
					transactions: [{
						...baseSimulationStateInput[0].transactions[0],
						signedTransaction: mockSignTransaction({
							...exampleTransaction,
							nonce: 1n,
						}),
					}],
				}] as const

				const firstBlock = await getBlockFromInput(baseSimulationStateInput, 'latest', true)
				const secondBlock = await getBlockFromInput(changedSimulationStateInput, 'latest', true)
				if (firstBlock === null || secondBlock === null) throw new Error('simulated block missing')

				assert.notEqual(firstBlock.hash, secondBlock.hash)
			})

			test('input-based transaction lookup uses execution block positions after gas splitting', async () => {
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
						transactionIdentifier: 5n,
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
						transactionIdentifier: 6n,
					},
				],
				signedMessages: [],
				blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
				simulateWithZeroBaseFee: false,
			}] as const

			const secondHash = splitSimulationStateInput[0].transactions[1]?.signedTransaction.hash
			if (secondHash === undefined) throw new Error('second transaction hash missing')
			const found = await getTransactionByHashFromInput(splitSimulationStateInput, secondHash)
			if (found === null) throw new Error('second transaction not found in input-only lookup')

				assert.equal(found.blockNumber, blockNumber + 2n)
				assert.equal(found.transactionIndex, 0n)
			})

			test('input-based execution blocks link together after gas splitting', async () => {
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
							transactionIdentifier: 8n,
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
							transactionIdentifier: 9n,
						},
					],
					signedMessages: [],
					blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
					simulateWithZeroBaseFee: false,
				}] as const

				const firstBlock = await getBlockFromInput(splitSimulationStateInput, blockNumber + 1n, true)
				const secondBlock = await getBlockFromInput(splitSimulationStateInput, blockNumber + 2n, true)
				if (firstBlock === null || secondBlock === null) throw new Error('split execution block missing')

				assert.equal(secondBlock.parentHash, firstBlock.hash)
				assert.equal(secondBlock.number, firstBlock.number + 1n)
			})

			test('state-based receipt uses execution block placement after gas splitting', async () => {
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
							transactionIdentifier: 10n,
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
							transactionIdentifier: 11n,
						},
					],
					signedMessages: [],
					blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
					simulateWithZeroBaseFee: false,
				}] as const

				const simulationState = await createSimulationState(ethereum, undefined, splitSimulationStateInput)
				if (simulationState.success === false) throw new Error('simulation unexpectedly failed')
				const secondHash = splitSimulationStateInput[0].transactions[1]?.signedTransaction.hash
				if (secondHash === undefined) throw new Error('second transaction hash missing')
				const secondBlock = await getBlockFromInput(splitSimulationStateInput, blockNumber + 2n, true)
				if (secondBlock === null) throw new Error('second simulated block missing')
				const receipt = await getReceiptFromState(simulationState, secondHash)
				if (receipt === null) throw new Error('receipt missing')

				assert.equal(receipt.blockNumber, blockNumber + 2n)
				assert.equal(receipt.blockHash, secondBlock.hash)
				assert.equal(receipt.transactionIndex, 0n)
				assert.equal(receipt.cumulativeGasUsed, receipt.gasUsed)
			})

			test('state-based receipt keeps receipt and log block numbers in sync', async () => {
				const simulationStateInput = [{
					stateOverrides: {},
					transactions: [{
						signedTransaction: mockSignTransaction({
							...exampleTransaction,
							nonce: 0n,
						}),
						website: { websiteOrigin: 'test', icon: undefined, title: undefined },
						created: new Date(),
						originalRequestParameters: { method: 'eth_sendTransaction', params: [{}]},
						transactionIdentifier: 14n,
					}],
					signedMessages: [],
					blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
					simulateWithZeroBaseFee: false,
				}] as const

				const simulationState = await createSimulationState(ethereum, undefined, simulationStateInput)
				if (simulationState.success === false) throw new Error('simulation unexpectedly failed')
				const transactionHash = simulationStateInput[0].transactions[0]?.signedTransaction.hash
				if (transactionHash === undefined) throw new Error('transaction hash missing')
				const receipt = await getReceiptFromState(simulationState, transactionHash)
				if (receipt === null) throw new Error('receipt missing')

				assert.equal(receipt.blockNumber, blockNumber + 1n)
				assert.equal(receipt.logs[0]?.blockNumber, receipt.blockNumber)
			})

			test('state-based logs honor the first simulated execution block hash after gas splitting', async () => {
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
							transactionIdentifier: 12n,
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
							transactionIdentifier: 13n,
						},
					],
					signedMessages: [],
					blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
					simulateWithZeroBaseFee: false,
				}] as const

				const simulationState = await createSimulationState(ethereum, undefined, splitSimulationStateInput)
				if (simulationState.success === false) throw new Error('simulation unexpectedly failed')
				const firstBlock = await getBlockFromInput(splitSimulationStateInput, blockNumber + 1n, true)
				if (firstBlock === null) throw new Error('first simulated block missing')
				const logs = await getLogsFromState(simulationState, { blockHash: firstBlock.hash })

				assert.equal(logs.length, 1)
				assert.equal(logs[0]?.blockHash, firstBlock.hash)
				assert.equal(logs[0]?.blockNumber, blockNumber + 1n)
			})
			test('execution-only simulation skips token balance follow-up simulation', async () => {
				const simulationStateInput = [{
					stateOverrides: {},
					transactions: [{
						signedTransaction: mockSignTransaction({
							...exampleTransaction,
							nonce: 0n,
						}),
						website: { websiteOrigin: 'test', icon: undefined, title: undefined },
						created: new Date(),
						originalRequestParameters: { method: 'eth_sendTransaction', params: [{}]},
						transactionIdentifier: 10n,
					}],
					signedMessages: [],
					blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
					simulateWithZeroBaseFee: false,
				}] as const

				requestHandler.ethSimulateV1Calls.length = 0
				const fullSimulationState = await createSimulationState(ethereum, undefined, simulationStateInput)
				if (fullSimulationState.success === false) throw new Error('simulation unexpectedly failed')
				assert.equal(requestHandler.ethSimulateV1Calls.some((call) => call.aggregate3BalanceQueryCount !== undefined), true)
				assert.equal(requestHandler.ethSimulateV1Calls.find((call) => call.aggregate3BalanceQueryCount !== undefined)?.lastCallGas, undefined)

				requestHandler.ethSimulateV1Calls.length = 0
				const executionSimulationState = await createExecutionSimulationState(ethereum, undefined, simulationStateInput)
				if (executionSimulationState.success === false) throw new Error('simulation unexpectedly failed')
				assert.equal(requestHandler.ethSimulateV1Calls.length, 1)
				assert.equal(requestHandler.ethSimulateV1Calls.some((call) => call.aggregate3BalanceQueryCount !== undefined), false)
			})

			test('execution-only receipt uses execution block placement after gas splitting', async () => {
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
							transactionIdentifier: 10n,
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
							transactionIdentifier: 11n,
						},
					],
					signedMessages: [],
					blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
					simulateWithZeroBaseFee: false,
				}] as const

				const simulationState = await createExecutionSimulationState(ethereum, undefined, splitSimulationStateInput)
				if (simulationState.success === false) throw new Error('simulation unexpectedly failed')
				const secondHash = splitSimulationStateInput[0].transactions[1]?.signedTransaction.hash
				if (secondHash === undefined) throw new Error('second transaction hash missing')
				const secondBlock = await getBlockFromInput(splitSimulationStateInput, blockNumber + 2n, true)
				if (secondBlock === null) throw new Error('second simulated block missing')
				const receipt = await getReceiptFromState(simulationState, secondHash)
				if (receipt === null) throw new Error('receipt missing')

				assert.equal(receipt.blockNumber, blockNumber + 2n)
				assert.equal(receipt.blockHash, secondBlock.hash)
				assert.equal(receipt.transactionIndex, 0n)
				assert.equal(receipt.cumulativeGasUsed, receipt.gasUsed)
			})

			test('execution-only logs honor the first simulated execution block hash after gas splitting', async () => {
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
							transactionIdentifier: 12n,
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
							transactionIdentifier: 13n,
						},
					],
					signedMessages: [],
					blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
					simulateWithZeroBaseFee: false,
				}] as const

				const simulationState = await createExecutionSimulationState(ethereum, undefined, splitSimulationStateInput)
				if (simulationState.success === false) throw new Error('simulation unexpectedly failed')
				const firstBlock = await getBlockFromInput(splitSimulationStateInput, blockNumber + 1n, true)
				if (firstBlock === null) throw new Error('first simulated block missing')
				const logs = await getLogsFromState(simulationState, { blockHash: firstBlock.hash })

				assert.equal(logs.length, 1)
				assert.equal(logs[0]?.blockHash, firstBlock.hash)
				assert.equal(logs[0]?.blockNumber, blockNumber + 1n)
			})
		})
