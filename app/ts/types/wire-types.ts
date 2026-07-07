import * as funtypes from 'funtypes'
import type { UnionToIntersection } from '../utils/typescript.js'
import { isHexEncodedNumber } from '../utils/bigint.js'

const BigIntParser: funtypes.ParsedValue<funtypes.String, bigint>['config'] = {
	parse: value => {
		if (!/^0x([a-fA-F0-9]{1,64})$/.test(value)) return { success: false, message: `${value} is not a hex string encoded number.` }
		return { success: true, value: BigInt(value) }
	},
	serialize: value => {
		if (typeof value !== 'bigint') return { success: false, message: `${typeof value} is not a bigint.`}
		if (value < 0n) return { success: false, message: `${typeof value} is not a non negative bigint.`}
		return { success: true, value: `0x${value.toString(16)}` }
	},
}

const SmallIntParser: funtypes.ParsedValue<funtypes.String, bigint>['config'] = {
	parse: value => {
		if (!/^0x([a-fA-F0-9]{1,64})$/.test(value)) return { success: false, message: `${value} is not a hex string encoded number.` }
		if (BigInt(value) >= 2n**64n) return { success: false, message: `${value} must be smaller than 2^64.` }
		return { success: true, value: BigInt(value) }
	},
	serialize: value => {
		if (value >= 2n**64n) return { success: false, message: `${value} must be smaller than 2^64.` }
		if (typeof value !== 'bigint') return { success: false, message: `${typeof value} is not a bigint.`}
		if (value < 0n) return { success: false, message: `${typeof value} is not a non negative bigint.`}
		return { success: true, value: `0x${value.toString(16)}` }
	},
}

const AddressParser: funtypes.ParsedValue<funtypes.String, bigint>['config'] = {
	parse: value => {
		if (!/^0x([a-fA-F0-9]{40})$/.test(value)) return { success: false, message: `${value} is not a hex string encoded address.` }
		return { success: true, value: BigInt(value) }
	},
	serialize: value => {
		if (typeof value !== 'bigint') return { success: false, message: `${typeof value} is not a bigint.`}
		if (value < 0n) return { success: false, message: `${typeof value} is not a non negative bigint.`}
		return { success: true, value: `0x${value.toString(16).padStart(40, '0')}` }
	},
}

const Bytes32Parser: funtypes.ParsedValue<funtypes.String, bigint>['config'] = {
	parse: value => {
		if (!/^0x([a-fA-F0-9]{64})$/.test(value)) return { success: false, message: `${value} is not a hex string encoded 32 byte value.` }
		return { success: true, value: BigInt(value) }
	},
	serialize: value => {
		if (typeof value !== 'bigint') return { success: false, message: `${typeof value} is not a bigint.`}
		if (value < 0n) return { success: false, message: `${typeof value} is not a non negative bigint.`}
		return { success: true, value: `0x${value.toString(16).padStart(64, '0')}` }
	},
}

const Bytes256Parser: funtypes.ParsedValue<funtypes.String, bigint>['config'] = {
	parse: value => {
		if (!/^0x([a-fA-F0-9]{512})$/.test(value)) return { success: false, message: `${value} is not a hex string encoded 256 byte value.` }
		return { success: true, value: BigInt(value) }
	},
	serialize: value => {
		if (typeof value !== 'bigint') return { success: false, message: `${typeof value} is not a bigint.`}
		if (value < 0n) return { success: false, message: `${typeof value} is not a non negative bigint.`}
		return { success: true, value: `0x${value.toString(16).padStart(512, '0')}` }
	},
}
const Bytes16Parser: funtypes.ParsedValue<funtypes.String, bigint>['config'] = {
	parse: value => {
		if (!/^0x([a-fA-F0-9]{16})$/.test(value)) return { success: false, message: `${value} is not a hex string encoded 256 byte value.` }
		return { success: true, value: BigInt(value) }
	},
	serialize: value => {
		if (typeof value !== 'bigint') return { success: false, message: `${typeof value} is not a bigint.`}
		if (value < 0n) return { success: false, message: `${typeof value} is not a non negative bigint.`}
		return { success: true, value: `0x${value.toString(16).padStart(16, '0')}` }
	},
}

