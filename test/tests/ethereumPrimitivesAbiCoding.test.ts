import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import type { Abi, Hex } from '../../app/ts/utils/ethereumPrimitives.js'
import { decodeAbiParameters, decodeEventLog, decodeFunctionData, encodeAbiParameters, encodePacked, formatAbiItem, keccak256, parseAbiItem, parseAbiParameters, stringToBytes, toEventSelector, toFunctionSelector } from '../../app/ts/utils/ethereumPrimitives.js'
import { encodeFunctionCall } from '../../app/ts/utils/abiRuntime.js'
import { checksumBeefAddress, checksumDeadAddress, invalidChecksumDeadAddress, lowercaseDeadAddress } from './ethereumPrimitivesFixtures.js'

const complexAbiParameters = [
	{
		name: 'example',
		type: 'tuple',
		components: [
			{ name: 'owner', type: 'address' },
			{ name: 'amount', type: 'uint256' },
			{ name: 'flags', type: 'bool[]' },
		],
	},
	{ name: 'payload', type: 'bytes' },
	{ name: 'numbers', type: 'uint256[]' },
] as const
const complexAbiValues = [
	[
		checksumDeadAddress,
		12345678901234567890n,
		[true, false, true],
	],
	'0x123456',
	[1n, 2n, 3n],
] as const
const transferAbi = [{
	type: 'function',
	name: 'transfer',
	stateMutability: 'nonpayable',
	inputs: [
		{ name: 'to', type: 'address' },
		{ name: 'amount', type: 'uint256' },
	],
	outputs: [{ name: 'ok', type: 'bool' }],
}] as const satisfies Abi
const transferEventAbi = [{
	type: 'event',
	name: 'Transfer',
	inputs: [
		{ indexed: true, name: 'from', type: 'address' },
		{ indexed: true, name: 'to', type: 'address' },
		{ indexed: false, name: 'value', type: 'uint256' },
	],
}] as const satisfies Abi
const dynamicIndexedEventAbi = [{
	type: 'event',
	name: 'E',
	inputs: [
		{ indexed: true, name: 'a', type: 'address' },
		{ indexed: true, name: 'b', type: 'string' },
		{ indexed: false, name: 'c', type: 'uint256' },
	],
}] as const satisfies Abi

