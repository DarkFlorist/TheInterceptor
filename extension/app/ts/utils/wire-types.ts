import * as funtypes from 'funtypes'
import { UnionToIntersection, assertNever } from './typescript.js'
import { IUnsignedTransaction } from './ethereum.js'

const BigIntParser: funtypes.ParsedValue<funtypes.String, bigint>['config'] = {
	parse: value => {
		if (!/^0x([a-fA-F0-9]{1,64})$/.test(value)) return { success: false, message: `${value} is not a hex string encoded number.` }
		else return { success: true, value: BigInt(value) }
	},
	serialize: value => {
		if (typeof value !== 'bigint') return { success: false, message: `${typeof value} is not a bigint.`}
		return { success: true, value: `0x${value.toString(16)}` }
	},
}

const SmallIntParser: funtypes.ParsedValue<funtypes.String, bigint>['config'] = {
	parse: value => {
		if (!/^0x([a-fA-F0-9]{1,64})$/.test(value)) return { success: false, message: `${value} is not a hex string encoded number.` }
		if (BigInt(value) >= 2n**64n) return { success: false, message: `${value} must be smaller than 2^64.` }
		else return { success: true, value: BigInt(value) }
	},
	serialize: value => {
		if (value >= 2n**64n) return { success: false, message: `${value} must be smaller than 2^64.` }
		if (typeof value !== 'bigint') return { success: false, message: `${typeof value} is not a bigint.`}
		return { success: true, value: `0x${value.toString(16)}` }
	},
}


const AddressParser: funtypes.ParsedValue<funtypes.String, bigint>['config'] = {
	parse: value => {
		if (!/^0x([a-fA-F0-9]{40})$/.test(value)) return { success: false, message: `${value} is not a hex string encoded address.` }
		else return { success: true, value: BigInt(value) }
	},
	serialize: value => {
		if (typeof value !== 'bigint') return { success: false, message: `${typeof value} is not a bigint.`}
		return { success: true, value: `0x${value.toString(16).padStart(40, '0')}` }
	},
}

const Bytes32Parser: funtypes.ParsedValue<funtypes.String, bigint>['config'] = {
	parse: value => {
		if (!/^0x([a-fA-F0-9]{64})$/.test(value)) return { success: false, message: `${value} is not a hex string encoded 32 byte value.` }
		else return { success: true, value: BigInt(value) }
	},
	serialize: value => {
		if (typeof value !== 'bigint') return { success: false, message: `${typeof value} is not a bigint.`}
		return { success: true, value: `0x${value.toString(16).padStart(64, '0')}` }
	},
}

const Bytes256Parser: funtypes.ParsedValue<funtypes.String, bigint>['config'] = {
	parse: value => {
		if (!/^0x([a-fA-F0-9]{512})$/.test(value)) return { success: false, message: `${value} is not a hex string encoded 256 byte value.` }
		else return { success: true, value: BigInt(value) }
	},
	serialize: value => {
		if (typeof value !== 'bigint') return { success: false, message: `${typeof value} is not a bigint.`}
		return { success: true, value: `0x${value.toString(16).padStart(512, '0')}` }
	},
}
const Bytes16Parser: funtypes.ParsedValue<funtypes.String, bigint>['config'] = {
	parse: value => {
		if (!/^0x([a-fA-F0-9]{16})$/.test(value)) return { success: false, message: `${value} is not a hex string encoded 256 byte value.` }
		else return { success: true, value: BigInt(value) }
	},
	serialize: value => {
		if (typeof value !== 'bigint') return { success: false, message: `${typeof value} is not a bigint.`}
		return { success: true, value: `0x${value.toString(16).padStart(16, '0')}` }
	},
}

const BytesParser: funtypes.ParsedValue<funtypes.String, Uint8Array>['config'] = {
	parse: value => {
		const match = /^(?:0x)?([a-fA-F0-9]*)$/.exec(value)
		if (match === null) return { success: false, message: `Expected a hex string encoded byte array with an optional '0x' prefix but received ${value}` }
		const normalized = match[1]
		if (normalized.length % 2) return { success: false, message: `Hex string encoded byte array must be an even number of charcaters long.`}
		const bytes = new Uint8Array(normalized.length / 2)
		for (let i = 0; i < normalized.length; i += 2) {
			bytes[i/2] = Number.parseInt(`${normalized[i]}${normalized[i + 1]}`, 16)
		}
		return { success: true, value: new Uint8Array(bytes) }
	},
	serialize: value => {
		if (!(value instanceof Uint8Array)) return { success: false, message: `${typeof value} is not a Uint8Array.`}
		let result = ''
		for (let i = 0; i < value.length; ++i) {
			result += ('0' + value[i].toString(16)).slice(-2)
		}
		return { success: true, value: `0x${result}` }
	}
}