export const BytesParser: funtypes.ParsedValue<funtypes.String, Uint8Array>['config'] = {
	parse: value => {
		const match = /^(?:0x)?([a-fA-F0-9]*)$/.exec(value)
		if (match === null) return { success: false, message: `Expected a hex string encoded byte array with an optional '0x' prefix but received ${ value }` }
		const normalized = match[1]
		if (normalized === undefined) return { success: false, message: `Expected a hex string encoded byte array with an optional '0x' prefix but received ${ value }` }
		if (normalized.length % 2) return { success: false, message: 'Hex string encoded byte array must be an even number of charcaters long.' }
		const bytes = new Uint8Array(normalized.length / 2)
		for (let i = 0; i < normalized.length; i += 2) {
			bytes[i/2] = Number.parseInt(`${ normalized[i] }${ normalized[i + 1] }`, 16)
		}
		return { success: true, value: new Uint8Array(bytes) }
	},
	serialize: value => {
		if (!(value instanceof Uint8Array)) return { success: false, message: `${typeof value} is not a Uint8Array.`}
		let result = ''
		for (let i = 0; i < value.length; ++i) {
			const val = value[i]
			if (val === undefined) return { success: false, message: `${typeof value} is not a Uint8Array.`}
			result += ('0' + val.toString(16)).slice(-2)
		}
		return { success: true, value: `0x${result}` }
	}
}

const TimestampParser: funtypes.ParsedValue<funtypes.String, Date>['config'] = {
	parse: value => {
		if (!/^0x([a-fA-F0-9]*)$/.test(value)) return { success: false, message: `${value} is not a hex string encoded timestamp.` }
		return { success: true, value: new Date(Number.parseInt(value, 16) * 1000) }
	},
	serialize: value => {
		if (!(value instanceof Date)) return { success: false, message: `${typeof value} is not a Date.`}
		return { success: true, value: `0x${Math.floor(value.valueOf() / 1000).toString(16)}` }
	},
}

const OptionalBytesParser: funtypes.ParsedValue<funtypes.Union<[funtypes.String, funtypes.Literal<undefined>]>, Uint8Array>['config'] = {
	parse: value => BytesParser.parse(value || '0x'),
	serialize: value => BytesParser.serialize!(value || new Uint8Array()),
}

export const LiteralConverterParserFactory: <TInput, TOutput> (input: TInput, output: TOutput) => funtypes.ParsedValue<funtypes.Runtype<TInput>, TOutput>['config'] = (input, output) => {
	return {
		parse: value => (value === input) ? { success: true, value: output } : { success: false, message: `${value} was expected to be literal.` },
		serialize: value => (value === output) ? { success: true, value: input } : { success: false, message: `${value} was expected to be literal.`  }
	}
}

const EthereumSignatureParityParser: funtypes.ParsedValue<funtypes.String, 'even' | 'odd'>['config'] = {
	parse: value => {
		switch (value) {
			case '0x0': return { success: true, value: 'even' }
			case '0x1': return { success: true, value: 'odd' }
			default: return { success: false, message: `${value} is not a supported signature parity.` }
		}
	},
	serialize: value => {
		switch (value) {
			case 'even': return { success: true, value: '0x0' }
			case 'odd': return { success: true, value: '0x1' }
			default: return { success: false, message: `${value} is not a supported signature parity.` }
		}
	},
}

const EthereumTypedTransactionVParser: funtypes.ParsedValue<funtypes.String, bigint>['config'] = {
	parse: value => {
		switch (value) {
			case '0x0': return { success: true, value: 0n }
			case '0x1': return { success: true, value: 1n }
			default: return { success: false, message: `${value} is not a supported typed transaction v value.` }
		}
	},
	serialize: value => {
		switch (value) {
			case 0n: return { success: true, value: '0x0' }
			case 1n: return { success: true, value: '0x1' }
			default: return { success: false, message: `${value} is not a supported typed transaction v value.` }
		}
	},
}

