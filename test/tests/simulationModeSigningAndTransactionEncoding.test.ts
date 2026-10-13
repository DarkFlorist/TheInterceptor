import { describe, test } from 'bun:test'
import * as assert from 'node:assert'
import { keccak256, recoverAddress } from '../../app/ts/utils/ethereumPrimitives.js'
import { EthereumSignedTransactionToSignedTransaction, EthereumUnsignedTransactionToUnsignedTransaction, rlpEncode, serializeSignedTransactionToBytes, serializeUnsignedTransactionToBytes } from '../../app/ts/utils/ethereum.js'
import { bigintToUint8Array, bytes32String } from '../../app/ts/utils/bigint.js'
import { EthereumAddress, EthereumSignatureParity, EthereumSignedTransaction, EthereumSignedTransaction1559, EthereumSignedTransactionWithBlockData, EthereumUnsignedTransaction, serialize } from '../../app/ts/types/wire-types.js'
import { getDeployedContractAddress, mockSignTransaction, simulatePersonalSign } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import { EthTransactionReceiptResponse, EthereumJsonRpcRequest } from '../../app/ts/types/JsonRpc-types.js'
import { d2ArrayFixed } from './data/eip712Data.js'
import { createSimulationModeTestContext, blockNumber, createSimulationStateInput, example7702Transaction, exampleTransaction, testBytes32, zeroBytes256 } from './simulationModeEthereumClientServiceTestHelpers.js'

const { ethereum } = createSimulationModeTestContext()