const TimestampParser: funtypes.ParsedValue<funtypes.String, Date>['config'] = {
	parse: value => {
		if (!/^0x([a-fA-F0-9]{0,8})$/.test(value)) return { success: false, message: `${value} is not a hex string encoded timestamp.` }
		else return { success: true, value: new Date(Number.parseInt(value, 16) * 1000) }
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

//
// Ethereum
//

export const EthereumQuantity = funtypes.String.withParser(BigIntParser)
export type EthereumQuantity = funtypes.Static<typeof EthereumQuantity>

export const EthereumQuantitySmall = funtypes.String.withParser(SmallIntParser)
export type EthereumQuantitySmall = funtypes.Static<typeof EthereumQuantitySmall>

export const EthereumData = funtypes.String.withParser(BytesParser)
export type EthereumData = funtypes.Static<typeof EthereumData>

export const EthereumAddress = funtypes.String.withParser(AddressParser)
export type EthereumAddress = funtypes.Static<typeof EthereumAddress>

export const EthereumAddressOrUndefined = funtypes.Union(EthereumAddress, funtypes.Undefined)
export type EthereumAddressOrUndefined = funtypes.Static<typeof EthereumAddressOrUndefined>

export const EthereumBytes32 = funtypes.String.withParser(Bytes32Parser)
export type EthereumBytes32 = funtypes.Static<typeof EthereumBytes32>

export const EthereumBytes256 = funtypes.String.withParser(Bytes256Parser)
export type EthereumBytes256 = funtypes.Static<typeof EthereumBytes256>

export const EthereumBytes16 = funtypes.String.withParser(Bytes16Parser)
export type EthereumBytes16 = funtypes.Static<typeof EthereumBytes16>

export const EthereumTimestamp = funtypes.String.withParser(TimestampParser)
export type EthereumTimestamp = funtypes.Static<typeof EthereumTimestamp>

export const EthereumBlockTag = funtypes.Union(EthereumQuantitySmall, EthereumBytes32, funtypes.Literal('latest'), funtypes.Literal('pending'))
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

export type EthereumUnsignedTransactionLegacy = funtypes.Static<typeof EthereumUnsignedTransactionLegacy>
export const EthereumUnsignedTransactionLegacy = funtypes.Intersect(
	funtypes.ReadonlyObject({
		type: funtypes.Union(funtypes.Literal('0x0').withParser(LiteralConverterParserFactory('0x0', 'legacy' as const)), funtypes.Literal(undefined).withParser(LiteralConverterParserFactory(undefined, 'legacy' as const))),
		from: EthereumAddress,
		nonce: EthereumQuantity,
		gasPrice: EthereumQuantity,
		gas: EthereumQuantity,
		to: funtypes.Union(EthereumAddress, funtypes.Null),
		value: EthereumQuantity,
		input: EthereumInput,
	}).asReadonly(),
	funtypes.Partial({
		chainId: EthereumQuantity,
	}).asReadonly()
)

export type EthereumUnsignedTransaction2930 = funtypes.Static<typeof EthereumUnsignedTransaction2930>
export const EthereumUnsignedTransaction2930 = funtypes.Intersect(
	funtypes.ReadonlyObject({
		type: funtypes.Literal('0x1').withParser(LiteralConverterParserFactory('0x1', '2930' as const)),
		from: EthereumAddress,
		nonce: EthereumQuantity,
		gasPrice: EthereumQuantity,
		gas: EthereumQuantity,
		to: funtypes.Union(EthereumAddress, funtypes.Null),
		value: EthereumQuantity,
		input: EthereumInput,
		chainId: EthereumQuantity,
	}).asReadonly(),
	funtypes.Partial({
		accessList: EthereumAccessList,
	}).asReadonly(),
)

export type EthereumUnsignedTransaction1559 = funtypes.Static<typeof EthereumUnsignedTransaction1559>
export const EthereumUnsignedTransaction1559 = funtypes.Intersect(
	funtypes.ReadonlyObject({
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
	}).asReadonly(),
	funtypes.Partial({
		accessList: EthereumAccessList,
	}).asReadonly(),
)
export type EthereumUnsignedTransaction = funtypes.Static<typeof EthereumUnsignedTransaction>
export const EthereumUnsignedTransaction = funtypes.Union(EthereumUnsignedTransactionLegacy, EthereumUnsignedTransaction2930, EthereumUnsignedTransaction1559)

export type EthereumTransaction2930And1559Signature = funtypes.Static<typeof EthereumTransaction2930And1559Signature>
export const EthereumTransaction2930And1559Signature = funtypes.ReadonlyObject({
	r: EthereumQuantity,
	s: EthereumQuantity,
	hash: EthereumBytes32,
	yParity: funtypes.Union(funtypes.Literal('0x0').withParser(LiteralConverterParserFactory('0x0', 'even' as const)), funtypes.Literal('0x1').withParser(LiteralConverterParserFactory('0x1', 'odd' as const))),
})

export type EthereumTransactionLegacySignature = funtypes.Static<typeof EthereumTransactionLegacySignature>
export const EthereumTransactionLegacySignature = funtypes.Intersect(
	funtypes.ReadonlyObject({
		r: EthereumQuantity,
		s: EthereumQuantity,
		hash: EthereumBytes32,
		v: EthereumQuantity,
	}),
	funtypes.Union(
		funtypes.ReadonlyObject({
			v: EthereumQuantity,
		}),
		funtypes.ReadonlyObject({
			yParity: funtypes.Union(funtypes.Literal('0x0').withParser(LiteralConverterParserFactory('0x0', 'even' as const)), funtypes.Literal('0x1').withParser(LiteralConverterParserFactory('0x1', 'odd' as const))),
			chainId: EthereumQuantity,
		})
	)
)

export type EthereumSignedTransactionLegacy = funtypes.Static<typeof EthereumSignedTransactionLegacy>
export const EthereumSignedTransactionLegacy = funtypes.Intersect(
	EthereumUnsignedTransactionLegacy,
	EthereumTransactionLegacySignature,
)

export type EthereumSignedTransaction2930 = funtypes.Static<typeof EthereumSignedTransaction2930>
export const EthereumSignedTransaction2930 = funtypes.Intersect(
	EthereumUnsignedTransaction2930,
	EthereumTransaction2930And1559Signature,
)

export type EthereumSignedTransaction1559 = funtypes.Static<typeof EthereumSignedTransaction1559>
export const EthereumSignedTransaction1559 = funtypes.Intersect(
	EthereumUnsignedTransaction1559,
	EthereumTransaction2930And1559Signature,
)

export type EthereumSignedTransaction = funtypes.Static<typeof EthereumSignedTransaction>
export const EthereumSignedTransaction = funtypes.Union(EthereumSignedTransactionLegacy, EthereumSignedTransaction2930, EthereumSignedTransaction1559)

export type EthereumSignedTransactionWithBlockData = funtypes.Static<typeof EthereumSignedTransactionWithBlockData>
export const EthereumSignedTransactionWithBlockData = funtypes.Intersect(
	funtypes.Union(
		EthereumSignedTransactionLegacy,
		EthereumSignedTransaction2930,
		funtypes.Intersect(EthereumSignedTransaction1559, funtypes.ReadonlyObject({gasPrice: EthereumQuantity})),
	),
	funtypes.ReadonlyObject({
		data: EthereumInput,
		blockHash: funtypes.Union(EthereumBytes32, funtypes.Null),
		blockNumber: funtypes.Union(EthereumQuantity, funtypes.Null),
		transactionIndex: funtypes.Union(EthereumQuantity, funtypes.Null),
		v: EthereumQuantity,
	})
)

export type EthereumBlockHeader = funtypes.Static<typeof EthereumBlockHeader>
export const EthereumBlockHeader = funtypes.ReadonlyObject({
	author: EthereumAddress,
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
	totalDifficulty: EthereumQuantity,
	transactions: funtypes.ReadonlyArray(EthereumSignedTransaction),
	uncles: funtypes.ReadonlyArray(EthereumBytes32),
	baseFeePerGas: EthereumQuantity,
	transactionsRoot: EthereumBytes32
}).asReadonly()

export type EthGetStorageAtResponse = funtypes.Static<typeof EthGetStorageAtResponse>
export const EthGetStorageAtResponse = funtypes.Union(
	EthereumBytes32,
	funtypes.String.withParser({ parse: x => x === '0x' ? { success: true, value: null } : { success: false, message: `eth_getStorageAt didn't return 32 bytes of data nor 0x.` } }),
)

export type EthGetLogsRequest = funtypes.Static<typeof EthGetLogsRequest>
export const EthGetLogsRequest = funtypes.Intersect(
	funtypes.Union(
		funtypes.ReadonlyObject({ blockHash: EthereumBytes32 }).asReadonly(),
		funtypes.ReadonlyObject({ fromBlock: EthereumQuantity, toBlock: funtypes.Union(EthereumQuantity, funtypes.Literal('latest')) }).asReadonly(),
	),
	funtypes.Partial({
		address: funtypes.Union(EthereumAddress, funtypes.ReadonlyArray(EthereumAddress)),
		topics: funtypes.ReadonlyArray(funtypes.Union(EthereumBytes32, funtypes.ReadonlyArray(EthereumBytes32), funtypes.Null)),
	}).asReadonly()
)

export type EthGetLogsResponse = funtypes.Static<typeof EthGetLogsResponse>
export const EthGetLogsResponse = funtypes.ReadonlyArray(
	funtypes.ReadonlyObject({
		removed: funtypes.Boolean,
		logIndex: funtypes.Union(EthereumQuantity, funtypes.Null),
		transactionIndex: funtypes.Union(EthereumQuantity, funtypes.Null),
		transactionHash: funtypes.Union(EthereumBytes32, funtypes.Null),
		blockHash: funtypes.Union(EthereumBytes32, funtypes.Null),
		blockNumber: funtypes.Union(EthereumQuantity, funtypes.Null),
		address: EthereumAddress,
		data: EthereumInput,
		topics: funtypes.ReadonlyArray(EthereumBytes32),
	}).asReadonly()
)

export type EthTransactionReceiptResponse = funtypes.Static<typeof EthTransactionReceiptResponse>
export const EthTransactionReceiptResponse = funtypes.Union(
	funtypes.Null,
	funtypes.ReadonlyObject({
		type: funtypes.Union(
			funtypes.Union(funtypes.Literal('0x0').withParser(LiteralConverterParserFactory('0x0', 'legacy' as const)), funtypes.Literal(undefined).withParser(LiteralConverterParserFactory(undefined, 'legacy' as const))),
			funtypes.Literal('0x0').withParser(LiteralConverterParserFactory('0x0', 'legacy' as const)),
			funtypes.Literal('0x1').withParser(LiteralConverterParserFactory('0x1', '2930' as const)),
			funtypes.Literal('0x2').withParser(LiteralConverterParserFactory('0x2', '1559' as const)),
		),
		blockHash: EthereumBytes32,
		blockNumber: EthereumQuantity,
		transactionHash: EthereumBytes32,
		transactionIndex: EthereumQuantity,
		contractAddress: funtypes.Union(funtypes.Null, EthereumAddress),
		cumulativeGasUsed: EthereumQuantity,
		gasUsed: EthereumQuantity,
		effectiveGasPrice: EthereumQuantity,
		from: EthereumAddress,
		to: funtypes.Union(funtypes.Null, EthereumAddress),
		logs: EthGetLogsResponse,
		logsBloom: EthereumBytes256,
		status: funtypes.Union(
			funtypes.Literal('0x0').withParser(LiteralConverterParserFactory('0x0', 'failure' as const)),
			funtypes.Literal('0x1').withParser(LiteralConverterParserFactory('0x1', 'success' as const)),
		),
	}).asReadonly()
)

const RevertErrorParser: funtypes.ParsedValue<funtypes.String, string>['config'] = {
	parse: value => {
		if (!value.startsWith('Reverted ')) return { success: true, value }
		const parseResult = BytesParser.parse(value.slice('Reverted '.length))
		if (!parseResult.success) return parseResult
		const decoded = new TextDecoder().decode(parseResult.value)
		return { success: true, value: decoded }
	},
	serialize: value => {
		const encoded = new TextEncoder().encode(value)
		const serializationResult = BytesParser.serialize!(encoded)
		if (!serializationResult.success) return serializationResult
		return { success: true, value: `Reverted ${serializationResult.value}` }
	},
}

export type MulticallRequestParameters = funtypes.Static<typeof MulticallRequestParameters>
export const MulticallRequestParameters = funtypes.Readonly(funtypes.Tuple(
	EthereumQuantity, // block number
	EthereumAddress, // miner
	funtypes.ReadonlyArray(EthereumUnsignedTransaction),
))

export type MulticallResponseEventLog = funtypes.Static<typeof MulticallResponseEventLog>
export const MulticallResponseEventLog =  funtypes.ReadonlyObject({
	loggersAddress: EthereumAddress,
	data: EthereumInput,
	topics: funtypes.ReadonlyArray(EthereumBytes32),
}).asReadonly()

export type MulticallResponseEventLogs = funtypes.Static<typeof MulticallResponseEventLogs>
export const MulticallResponseEventLogs = funtypes.ReadonlyArray(MulticallResponseEventLog)

export type EthBalanceChanges = funtypes.Static<typeof EthBalanceChanges>
export const EthBalanceChanges = funtypes.ReadonlyArray(
	funtypes.ReadonlyObject({
		address: EthereumAddress,
		before: EthereumQuantity,
		after: EthereumQuantity,
	}).asReadonly()
)

export type SingleMulticallResponse = funtypes.Static<typeof SingleMulticallResponse>
export const SingleMulticallResponse = funtypes.Union(
	funtypes.ReadonlyObject({
		statusCode: funtypes.Literal(1).withParser(LiteralConverterParserFactory(1, 'success' as const)),
		gasSpent: EthereumQuantity,
		returnValue: EthereumData,
		events: MulticallResponseEventLogs,
		balanceChanges: EthBalanceChanges,
	}).asReadonly(),
	funtypes.ReadonlyObject({
		statusCode: funtypes.Literal(0).withParser(LiteralConverterParserFactory(0, 'failure' as const)),
		gasSpent: EthereumQuantity,
		error: funtypes.String.withParser(RevertErrorParser),
		returnValue: EthereumData,
	}).asReadonly(),
)

export type MulticallResponse = funtypes.Static<typeof MulticallResponse>
export const MulticallResponse = funtypes.ReadonlyArray(SingleMulticallResponse)

//
// Token Lists
//

export type TokenListResponse = funtypes.Static<typeof TokenListResponse>
export const TokenListResponse = funtypes.ReadonlyObject({tokens: funtypes.ReadonlyArray(funtypes.ReadonlyObject({
	address: EthereumAddress,
	name: funtypes.String,
	symbol: funtypes.String,
	decimals: funtypes.Number,
	logoUri: funtypes.Union(funtypes.String, funtypes.Undefined),
}).asReadonly())}).asReadonly()

//
// NFT Data
//

export type NFTDataResponse = funtypes.Static<typeof NFTDataResponse>
export const NFTDataResponse = funtypes.ReadonlyObject({
	address: EthereumAddress,
	name: funtypes.String,
	symbol: funtypes.String,
	image_url: funtypes.String,
}).asReadonly()

//
// Helpers
//

export function serializeUnsignedTransactionToJson(transaction: IUnsignedTransaction): unknown {
	switch (transaction.type) {
		case 'legacy':
			return {
				type: '0x0',
				from: serialize(EthereumAddress, transaction.from),
				nonce: serialize(EthereumQuantity, transaction.nonce),
				gasPrice: serialize(EthereumQuantity, transaction.gasPrice),
				gas: serialize(EthereumQuantity, transaction.gasLimit),
				to: transaction.to !== null ? serialize(EthereumAddress, transaction.to) : null,
				value: serialize(EthereumQuantity, transaction.value),
				data: serialize(EthereumData, transaction.input),
				...'chainId' in transaction && transaction.chainId !== undefined ? { chainId: serialize(EthereumQuantity, transaction.chainId) } : {},
			}
		case '2930':
			return {
				type: '0x1',
				from: serialize(EthereumAddress, transaction.from),
				nonce: serialize(EthereumQuantity, transaction.nonce),
				gasPrice: serialize(EthereumQuantity, transaction.gasPrice),
				gas: serialize(EthereumQuantity, transaction.gasLimit),
				to: transaction.to !== null ? serialize(EthereumAddress, transaction.to) : null,
				value: serialize(EthereumQuantity, transaction.value),
				data: serialize(EthereumData, transaction.input),
				chainId: serialize(EthereumQuantity, transaction.chainId),
				accessList: serialize(EthereumAccessList, transaction.accessList),
			}
		case '1559':
			return {
				type: '0x2',
				from: serialize(EthereumAddress, transaction.from),
				nonce: serialize(EthereumQuantity, transaction.nonce),
				maxFeePerGas: serialize(EthereumQuantity, transaction.maxFeePerGas),
				maxPriorityFeePerGas: serialize(EthereumQuantity, transaction.maxPriorityFeePerGas),
				gas: serialize(EthereumQuantity, transaction.gasLimit),
				to: transaction.to !== null ? serialize(EthereumAddress, transaction.to) : null,
				value: serialize(EthereumQuantity, transaction.value),
				data: serialize(EthereumData, transaction.input),
				chainId: serialize(EthereumQuantity, transaction.chainId),
				accessList: serialize(EthereumAccessList, transaction.accessList),
			}
		default: assertNever(transaction)
	}
}

export function serialize<T, U extends funtypes.Codec<T>>(funtype: U, value: T) {
	return funtype.serialize(value) as ToWireType<U>
}

export type ToWireType<T> =
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


export type DappRequestTransaction = funtypes.Static<typeof DappRequestTransaction>
export const DappRequestTransaction = funtypes.Partial({
	from: EthereumAddress,
	data: EthereumData,
	gas: EthereumQuantity,
	value: EthereumQuantity,
	to: EthereumAddress,
	gasPrice: EthereumQuantity,
	maxPriorityFeePerGas: EthereumQuantity,
	maxFeePerGas: EthereumQuantity,
}).asReadonly()

export type EthereumBlockHeaderWithTransactionHashes = funtypes.Static<typeof EthereumBlockHeaderWithTransactionHashes>
export const EthereumBlockHeaderWithTransactionHashes = funtypes.ReadonlyObject({
	author: EthereumAddress,
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
	totalDifficulty: EthereumQuantity,
	transactions: funtypes.ReadonlyArray(EthereumBytes32),
	uncles: funtypes.ReadonlyArray(EthereumBytes32),
	baseFeePerGas: EthereumQuantity,
	transactionsRoot: EthereumBytes32
}).asReadonly()

export type GetBlockReturn = funtypes.Static<typeof GetBlockReturn>
export const GetBlockReturn = funtypes.Union(EthereumBlockHeader, EthereumBlockHeaderWithTransactionHashes)

export const NewHeadsSubscriptionData = funtypes.ReadonlyObject({
	subscription: funtypes.String,
	result: EthereumBlockHeaderWithTransactionHashes
}).asReadonly()

export type JsonRpcNewHeadsNotification = funtypes.Static<typeof JsonRpcNewHeadsNotification>
export const JsonRpcNewHeadsNotification = funtypes.ReadonlyObject({
	jsonrpc: funtypes.Literal('2.0'),
	method: funtypes.String,
	params: NewHeadsSubscriptionData
}).asReadonly()

export type JsonSubscriptionNotification = funtypes.Static<typeof JsonSubscriptionNotification>
export const JsonSubscriptionNotification = funtypes.ReadonlyObject({
	jsonrpc: funtypes.Literal('2.0'),
	method: funtypes.Literal('eth_subscription'),
	params: funtypes.ReadonlyObject({
		result: funtypes.Union(EthereumBlockHeader, EthereumBytes32),
		subscription: funtypes.String
	}).asReadonly()
}).asReadonly()

export type JsonRpcSuccessResponse = funtypes.Static<typeof JsonRpcSuccessResponse>
export const JsonRpcSuccessResponse = funtypes.ReadonlyObject({
	jsonrpc: funtypes.Literal('2.0'),
	id: funtypes.Union(funtypes.String, funtypes.Number),
	result: funtypes.Unknown,
}).asReadonly()

export type JsonRpcErrorResponse = funtypes.Static<typeof JsonRpcErrorResponse>
export const JsonRpcErrorResponse = funtypes.ReadonlyObject({
	jsonrpc: funtypes.Literal('2.0'),
	id: funtypes.Union(funtypes.String, funtypes.Number),
	error: funtypes.ReadonlyObject({
		code: funtypes.Number,
		message: funtypes.String,
		data: funtypes.Unknown,
	}).asReadonly(),
}).asReadonly()


export type JsonRpcNotification = funtypes.Static<typeof JsonRpcNotification>
export const JsonRpcNotification = funtypes.Union(JsonRpcNewHeadsNotification, JsonSubscriptionNotification)

export type JsonRpcRequest = funtypes.Static<typeof JsonRpcRequest>
export const JsonRpcRequest = funtypes.ReadonlyObject({
	jsonrpc: funtypes.Literal('2.0'),
	id: funtypes.Union(funtypes.String, funtypes.Number),
	method: funtypes.String,
	params: funtypes.Union(funtypes.ReadonlyArray(funtypes.Unknown), funtypes.Literal(undefined).withParser(LiteralConverterParserFactory(undefined, [])))
})

export type JsonRpcResponse = funtypes.Static<typeof JsonRpcResponse>
export const JsonRpcResponse = funtypes.Union(JsonRpcErrorResponse, JsonRpcSuccessResponse)

export type JsonRpcMessage = funtypes.Static<typeof JsonRpcMessage>
export const JsonRpcMessage = funtypes.Union(JsonRpcResponse, JsonRpcNotification, JsonRpcRequest)

export type TransactionByHashParams = funtypes.Static<typeof TransactionByHashParams>
export const TransactionByHashParams = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_getTransactionByHash'),
	params: funtypes.Tuple(EthereumBytes32)
})