const BigIntParserNonHex: funtypes.ParsedValue<funtypes.String, bigint>['config'] = {
	parse: value => {
		if (!/^[0-9]+$/.test(value)) return { success: false, message: `${ value } is not a string encoded number.` }
		return { success: true, value: BigInt(value) }
	},
	serialize: value => {
		if (typeof value !== 'bigint') return { success: false, message: `${ typeof value } is not a bigint.`}
		return { success: true, value: `${ value.toString() }` }
	},
}

export const NonHexBigInt = funtypes.String.withParser(BigIntParserNonHex)
export type NonHexBigInt = funtypes.Static<typeof NonHexBigInt>

//
// Ethereum
//

export const EthereumQuantity = funtypes.String.withParser(BigIntParser)
export type EthereumQuantity = funtypes.Static<typeof EthereumQuantity>

export const EthereumSignatureParity = funtypes.String.withParser(EthereumSignatureParityParser)
export type EthereumSignatureParity = funtypes.Static<typeof EthereumSignatureParity>

const EthereumTypedTransactionV = funtypes.String.withParser(EthereumTypedTransactionVParser)

export const EthereumQuantitySmall = funtypes.String.withParser(SmallIntParser)
export type EthereumQuantitySmall = funtypes.Static<typeof EthereumQuantitySmall>

export const EthereumData = funtypes.String.withParser(BytesParser)
export type EthereumData = funtypes.Static<typeof EthereumData>

export const EthereumAddress = funtypes.String.withParser(AddressParser)
export type EthereumAddress = funtypes.Static<typeof EthereumAddress>

export type OptionalEthereumAddress = funtypes.Static<typeof OptionalEthereumAddress>
export const OptionalEthereumAddress = funtypes.Union(EthereumAddress, funtypes.Undefined)

export const EthereumAddressOrMissing = funtypes.Union(EthereumAddress, funtypes.Literal('missing').withParser(LiteralConverterParserFactory('missing', undefined)))
export type EthereumAddressOrMissing = funtypes.Static<typeof EthereumAddressOrMissing>

export const EthereumBytes32 = funtypes.String.withParser(Bytes32Parser)
export type EthereumBytes32 = funtypes.Static<typeof EthereumBytes32>

export const EthereumBytes256 = funtypes.String.withParser(Bytes256Parser)
export type EthereumBytes256 = funtypes.Static<typeof EthereumBytes256>

export const EthereumBytes16 = funtypes.String.withParser(Bytes16Parser)
export type EthereumBytes16 = funtypes.Static<typeof EthereumBytes16>

export const EthereumTimestamp = funtypes.String.withParser(TimestampParser)
export type EthereumTimestamp = funtypes.Static<typeof EthereumTimestamp>

export const EthereumBlockTag = funtypes.Union(EthereumQuantitySmall, EthereumBytes32, funtypes.Literal('latest'), funtypes.Literal('pending'), funtypes.Literal('finalized'))
export type EthereumBlockTag = funtypes.Static<typeof EthereumBlockTag>

export const EthereumInput = funtypes.Union(funtypes.String, funtypes.Undefined).withParser(OptionalBytesParser)
export type EthereumInput = funtypes.Static<typeof EthereumInput>

export const EthereumAccessList = funtypes.ReadonlyArray(
	funtypes.ReadonlyObject({
		address: EthereumAddress,
		storageKeys: funtypes.ReadonlyArray(EthereumBytes32)
	}).asReadonly()
)
export type EthereumAccessList = funtypes.Static<typeof EthereumAccessList>

type EthereumUnsignedTransactionLegacy = funtypes.Static<typeof EthereumUnsignedTransactionLegacy>
export const EthereumUnsignedTransactionLegacyFields = {
	type: funtypes.Union(funtypes.Literal('0x0').withParser(LiteralConverterParserFactory('0x0', 'legacy' as const)), funtypes.Literal(undefined).withParser(LiteralConverterParserFactory(undefined, 'legacy' as const))),
	from: EthereumAddress,
	nonce: EthereumQuantity,
	gasPrice: EthereumQuantity,
	gas: EthereumQuantity,
	to: funtypes.Union(EthereumAddress, funtypes.Null),
	value: EthereumQuantity,
	input: EthereumInput,
}
export const EthereumUnsignedTransactionLegacyOptionalFields = {
	chainId: EthereumQuantity,
}
const EthereumUnsignedTransactionLegacy = funtypes.Intersect(
	funtypes.ReadonlyObject(EthereumUnsignedTransactionLegacyFields).asReadonly(),
	funtypes.Partial(EthereumUnsignedTransactionLegacyOptionalFields).asReadonly()
)