describe('SimulationModeEthereumClientService', () => {
	test('preserves the 20-byte sender width when deriving contract addresses', () => {
		const senderWithLeadingZeroBytes = 1n
		const expectedAddress = BigInt(`0x${ keccak256(rlpEncode([bigintToUint8Array(senderWithLeadingZeroBytes, 20), new Uint8Array()])).slice(26) }`)
		assert.equal(getDeployedContractAddress(senderWithLeadingZeroBytes, 0n), expectedAddress)
	})

	test('prepareEthSimulateV1Input strips the local transaction hash from RPC calls', async () => {
		const prepared = await ethereum.prepareEthSimulateV1Input(createSimulationStateInput(), blockNumber, undefined)
		const call = prepared.request.params[0].blockStateCalls[0]?.calls[0]
		if (call === undefined) throw new Error('missing prepared eth_simulateV1 call')
		assert.equal('hash' in call, false)

		const serialized = serialize<EthereumJsonRpcRequest, typeof EthereumJsonRpcRequest>(EthereumJsonRpcRequest, prepared.request)
		assert.doesNotThrow(() => JSON.stringify(serialized))
	})

	test('prepareEthSimulateV1Input strips authorization authority metadata but preserves signatures', async () => {
		const signedAuthorization = {
			chainId: 5n,
			address: 0n,
			nonce: 3n,
			authority: 0x0000000000000000000000000000000000000004n,
			r: 0x11n,
			s: 0x22n,
			yParity: 'odd' as const,
		}
		const input = [{
			stateOverrides: {},
			transactions: [{
				signedTransaction: mockSignTransaction({ ...example7702Transaction, authorizationList: [signedAuthorization] }),
				website: { websiteOrigin: 'test', icon: undefined, title: undefined },
				created: new Date(),
				originalRequestParameters: { method: 'eth_sendTransaction', params: [{ type: '7702', authorizationList: [] }]},
				transactionIdentifier: 104n,
			}],
			signedMessages: [],
			blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
			simulateWithZeroBaseFee: false,
		}] as const
		const prepared = await ethereum.prepareEthSimulateV1Input(input, blockNumber, undefined)
		const call = prepared.request.params[0].blockStateCalls[0]?.calls[0]
		if (call?.type !== '7702') throw new Error('missing prepared type-7702 call')
		const [authorization] = call.authorizationList ?? []
		if (authorization === undefined) throw new Error('missing prepared authorization')
		assert.deepEqual(authorization, {
			chainId: signedAuthorization.chainId,
			address: signedAuthorization.address,
			nonce: signedAuthorization.nonce,
			r: signedAuthorization.r,
			s: signedAuthorization.s,
			yParity: signedAuthorization.yParity,
		})
		assert.equal('authority' in authorization, false)
	})

	test('mockSignTransaction should have r=0, s=0 and yParity = "even"', async () => {
		const signed = mockSignTransaction(exampleTransaction)
		assert.equal(signed.type, '1559')
		assert.equal(signed.r, 0n)
		assert.equal(signed.s, 0n)
		if (!('yParity' in signed)) throw new Error('yParity missing')
		if (signed.type === '1559') assert.equal(signed.yParity, 'even')
	})

	test('mockSignTransaction preserves signed 7702 authorization tuples', async () => {
		const signedAuthorization = {
			chainId: 5n,
			address: 0x000000009b1d0af20d8c6d0a44e162d11f9b8f00n,
			nonce: 3n,
			authority: 0x0000000000000000000000000000000000000004n,
			r: 0x11n,
			s: 0x22n,
			yParity: 'odd' as const,
		}
		const signed = mockSignTransaction({
			...example7702Transaction,
			authorizationList: [signedAuthorization],
		})

		assert.equal(signed.type, '7702')
		if (signed.type !== '7702') throw new Error('wrong transaction type')
		const [authorization] = signed.authorizationList
		if (authorization === undefined) throw new Error('authorization missing')
		assert.equal(authorization.r, signedAuthorization.r)
		assert.equal(authorization.s, signedAuthorization.s)
		assert.equal(authorization.yParity, signedAuthorization.yParity)
		assert.equal(authorization.authority, signedAuthorization.authority)
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

	test('simulatePersonalSign signs fixed-array EIP-712 messages with the local Ethereum primitive signature', async () => {
		const signingAddress = EthereumAddress.parse('0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf')
		assert.deepStrictEqual(
			await simulatePersonalSign({
				method: 'eth_signTypedData_v4',
				params: [signingAddress, JSON.parse(d2ArrayFixed)],
			}, signingAddress),
			{
				messageHash: '0x0581bbcb9d6c92c0c6c4f81e5893f79e39fa4df2b706ef9f4019b58c4f03ddc7',
				signature: '0xf7ca21e850390d92d5b4c0f674eab809fff955910bde1f07a80bbd7c13b5528d03f348f459edc126b8721218c5f9074088cdfac420233d5c30dabaea5f8f31cb1c',
			},
		)
	})

	test('simulatePersonalSign rejects malformed EIP-712 messages with missing string fields', async () => {
		const signingAddress = EthereumAddress.parse('0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf')
		await assert.rejects(
			simulatePersonalSign({
				method: 'eth_signTypedData_v4',
				params: [signingAddress, {
					domain: {
						name: 'Ether Mail',
						version: '1',
						chainId: 1,
						verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
					},
					types: {
						Mail: [{ name: 'contents', type: 'string' }],
					},
					primaryType: 'Mail',
					message: {},
				}],
			}, signingAddress),
			/Missing EIP-712 value for Mail\.contents/u,
		)
	})

	test('simulatePersonalSign matches reference primitive coercion for malformed but accepted EIP-712 values', async () => {
		const signingAddress = EthereumAddress.parse('0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf')
		assert.deepStrictEqual(
			await simulatePersonalSign({
				method: 'eth_signTypedData_v4',
				params: [signingAddress, {
					domain: {
						name: 'Primitive Coercion',
						version: '1',
						chainId: 1,
						verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
					},
					types: {
						Weird: [
							{ name: 'numericText', type: 'string' },
							{ name: 'booleanText', type: 'string' },
							{ name: 'payload', type: 'bytes' },
						],
					},
					primaryType: 'Weird',
					message: {
						numericText: 123,
						booleanText: false,
						payload: 'abc',
					},
				}],
			}, signingAddress),
			{
				messageHash: '0x1a5961e55544fd296fa56bf3b3a2f44f9d3d8c382537240e670f5fadf0fb97e4',
				signature: '0x878b751710ce2ef85acdfd5f65ffc7b6a0bfe2881e2a7038c729ba29bb299f8135023f386885dd7ef72a67fe84fd4fa08f8548a22a727c27ed169eb407bccaf81b',
			},
		)
	})

	test('simulatePersonalSign hashes hex-looking EIP-712 strings as UTF-8 strings', async () => {
		const signingAddress = EthereumAddress.parse('0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf')
		assert.deepStrictEqual(
			await simulatePersonalSign({
				method: 'eth_signTypedData_v4',
				params: [signingAddress, {
					domain: {
						name: 'Hex String',
						version: '1',
						chainId: 1,
						verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
					},
					types: {
						Message: [
							{ name: 'text', type: 'string' },
						],
					},
					primaryType: 'Message',
					message: {
						text: '0x1234',
					},
				}],
			}, signingAddress),
			{
				messageHash: '0x42f5f2d4ed7271ca48bcf4aeebb8ccccc373da3857717b52f1c4950434133830',
				signature: '0x68f4ff205ffa91140515b9bf35a540b6fac7b298f8b0910bc5ead6c24bedfce441792802329733e10610aa314e93239ddb9985739fcd3794867968e7aafdddd11c',
			},
		)
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
})