export type SendTransactionParams = funtypes.Static<typeof SendTransactionParams>
export const SendTransactionParams = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_sendTransaction'),
	params: funtypes.Tuple(DappRequestTransaction)
})

export type EthereumAccountsReply = funtypes.Static<typeof EthereumAccountsReply>
export const EthereumAccountsReply = funtypes.ReadonlyArray(EthereumAddress)

export type EthereumChainReply = funtypes.Static<typeof EthereumChainReply>
export const EthereumChainReply = funtypes.ReadonlyArray(EthereumQuantity)

export type TransactionReceiptParams = funtypes.Static<typeof TransactionReceiptParams>
export const TransactionReceiptParams = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_getTransactionReceipt'),
	params: funtypes.Tuple(EthereumBytes32)
})

export type EstimateGasParamsVariables = funtypes.Static<typeof EstimateGasParamsVariables>
export const EstimateGasParamsVariables = funtypes.Intersect(
	funtypes.Partial({
		to: EthereumAddress,
		from: EthereumAddress,
		data: EthereumData,
		value: EthereumQuantity,
		gasPrice: EthereumQuantity,
		gas: EthereumQuantity
	})
)

export type EstimateGasParams = funtypes.Static<typeof EstimateGasParams>
export const EstimateGasParams = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_estimateGas'),
	params: funtypes.Union(funtypes.Tuple(EstimateGasParamsVariables), funtypes.Tuple(EstimateGasParamsVariables, EthereumBlockTag))
})