type EthereumUnsignedTransaction2930 = funtypes.Static<typeof EthereumUnsignedTransaction2930>
export const EthereumUnsignedTransaction2930Fields = {
	type: funtypes.Literal('0x1').withParser(LiteralConverterParserFactory('0x1', '2930' as const)),
	from: EthereumAddress,
	nonce: EthereumQuantity,
	gasPrice: EthereumQuantity,
	gas: EthereumQuantity,
	to: funtypes.Union(EthereumAddress, funtypes.Null),
	value: EthereumQuantity,
	input: EthereumInput,
	chainId: EthereumQuantity,
}
export const EthereumTransactionAccessListFields = {
	accessList: EthereumAccessList,
}
const EthereumUnsignedTransaction2930 = funtypes.Intersect(
	funtypes.ReadonlyObject(EthereumUnsignedTransaction2930Fields).asReadonly(),
	funtypes.Partial(EthereumTransactionAccessListFields).asReadonly(),
)

type EthereumUnsignedTransaction1559 = funtypes.Static<typeof EthereumUnsignedTransaction1559>
export const EthereumUnsignedTransaction1559Fields = {
	type: funtypes.Literal('0x2').withParser(LiteralConverterParserFactory('0x2', '1559' as const)),
	from: EthereumAddress,
	nonce: EthereumQuantity,
	maxFeePerGas: EthereumQuantity,
	maxPriorityFeePerGas: EthereumQuantity,
	gas: EthereumQuantity,
	to: funtypes.Union(EthereumAddress, funtypes.Null),
	value: EthereumQuantity,
	input: EthereumInput,
	chainId: EthereumQuantity,
}
const EthereumUnsignedTransaction1559 = funtypes.Intersect(
	funtypes.ReadonlyObject(EthereumUnsignedTransaction1559Fields).asReadonly(),
	funtypes.Partial(EthereumTransactionAccessListFields).asReadonly(),
)

type EthereumUnsignedTransaction7702 = funtypes.Static<typeof EthereumUnsignedTransaction7702>
export const EthereumUnsignedTransaction7702Fields = {
	type: funtypes.Literal('0x4').withParser(LiteralConverterParserFactory('0x4', '7702' as const)),
	from: EthereumAddress,
	nonce: EthereumQuantity,
	maxFeePerGas: EthereumQuantity,
	maxPriorityFeePerGas: EthereumQuantity,
	gas: EthereumQuantity,
	to: funtypes.Union(EthereumAddress, funtypes.Null),
	value: EthereumQuantity,
	input: EthereumInput,
	chainId: EthereumQuantity,
	authorizationList: funtypes.ReadonlyArray(funtypes.ReadonlyObject({
		chainId: EthereumQuantity,
		address: EthereumAddress,
		nonce: EthereumQuantity,
	}))
}
const EthereumUnsignedTransaction7702 = funtypes.Intersect(
	funtypes.ReadonlyObject(EthereumUnsignedTransaction7702Fields).asReadonly(),
	funtypes.Partial(EthereumTransactionAccessListFields).asReadonly(),
)

type EthereumUnsignedTransaction4844  = funtypes.Static<typeof EthereumUnsignedTransaction4844>
export const EthereumUnsignedTransaction4844Fields = {
	type: funtypes.Literal('0x3').withParser(LiteralConverterParserFactory('0x3', '4844' as const)),
	from: EthereumAddress,
	nonce: EthereumQuantity,
	maxFeePerGas: EthereumQuantity,
	maxPriorityFeePerGas: EthereumQuantity,
	gas: EthereumQuantity,
	to: funtypes.Union(EthereumAddress, funtypes.Null),
	value: EthereumQuantity,
	input: EthereumInput,
	chainId: EthereumQuantity,
	maxFeePerBlobGas: EthereumQuantity,
	blobVersionedHashes: funtypes.ReadonlyArray(EthereumBytes32),
}
const EthereumUnsignedTransaction4844 = funtypes.Intersect(
	funtypes.ReadonlyObject(EthereumUnsignedTransaction4844Fields).asReadonly(),
	funtypes.Partial(EthereumTransactionAccessListFields).asReadonly(),
)

