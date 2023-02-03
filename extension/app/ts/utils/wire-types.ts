import * as t from 'funtypes'
import { UnionToIntersection, assertNever } from './typescript.js'
import { IUnsignedTransaction } from './ethereum.js'

const BigIntParser: t.ParsedValue<t.String, bigint>['config'] = {
	parse: value => {
		if (!/^0x([a-fA-F0-9]{1,64})$/.test(value)) return { success: false, message: `${value} is not a hex string encoded number.` }
		else return { success: true, value: BigInt(value) }
	},
	serialize: value => {
		if (typeof value !== 'bigint') return { success: false, message: `${typeof value} is not a bigint.`}
		return { success: true, value: `0x${value.toString(16)}` }
	},
}

const SmallIntParser: t.ParsedValue<t.String, bigint>['config'] = {
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


const AddressParser: t.ParsedValue<t.String, bigint>['config'] = {
	parse: value => {
		if (!/^0x([a-fA-F0-9]{40})$/.test(value)) return { success: false, message: `${value} is not a hex string encoded address.` }
		else return { success: true, value: BigInt(value) }
	},
	serialize: value => {
		if (typeof value !== 'bigint') return { success: false, message: `${typeof value} is not a bigint.`}
		return { success: true, value: `0x${value.toString(16).padStart(40, '0')}` }
	},
}

const Bytes32Parser: t.ParsedValue<t.String, bigint>['config'] = {
	parse: value => {
		if (!/^0x([a-fA-F0-9]{64})$/.test(value)) return { success: false, message: `${value} is not a hex string encoded 32 byte value.` }
		else return { success: true, value: BigInt(value) }
	},
	serialize: value => {
		if (typeof value !== 'bigint') return { success: false, message: `${typeof value} is not a bigint.`}
		return { success: true, value: `0x${value.toString(16).padStart(64, '0')}` }
	},
}

const Bytes256Parser: t.ParsedValue<t.String, bigint>['config'] = {
	parse: value => {
		if (!/^0x([a-fA-F0-9]{512})$/.test(value)) return { success: false, message: `${value} is not a hex string encoded 256 byte value.` }
		else return { success: true, value: BigInt(value) }
	},
	serialize: value => {
		if (typeof value !== 'bigint') return { success: false, message: `${typeof value} is not a bigint.`}
		return { success: true, value: `0x${value.toString(16).padStart(512, '0')}` }
	},
}

const BytesParser: t.ParsedValue<t.String, Uint8Array>['config'] = {
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

const TimestampParser: t.ParsedValue<t.String, Date>['config'] = {
	parse: value => {
		if (!/^0x([a-fA-F0-9]{0,8})$/.test(value)) return { success: false, message: `${value} is not a hex string encoded timestamp.` }
		else return { success: true, value: new Date(Number.parseInt(value, 16) * 1000) }
	},
	serialize: value => {
		if (!(value instanceof Date)) return { success: false, message: `${typeof value} is not a Date.`}
		return { success: true, value: `0x${Math.floor(value.valueOf() / 1000).toString(16)}` }
	},
}

const OptionalBytesParser: t.ParsedValue<t.Union<[t.String, t.Literal<undefined>]>, Uint8Array>['config'] = {
	parse: value => BytesParser.parse(value || '0x'),
	serialize: value => BytesParser.serialize!(value || new Uint8Array()),
}

export const LiteralConverterParserFactory: <TInput, TOutput> (input: TInput, output: TOutput) => t.ParsedValue<t.Runtype<TInput>, TOutput>['config'] = (input, output) => {
	return {
		parse: value => (value === input) ? { success: true, value: output } : { success: false, message: `${value} was expected to be literal.` },
		serialize: value => (value === output) ? { success: true, value: input } : { success: false, message: `${value} was expected to be literal.`  }
	}
}

//
// Ethereum
//

export const EthereumQuantity = t.String.withParser(BigIntParser)
export type EthereumQuantity = t.Static<typeof EthereumQuantity>

export const EthereumQuantitySmall = t.String.withParser(SmallIntParser)
export type EthereumQuantitySmall = t.Static<typeof EthereumQuantitySmall>

export const EthereumData = t.String.withParser(BytesParser)
export type EthereumData = t.Static<typeof EthereumData>

export const EthereumAddress = t.String.withParser(AddressParser)
export type EthereumAddress = t.Static<typeof EthereumAddress>

export const EthereumBytes32 = t.String.withParser(Bytes32Parser)
export type EthereumBytes32 = t.Static<typeof EthereumBytes32>

export const EthereumBytes256 = t.String.withParser(Bytes256Parser)
export type EthereumBytes256 = t.Static<typeof EthereumBytes256>

export const EthereumTimestamp = t.String.withParser(TimestampParser)
export type EthereumTimestamp = t.Static<typeof EthereumTimestamp>

export const EthereumBlockTag = t.Union(EthereumQuantitySmall, EthereumBytes32, t.Literal('latest'), t.Literal('pending'))
export type EthereumBlockTag = t.Static<typeof EthereumBlockTag>

export const EthereumInput = t.Union(t.String, t.Undefined).withParser(OptionalBytesParser)
export type EthereumInput = t.Static<typeof EthereumInput>

export const EthereumAccessList = t.ReadonlyArray(
	t.Object({
		address: EthereumAddress,
		storageKeys: t.ReadonlyArray(EthereumBytes32)
	}).asReadonly()
)
export type EthereumAccessList = t.Static<typeof EthereumAccessList>

export type EthereumUnsignedTransactionLegacy = t.Static<typeof EthereumUnsignedTransactionLegacy>
export const EthereumUnsignedTransactionLegacy = t.Intersect(
	t.Object({
		type: t.Union(t.Literal('0x0').withParser(LiteralConverterParserFactory('0x0', 'legacy' as const)), t.Literal(undefined).withParser(LiteralConverterParserFactory(undefined, 'legacy' as const))),
		from: EthereumAddress,
		nonce: EthereumQuantity,
		gasPrice: EthereumQuantity,
		gas: EthereumQuantity,
		to: t.Union(EthereumAddress, t.Null),
		value: EthereumQuantity,
		input: EthereumInput,
	}).asReadonly(),
	t.Partial({
		chainId: EthereumQuantity,
	}).asReadonly()
)

export type EthereumUnsignedTransaction2930 = t.Static<typeof EthereumUnsignedTransaction2930>
export const EthereumUnsignedTransaction2930 = t.Intersect(
	t.Object({
		type: t.Literal('0x1').withParser(LiteralConverterParserFactory('0x1', '2930' as const)),
		from: EthereumAddress,
		nonce: EthereumQuantity,
		gasPrice: EthereumQuantity,
		gas: EthereumQuantity,
		to: t.Union(EthereumAddress, t.Null),
		value: EthereumQuantity,
		input: EthereumInput,
		chainId: EthereumQuantity,
	}).asReadonly(),
	t.Partial({
		accessList: EthereumAccessList,
	}),
)

export type EthereumUnsignedTransaction1559 = t.Static<typeof EthereumUnsignedTransaction1559>
export const EthereumUnsignedTransaction1559 = t.Intersect(
	t.Object({
		type: t.Literal('0x2').withParser(LiteralConverterParserFactory('0x2', '1559' as const)),
		from: EthereumAddress,
		nonce: EthereumQuantity,
		maxFeePerGas: EthereumQuantity,
		maxPriorityFeePerGas: EthereumQuantity,
		gas: EthereumQuantity,
		to: t.Union(EthereumAddress, t.Null),
		value: EthereumQuantity,
		input: EthereumInput,
		chainId: EthereumQuantity,
	}).asReadonly(),
	t.Partial({
		accessList: EthereumAccessList,
	}),
)
export type EthereumUnsignedTransaction = t.Static<typeof EthereumUnsignedTransaction>
export const EthereumUnsignedTransaction = t.Union(EthereumUnsignedTransactionLegacy, EthereumUnsignedTransaction2930, EthereumUnsignedTransaction1559)

export type EthereumTransactionSignature = t.Static<typeof EthereumTransactionSignature>
export const EthereumTransactionSignature = t.Intersect(
	t.Object({
		r: EthereumQuantity,
		s: EthereumQuantity,
		hash: EthereumBytes32
	}),
	t.Union(
		t.Object({ yParity: t.Union(t.Literal('0x0').withParser(LiteralConverterParserFactory('0x0', 'even' as const)), t.Literal('0x1').withParser(LiteralConverterParserFactory('0x1', 'odd' as const))) }),
		t.Object({ v: EthereumQuantity })
	)
)

export type EthereumSignedTransactionLegacy = t.Static<typeof EthereumSignedTransactionLegacy>
export const EthereumSignedTransactionLegacy = t.Intersect(
	EthereumUnsignedTransactionLegacy,
	EthereumTransactionSignature,
)

export type EthereumSignedTransaction2930 = t.Static<typeof EthereumSignedTransaction2930>
export const EthereumSignedTransaction2930 = t.Intersect(
	EthereumUnsignedTransaction2930,
	EthereumTransactionSignature,
)

export type EthereumSignedTransaction1559 = t.Static<typeof EthereumSignedTransaction1559>
export const EthereumSignedTransaction1559 = t.Intersect(
	EthereumUnsignedTransaction1559,
	EthereumTransactionSignature,
)

export type EthereumSignedTransaction = t.Static<typeof EthereumSignedTransaction>
export const EthereumSignedTransaction = t.Union(EthereumSignedTransactionLegacy, EthereumSignedTransaction2930, EthereumSignedTransaction1559)

export type EthereumSignedTransactionWithBlockData = t.Static<typeof EthereumSignedTransactionWithBlockData>
export const EthereumSignedTransactionWithBlockData = t.Intersect(
	t.Union(
		EthereumSignedTransactionLegacy,
		EthereumSignedTransaction2930,
		t.Intersect(EthereumSignedTransaction1559, t.Object({gasPrice: EthereumQuantity})),
	),
	t.Object({
		blockHash: t.Union(EthereumBytes32, t.Null),
		blockNumber: t.Union(EthereumQuantity, t.Null),
		transactionIndex: t.Union(EthereumQuantity, t.Null)
	})
)

export type EthereumBlockHeader = t.Static<typeof EthereumBlockHeader>
export const EthereumBlockHeader = t.Object({
	difficulty: EthereumQuantity,
	extraData: EthereumData,
	gasLimit: EthereumQuantity,
	gasUsed: EthereumQuantity,
	hash: EthereumBytes32,
	logsBloom: EthereumBytes256,
	miner: EthereumAddress,
	mixHash: EthereumBytes32,
	nonce: EthereumQuantity,
	number: EthereumQuantity,
	parentHash: EthereumBytes32,
	receiptsRoot: EthereumBytes32,
	sha3Uncles: EthereumBytes32,
	stateRoot: EthereumBytes32,
	timestamp: EthereumTimestamp,
	size: EthereumQuantity,
	totalDifficulty: EthereumQuantity,
	transactions: t.ReadonlyArray(EthereumSignedTransaction),
	uncles: t.ReadonlyArray(EthereumBytes32),
	baseFeePerGas: EthereumQuantity,
	transactionsRoot: EthereumBytes32
}).asReadonly()


export const EthGetStorageAtRequestParameters = t.Readonly(t.Tuple(EthereumAddress, EthereumQuantity))
export type EthGetStorageAtRequestParameters = t.Static<typeof EthGetStorageAtRequestParameters>

export type EthGetStorageAtResponse = t.Static<typeof EthGetStorageAtResponse>
export const EthGetStorageAtResponse = t.Union(
	EthereumBytes32,
	t.String.withParser({ parse: x => x === '0x' ? { success: true, value: null } : { success: false, message: `eth_getStorageAt didn't return 32 bytes of data nor 0x.` } }),
)

export type EthGetLogsRequest = t.Static<typeof EthGetLogsRequest>
export const EthGetLogsRequest = t.Intersect(
	t.Union(
		t.Object({ blockHash: EthereumBytes32 }).asReadonly(),
		t.Object({ fromBlock: EthereumQuantity, toBlock: t.Union(EthereumQuantity, t.Literal('latest')) }).asReadonly(),
	),
	t.Partial({
		address: EthereumAddress,
		topics: t.ReadonlyArray(t.Union(EthereumBytes32, t.ReadonlyArray(EthereumBytes32))),
	}).asReadonly()
)

export type EthGetLogsResponse = t.Static<typeof EthGetLogsResponse>
export const EthGetLogsResponse = t.ReadonlyArray(
	t.Object({
		removed: t.Boolean,
		logIndex: t.Union(EthereumQuantity, t.Null),
		transactionIndex: t.Union(EthereumQuantity, t.Null),
		transactionHash: t.Union(EthereumBytes32, t.Null),
		blockHash: t.Union(EthereumBytes32, t.Null),
		blockNumber: t.Union(EthereumQuantity, t.Null),
		address: EthereumAddress,
		data: EthereumInput,
		topics: t.ReadonlyArray(EthereumBytes32),
	}).asReadonly()
)

export type EthTransactionReceiptResponse = t.Static<typeof EthTransactionReceiptResponse>
export const EthTransactionReceiptResponse = t.Union(
	t.Null,
	t.Object({
		type: t.Union(
			t.Union(t.Literal('0x0').withParser(LiteralConverterParserFactory('0x0', 'legacy' as const)), t.Literal(undefined).withParser(LiteralConverterParserFactory(undefined, 'legacy' as const))),
			t.Literal('0x0').withParser(LiteralConverterParserFactory('0x0', 'legacy' as const)),
			t.Literal('0x1').withParser(LiteralConverterParserFactory('0x1', '2930' as const)),
			t.Literal('0x2').withParser(LiteralConverterParserFactory('0x2', '1559' as const)),
		),
		blockHash: EthereumBytes32,
		blockNumber: EthereumQuantity,
		transactionHash: EthereumBytes32,
		transactionIndex: EthereumQuantity,
		contractAddress: t.Union(t.Null, EthereumAddress),
		cumulativeGasUsed: EthereumQuantity,
		gasUsed: EthereumQuantity,
		effectiveGasPrice: EthereumQuantity,
		from: EthereumAddress,
		to: t.Union(t.Null, EthereumAddress),
		logs: EthGetLogsResponse,
		logsBloom: EthereumBytes256,
		status: t.Union(
			t.Literal('0x0').withParser(LiteralConverterParserFactory('0x0', 'failure' as const)),
			t.Literal('0x1').withParser(LiteralConverterParserFactory('0x1', 'success' as const)),
		),
	}).asReadonly()
)

const RevertErrorParser: t.ParsedValue<t.String, string>['config'] = {
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

export type MulticallRequestParameters = t.Static<typeof MulticallRequestParameters>
export const MulticallRequestParameters = t.Readonly(t.Tuple(
	EthereumQuantity, // block number
	EthereumAddress, // miner
	t.ReadonlyArray(EthereumUnsignedTransaction),
))

export type MulticallResponseEventLog = t.Static<typeof MulticallResponseEventLog>
export const MulticallResponseEventLog =  t.Object({
	loggersAddress: EthereumAddress,
	data: EthereumInput,
	topics: t.ReadonlyArray(EthereumBytes32),
}).asReadonly()

export type MulticallResponseEventLogs = t.Static<typeof MulticallResponseEventLogs>
export const MulticallResponseEventLogs = t.ReadonlyArray(MulticallResponseEventLog)

export type EthBalanceChanges = t.Static<typeof EthBalanceChanges>
export const EthBalanceChanges = t.ReadonlyArray(
	t.Object({
		address: EthereumAddress,
		before: EthereumQuantity,
		after: EthereumQuantity,
	}).asReadonly()
)

export type SingleMulticallResponse = t.Static<typeof SingleMulticallResponse>
export const SingleMulticallResponse = t.Union(
	t.Object({
		statusCode: t.Literal(1).withParser(LiteralConverterParserFactory(1, 'success' as const)),
		gasSpent: EthereumQuantity,
		returnValue: EthereumData,
		events: MulticallResponseEventLogs,
		balanceChanges: EthBalanceChanges,
	}).asReadonly(),
	t.Object({
		statusCode: t.Literal(0).withParser(LiteralConverterParserFactory(0, 'failure' as const)),
		gasSpent: EthereumQuantity,
		error: t.String.withParser(RevertErrorParser),
		returnValue: EthereumData,
	}).asReadonly(),
)

export type MulticallResponse = t.Static<typeof MulticallResponse>
export const MulticallResponse = t.ReadonlyArray(SingleMulticallResponse)

//
// Token Lists
//

export type TokenListResponse = t.Static<typeof TokenListResponse>
export const TokenListResponse = t.Object({tokens: t.ReadonlyArray(t.Object({
	address: EthereumAddress,
	name: t.String,
	symbol: t.String,
	decimals: t.Number,
	logoUri: t.Union(t.String, t.Undefined),
}).asReadonly())}).asReadonly()

//
// NFT Data
//

export type NFTDataResponse = t.Static<typeof NFTDataResponse>
export const NFTDataResponse = t.Object({
	address: EthereumAddress,
	name: t.String,
	symbol: t.String,
	image_url: t.String,
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

export function serialize<T, U extends t.Codec<T>>(funtype: U, value: T) {
	return funtype.serialize(value) as ToWireType<U>
}

export type ToWireType<T> =
	T extends t.Intersect<infer U> ? UnionToIntersection<{ [I in keyof U]: ToWireType<U[I]> }[number]>
	: T extends t.Union<infer U> ? { [I in keyof U]: ToWireType<U[I]> }[number]
	: T extends t.Record<infer U, infer V> ? Record<t.Static<U>, ToWireType<V>>
	: T extends t.Partial<infer U, infer V> ? V extends true ? { readonly [K in keyof U]?: ToWireType<U[K]> } : { [K in keyof U]?: ToWireType<U[K]> }
	: T extends t.Object<infer U, infer V> ? V extends true ? { readonly [K in keyof U]: ToWireType<U[K]> } : { [K in keyof U]: ToWireType<U[K]> }
	: T extends t.Readonly<t.Tuple<infer U>> ? { readonly [P in keyof U]: ToWireType<U[P]>}
	: T extends t.Tuple<infer U> ? { [P in keyof U]: ToWireType<U[P]>}
	: T extends t.ReadonlyArray<infer U> ? readonly ToWireType<U>[]
	: T extends t.Array<infer U> ? ToWireType<U>[]
	: T extends t.ParsedValue<infer U, infer _> ? ToWireType<U>
	: T extends t.Codec<infer U> ? U
	: never


export type DappRequestTransaction = t.Static<typeof DappRequestTransaction>
export const DappRequestTransaction = t.Intersect(
	t.Object({
		from: EthereumAddress,
		data: EthereumData,
	}).asReadonly(),
	t.Partial({
		gas: EthereumQuantity,
		value: EthereumQuantity,
		to: EthereumAddress,
		maxPriorityFeePerGas: EthereumQuantity,
		maxFeePerGas: EthereumQuantity
	}).asReadonly()
)

export type EthereumBlockHeaderWithTransactionHashes = t.Static<typeof EthereumBlockHeaderWithTransactionHashes>
export const EthereumBlockHeaderWithTransactionHashes = t.Object({
	difficulty: EthereumQuantity,
	extraData: EthereumData,
	gasLimit: EthereumQuantity,
	gasUsed: EthereumQuantity,
	hash: EthereumBytes32,
	logsBloom: EthereumBytes256,
	miner: EthereumAddress,
	mixHash: EthereumBytes32,
	nonce: EthereumQuantity,
	number: EthereumQuantity,
	parentHash: EthereumBytes32,
	receiptsRoot: EthereumBytes32,
	sha3Uncles: EthereumBytes32,
	stateRoot: EthereumBytes32,
	timestamp: EthereumTimestamp,
	size: EthereumQuantity,
	totalDifficulty: EthereumQuantity,
	transactions: t.ReadonlyArray(EthereumBytes32),
	uncles: t.ReadonlyArray(EthereumBytes32),
	baseFeePerGas: EthereumQuantity,
	transactionsRoot: EthereumBytes32
}).asReadonly()

export type GetBlockReturn = t.Static<typeof GetBlockReturn>
export const GetBlockReturn = t.Union(EthereumBlockHeader, EthereumBlockHeaderWithTransactionHashes)

export const NewHeadsSubscriptionData = t.Object({
	subscription: t.String,
	result: EthereumBlockHeaderWithTransactionHashes
}).asReadonly()

export type JsonRpcNewHeadsNotification = t.Static<typeof JsonRpcNewHeadsNotification>
export const JsonRpcNewHeadsNotification = t.Object({
	jsonrpc: t.Literal('2.0'),
	method: t.String,
	params: NewHeadsSubscriptionData
}).asReadonly()

export type JsonSubscriptionNotification = t.Static<typeof JsonSubscriptionNotification>
export const JsonSubscriptionNotification = t.Object({
	jsonrpc: t.Literal('2.0'),
	method: t.Literal('eth_subscription'),
	params: t.Object({
		result: t.Union(EthereumBlockHeader, EthereumBytes32),
		subscription: t.String
	}).asReadonly()
}).asReadonly()

export type JsonRpcSuccessResponse = t.Static<typeof JsonRpcSuccessResponse>
export const JsonRpcSuccessResponse = t.Object({
	jsonrpc: t.Literal('2.0'),
	id: t.Union(t.String, t.Number),
	result: t.Unknown,
}).asReadonly()

export type JsonRpcErrorResponse = t.Static<typeof JsonRpcErrorResponse>
export const JsonRpcErrorResponse = t.Object({
	jsonrpc: t.Literal('2.0'),
	id: t.Union(t.String, t.Number),
	error: t.Object({
		code: t.Number,
		message: t.String,
		data: t.Unknown,
	}).asReadonly(),
}).asReadonly()


export type JsonRpcNotification = t.Static<typeof JsonRpcNotification>
export const JsonRpcNotification = t.Union(JsonRpcNewHeadsNotification, JsonSubscriptionNotification)

export type JsonRpcRequest = t.Static<typeof JsonRpcRequest>
export const JsonRpcRequest = t.Object({
	jsonrpc: t.Literal('2.0'),
	id: t.Union(t.String, t.Number),
	method: t.String,
	params: t.Union(t.ReadonlyArray(t.Unknown), t.Literal(undefined).withParser(LiteralConverterParserFactory(undefined, [])))
})

export type JsonRpcResponse = t.Static<typeof JsonRpcResponse>
export const JsonRpcResponse = t.Union(JsonRpcErrorResponse, JsonRpcSuccessResponse)

export type JsonRpcMessage = t.Static<typeof JsonRpcMessage>
export const JsonRpcMessage = t.Union(JsonRpcResponse, JsonRpcNotification, JsonRpcRequest)

export type EthCallParams = t.Static<typeof EthCallParams>
export const EthCallParams = t.Object({
	method: t.Literal('eth_call'),
	params: t.Tuple(
		t.Object({
			data: EthereumData,
			to: EthereumAddress,
		}),
		EthereumBlockTag
	)
}).asReadonly()

export type TransactionByHashParams = t.Static<typeof TransactionByHashParams>
export const TransactionByHashParams = t.Object({
	method: t.Literal('eth_getTransactionByHash'),
	params: t.Tuple(EthereumBytes32)
})

export type SendTransactionParams = t.Static<typeof SendTransactionParams>
export const SendTransactionParams = t.Object({
	method: t.Literal('eth_sendTransaction'),
	params: t.Tuple(DappRequestTransaction)
})


export type EthereumAccountsReply = t.Static<typeof EthereumAccountsReply>
export const EthereumAccountsReply = t.ReadonlyArray(EthereumAddress)

export type EthereumChainReply = t.Static<typeof EthereumChainReply>
export const EthereumChainReply = t.ReadonlyArray(EthereumQuantity)

export type TransactionReceiptParams = t.Static<typeof TransactionReceiptParams>
export const TransactionReceiptParams = t.Object({
	method: t.Literal('eth_getTransactionReceipt'),
	params: t.Tuple(EthereumBytes32)
})

export type EstimateGasParamsVariables = t.Static<typeof EstimateGasParamsVariables>
export const EstimateGasParamsVariables = t.Intersect(
	t.Object({
		to: EthereumAddress
	}),
	t.Partial({
		from: EthereumAddress,
		data: EthereumData,
		value: EthereumQuantity,
		gasPrice: EthereumQuantity,
		gas: EthereumQuantity
	})
)

export type EstimateGasParams = t.Static<typeof EstimateGasParams>
export const EstimateGasParams = t.Object({
	method: t.Literal('eth_estimateGas'),
	params: t.Union(t.Tuple(EstimateGasParamsVariables), t.Tuple(EstimateGasParamsVariables, EthereumBlockTag))
})

export type EthBalanceParams = t.Static<typeof EthBalanceParams>
export const EthBalanceParams = t.Object({
	method: t.Literal('eth_getBalance'),
	params: t.Tuple(EthereumAddress, EthereumBlockTag)
})

export type EthBlockByNumberParams = t.Static<typeof EthBlockByNumberParams>
export const EthBlockByNumberParams = t.Object({
	method: t.Literal('eth_getBlockByNumber'),
	params: t.Tuple(EthereumBlockTag, t.Boolean)
})

export type EthSubscribeParams = t.Static<typeof EthSubscribeParams>
export const EthSubscribeParams = t.Object({
	method: t.Literal('eth_subscribe'),
	params: t.Tuple(t.Union(t.Literal('newHeads'), t.Literal('logs'), t.Literal('newPendingTransactions'), t.Literal('syncing')))
})

export type EthUnSubscribeParams = t.Static<typeof EthUnSubscribeParams>
export const EthUnSubscribeParams = t.Object({
	method: t.Literal('eth_unsubscribe'),
	params: t.Tuple(t.String)
})

export const EthSubscriptionResponse = t.String
export type EthSubscriptionResponse = t.Static<typeof EthSubscriptionResponse>

export type PersonalSignParams = t.Static<typeof PersonalSignParams>
export const PersonalSignParams = t.Object({
	method: t.Literal('personal_sign'),
	params: t.Union(
		t.Tuple(t.String, EthereumAddress, t.Union(t.String, t.Undefined)), // message, account, password
		t.Tuple(t.String, EthereumAddress) // message, account
	)
})

export type EIP712Message = t.Static<typeof EIP712Message>
export const EIP712Message = t.Object({
	types: t.Record(t.String, t.ReadonlyArray(
		t.Object({
			name: t.String,
			type: t.String,
		})
	)),
	primaryType: t.String,
	domain: t.Record(t.String, t.String),
	message: t.Record(t.String, t.Union(t.Record(t.String, t.String), t.String)),
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

const EIP712MessageParser: t.ParsedValue<t.String, EIP712Message>['config'] = {
	parse: value => {
		if (!isJSON(value) || !EIP712Message.test(JSON.parse(value))) return { success: false, message: `${ value } is not EIP712 message` }
		else return { success: true, value: EIP712Message.parse(JSON.parse(value)) }
	},
	serialize: value => {
		if (!EIP712Message.test(value)) return { success: false, message: `${ value } is not a EIP712 mmessage.`}
		return { success: true, value: EIP712Message.serialize(value) as string }
	},
}

export type SignTypedDataParams = t.Static<typeof SignTypedDataParams>
export const SignTypedDataParams = t.Object({
	method: t.Union(
		t.Literal('eth_signTypedData'),
		t.Literal('eth_signTypedData_v1'),
		t.Literal('eth_signTypedData_v2'),
		t.Literal('eth_signTypedData_v3'),
		t.Literal('eth_signTypedData_v4'),
	),
	params: t.Tuple(EthereumAddress, t.String.withParser(EIP712MessageParser)), // address that will sign the message, typed data
})

export type SwitchEthereumChainParams = t.Static<typeof SwitchEthereumChainParams>
export const SwitchEthereumChainParams = t.Object({
	method: t.Literal('wallet_switchEthereumChain'),
	params: t.Tuple(t.Object({
		chainId: EthereumQuantity
	}).asReadonly()),
}).asReadonly()

export type GetCode = t.Static<typeof GetCode>
export const GetCode = t.Object({
	method: t.Literal('eth_getCode'),
	params: t.Tuple(EthereumAddress, EthereumBlockTag)
}).asReadonly()

export type RequestPermissions = t.Static<typeof RequestPermissions>
export const RequestPermissions = t.Object({
	method: t.Literal('wallet_requestPermissions'),
	params: t.Tuple( t.Object({ eth_accounts: t.Object({ }) }) )
}).asReadonly()

const BigIntParserNonHex: t.ParsedValue<t.String, bigint>['config'] = {
	parse: value => {
		if (!/^[0-9]+$/.test(value)) return { success: false, message: `${ value } is not a string encoded number.` }
		else return { success: true, value: BigInt(value) }
	},
	serialize: value => {
		if (typeof value !== 'bigint') return { success: false, message: `${ typeof value } is not a bigint.`}
		return { success: true, value: `${ value.toString() }` }
	},
}

export const NonHexBigInt = t.String.withParser(BigIntParserNonHex)
export type NonHexBigInt = t.Static<typeof NonHexBigInt>

export type EIP2612Message = t.Static<typeof EIP2612Message>
export const EIP2612Message = t.Object({
	types: t.Object({
		EIP712Domain: t.Tuple(
			t.Object({
				name: t.Literal('name'),
				type: t.Literal('string'),
			}),
			t.Object({
				name: t.Literal('version'),
				type: t.Literal('string'),
			}),
			t.Object({
				name: t.Literal('chainId'),
				type: t.Literal('uint256'),
			}),
			t.Object({
				name: t.Literal('verifyingContract'),
				type: t.Literal('address'),
			}),
		),
		Permit: t.Tuple(
			t.Object({
				name: t.Literal('owner'),
				type: t.Literal('address'),
			}),
			t.Object({
				name: t.Literal('spender'),
				type: t.Literal('address'),
			}),
			t.Object({
				name: t.Literal('value'),
				type: t.Literal('uint256'),
			}),
			t.Object({
				name: t.Literal('nonce'),
				type: t.Literal('uint256'),
			}),
			t.Object({
				name: t.Literal('deadline'),
				type: t.Literal('uint256'),
			}),
		),
	}),
	primaryType: t.Literal('Permit'),
	domain: t.Object({
		name: t.String,
		version: NonHexBigInt,
		chainId: t.Number,
		verifyingContract: EthereumAddress,
	}),
	message: t.Object({
		owner: EthereumAddress,
		spender: EthereumAddress,
		value: NonHexBigInt,
		nonce: t.Number,
		deadline: t.Number,
	}),
})

export type GetTransactionCount = t.Static<typeof GetTransactionCount>
export const GetTransactionCount = t.Object({
	method: t.Literal('eth_getTransactionCount'),
	params: t.Tuple(EthereumAddress, EthereumBlockTag)
}).asReadonly()

export type GetSimulationStackReply = t.Static<typeof GetSimulationStackReply>
export const GetSimulationStackReply = t.ReadonlyArray(t.Intersect(
	EthereumUnsignedTransaction,
	SingleMulticallResponse,
	t.Object({
		realizedGasPrice: EthereumQuantity,
		gasLimit: EthereumQuantity,
	}).asReadonly(),
))

export type GetSimulationStack = t.Static<typeof GetSimulationStack>
export const GetSimulationStack = t.Object({
	method: t.Literal('interceptor_getSimulationStack'),
	params: t.Tuple(t.Literal('1.0.0')),
}).asReadonly()

export type SupportedETHRPCCall = t.Static<typeof SupportedETHRPCCall>
export const SupportedETHRPCCall = t.Union(
	EthBlockByNumberParams,
	EthBalanceParams,
	EstimateGasParams,
	TransactionByHashParams,
	TransactionReceiptParams,
	SendTransactionParams,
	EthCallParams,
	EthSubscribeParams,
	EthUnSubscribeParams,
	t.Object({ method: t.Literal('eth_blockNumber') }),
	t.Object({ method: t.Literal('eth_chainId') }),
	t.Object({ method: t.Literal('net_version') }),
	GetCode,
	PersonalSignParams,
	SignTypedDataParams,
	SwitchEthereumChainParams,
	RequestPermissions,
	t.Object({ method: t.Literal('wallet_getPermissions') }),
	t.Object({ method: t.Literal('eth_accounts') }),
	t.Object({ method: t.Literal('eth_requestAccounts') }),
	t.Object({ method: t.Literal('eth_gasPrice') }),
	GetTransactionCount,
	GetSimulationStack,
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

export type Permit2 = t.Static<typeof Permit2>
export const Permit2 = t.Object({
	types: t.Object({
		PermitSingle: t.Tuple(
			t.Object({
				name: t.Literal('details'),
				type: t.Literal('PermitDetails'),
			}),
			t.Object({
				name: t.Literal('spender'),
				type: t.Literal('address'),
			}),
			t.Object({
				name: t.Literal('sigDeadline'),
				type: t.Literal('uint256'),
			}),
		),
		PermitDetails: t.Tuple(
			t.Object({
				name: t.Literal('token'),
				type: t.Literal('address'),
			}),
			t.Object({
				name: t.Literal('amount'),
				type: t.Literal('uint160'),
			}),
			t.Object({
				name: t.Literal('expiration'),
				type: t.Literal('uint48'),
			}),
			t.Object({
				name: t.Literal('nonce'),
				type: t.Literal('uint48'),
			}),
		),
		EIP712Domain: t.Tuple(
			t.Object({
				name: t.Literal('name'),
				type: t.Literal('string'),
			}),
			t.Object({
				name: t.Literal('chainId'),
				type: t.Literal('uint256'),
			}),
			t.Object({
				name: t.Literal('verifyingContract'),
				type: t.Literal('address'),
			}),
		)
	}),
	domain: t.Object({
		name: t.Literal('Permit2'),
		chainId: NonHexBigInt,
		verifyingContract: EthereumAddress,
	}),
	primaryType: t.Literal('PermitSingle'),
	message: t.Object({
		details: t.Object({
			token: EthereumAddress,
			amount: NonHexBigInt,
			expiration: NonHexBigInt,
			nonce: NonHexBigInt,
		}),
		spender: EthereumAddress,
		sigDeadline: NonHexBigInt,
	})
})