export type EthCallParams = funtypes.Static<typeof EthCallParams>
export const EthCallParams = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_call'),
	params: funtypes.Tuple(
		EstimateGasParamsVariables,
		EthereumBlockTag
	)
}).asReadonly()

export type EthGetLogsParams = funtypes.Static<typeof EthGetLogsParams>
export const EthGetLogsParams = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_getLogs'),
	params: funtypes.Tuple(EthGetLogsRequest)
}).asReadonly()

export type EthBalanceParams = funtypes.Static<typeof EthBalanceParams>
export const EthBalanceParams = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_getBalance'),
	params: funtypes.Tuple(EthereumAddress, EthereumBlockTag)
})

export type EthBlockByNumberParams = funtypes.Static<typeof EthBlockByNumberParams>
export const EthBlockByNumberParams = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_getBlockByNumber'),
	params: funtypes.Tuple(EthereumBlockTag, funtypes.Boolean)
})

export type EthSubscribeParams = funtypes.Static<typeof EthSubscribeParams>
export const EthSubscribeParams = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_subscribe'),
	params: funtypes.Tuple(funtypes.Union(funtypes.Literal('newHeads'), funtypes.Literal('logs'), funtypes.Literal('newPendingTransactions'), funtypes.Literal('syncing')))
})

export type EthUnSubscribeParams = funtypes.Static<typeof EthUnSubscribeParams>
export const EthUnSubscribeParams = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_unsubscribe'),
	params: funtypes.Tuple(funtypes.String)
})