export type EthereumUnsignedTransaction = funtypes.Static<typeof EthereumUnsignedTransaction>
export const EthereumUnsignedTransaction = funtypes.Union(EthereumUnsignedTransactionLegacy, EthereumUnsignedTransaction2930, EthereumUnsignedTransaction1559, EthereumUnsignedTransaction4844, EthereumUnsignedTransaction7702)

type OptionalEthereumUnsignedTransaction1559 = funtypes.Static<typeof EthereumUnsignedTransaction1559>
const OptionalEthereumUnsignedTransaction1559 = funtypes.Intersect(
	funtypes.ReadonlyObject({
		type: funtypes.Literal('0x2').withParser(LiteralConverterParserFactory('0x2', '1559' as const)),
		from: EthereumAddress,
		nonce: EthereumQuantity,
		to: funtypes.Union(EthereumAddress, funtypes.Null),
		value: EthereumQuantity,
		input: EthereumInput,
		chainId: EthereumQuantity,
	}).asReadonly(),
	funtypes.Partial({
		gas: EthereumQuantity,
		maxFeePerGas: EthereumQuantity,
		maxPriorityFeePerGas: EthereumQuantity,
		accessList: EthereumAccessList,
	}).asReadonly(),
)

type OptionalEthereumUnsignedTransaction4844 = funtypes.Static<typeof OptionalEthereumUnsignedTransaction4844>
const OptionalEthereumUnsignedTransaction4844 = funtypes.Intersect(
	funtypes.ReadonlyObject({
		type: funtypes.Literal('0x3').withParser(LiteralConverterParserFactory('0x3', '4844' as const)),
		from: EthereumAddress,
		nonce: EthereumQuantity,
		to: funtypes.Union(EthereumAddress, funtypes.Null),
		value: EthereumQuantity,
		input: EthereumInput,
		chainId: EthereumQuantity,
		maxFeePerBlobGas: EthereumQuantity,
		blobVersionedHashes: funtypes.ReadonlyArray(EthereumBytes32),
	}).asReadonly(),
	funtypes.Partial({
		gas: EthereumQuantity,
		maxFeePerGas: EthereumQuantity,
		maxPriorityFeePerGas: EthereumQuantity,
		accessList: EthereumAccessList,
	}).asReadonly(),
)

type OptionalEthereumUnsignedTransaction7702 = funtypes.Static<typeof EthereumUnsignedTransaction7702>
const OptionalEthereumUnsignedTransaction7702 = funtypes.Intersect(
	funtypes.ReadonlyObject({
		type: funtypes.Literal('0x4').withParser(LiteralConverterParserFactory('0x4', '7702' as const)),
		from: EthereumAddress,
		nonce: EthereumQuantity,
		to: funtypes.Union(EthereumAddress, funtypes.Null),
		value: EthereumQuantity,
		input: EthereumInput,
		chainId: EthereumQuantity,
		authorizationList: funtypes.ReadonlyArray(funtypes.ReadonlyObject({
			chainId: EthereumQuantity,
			address: EthereumAddress,
			nonce: EthereumQuantity,
		}))
	}).asReadonly(),
	funtypes.Partial({
		gas: EthereumQuantity,
		maxFeePerGas: EthereumQuantity,
		maxPriorityFeePerGas: EthereumQuantity,
		accessList: EthereumAccessList,
	}).asReadonly(),
)

export type OptionalEthereumUnsignedTransaction = funtypes.Static<typeof OptionalEthereumUnsignedTransaction>
export const OptionalEthereumUnsignedTransaction = funtypes.Union(EthereumUnsignedTransactionLegacy, EthereumUnsignedTransaction2930, OptionalEthereumUnsignedTransaction1559, OptionalEthereumUnsignedTransaction4844, OptionalEthereumUnsignedTransaction7702)

const OptionalEthereumTypedTransactionV = funtypes.Partial({
	v: EthereumTypedTransactionV,
}).asReadonly()

