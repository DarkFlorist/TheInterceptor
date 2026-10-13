import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { hashMessage, hashStruct, hashTypedData, privateKeyToAccount, recoverAddress, stringToBytes } from '../../app/ts/utils/ethereumPrimitives.js'
import { canVerifyStructArray, d2Array, d2ArrayFixed, d3ArrayFixed, hasFixedArray } from './data/eip712Data.js'

const privateKey = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const accountAddress = '0xFCAd0B19bB29D4674531d6f115237E16AfCE377c'
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
})