export type EthGetStorageAtParams = funtypes.Static<typeof EthGetStorageAtParams>
export const EthGetStorageAtParams = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_getStorageAt'),
	params: funtypes.Tuple(EthereumAddress, EthereumQuantity, EthereumBlockTag)
})

export const EthSubscriptionResponse = funtypes.String
export type EthSubscriptionResponse = funtypes.Static<typeof EthSubscriptionResponse>

export type PersonalSignParams = funtypes.Static<typeof PersonalSignParams>
export const PersonalSignParams = funtypes.ReadonlyObject({
	method: funtypes.Literal('personal_sign'),
	params: funtypes.Union(
		funtypes.Tuple(funtypes.String, EthereumAddress, funtypes.Union(funtypes.String, funtypes.Undefined)), // message, account, password
		funtypes.Tuple(funtypes.String, EthereumAddress) // message, account
	)
})

export type EIP712Message = funtypes.Static<typeof EIP712Message>
export const EIP712Message = funtypes.ReadonlyObject({
	types: funtypes.Record(funtypes.String, funtypes.ReadonlyArray(
		funtypes.ReadonlyObject({
			name: funtypes.String,
			type: funtypes.String,
		})
	)),
	primaryType: funtypes.String,
	domain: funtypes.Record(funtypes.String, funtypes.String),
	message: funtypes.Record(funtypes.String, funtypes.Union(funtypes.Record(funtypes.String, funtypes.String), funtypes.String)),
})