export const EthereumTransaction2930And1559And4844SignatureFields = {
	r: EthereumQuantity,
	s: EthereumQuantity,
	hash: EthereumBytes32,
}
export const EthereumSignatureParityFields = {
	yParity: EthereumSignatureParity,
}
export const EthereumTypedTransactionVFields = {
	v: EthereumTypedTransactionV,
}

const EthereumTransaction2930And1559And4844Signature = funtypes.Intersect(
	funtypes.ReadonlyObject(EthereumTransaction2930And1559And4844SignatureFields),
	funtypes.Union(
		funtypes.Intersect(funtypes.ReadonlyObject(EthereumSignatureParityFields), OptionalEthereumTypedTransactionV),
		funtypes.ReadonlyObject(EthereumTypedTransactionVFields),
	)
)

type MessageSignature = funtypes.Static<typeof MessageSignature>
export const MessageSignatureFields = {
	r: EthereumQuantity,
	s: EthereumQuantity,
	hash: EthereumBytes32,
	v: EthereumQuantity,
}
const MessageSignature = funtypes.ReadonlyObject(MessageSignatureFields)

type EthereumTransactionLegacySignature = funtypes.Static<typeof EthereumTransactionLegacySignature>
const EthereumTransactionLegacySignature = funtypes.Intersect(
	MessageSignature,
	funtypes.Union(
		funtypes.ReadonlyObject({ v: EthereumQuantity }),
		funtypes.ReadonlyObject({ ...EthereumSignatureParityFields, chainId: EthereumQuantity })
	)
)

export type EthereumSignedTransactionOptimismDeposit = funtypes.Static<typeof EthereumSignedTransactionOptimismDeposit>
export const EthereumSignedTransactionOptimismDepositFields = {
	type: funtypes.Literal('0x7e').withParser(LiteralConverterParserFactory('0x7e', 'optimismDeposit' as const)),
	sourceHash: EthereumBytes32,
	from: EthereumAddress,
	to: funtypes.Union(EthereumAddress, funtypes.Null),
	mint: funtypes.Union(EthereumQuantity, funtypes.Null, funtypes.Undefined),
	value: EthereumQuantity,
	gas: EthereumQuantity,
	data: EthereumInput,
	hash: EthereumBytes32,
	gasPrice: EthereumQuantity,
	nonce: EthereumQuantity,
}
export const EthereumSignedTransactionOptimismDeposit = funtypes.ReadonlyObject(EthereumSignedTransactionOptimismDepositFields)

export type EthereumSignedTransactionLegacy = funtypes.Static<typeof EthereumSignedTransactionLegacy>
export const EthereumSignedTransactionLegacy = funtypes.Intersect(
	EthereumUnsignedTransactionLegacy,
	EthereumTransactionLegacySignature,
)

export type EthereumSignedTransaction2930 = funtypes.Static<typeof EthereumSignedTransaction2930>
export const EthereumSignedTransaction2930 = funtypes.Intersect(
	EthereumUnsignedTransaction2930,
	EthereumTransaction2930And1559And4844Signature,
)

export type EthereumSignedTransaction7702 = funtypes.Static<typeof EthereumSignedTransaction7702>
export const EthereumSignedTransaction7702Fields = {
	type: funtypes.Literal('0x4').withParser(LiteralConverterParserFactory('0x4', '7702' as const)),
	from: EthereumAddress,
	nonce: EthereumQuantity,
	maxFeePerGas: EthereumQuantity,
	maxPriorityFeePerGas: EthereumQuantity,
	gas: EthereumQuantity,
	to: funtypes.Union(EthereumAddress, funtypes.Null),
	value: EthereumQuantity,
	input: EthereumInput,
	chainId: EthereumQuantity,
	authorizationList: funtypes.ReadonlyArray(funtypes.ReadonlyObject({
		chainId: EthereumQuantity,
		address: EthereumAddress,
		nonce: EthereumQuantity,
		r: EthereumQuantity,
		s: EthereumQuantity,
		yParity: EthereumSignatureParity
	}))
}
export const EthereumSignedTransaction7702 = funtypes.Intersect(
	funtypes.ReadonlyObject(EthereumSignedTransaction7702Fields).asReadonly(),
	funtypes.Partial(EthereumTransactionAccessListFields).asReadonly(),
	EthereumTransaction2930And1559And4844Signature
)

