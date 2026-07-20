import * as assert from 'assert'
import { describe, test } from 'bun:test'
import type { Abi, Hex } from '../../app/ts/utils/ethereumPrimitives.js'
import {
	bytesToHex,
	concat,
	decodeAbiParameters,
	decodeEventLog,
	decodeFunctionData,
	encodeAbiParameters,
	encodePacked,
	ens_normalize,
	formatAbiItem,
	formatUnits,
	getAddress,
	getCreate2Address,
	hashMessage,
	hashStruct,
	hashTypedData,
	isAddress,
	keccak256,
	namehash,
	parseAbiItem,
	parseAbiParameters,
	parseTransaction,
	privateKeyToAccount,
	recoverAddress,
	serializeTransaction,
	stringToBytes,
	toEventSelector,
	toFunctionSelector,
	toRlp,
} from '../../app/ts/utils/ethereumPrimitives.js'
import { encodeFunctionCall } from '../../app/ts/utils/abiRuntime.js'
import { canVerifyStructArray, d2Array, d2ArrayFixed, d3ArrayFixed, hasFixedArray } from './data/eip712Data.js'

const privateKey = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const accountAddress = '0xFCAd0B19bB29D4674531d6f115237E16AfCE377c'
const checksumDeadAddress = '0x000000000000000000000000000000000000dEaD'
const checksumBeefAddress = '0x000000000000000000000000000000000000bEEF'
const lowercaseDeadAddress = '0x000000000000000000000000000000000000dead'
const lowercaseBeefAddress = '0x000000000000000000000000000000000000beef'
const invalidChecksumDeadAddress = '0x000000000000000000000000000000000000dEad'
const typedData = {
	domain: {
		name: 'Ether Mail',
		version: '1',
		chainId: 1,
		verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
	},
	types: {
		Person: [
			{ name: 'name', type: 'string' },
			{ name: 'wallet', type: 'address' },
		],
		Mail: [
			{ name: 'from', type: 'Person' },
			{ name: 'to', type: 'Person' },
			{ name: 'contents', type: 'string' },
		],
	},
	primaryType: 'Mail',
	message: {
		from: {
			name: 'Cow',
			wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826',
		},
		to: {
			name: 'Bob',
			wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB',
		},
		contents: 'Hello, Bob!',
	},
} as const
const reorderedDomainTypedData = {
	...typedData,
	types: {
		EIP712Domain: [
			{ name: 'verifyingContract', type: 'address' },
			{ name: 'chainId', type: 'uint256' },
			{ name: 'version', type: 'string' },
			{ name: 'name', type: 'string' },
		],
		...typedData.types,
	},
} as const
const typedDataMissingMessageString = {
	...typedData,
	message: {
		from: typedData.message.from,
		to: typedData.message.to,
	},
} as const
const typedDataMissingDomainString = {
	...typedData,
	domain: {
		version: '1',
		chainId: 1,
		verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
	},
	types: {
		EIP712Domain: [
			{ name: 'name', type: 'string' },
			{ name: 'version', type: 'string' },
			{ name: 'chainId', type: 'uint256' },
			{ name: 'verifyingContract', type: 'address' },
		],
		...typedData.types,
	},
} as const
const typedDataPrimitiveCoercion = {
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
} as const
const typedDataHexString = {
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
} as const
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
const unsignedEip1559Transaction = {
	type: 'eip1559',
	chainId: 1,
	nonce: 7,
	maxFeePerGas: 20_000_000_000n,
	maxPriorityFeePerGas: 1_500_000_000n,
	gas: 21_000n,
	to: checksumDeadAddress,
	value: 123_456_789n,
	data: '0x',
	accessList: [],
} as const
const transactionSignature = {
	r: '0x1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100',
	s: '0x2f2e2d2c2b2a292827262524232221201f1e1d1c1b1a19181716151413121110',
	yParity: 1,
} as const
const typedDataArrayVectors = [
	{
		name: 'hasFixedArray',
		raw: hasFixedArray,
		hash: '0x5d53c3a4b542d62029dd53e4dd0657c960f84ff87da9b8b3105f460bf18279f4',
		signature: '0x45d7254558cd6c29403092d6e4933759e65567b03d4c442fc83ab218c1d4297a7a4186781e65a9152d8c358e5cca4fe0d87c27a6a436bd896d8f16185c9c07cd1b',
	},
	{
		name: 'd2Array',
		raw: d2Array,
		hash: '0x7133ab40a1b362f8f7ddd2e3ba6bfc371fa63130276b11bcb0408280909ec334',
		signature: '0xeb26dd138d9c410bd3ee87e403e7fa777b9815dff9a461d002065599e5db4e8872a1ba849882ca414d931ea40cf23b0f30fef9ebcc5de3782c3ae9cb170c0e831c',
	},
	{
		name: 'd2ArrayFixed',
		raw: d2ArrayFixed,
		hash: '0x0581bbcb9d6c92c0c6c4f81e5893f79e39fa4df2b706ef9f4019b58c4f03ddc7',
		signature: '0xbb8feebc78124e48f578be567934c6474207826490994352717215444d5b5e1b2422002e40a1767ff74bdde78ff39f6f870350a9075ab6768e8040c5c6a90aca1c',
	},
	{
		name: 'd3ArrayFixed',
		raw: d3ArrayFixed,
		hash: '0x6a337287af38ecfb4d7823c31eabaf8024e4ad746a391feb38f5926ee7cfd0ab',
		signature: '0xcb33d2766e8c6599e229668c0d66cfae6549fa0cba1cd27d942e881c76431e5f0b6984604e4b4d4465489f4306125d133554450f25792f362e4426b6ba13e4e71c',
	},
	{
		name: 'canVerifyStructArray',
		raw: canVerifyStructArray,
		hash: '0xe3e147d255f92f5a9de155defefb2816b1ca970e975b38baadb0cca27e733d36',
		signature: '0xf5c86ad5e1c3de22b5dc723e6c691569516d5f6f01ae2875498adfc26970f51e1639a9a6452f7461be16b1869e196a7c9234a94cfb224db3e9ee947e6cf4d4721b',
	},
] as const