function isJSON(text: string){
	if (typeof text !== 'string') return false
	try {
		JSON.parse(text)
		return true
	}
	catch (error) {
		return false
	}
}

const EIP712MessageParser: funtypes.ParsedValue<funtypes.String, EIP712Message>['config'] = {
	parse: value => {
		if (!isJSON(value) || !EIP712Message.test(JSON.parse(value))) return { success: false, message: `${ value } is not EIP712 message` }
		else return { success: true, value: EIP712Message.parse(JSON.parse(value)) }
	},
	serialize: value => {
		if (!EIP712Message.test(value)) return { success: false, message: `${ value } is not a EIP712 mmessage.`}
		return { success: true, value: EIP712Message.serialize(value) as string }
	},
}

export type SignTypedDataParams = funtypes.Static<typeof SignTypedDataParams>
export const SignTypedDataParams = funtypes.ReadonlyObject({
	method: funtypes.Union(
		funtypes.Literal('eth_signTypedData'),
		funtypes.Literal('eth_signTypedData_v1'),
		funtypes.Literal('eth_signTypedData_v2'),
		funtypes.Literal('eth_signTypedData_v3'),
		funtypes.Literal('eth_signTypedData_v4'),
	),
	params: funtypes.Tuple(EthereumAddress, funtypes.String.withParser(EIP712MessageParser)), // address that will sign the message, typed data
})