export type EthereumSignedTransaction1559 = funtypes.Static<typeof EthereumSignedTransaction1559>
export const EthereumSignedTransaction1559 = funtypes.Intersect(
	EthereumUnsignedTransaction1559,
	EthereumTransaction2930And1559And4844Signature,
)

export type EthereumSignedTransaction4844 = funtypes.Static<typeof EthereumSignedTransaction4844>
export const EthereumSignedTransaction4844 = funtypes.Intersect(
	EthereumUnsignedTransaction4844,
	EthereumTransaction2930And1559And4844Signature,
)

export type EthereumSendableSignedTransaction = funtypes.Static<typeof EthereumSendableSignedTransaction>
export const EthereumSendableSignedTransaction = funtypes.Union(EthereumSignedTransactionLegacy, EthereumSignedTransaction2930, EthereumSignedTransaction1559, EthereumSignedTransaction4844, EthereumSignedTransaction7702)

export type EthereumSignedTransaction = funtypes.Static<typeof EthereumSignedTransaction>
export const EthereumSignedTransaction = funtypes.Union(EthereumSendableSignedTransaction, EthereumSignedTransactionOptimismDeposit)

const knownEthereumTransactionTypeIds: readonly string[] = ['0x0', '0x1', '0x2', '0x3', '0x4', '0x7e', 'legacy', '2930', '1559', '4844', '7702', 'optimismDeposit']
export function isKnownEthereumTransactionType(type: string) {
	return knownEthereumTransactionTypeIds.includes(type)
}

export function isUnhandledEthereumTransactionType(type: string) {
	return isHexEncodedNumber(type) && !isKnownEthereumTransactionType(type)
}

export const EthereumSignedTransactionWithBlockReferenceFields = {
	data: EthereumInput,
	blockHash: funtypes.Union(EthereumBytes32, funtypes.Null),
	blockNumber: funtypes.Union(EthereumQuantity, funtypes.Null),
	transactionIndex: funtypes.Union(EthereumQuantity, funtypes.Null),
}
const EthereumSignedTransactionWithBlockReferences = funtypes.ReadonlyObject(EthereumSignedTransactionWithBlockReferenceFields)
export const EthereumSignedTransactionBlockGasPriceFields = { gasPrice: EthereumQuantity }
const EthereumSignedTransactionBlockGasPrice = funtypes.ReadonlyObject(EthereumSignedTransactionBlockGasPriceFields)

export type EthereumSignedTransactionWithBlockData = funtypes.Static<typeof EthereumSignedTransactionWithBlockData>
export const EthereumSignedTransactionWithBlockData = funtypes.Union(
	funtypes.Intersect(EthereumSignedTransactionLegacy, EthereumSignedTransactionWithBlockReferences),
	funtypes.Intersect(EthereumSignedTransaction2930, EthereumSignedTransactionWithBlockReferences),
	funtypes.Intersect(EthereumSignedTransaction1559, EthereumSignedTransactionBlockGasPrice, EthereumSignedTransactionWithBlockReferences),
	funtypes.Intersect(EthereumSignedTransaction4844, EthereumSignedTransactionBlockGasPrice, EthereumSignedTransactionWithBlockReferences),
	funtypes.Intersect(EthereumSignedTransaction7702, EthereumSignedTransactionBlockGasPrice, EthereumSignedTransactionWithBlockReferences),
)

type EthereumWithdrawal = funtypes.Static<typeof EthereumWithdrawal>
const EthereumWithdrawal = funtypes.ReadonlyObject({
	index: EthereumQuantity,
	validatorIndex: EthereumQuantity,
	address: EthereumAddress,
	amount: EthereumQuantity,
})