describe('local Ethereum primitive helpers', () => {
	test('matches reference human-readable ABI parsing and formatting vectors used by abiRuntime', () => {
		assert.deepStrictEqual(
			parseAbiParameters('uint256 amount, address owner, (uint256 id, bytes32 label) record'),
			[
				{ type: 'uint256', name: 'amount' },
				{ type: 'address', name: 'owner' },
				{
					type: 'tuple',
					components: [
						{ type: 'uint256', name: 'id' },
						{ type: 'bytes32', name: 'label' },
					],
					name: 'record',
				},
			],
		)
		assert.deepStrictEqual(
			parseAbiParameters('(uint256,address)'),
			[{
				type: 'tuple',
				components: [
					{ type: 'uint256' },
					{ type: 'address' },
				],
			}],
		)
			assert.deepStrictEqual(
				parseAbiParameters('(uint256 a, address b)[] records'),
				[{
					type: 'tuple[]',
				components: [
					{ type: 'uint256', name: 'a' },
					{ type: 'address', name: 'b' },
				],
					name: 'records',
				}],
			)
			assert.deepStrictEqual(
				parseAbiParameters('address payable recipient'),
				[{ type: 'address', name: 'recipient' }],
			)
			assert.equal(
				formatAbiItem(parseAbiItem('function foo((uint256 a, address b) p) view returns (bool)')),
				'foo((uint256,address))',
			)
			assert.equal(
				formatAbiItem(parseAbiItem('function pay(address payable recipient)')),
				'pay(address)',
			)
			assert.deepStrictEqual(
				parseAbiItem('constructor(address owner)'),
				{
					type: 'constructor',
					stateMutability: 'nonpayable',
					inputs: [{ type: 'address', name: 'owner' }],
				},
			)
			assert.deepStrictEqual(
				parseAbiItem('fallback() external payable'),
				{ type: 'fallback', stateMutability: 'payable' },
			)
			assert.deepStrictEqual(
				parseAbiItem('receive() external payable'),
				{ type: 'receive', stateMutability: 'payable' },
			)
			assert.equal(
				formatAbiItem(parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')),
				'Transfer(address,address,uint256)',
		)
	})

	test('matches reference packed and standard ABI encode/decode vectors', () => {
		const encodedAbi = encodeAbiParameters(complexAbiParameters, complexAbiValues)
		assert.equal(
			encodedAbi,
			'0x000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000001400000000000000000000000000000000000000000000000000000000000000180000000000000000000000000000000000000000000000000000000000000dead000000000000000000000000000000000000000000000000ab54a98ceb1f0ad200000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000312345600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000003',
		)
		assert.deepStrictEqual(
			decodeAbiParameters(complexAbiParameters, encodedAbi),
			[
				{
					owner: checksumDeadAddress,
					amount: 12345678901234567890n,
					flags: [true, false, true],
				},
				'0x123456',
				[1n, 2n, 3n],
			],
		)
		assert.equal(
			encodePacked(
				['address', 'uint24', 'bool', 'bytes3', 'string'],
				[checksumDeadAddress, 0x123456, true, '0xaabbcc', 'hello'],
			),
			'0x000000000000000000000000000000000000dead12345601aabbcc68656c6c6f',
		)
		assert.equal(encodePacked(['address'], [lowercaseDeadAddress]), '0x000000000000000000000000000000000000dead')
		assert.equal(encodePacked(['address'], [checksumDeadAddress]), '0x000000000000000000000000000000000000dead')
		assert.equal(encodePacked(['address'], [invalidChecksumDeadAddress]), '0x000000000000000000000000000000000000dead')
		assert.throws(() => encodePacked(['address'], ['0x1234']), /invalid|Address/u)
		assert.equal(encodePacked(['bool'], [true]), '0x01')
		assert.equal(encodePacked(['bool'], [false]), '0x00')
		assert.equal(encodePacked(['bool'], [1]), '0x01')
		assert.equal(encodePacked(['bool'], [2]), '0x02')
		assert.throws(() => encodePacked(['bool'], ['true']))
		assert.equal(
			encodePacked(['uint16[]'], [[1, 0x1234, 0xffff]]),
			'0x00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000001234000000000000000000000000000000000000000000000000000000000000ffff',
		)
		assert.equal(
			encodePacked(['address[]'], [[checksumDeadAddress, checksumBeefAddress]]),
			'0x000000000000000000000000000000000000000000000000000000000000dead000000000000000000000000000000000000000000000000000000000000beef',
		)
		assert.equal(
			encodePacked(['address[]'], [[checksumDeadAddress, invalidChecksumDeadAddress]]),
			'0x000000000000000000000000000000000000000000000000000000000000dead000000000000000000000000000000000000000000000000000000000000dead',
		)
		assert.equal(
			encodePacked(['bool[]'], [[true, false, true]]),
			'0x000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001',
		)
		assert.equal(
			encodePacked(['bytes3[]'], [['0xaabbcc', '0x112233']]),
			'0xaabbcc00000000000000000000000000000000000000000000000000000000001122330000000000000000000000000000000000000000000000000000000000',
		)
		assert.equal(encodePacked(['bytes[]'], [['0xaabbcc', '0x1122']]), '0xaabbcc1122')
		assert.equal(encodePacked(['string[]'], [['ab', 'cd']]), '0x61626364')
		assert.equal(
			encodePacked(['int16[]'], [[-1, 2]]),
			'0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0000000000000000000000000000000000000000000000000000000000000002',
		)
		assert.equal(
			encodePacked(['uint16[2]'], [[1, 2]]),
			'0x00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000002',
		)
		assert.equal(
			encodeAbiParameters([{ type: 'uint256' }], ['0x539']),
			'0x0000000000000000000000000000000000000000000000000000000000000539',
		)
		assert.equal(
			encodeAbiParameters([{ type: 'address' }], [lowercaseDeadAddress]),
			'0x000000000000000000000000000000000000000000000000000000000000dead',
		)
		assert.equal(
			encodeAbiParameters([{ type: 'address' }], [checksumDeadAddress]),
			'0x000000000000000000000000000000000000000000000000000000000000dead',
		)
		assert.equal(
			encodeAbiParameters([{ type: 'address' }], [invalidChecksumDeadAddress]),
			encodeAbiParameters([{ type: 'address' }], [lowercaseDeadAddress]),
		)
		assert.equal(
			encodeFunctionCall(transferAbi, 'transfer', [invalidChecksumDeadAddress, 1n]),
			encodeFunctionCall(transferAbi, 'transfer', [lowercaseDeadAddress, 1n]),
		)
		const tupleParameters = parseAbiParameters('(uint256 a, address b) p')
		const encodedTuple = encodeAbiParameters(tupleParameters, [{ a: 1n, b: checksumDeadAddress }])
		assert.equal(
			encodedTuple,
			'0x0000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000dead',
		)
		assert.deepStrictEqual(decodeAbiParameters(tupleParameters, encodedTuple), [{ a: 1n, b: checksumDeadAddress }])
	})

	test('matches reference function data and event log decode vectors', () => {
		const transferData: Hex = `${ toFunctionSelector('transfer(address,uint256)') }${ encodeAbiParameters(transferAbi[0].inputs, [checksumDeadAddress, 123n]).slice(2) }`
		assert.equal(transferData, '0xa9059cbb000000000000000000000000000000000000000000000000000000000000dead000000000000000000000000000000000000000000000000000000000000007b')
		assert.deepStrictEqual(decodeFunctionData({ abi: transferAbi, data: transferData }), {
			functionName: 'transfer',
			args: [checksumDeadAddress, 123n],
		})

		const decodedTransfer = decodeEventLog({
			abi: transferEventAbi,
			topics: [
				toEventSelector('Transfer(address,address,uint256)'),
				'0x000000000000000000000000000000000000000000000000000000000000dead',
				'0x000000000000000000000000000000000000000000000000000000000000beef',
			],
			data: encodeAbiParameters([{ type: 'uint256' }], [987654321n]),
		})
		const inferredTransferArgs: { readonly from: Hex, readonly to: Hex, readonly value: bigint } = decodedTransfer.args
		assert.deepStrictEqual(
			decodedTransfer,
			{
				eventName: 'Transfer',
				args: {
					from: checksumDeadAddress,
					to: checksumBeefAddress,
					value: 987654321n,
				},
			},
		)
		assert.equal(inferredTransferArgs.value, 987654321n)

		const emptyEventAbi = [{ type: 'event', name: 'Ping', inputs: [] }] as const satisfies Abi
		const decodedEmptyEvent = decodeEventLog({
			abi: emptyEventAbi,
			topics: [toEventSelector('Ping()')],
			data: '0x',
		})
		const inferredEmptyArgs: Readonly<Record<string, never>> = decodedEmptyEvent.args
		assert.deepStrictEqual(inferredEmptyArgs, {})

		const mixedEventAbi = [{
			type: 'event',
			name: 'Mixed',
			inputs: [{ name: 'first', type: 'uint256' }, { type: 'uint256' }],
		}] as const satisfies Abi
		const decodedMixedEvent = decodeEventLog({
			abi: mixedEventAbi,
			topics: [toEventSelector('Mixed(uint256,uint256)')],
			data: encodeAbiParameters(mixedEventAbi[0].inputs, [1n, 2n]),
		})
		const inferredMixedArgs: readonly [bigint, bigint] = decodedMixedEvent.args
		assert.deepStrictEqual(inferredMixedArgs, [1n, 2n])
	})

	test('matches reference loose event decoding for indexed args when non-indexed data is missing', () => {
		const transferTopics = [
			toEventSelector('Transfer(address,address,uint256)'),
			'0x000000000000000000000000000000000000000000000000000000000000dead',
			'0x000000000000000000000000000000000000000000000000000000000000beef',
		] as const
		assert.throws(() => decodeEventLog({ abi: transferEventAbi, data: '0x', topics: transferTopics, strict: true }))
		const decodedLooseTransfer = decodeEventLog({ abi: transferEventAbi, data: '0x', topics: transferTopics, strict: false })
		const inferredLooseTransferArgs: Partial<{ readonly from: Hex, readonly to: Hex, readonly value: bigint }> = decodedLooseTransfer.args
		assert.deepStrictEqual(
			decodedLooseTransfer,
			{
				eventName: 'Transfer',
				args: {
					from: checksumDeadAddress,
					to: checksumBeefAddress,
				},
			},
		)
		assert.equal(inferredLooseTransferArgs.value, undefined)
		const topicB = keccak256(stringToBytes('hello'))
		assert.deepStrictEqual(
			decodeEventLog({
				abi: dynamicIndexedEventAbi,
				data: '0x',
				topics: [
					toEventSelector('E(address,string,uint256)'),
					'0x000000000000000000000000000000000000000000000000000000000000dead',
					topicB,
				],
				strict: false,
			}),
			{
				eventName: 'E',
				args: {
					a: checksumDeadAddress,
					b: topicB,
				},
			},
		)

		const indexedFirstMixedAbi = [{
			type: 'event',
			name: 'IndexedFirstMixed',
			inputs: [
				{ name: 'first', type: 'uint256', indexed: true },
				{ type: 'uint256' },
			],
		}] as const satisfies Abi
		const decodedIndexedFirstMixed = decodeEventLog({
			abi: indexedFirstMixedAbi,
			data: '0x',
			topics: [
				toEventSelector('IndexedFirstMixed(uint256,uint256)'),
				'0x0000000000000000000000000000000000000000000000000000000000000001',
			],
			strict: false,
		})
		const inferredIndexedFirstMixedArgs: readonly [bigint | undefined, bigint | undefined] = decodedIndexedFirstMixed.args
		assert.deepStrictEqual(inferredIndexedFirstMixedArgs, [1n, undefined])

		const indexedSecondUnnamedAbi = [{
			type: 'event',
			name: 'IndexedSecondUnnamed',
			inputs: [
				{ type: 'uint256' },
				{ type: 'uint256', indexed: true },
			],
		}] as const satisfies Abi
		const decodedIndexedSecondUnnamed = decodeEventLog({
			abi: indexedSecondUnnamedAbi,
			data: '0x',
			topics: [
				toEventSelector('IndexedSecondUnnamed(uint256,uint256)'),
				'0x0000000000000000000000000000000000000000000000000000000000000002',
			],
			strict: false,
		})
		const inferredIndexedSecondUnnamedArgs: readonly [bigint | undefined, bigint | undefined] = decodedIndexedSecondUnnamed.args
		assert.deepStrictEqual(inferredIndexedSecondUnnamedArgs, [undefined, 2n])
	})
})