export type SwitchEthereumChainParams = funtypes.Static<typeof SwitchEthereumChainParams>
export const SwitchEthereumChainParams = funtypes.ReadonlyObject({
	method: funtypes.Literal('wallet_switchEthereumChain'),
	params: funtypes.Tuple(funtypes.ReadonlyObject({
		chainId: EthereumQuantity
	}).asReadonly()),
}).asReadonly()

export type GetCode = funtypes.Static<typeof GetCode>
export const GetCode = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_getCode'),
	params: funtypes.Tuple(EthereumAddress, EthereumBlockTag)
}).asReadonly()

export type RequestPermissions = funtypes.Static<typeof RequestPermissions>
export const RequestPermissions = funtypes.ReadonlyObject({
	method: funtypes.Literal('wallet_requestPermissions'),
	params: funtypes.Tuple( funtypes.ReadonlyObject({ eth_accounts: funtypes.ReadonlyObject({ }) }) )
}).asReadonly()

const BigIntParserNonHex: funtypes.ParsedValue<funtypes.String, bigint>['config'] = {
	parse: value => {
		if (!/^[0-9]+$/.test(value)) return { success: false, message: `${ value } is not a string encoded number.` }
		else return { success: true, value: BigInt(value) }
	},
	serialize: value => {
		if (typeof value !== 'bigint') return { success: false, message: `${ typeof value } is not a bigint.`}
		return { success: true, value: `${ value.toString() }` }
	},
}

export const NonHexBigInt = funtypes.String.withParser(BigIntParserNonHex)
export type NonHexBigInt = funtypes.Static<typeof NonHexBigInt>