type EthereumBlockHeaderWithoutTransactions = funtypes.Static<typeof EthereumBlockHeaderWithoutTransactions>
const EthereumBlockHeaderWithoutTransactions = funtypes.Intersect(
	funtypes.MutablePartial({
		author: EthereumAddress,
	}),
	funtypes.Intersect(
		funtypes.ReadonlyObject({
			difficulty: EthereumQuantity,
			extraData: EthereumData,
			gasLimit: EthereumQuantity,
			gasUsed: EthereumQuantity,
			hash: EthereumBytes32,
			logsBloom: EthereumBytes256,
			miner: EthereumAddress,
			mixHash: EthereumBytes32,
			nonce: EthereumBytes16,
			number: EthereumQuantity,
			parentHash: EthereumBytes32,
			receiptsRoot: EthereumBytes32,
			sha3Uncles: EthereumBytes32,
			stateRoot: EthereumBytes32,
			timestamp: EthereumTimestamp,
			size: EthereumQuantity,
			uncles: funtypes.ReadonlyArray(EthereumBytes32),
			baseFeePerGas: funtypes.Union(EthereumQuantity, funtypes.Undefined),
			transactionsRoot: EthereumBytes32,
		}),
		funtypes.ReadonlyPartial({
			excessBlobGas: EthereumQuantity,
			blobGasUsed: EthereumQuantity,
			parentBeaconBlockRoot: EthereumBytes32,
			withdrawalsRoot: EthereumBytes32, // missing from old block
			withdrawals: funtypes.ReadonlyArray(EthereumWithdrawal), // missing from old block
			totalDifficulty: EthereumQuantity, // missing from new blocks
		})
	)
)

export type EthereumBlockHeaderWithTransactionHashes = funtypes.Static<typeof EthereumBlockHeaderWithTransactionHashes>
export const EthereumBlockHeaderWithTransactionHashes = funtypes.Union(funtypes.Null, funtypes.Intersect(
	EthereumBlockHeaderWithoutTransactions,
	funtypes.ReadonlyObject({ transactions: funtypes.ReadonlyArray(EthereumBytes32) })
))

type EthereumUnknownTransactionType = funtypes.Static<typeof EthereumUnknownTransactionType>
const EthereumUnknownTransactionType = funtypes.ReadonlyObject({
	hash: EthereumBytes32,
	type: funtypes.String.withConstraint((type) => {
		return isUnhandledEthereumTransactionType(type)
	})
})

export type EthereumBlockHeaderTransaction = funtypes.Static<typeof EthereumBlockHeaderTransaction>
export const EthereumBlockHeaderTransaction = funtypes.Union(EthereumSignedTransaction, EthereumUnknownTransactionType)

export type EthereumBlockHeader = funtypes.Static<typeof EthereumBlockHeader>
export const EthereumBlockHeader = funtypes.Union(funtypes.Null, funtypes.Intersect(
	EthereumBlockHeaderWithoutTransactions,
	funtypes.ReadonlyObject({ transactions: funtypes.ReadonlyArray(EthereumBlockHeaderTransaction) })
))

//
// Helpers
//

export function serialize<T, U extends funtypes.Codec<T>>(funtype: U, value: T) {
	return funtype.serialize(value) as ToWireType<U>
}

type ToWireType<T> =
	T extends funtypes.Intersect<infer U> ? UnionToIntersection<{ [I in keyof U]: ToWireType<U[I]> }[number]>
	: T extends funtypes.Union<infer U> ? { [I in keyof U]: ToWireType<U[I]> }[number]
	: T extends funtypes.Record<infer U, infer V> ? Record<funtypes.Static<U>, ToWireType<V>>
	: T extends funtypes.Partial<infer U, infer V> ? V extends true ? { readonly [K in keyof U]?: ToWireType<U[K]> } : { [K in keyof U]?: ToWireType<U[K]> }
	: T extends funtypes.Object<infer U, infer V> ? V extends true ? { readonly [K in keyof U]: ToWireType<U[K]> } : { [K in keyof U]: ToWireType<U[K]> }
	: T extends funtypes.Readonly<funtypes.Tuple<infer U>> ? { readonly [P in keyof U]: ToWireType<U[P]>}
	: T extends funtypes.Tuple<infer U> ? { [P in keyof U]: ToWireType<U[P]>}
	: T extends funtypes.ReadonlyArray<infer U> ? readonly ToWireType<U>[]
	: T extends funtypes.Array<infer U> ? ToWireType<U>[]
	: T extends funtypes.ParsedValue<infer U, infer _> ? ToWireType<U>
	: T extends funtypes.Codec<infer U> ? U
	: never