describe('local Ethereum primitive helpers', () => {
	test('matches reference address, bytes, RLP, selector, and unit formatting vectors', () => {
		assert.equal(getAddress(lowercaseDeadAddress), checksumDeadAddress)
		assert.equal(getAddress('0x000000000000000000000000000000000000DEAD'), checksumDeadAddress)
		assert.equal(getAddress(invalidChecksumDeadAddress), checksumDeadAddress)
		assert.throws(() => getAddress('0x1234'), /invalid/u)
		assert.equal(isAddress(checksumDeadAddress), true)
		assert.equal(isAddress(lowercaseDeadAddress), true)
		assert.equal(isAddress('0x000000000000000000000000000000000000DEAD'), false)
		assert.equal(isAddress('0X000000000000000000000000000000000000DEAD'), false)
		assert.equal(isAddress(invalidChecksumDeadAddress), false)
		assert.equal(
			getCreate2Address({
				from: checksumDeadAddress,
				salt: `0x${ '00'.repeat(31) }2a`,
				bytecodeHash: keccak256('0x60006000'),
			}),
			'0x82774b0268C8ED297E610841C83B862FDB78673b',
		)
		assert.equal(bytesToHex(new Uint8Array([0, 1, 255])), '0x0001ff')
		assert.equal(bytesToHex(stringToBytes('hello')), '0x68656c6c6f')
		assert.equal(keccak256(stringToBytes('hello')), '0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8')
		assert.equal(concat(['0x12', '0x3456']), '0x123456')
		assert.throws(() => Reflect.apply(concat, undefined, [['0x12', new Uint8Array([0x34])]]), /Cannot concat hex strings and byte arrays/u)
		assert.equal(toRlp(['0x01', ['0x02', '0x636174']], 'hex'), '0xc701c50283636174')
		assert.deepStrictEqual(toRlp(['0x01', ['0x02', '0x636174']], 'bytes'), new Uint8Array([0xc7, 0x01, 0xc5, 0x02, 0x83, 0x63, 0x61, 0x74]))
		assert.throws(() => toRlp(0), /RLP value/u)
		assert.throws(() => toRlp('cat'), /0x-prefixed/u)
		assert.throws(() => toRlp([1, 2, '0x03']), /RLP value/u)
		assert.equal(toFunctionSelector('transfer(address,uint256)'), '0xa9059cbb')
		assert.equal(toEventSelector('Transfer(address,address,uint256)'), '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef')
		assert.equal(formatUnits(1234567890000000000n, 18), '1.23456789')
		assert.equal(formatUnits(-120000n, 4), '-12')
	})

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
		const transferData = toFunctionSelector('transfer(address,uint256)') + encodeAbiParameters(transferAbi[0].inputs, [checksumDeadAddress, 123n]).slice(2)
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

	test('matches reference ENS normalization and namehash vectors', () => {
		assert.equal(namehash('vitalik.eth'), '0xee6c4522aab0003e8d14cd40a6af439055fd2577951148c14b6cea9a53475835')
		assert.equal(namehash('Vitalik.eth'), '0xfc1a1eb20849620be486e201e6aa4ab264c7a01f1e48d8a9ae3aacead41c405e')
		const normalizedVectors = [
			['', ''],
			['BÜCHER.eth', 'bücher.eth'],
			['bücher.eth', 'bücher.eth'],
			['RaFFY🚴‍♂️.eTh', 'raffy🚴‍♂.eth'],
			['1️⃣2️⃣.eth', '1⃣2⃣.eth'],
			['faß.eth', 'faß.eth'],
			['fass.eth', 'fass.eth'],
			['ℌello.eth', 'hello.eth'],
			['hello-.eth', 'hello-.eth'],
			['-hello.eth', '-hello.eth'],
			['__.eth', '__.eth'],
			['_foo.eth', '_foo.eth'],
			['__foo.eth', '__foo.eth'],
			['mañana.eth', 'mañana.eth'],
			['mañana.eth', 'mañana.eth'],
			['ã.eth', 'ã.eth'],
			['paypal.eth', 'paypal.eth'],
			['ζζ.eth', 'ζζ.eth'],
			['ηη.eth', 'ηη.eth'],
			['ςς.eth', 'ςς.eth'],
			['ϢϢ.eth', 'ϣϣ.eth'],
			['־.eth', '־.eth'],
			['؆.eth', '؆.eth'],
			['۞.eth', '۞.eth'],
			['中文.eth', '中文.eth'],
			['abc中文.eth', 'abc中文.eth'],
			['中文abc.eth', '中文abc.eth'],
			['abc日本.eth', 'abc日本.eth'],
			['日本abc.eth', '日本abc.eth'],
			['東京.eth', '東京.eth'],
			['abc한글.eth', 'abc한글.eth'],
			['한글abc.eth', '한글abc.eth'],
			['مرحبا.eth', 'مرحبا.eth'],
			['مِ.eth', 'مِ.eth'],
			['कि.eth', 'कि.eth'],
			['שלום.eth', 'שלום.eth'],
			['emoji❤️.eth', 'emoji❤.eth'],
			['❤️.eth', '❤.eth'],
			['☕️.eth', '☕.eth'],
			['\u2615\ufe0e.eth', '☕.eth'],
			['\u2764\ufe0e.eth', '❤.eth'],
			['\u2764\ufe0f\ufe0e.eth', '❤.eth'],
			['👨‍👩‍👧‍👦.eth', '👨‍👩‍👧‍👦.eth'],
			['🏴‍☠️.eth', '🏴‍☠.eth'],
			['🏳️‍🌈.eth', '🏳‍🌈.eth'],
			['👩‍❤️‍👩.eth', '👩‍❤‍👩.eth'],
			['👨‍👦.eth', '👨‍👦.eth'],
			['🧑🏽‍💻.eth', '🧑🏽‍💻.eth'],
			['🧑🏽.eth', '🧑🏽.eth'],
			['😀--a.eth', '😀--a.eth'],
			['a\u00adb.eth', 'ab.eth'],
			['ＡＢＣ.eth', 'abc.eth'],
			['１２３.eth', '123.eth'],
			['０x.eth', '0x.eth'],
			['Å.eth', 'å.eth'],
			['Å.eth', 'å.eth'],
			['$.eth', '$.eth'],
			['₿.eth', '₿.eth'],
			['®.eth', '®.eth'],
			['©.eth', '©.eth'],
			['™.eth', 'tm.eth'],
			['Ǆ.eth', 'dž.eth'],
				['①.eth', '1.eth'],
					['⑩.eth', '10.eth'],
					['⑪.eth', '11.eth'],
					['⁴.eth', '4.eth'],
					['₂.eth', '2.eth'],
					['¼.eth', '1⁄4.eth'],
					['⅐.eth', '1⁄7.eth'],
					['⁃.eth', '-.eth'],
					['﹘.eth', '-.eth'],
					['۱۲۳.eth', '١٢٣.eth'],
				['۰.eth', '٠.eth'],
				['۱.eth', '١.eth'],
				['۲.eth', '٢.eth'],
				['۳.eth', '٣.eth'],
				['۴.eth', '۴.eth'],
				['۵.eth', '۵.eth'],
				['۶.eth', '۶.eth'],
				['۷.eth', '٧.eth'],
				['۸.eth', '٨.eth'],
				['۹.eth', '٩.eth'],
				['۴۵۶.eth', '۴۵۶.eth'],
				['۰۱۲۳۴۵۶۷۸۹.eth', '٠١٢٣۴۵۶٧٨٩.eth'],
				['مرحبا۱۲۳.eth', 'مرحبا١٢٣.eth'],
				['مرحبا۴۵۶.eth', 'مرحبا۴۵۶.eth'],
				['—.eth', '-.eth'],
				['•.eth', '•.eth'],
				['‿.eth', '‿.eth'],
				['★.eth', '★.eth'],
				['☑.eth', '☑.eth'],
				['°.eth', '°.eth'],
				['♪.eth', '♪.eth'],
				['♫.eth', '♫.eth'],
				['♩.eth', '♩.eth'],
					['♬.eth', '♬.eth'],
					['¤.eth', '¤.eth'],
					['¬.eth', '¬.eth'],
					['฿.eth', '฿.eth'],
					['⃀.eth', '⃀.eth'],
					['⃁.eth', '⃁.eth'],
					['〄.eth', '〄.eth'],
					['〓.eth', '〓.eth'],
					['〠.eth', '〠.eth'],
					['ｰ.eth', 'ー.eth'],
					['￩.eth', '←.eth'],
					['￪.eth', '↑.eth'],
					['￫.eth', '→.eth'],
					['￬.eth', '↓.eth'],
					['ϲω.eth', 'σω.eth'],
					['ζζ.eth', 'ζζ.eth'],
					['ηη.eth', 'ηη.eth'],
					['ςς.eth', 'ςς.eth'],
					['τζ.eth', 'τζ.eth'],
					['τη.eth', 'τη.eth'],
					['Π.eth', 'π.eth'],
					['ϖ.eth', 'π.eth'],
					['ππ.eth', 'ππ.eth'],
					['ξ.eth', 'ξ.eth'],
					['ξξ.eth', 'ξξ.eth'],
				['тест.eth', 'тест.eth'],
				['те.eth', 'те.eth'],
				['єя.eth', 'єя.eth'],
				['ҫя.eth', 'ҫя.eth'],
				['ӕя.eth', 'ӕя.eth'],
				['Բ.eth', 'բ.eth'],
				['ܐ.eth', 'ܐ.eth'],
				['ހ.eth', 'ހ.eth'],
				['অ.eth', 'অ.eth'],
				['ਅ.eth', 'ਅ.eth'],
				['અ.eth', 'અ.eth'],
				['ଅ.eth', 'ଅ.eth'],
				['அ.eth', 'அ.eth'],
				['ఈ.eth', 'ఈ.eth'],
				['ಀ.eth', 'ಀ.eth'],
				['അ.eth', 'അ.eth'],
				['අ.eth', 'අ.eth'],
				['༌.eth', '་.eth'],
				['က.eth', 'က.eth'],
				['Ⴧ.eth', 'ⴧ.eth'],
				['ሁ.eth', 'ሁ.eth'],
				['Ꭳ.eth', 'Ꭳ.eth'],
				['ក.eth', 'ក.eth'],
				['᠐.eth', '᠐.eth'],
				['Ẽ.eth', 'ẽ.eth'],
				['Ỳ.eth', 'ỳ.eth'],
			] as const
			for (const [input, expected] of normalizedVectors) {
				assert.equal(ens_normalize(input), expected, input)
			}
			assert.equal(namehash('۴۵۶.eth'), '0x1efe00551c0d9a8e0672ea9fe2017d5b9e3d2d4512bfa28400db23d927382ece')
			assert.equal(namehash('مرحبا۴۵۶.eth'), '0x828e8a043aa1c488fff2031dbf0f6f5c04692c5e509ec2401815d57b1ee2a10a')
		})

	test('rejects ENS names that the old normalizer rejected as unsafe or invalid', () => {
		const rejectedNames = [
			'foo。eth',
			'foo．eth',
			'foo｡eth',
			'İ.eth',
			'ab--cd.eth',
			'xn--raffy.eth',
			'\ue000.eth',
			'\ufdd0.eth',
			'\ufffe.eth',
			'💩Raffy.eth_',
			'_foo_bar.eth',
			'__foo_bar.eth',
			'foo_.eth',
			'foo_bar.eth',
			'!foo.eth',
			'foo%bar.eth',
			'~.eth',
			'℮.eth',
			'✓.eth',
			'a\u0338.eth',
			'a\u0340.eth',
			'a\u0341.eth',
			'a\u0305.eth',
			'a\u20dd.eth',
			'a\u034f.eth',
			'ð.eth',
			'þ.eth',
			'œ.eth',
			'ı.eth',
			'ª.eth',
			'¹.eth',
			'º.eth',
			'ŉ.eth',
			'ǆ.eth',
			'ʰ.eth',
			'ˡ.eth',
			'ʹ.eth',
			'ᴴ.eth',
			'ꜗ.eth',
			'ꞈ.eth',
			'օ.eth',
			'Ͱ.eth',
				'ʹ.eth',
				'Ѡ.eth',
				'ϲ.eth',
				'є.eth',
				'єє.eth',
				'ҫ.eth',
				'ӕ.eth',
				'ес.eth',
				'раура.eth',
				'тт.eth',
				'⁰.eth',
				'⓫.eth',
				'⓿.eth',
			'❶.eth',
			'➊.eth',
				'β.eth',
				'β1.eth',
				'α.eth',
				'δ.eth',
				'τεστ.eth',
				'τορ.eth',
				'κοτ.eth',
				'σκοτ.eth',
				'εσ.eth',
				'а.eth',
			'е.eth',
			'с.eth',
			'ו.eth',
			'ט.eth',
			'י.eth',
			'ا.eth',
			'ه.eth',
			'ؿ.eth',
			'مرحبا1.eth',
			'שלום1.eth',
			'हिन्दी1.eth',
			'ไทย1.eth',
			'abcمرحبا.eth',
			'مرحباabc.eth',
			'abcעברית.eth',
			'עבריתabc.eth',
			'abcไทย.eth',
			'ไทยabc.eth',
			'abcहिन्दी.eth',
				'हिन्दीabc.eth',
				'०.eth',
				'๐.eth',
				'จ.eth',
				'↚.eth',
				'∀.eth',
					'₠.eth',
					'₢.eth',
					'ࢭ.eth',
					'ࢮ.eth',
					'ऽ.eth',
					'ฯ.eth',
					'︳.eth',
					'︴.eth',
						'⁄.eth',
						'々.eth',
						'〻.eth',
						'ￚ.eth',
						'ⱼ.eth',
						'ⱽ.eth',
						'ㇰ.eth',
						'ㇿ.eth',
						'ꚜ.eth',
						'ꚝ.eth',
						'ﬅ.eth',
						'ﬆ.eth',
						'𐅀.eth',
						'𞀲.eth',
						'𛀀.eth',
						'±.eth',
				'×.eth',
				'÷.eth',
				'♭.eth',
				'♮.eth',
				'♯.eth',
				'foo..eth',
			'.foo.eth',
			'foo.eth.',
			'\u0303.eth',
			'οо.eth',
			'раураl.eth',
			'a b.eth',
			'a/b.eth',
			'a\u200db.eth',
			'a\u200cb.eth',
			'a\u200d😀.eth',
			'😀\u200da.eth',
			'😀\u200d😀.eth',
			'👦‍👦.eth',
			'👨‍👨.eth',
			'👧‍👦.eth',
			'🏽.eth',
			'🏻.eth',
			'a🏽.eth',
		] as const
		for (const name of rejectedNames) {
			assert.throws(() => ens_normalize(name), /Invalid ENS/u, name)
		}
	})

	test('rejects sampled ENS compatibility and confusable ranges that old normalizer rejected', () => {
		const rejectedCodePoints = [
			0x02b0,
			0x02b9,
			0x02e1,
			0x1d2c,
			0x1d34,
			0x1d9c,
			0xa717,
			0xa788,
			0xa7f2,
			0x0555,
			0x0585,
			0x05d5,
			0x05e1,
			0x0627,
			0x0647,
			0x063f,
			0x066e,
				0x06d5,
				0x2c7c,
				0x2c7d,
				0x31f0,
				0x31ff,
				0xa69c,
				0xa69d,
			] as const
		for (const codePoint of rejectedCodePoints) {
			const name = `${ String.fromCodePoint(codePoint) }.eth`
			assert.throws(() => ens_normalize(name), /Invalid ENS/u, `U+${ codePoint.toString(16).padStart(4, '0') }`)
		}
	})

	test('matches reference EIP-191 and EIP-712 hash and deterministic signature vectors', async () => {
		const account = privateKeyToAccount(privateKey)
		assert.equal(account.address, accountAddress)
		assert.equal(hashMessage({ raw: stringToBytes('hello') }), '0x50b2c43fd39106bafbba0da34fc430e1f91e3c96ea2acee2bc34119f92b37750')
		assert.equal(hashMessage('recover me'), '0x17d676f6f317b30e564660e687d3efd92178ef409afd30945d99f938afafdec6')
		assert.equal(hashStruct({ data: typedData.message, primaryType: 'Mail', types: typedData.types }), '0xc52c0ee5d84264471806290a3f2c4cecfc5490626bf912d01f240d7a274b371e')
		assert.equal(hashTypedData(typedData), '0xbe609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2')
		assert.equal(hashTypedData({ ...typedData, domain: { ...typedData.domain, chainId: '0x1' } }), '0xbe609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2')
		assert.equal(hashTypedData(reorderedDomainTypedData), '0x9715a377b111f22762d1e40388cdd6861d1480afbc89a4f9c09869451666e7e7')
		assert.equal(
			await account.signMessage({ message: { raw: stringToBytes('hello') } }),
			'0x0c3324046197fec2336027b2c0931a7b4d5e8fc063e1977b46ab510d6dc493057889019d0e4a07d56babffba4a017a4c85c69aae7dcfacdb004e75ed453a46511b',
		)
		assert.equal(
			await account.signTypedData(typedData),
			'0x10d3ce8040590e48889801080ad40f3d514c2c3ce03bbbe3e179bbf5ba56c75425951fa15220f637e2ab79fd033b99c4b340339e00e360316547e956c61ffcb01c',
		)
		assert.equal(
			await account.signTypedData(reorderedDomainTypedData),
			'0x18aea0c0adb24e6a61d8a2e2d5ebd7c2cb931cf89390a361e8b7d892439556ed245b5cb6ce1a8d0086db48d63873bffbc6f90d7f9fda22c1eea3570d15b0bbc51b',
		)
		const recoverHash = hashMessage('recover me')
		const recoverSignature = '0xbfd5d3b10061eb98701a35adcf1e2a39d5814067517a4f4d0cee146ed56f46b64bda3d34d90a39235f8ca9dde1cd4a1f48a6b66bbaa616bcd1fbf9ad1aeafbe71b'
		const recoverSignatureObject = {
			r: '0xbfd5d3b10061eb98701a35adcf1e2a39d5814067517a4f4d0cee146ed56f46b6',
			s: '0x4bda3d34d90a39235f8ca9dde1cd4a1f48a6b66bbaa616bcd1fbf9ad1aeafbe7',
		} as const
		assert.equal(await recoverAddress({ hash: recoverHash, signature: recoverSignature }), accountAddress)
		assert.equal(await recoverAddress({ hash: recoverHash, signature: { ...recoverSignatureObject, v: 0n } }), accountAddress)
		assert.equal(await recoverAddress({ hash: recoverHash, signature: { ...recoverSignatureObject, v: 27n } }), accountAddress)
		assert.notEqual(await recoverAddress({ hash: recoverHash, signature: { ...recoverSignatureObject, v: 1n } }), accountAddress)
		assert.notEqual(await recoverAddress({ hash: recoverHash, signature: { ...recoverSignatureObject, v: 28n } }), accountAddress)
		assert.equal(
			await recoverAddress({
				hash: recoverHash,
				signature: {
					r: '0xbfd5d3b10061eb98701a35adcf1e2a39d5814067517a4f4d0cee146ed56f46b6',
					s: '0x4bda3d34d90a39235f8ca9dde1cd4a1f48a6b66bbaa616bcd1fbf9ad1aeafbe7',
					yParity: 0,
				},
			}),
			accountAddress,
		)
	})

	test('matches reference EIP-712 signing vectors for fixed, nested, and struct arrays', async () => {
		const account = privateKeyToAccount(privateKey)
		for (const vector of typedDataArrayVectors) {
			const typedData = JSON.parse(vector.raw)
			assert.equal(hashTypedData(typedData), vector.hash, vector.name)
			assert.equal(await account.signTypedData(typedData), vector.signature, vector.name)
		}
	})

	test('matches reference EIP-712 rejection for missing string fields', async () => {
		const account = privateKeyToAccount(privateKey)
		assert.throws(() => hashTypedData(typedDataMissingMessageString), /Missing EIP-712 value for Mail\.contents/u)
		await assert.rejects(account.signTypedData(typedDataMissingMessageString), /Missing EIP-712 value for Mail\.contents/u)
		assert.throws(() => hashTypedData(typedDataMissingDomainString), /Missing EIP-712 value for EIP712Domain\.name/u)
		await assert.rejects(account.signTypedData(typedDataMissingDomainString), /Missing EIP-712 value for EIP712Domain\.name/u)
	})

	test('matches reference EIP-712 primitive coercion for malformed but accepted string and bytes values', async () => {
		const account = privateKeyToAccount(privateKey)
		assert.equal(hashTypedData(typedDataPrimitiveCoercion), '0x1a5961e55544fd296fa56bf3b3a2f44f9d3d8c382537240e670f5fadf0fb97e4')
		assert.equal(
			await account.signTypedData(typedDataPrimitiveCoercion),
			'0x5f950bf1f14033d44343aac2f060bcabb85b6c4e5a8fb1add5e95495950c0b4f3726dd1a1abb6bfaef2eeaa6513a7f5d3e35190a7181aafaef862cc3034c030f1c',
		)
		assert.equal(hashTypedData(typedDataHexString), '0x42f5f2d4ed7271ca48bcf4aeebb8ccccc373da3857717b52f1c4950434133830')
		assert.equal(
			await account.signTypedData(typedDataHexString),
			'0xfa17bdf29350587598aad67b1dc0da1ad9d5bfae47dfd442297c3981c15ccf7237da21f499b097f6aae90cd744ad6b5426404bed627934f0a3bab539042ad1591b',
		)
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

	test('matches reference EIP-1559 serialize and parse vectors used by raw transaction approval', () => {
		const serializedUnsigned = serializeTransaction(unsignedEip1559Transaction)
		assert.equal(serializedUnsigned, '0x02ec01078459682f008504a817c80082520894000000000000000000000000000000000000dead84075bcd1580c0')
		assert.equal(
			serializeTransaction(unsignedEip1559Transaction, transactionSignature),
			'0x02f86f01078459682f008504a817c80082520894000000000000000000000000000000000000dead84075bcd1580c001a01f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100a02f2e2d2c2b2a292827262524232221201f1e1d1c1b1a19181716151413121110',
		)
		assert.equal(
			serializeTransaction(unsignedEip1559Transaction, { r: transactionSignature.r, s: transactionSignature.s, v: 0n }),
			'0x02f86f01078459682f008504a817c80082520894000000000000000000000000000000000000dead84075bcd1580c080a01f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100a02f2e2d2c2b2a292827262524232221201f1e1d1c1b1a19181716151413121110',
		)
		assert.equal(
			serializeTransaction(unsignedEip1559Transaction, { r: transactionSignature.r, s: transactionSignature.s, v: 1n }),
			'0x02f86f01078459682f008504a817c80082520894000000000000000000000000000000000000dead84075bcd1580c001a01f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100a02f2e2d2c2b2a292827262524232221201f1e1d1c1b1a19181716151413121110',
		)
		assert.deepStrictEqual(
			parseTransaction(serializeTransaction(unsignedEip1559Transaction, transactionSignature)),
			{
				r: transactionSignature.r,
				s: transactionSignature.s,
				v: 28n,
				yParity: 1,
				chainId: 1,
				type: 'eip1559',
				to: lowercaseDeadAddress,
				gas: 21_000n,
				nonce: 7,
				value: 123_456_789n,
				maxFeePerGas: 20_000_000_000n,
				maxPriorityFeePerGas: 1_500_000_000n,
			},
		)

		const signedTransactionWithAccessList = '0x02f8aa01078459682f008504a817c80082753094000000000000000000000000000000000000dead84075bcd15821234f838f794000000000000000000000000000000000000beefe1a0111111111111111111111111111111111111111111111111111111111111111101a01f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100a02f2e2d2c2b2a292827262524232221201f1e1d1c1b1a19181716151413121110'
		assert.deepStrictEqual(parseTransaction(signedTransactionWithAccessList), {
			r: transactionSignature.r,
			s: transactionSignature.s,
			v: 28n,
			yParity: 1,
			chainId: 1,
			type: 'eip1559',
			to: lowercaseDeadAddress,
			gas: 30_000n,
			data: '0x1234',
			nonce: 7,
			value: 123_456_789n,
			maxFeePerGas: 20_000_000_000n,
			maxPriorityFeePerGas: 1_500_000_000n,
			accessList: [{
				address: lowercaseBeefAddress,
				storageKeys: ['0x1111111111111111111111111111111111111111111111111111111111111111'],
			}],
		})
		const serializedContractCreation = serializeTransaction({
			type: 'eip1559',
			chainId: 1,
			nonce: 0,
			maxFeePerGas: 1n,
			maxPriorityFeePerGas: 1n,
			gas: 100_000n,
			data: '0x60006000',
			accessList: [],
		})
		assert.equal(serializedContractCreation, '0x02d001800101830186a080808460006000c0')
		assert.deepStrictEqual(parseTransaction(serializedContractCreation), {
			chainId: 1,
			type: 'eip1559',
			gas: 100_000n,
			data: '0x60006000',
			nonce: 0,
			maxFeePerGas: 1n,
			maxPriorityFeePerGas: 1n,
		})
	})
})