export type EIP2612Message = funtypes.Static<typeof EIP2612Message>
export const EIP2612Message = funtypes.ReadonlyObject({
	types: funtypes.ReadonlyObject({
		EIP712Domain: funtypes.Tuple(
			funtypes.ReadonlyObject({
				name: funtypes.Literal('name'),
				type: funtypes.Literal('string'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('version'),
				type: funtypes.Literal('string'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('chainId'),
				type: funtypes.Literal('uint256'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('verifyingContract'),
				type: funtypes.Literal('address'),
			}),
		),
		Permit: funtypes.Tuple(
			funtypes.ReadonlyObject({
				name: funtypes.Literal('owner'),
				type: funtypes.Literal('address'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('spender'),
				type: funtypes.Literal('address'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('value'),
				type: funtypes.Literal('uint256'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('nonce'),
				type: funtypes.Literal('uint256'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('deadline'),
				type: funtypes.Literal('uint256'),
			}),
		),
	}),
	primaryType: funtypes.Literal('Permit'),
	domain: funtypes.ReadonlyObject({
		name: funtypes.String,
		version: NonHexBigInt,
		chainId: funtypes.Number,
		verifyingContract: EthereumAddress,
	}),
	message: funtypes.ReadonlyObject({
		owner: EthereumAddress,
		spender: EthereumAddress,
		value: NonHexBigInt,
		nonce: funtypes.Number,
		deadline: funtypes.Number,
	}),
})

export type GetTransactionCount = funtypes.Static<typeof GetTransactionCount>
export const GetTransactionCount = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_getTransactionCount'),
	params: funtypes.Tuple(EthereumAddress, EthereumBlockTag)
}).asReadonly()

export type EthSign = funtypes.Static<typeof EthSign>
export const EthSign = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_sign'),
	params: funtypes.Tuple(EthereumAddress, funtypes.String),
}).asReadonly()

export type GetSimulationStackReply = funtypes.Static<typeof GetSimulationStackReply>
export const GetSimulationStackReply = funtypes.ReadonlyArray(funtypes.Intersect(
	EthereumUnsignedTransaction,
	SingleMulticallResponse,
	funtypes.ReadonlyObject({
		realizedGasPrice: EthereumQuantity,
		gasLimit: EthereumQuantity,
	}).asReadonly(),
))

export type GetSimulationStack = funtypes.Static<typeof GetSimulationStack>
export const GetSimulationStack = funtypes.ReadonlyObject({
	method: funtypes.Literal('interceptor_getSimulationStack'),
	params: funtypes.Tuple(funtypes.Literal('1.0.0')),
}).asReadonly()

export type EthereumJsonRpcRequest = funtypes.Static<typeof EthereumJsonRpcRequest>
export const EthereumJsonRpcRequest = funtypes.Union(
	EthBlockByNumberParams,
	EthBalanceParams,
	EstimateGasParams,
	TransactionByHashParams,
	TransactionReceiptParams,
	SendTransactionParams,
	EthCallParams,
	EthSubscribeParams,
	EthUnSubscribeParams,
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_blockNumber') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_chainId') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('net_version') }),
	GetCode,
	PersonalSignParams,
	SignTypedDataParams,
	SwitchEthereumChainParams,
	RequestPermissions,
	funtypes.ReadonlyObject({ method: funtypes.Literal('wallet_getPermissions') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_accounts') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_requestAccounts') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_gasPrice') }),
	GetTransactionCount,
	GetSimulationStack,
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_multicall'), params: MulticallRequestParameters }),
	EthGetStorageAtParams,
	EthGetLogsParams,
	EthSign,
)

export const SupportedETHRPCCalls = [
	'eth_getBlockByNumber',
	'eth_getBalance',
	'eth_estimateGas',
	'eth_getTransactionByHash',
	'eth_getTransactionReceipt',
	'eth_sendTransaction',
	'eth_call',
	'eth_subscribe',
	'eth_unsubscribe',
	'eth_blockNumber',
	'eth_chainId',
	'net_version',
	'eth_getCode',
	'personal_sign',
	'eth_signTypedData',
	'eth_signTypedData_v1',
	'eth_signTypedData_v2',
	'eth_signTypedData_v3',
	'eth_signTypedData_v4',
	'wallet_switchEthereumChain',
	'wallet_requestPermissions',
	'wallet_getPermissions',
	'eth_accounts',
	'eth_requestAccounts',
	'eth_gasPrice',
	'eth_getTransactionCount',
	'interceptor_getSimulationStack'
]

export type Permit2 = funtypes.Static<typeof Permit2>
export const Permit2 = funtypes.ReadonlyObject({
	types: funtypes.ReadonlyObject({
		PermitSingle: funtypes.Tuple(
			funtypes.ReadonlyObject({
				name: funtypes.Literal('details'),
				type: funtypes.Literal('PermitDetails'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('spender'),
				type: funtypes.Literal('address'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('sigDeadline'),
				type: funtypes.Literal('uint256'),
			}),
		),
		PermitDetails: funtypes.Tuple(
			funtypes.ReadonlyObject({
				name: funtypes.Literal('token'),
				type: funtypes.Literal('address'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('amount'),
				type: funtypes.Literal('uint160'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('expiration'),
				type: funtypes.Literal('uint48'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('nonce'),
				type: funtypes.Literal('uint48'),
			}),
		),
		EIP712Domain: funtypes.Tuple(
			funtypes.ReadonlyObject({
				name: funtypes.Literal('name'),
				type: funtypes.Literal('string'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('chainId'),
				type: funtypes.Literal('uint256'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('verifyingContract'),
				type: funtypes.Literal('address'),
			}),
		)
	}),
	domain: funtypes.ReadonlyObject({
		name: funtypes.Literal('Permit2'),
		chainId: NonHexBigInt,
		verifyingContract: EthereumAddress,
	}),
	primaryType: funtypes.Literal('PermitSingle'),
	message: funtypes.ReadonlyObject({
		details: funtypes.ReadonlyObject({
			token: EthereumAddress,
			amount: NonHexBigInt,
			expiration: NonHexBigInt,
			nonce: NonHexBigInt,
		}),
		spender: EthereumAddress,
		sigDeadline: NonHexBigInt,
	})
})
