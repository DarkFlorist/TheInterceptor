import { ErrorWithCodeAndOptionalData } from './error.js'
import {
	EthereumAccessList,
	EthereumAddress,
	EthereumBytes16,
	EthereumBytes256,
	EthereumBytes32,
	EthereumData,
	EthereumInput,
	EthereumQuantity,
	EthereumQuantitySmall,
	EthereumSignatureParity,
	EthereumSignedTransaction1559,
	EthereumSignedTransaction2930,
	EthereumSignedTransactionBlockGasPriceFields,
	EthereumSignedTransaction4844,
	EthereumSignedTransaction7702,
	EthereumSignedTransaction7702Fields,
	EthereumSignedTransactionLegacy,
	EthereumSignedTransactionOptimismDeposit,
	EthereumSignatureParityFields,
	EthereumSignedTransactionOptimismDepositFields,
	EthereumSignedTransactionWithBlockReferenceFields,
	EthereumTimestamp,
	EthereumTransaction2930And1559And4844SignatureFields,
	EthereumTransactionAccessListFields,
	EthereumTypedTransactionVFields,
	EthereumUnsignedTransaction1559Fields,
	EthereumUnsignedTransaction2930Fields,
	EthereumUnsignedTransaction4844Fields,
	EthereumUnsignedTransactionLegacyFields,
	EthereumUnsignedTransactionLegacyOptionalFields,
	isUnhandledEthereumTransactionType,
	LiteralConverterParserFactory,
	MessageSignatureFields,
} from './wire-types.js'
import { isJSONEncodeable } from '../utils/json.js'
import * as funtypes from 'funtypes'

type AccountOverride = funtypes.Static<typeof AccountOverride>
const AccountOverride = funtypes.ReadonlyPartial({
	state: funtypes.ReadonlyRecord(funtypes.String, EthereumBytes32),
	stateDiff: funtypes.ReadonlyRecord(funtypes.String, EthereumBytes32),
	nonce: EthereumQuantitySmall,
	balance: EthereumQuantity,
	code: EthereumData,
	movePrecompileToAddress: EthereumAddress,
})

function knownKeysOf(...fieldSets: readonly object[]) {
	return fieldSets.flatMap(Object.keys)
}

const signedTransactionSignatureFields = [
	EthereumTransaction2930And1559And4844SignatureFields,
	EthereumSignatureParityFields,
	EthereumTypedTransactionVFields,
]

function validateAdditionalProperties(value: unknown, knownKeys: ReadonlySet<string>) {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return { success: false as const, message: 'Additional properties must be on an object.' }
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key === 'symbol') return { success: false as const, message: `Additional property ${ String(key) } must be JSON encodeable.` }
		if (knownKeys.has(key)) continue
		if (!Object.prototype.propertyIsEnumerable.call(value, key)) return { success: false as const, message: `Additional property ${ key } must be JSON encodeable.` }
		const nestedValue = Object.getOwnPropertyDescriptor(value, key)?.value
		if (!isJSONEncodeable(nestedValue)) return { success: false as const, message: `Additional property ${ key } must be JSON encodeable.` }
	}
	return { success: true as const, value }
}

const EthSimulateV1AdditionalProperties = (knownKeys: readonly string[]) => {
	const knownKeySet = new Set(knownKeys)
	return funtypes.Unknown.withParser({
		parse: (value) => validateAdditionalProperties(value, knownKeySet),
		serialize: (value) => validateAdditionalProperties(value, knownKeySet),
	})
}

export type BlockOverrides = funtypes.Static<typeof BlockOverrides>
export const BlockOverrides = funtypes.Partial({
	number: EthereumQuantity,
	prevRandao: EthereumBytes32,
	time: EthereumTimestamp,
	gasLimit: EthereumQuantitySmall,
	feeRecipient: EthereumAddress,
	baseFeePerGas: EthereumQuantity,
	blobBaseFee: EthereumQuantity,
}).asReadonly()

type BlockCall = funtypes.Static<typeof BlockCall>
const blockCallLegacyTypeFields = {
	type: funtypes.Union(
		funtypes.Literal('0x0').withParser(LiteralConverterParserFactory('0x0', 'legacy' as const)),
		funtypes.Literal(undefined).withParser(LiteralConverterParserFactory(undefined, 'legacy' as const)),
	),
}
const blockCall2930TypeFields = {
	type: funtypes.Literal('0x1').withParser(LiteralConverterParserFactory('0x1', '2930' as const)),
}
const blockCall1559TypeFields = {
	type: funtypes.Literal('0x2').withParser(LiteralConverterParserFactory('0x2', '1559' as const)),
}
const blockCall4844TypeFields = {
	type: funtypes.Literal('0x3').withParser(LiteralConverterParserFactory('0x3', '4844' as const)),
}
const blockCall7702TypeFields = {
	type: funtypes.Literal('0x4').withParser(LiteralConverterParserFactory('0x4', '7702' as const)),
}
const blockCallCommonFields = {
	from: EthereumAddress,
	nonce: EthereumQuantity,
	gas: EthereumQuantity,
	to: funtypes.Union(EthereumAddress, funtypes.Null),
	value: EthereumQuantity,
	input: EthereumInput,
	data: EthereumInput,
	chainId: EthereumQuantity,
}
const blockCallGasPriceFields = {
	gasPrice: EthereumQuantity,
}
const blockCallFeeMarketFields = {
	maxFeePerGas: EthereumQuantity,
	maxPriorityFeePerGas: EthereumQuantity,
}
const blockCallAccessListFields = {
	accessList: EthereumAccessList,
}
const blockCallBlobFields = {
	maxFeePerBlobGas: EthereumQuantity,
	blobVersionedHashes: funtypes.ReadonlyArray(EthereumBytes32),
	blobs: funtypes.ReadonlyArray(EthereumData),
}
const blockCallSignatureFields = {
	r: EthereumQuantity,
	s: EthereumQuantity,
	v: EthereumQuantity,
	yParity: EthereumSignatureParity,
}
const blockCallAuthorizationListFields = {
	authorizationList: funtypes.ReadonlyArray(funtypes.Intersect(
		funtypes.ReadonlyObject({
			chainId: EthereumQuantity,
			address: EthereumAddress,
			nonce: EthereumQuantity,
		}),
		funtypes.ReadonlyPartial({
			r: EthereumQuantity,
			s: EthereumQuantity,
			yParity: EthereumSignatureParity,
		})
	))
}

const BlockCallAdditionalProperties = (...fieldSets: readonly object[]) => EthSimulateV1AdditionalProperties(knownKeysOf(...fieldSets))

const BlockCall = funtypes.Union(
	funtypes.Intersect(
		BlockCallAdditionalProperties(blockCallLegacyTypeFields, blockCallCommonFields, blockCallGasPriceFields, blockCallSignatureFields),
		funtypes.Partial({
			...blockCallLegacyTypeFields,
			...blockCallCommonFields,
			...blockCallGasPriceFields,
			...blockCallSignatureFields,
		})
	),
	funtypes.Intersect(
		BlockCallAdditionalProperties(blockCall2930TypeFields, blockCallCommonFields, blockCallGasPriceFields, blockCallAccessListFields, blockCallSignatureFields),
		funtypes.ReadonlyObject(blockCall2930TypeFields),
		funtypes.Partial({
			...blockCallCommonFields,
			...blockCallGasPriceFields,
			...blockCallAccessListFields,
			...blockCallSignatureFields,
		})
	),
	funtypes.Intersect(
		BlockCallAdditionalProperties(blockCall1559TypeFields, blockCallCommonFields, blockCallFeeMarketFields, blockCallAccessListFields, blockCallSignatureFields),
		funtypes.ReadonlyObject(blockCall1559TypeFields),
		funtypes.Partial({
			...blockCallCommonFields,
			...blockCallFeeMarketFields,
			...blockCallAccessListFields,
			...blockCallSignatureFields,
		})
	),
	funtypes.Intersect(
		BlockCallAdditionalProperties(blockCall4844TypeFields, blockCallCommonFields, blockCallFeeMarketFields, blockCallAccessListFields, blockCallBlobFields, blockCallSignatureFields),
		funtypes.ReadonlyObject(blockCall4844TypeFields),
		funtypes.Partial({
			...blockCallCommonFields,
			...blockCallFeeMarketFields,
			...blockCallAccessListFields,
			...blockCallBlobFields,
			...blockCallSignatureFields,
		})
	),
	funtypes.Intersect(
		BlockCallAdditionalProperties(blockCall7702TypeFields, blockCallCommonFields, blockCallFeeMarketFields, blockCallAccessListFields, blockCallAuthorizationListFields, blockCallSignatureFields),
		funtypes.ReadonlyObject(blockCall7702TypeFields),
		funtypes.Partial({
			...blockCallCommonFields,
			...blockCallFeeMarketFields,
			...blockCallAccessListFields,
			...blockCallAuthorizationListFields,
			...blockCallSignatureFields,
		})
	)
)

export type StateOverrides = funtypes.Static<typeof StateOverrides>
export const StateOverrides = funtypes.ReadonlyRecord(funtypes.String, AccountOverride)

export type MutableStateOverrides = funtypes.Static<typeof MutableStateOverrides>
export const MutableStateOverrides = funtypes.Record(funtypes.String, AccountOverride)

export type BlockCalls = funtypes.Static<typeof BlockCalls>
export const BlockCalls = funtypes.Intersect(
	funtypes.ReadonlyObject({
		calls: funtypes.ReadonlyArray(BlockCall),
	}),
	funtypes.ReadonlyPartial({
		stateOverrides: StateOverrides,
		blockOverrides: BlockOverrides,
	})
)

type EthSimulateV1ParamObject = funtypes.Static<typeof EthSimulateV1ParamObject>
const EthSimulateV1ParamObject = funtypes.Intersect(
	funtypes.ReadonlyObject({
		blockStateCalls: funtypes.ReadonlyArray(BlockCalls),
	}),
	funtypes.ReadonlyPartial({
		traceTransfers: funtypes.Boolean,
		validation: funtypes.Boolean,
		returnFullTransactions: funtypes.Boolean,
	}),
)

export type EthSimulateV1Params = funtypes.Static<typeof EthSimulateV1Params>
export type EthSimulateV1BlockTag = funtypes.Static<typeof EthSimulateV1BlockTag>
export const EthSimulateV1BlockTag = funtypes.Union(
	funtypes.String.withConstraint((value) => /^0x[a-fA-F0-9]{64}$/.test(value)),
	EthereumQuantitySmall,
	funtypes.Literal('earliest'),
	funtypes.Literal('safe'),
	funtypes.Literal('latest'),
	funtypes.Literal('pending'),
	funtypes.Literal('finalized'),
)

export const EthSimulateV1Params = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_simulateV1'),
	params: funtypes.Union(
		funtypes.ReadonlyTuple(EthSimulateV1ParamObject),
		funtypes.ReadonlyTuple(EthSimulateV1ParamObject, EthSimulateV1BlockTag),
	),
})

export type EthereumEvent = funtypes.Static<typeof EthereumEvent>
export const EthereumEvent = funtypes.ReadonlyObject({
	address: EthereumAddress,
	data: EthereumInput,
	topics: funtypes.ReadonlyArray(EthereumBytes32),
}).asReadonly()

type CallResultLog = funtypes.Static<typeof CallResultLog>
const CallResultLog = funtypes.Intersect(
	EthereumEvent,
	funtypes.ReadonlyObject({
		logIndex: EthereumQuantity,
		blockHash: funtypes.Union(EthereumBytes32, funtypes.Null), // Base returns null for this at times
		blockNumber: EthereumQuantity,
	}),
	funtypes.ReadonlyPartial({ // these are not optional in the eth_simulateV1 spec, but they are not standard for logs
		transactionHash: EthereumBytes32,
		transactionIndex: EthereumQuantity,
		blockTimestamp: EthereumQuantity,
		removed: funtypes.Boolean,
	})
)

type CallResultLogs = funtypes.Static<typeof CallResultLogs>
const CallResultLogs = funtypes.ReadonlyArray(CallResultLog)

type EthSimulateCallResultFailure = funtypes.Static<typeof EthSimulateCallResultFailure>
const ethSimulateCallResultFailureFields = {
	status: funtypes.Literal('0x0').withParser(LiteralConverterParserFactory('0x0', 'failure' as const)),
	returnData: EthereumData,
	gasUsed: EthereumQuantitySmall,
	error: ErrorWithCodeAndOptionalData
}
const ethSimulateCallResultOptionalFields = {
	maxUsedGas: EthereumQuantitySmall,
}

const EthSimulateCallResultFailure = funtypes.Intersect(
	EthSimulateV1AdditionalProperties(knownKeysOf(ethSimulateCallResultFailureFields, ethSimulateCallResultOptionalFields)),
	funtypes.ReadonlyObject(ethSimulateCallResultFailureFields),
	funtypes.ReadonlyPartial(ethSimulateCallResultOptionalFields),
)

type EthSimulateCallResultSuccess = funtypes.Static<typeof EthSimulateCallResultSuccess>
const ethSimulateCallResultSuccessFields = {
	returnData: EthereumData,
	gasUsed: EthereumQuantitySmall,
	status: funtypes.Literal('0x1').withParser(LiteralConverterParserFactory('0x1', 'success' as const)),
	logs: CallResultLogs
}

const EthSimulateCallResultSuccess = funtypes.Intersect(
	EthSimulateV1AdditionalProperties(knownKeysOf(ethSimulateCallResultSuccessFields, ethSimulateCallResultOptionalFields)),
	funtypes.ReadonlyObject(ethSimulateCallResultSuccessFields),
	funtypes.ReadonlyPartial(ethSimulateCallResultOptionalFields),
)

export type EthSimulateV1CallResult = funtypes.Static<typeof EthSimulateV1CallResult>
export const EthSimulateV1CallResult = funtypes.Union(EthSimulateCallResultFailure, EthSimulateCallResultSuccess)

export type EthSimulateV1CallResults = funtypes.Static<typeof EthSimulateV1CallResults>
export const EthSimulateV1CallResults = funtypes.ReadonlyArray(EthSimulateV1CallResult)

type EthSimulateV1Withdrawal = funtypes.Static<typeof EthSimulateV1Withdrawal>
const EthSimulateV1Withdrawal = funtypes.ReadonlyObject({
	index: EthereumQuantity,
	validatorIndex: EthereumQuantity,
	address: EthereumAddress,
	amount: EthereumQuantity,
})

const ethSimulateV1UnknownTransactionTypeFields = {
	hash: EthereumBytes32,
	type: funtypes.String.withConstraint((type) => {
		return isUnhandledEthereumTransactionType(type)
	}),
}

const EthSimulateV1UnknownTransactionType = funtypes.ReadonlyObject(ethSimulateV1UnknownTransactionTypeFields)

const EthSimulateV1LegacyBlockHeaderTransaction = funtypes.Intersect(
	EthSimulateV1AdditionalProperties(knownKeysOf(
		EthereumUnsignedTransactionLegacyFields,
		EthereumUnsignedTransactionLegacyOptionalFields,
		MessageSignatureFields,
		EthereumSignatureParityFields,
		EthereumSignedTransactionWithBlockReferenceFields,
	)),
	EthereumSignedTransactionLegacy,
	funtypes.ReadonlyPartial(EthereumSignedTransactionWithBlockReferenceFields),
)

const EthSimulateV1AccessListBlockHeaderTransaction = funtypes.Intersect(
	EthSimulateV1AdditionalProperties(knownKeysOf(
		EthereumUnsignedTransaction2930Fields,
		EthereumTransactionAccessListFields,
		...signedTransactionSignatureFields,
		EthereumSignedTransactionWithBlockReferenceFields,
	)),
	EthereumSignedTransaction2930,
	funtypes.ReadonlyPartial(EthereumSignedTransactionWithBlockReferenceFields),
)

const EthSimulateV1FeeMarketBlockHeaderTransaction = funtypes.Intersect(
	EthSimulateV1AdditionalProperties(knownKeysOf(
		EthereumUnsignedTransaction1559Fields,
		EthereumTransactionAccessListFields,
		...signedTransactionSignatureFields,
		EthereumSignedTransactionBlockGasPriceFields,
		EthereumSignedTransactionWithBlockReferenceFields,
	)),
	EthereumSignedTransaction1559,
	funtypes.ReadonlyPartial({
		...EthereumSignedTransactionBlockGasPriceFields,
		...EthereumSignedTransactionWithBlockReferenceFields,
	}),
)

const EthSimulateV1BlobBlockHeaderTransaction = funtypes.Intersect(
	EthSimulateV1AdditionalProperties(knownKeysOf(
		EthereumUnsignedTransaction4844Fields,
		EthereumTransactionAccessListFields,
		...signedTransactionSignatureFields,
		EthereumSignedTransactionBlockGasPriceFields,
		EthereumSignedTransactionWithBlockReferenceFields,
	)),
	EthereumSignedTransaction4844,
	funtypes.ReadonlyPartial({
		...EthereumSignedTransactionBlockGasPriceFields,
		...EthereumSignedTransactionWithBlockReferenceFields,
	}),
)

const EthSimulateV1AuthorizationListBlockHeaderTransaction = funtypes.Intersect(
	EthSimulateV1AdditionalProperties(knownKeysOf(
		EthereumSignedTransaction7702Fields,
		EthereumTransactionAccessListFields,
		...signedTransactionSignatureFields,
		EthereumSignedTransactionBlockGasPriceFields,
		EthereumSignedTransactionWithBlockReferenceFields,
	)),
	EthereumSignedTransaction7702,
	funtypes.ReadonlyPartial({
		...EthereumSignedTransactionBlockGasPriceFields,
		...EthereumSignedTransactionWithBlockReferenceFields,
	}),
)

const EthSimulateV1OptimismDepositBlockHeaderTransaction = funtypes.Intersect(
	EthSimulateV1AdditionalProperties(knownKeysOf(
		EthereumSignedTransactionOptimismDepositFields,
		EthereumSignedTransactionWithBlockReferenceFields,
	)),
	EthereumSignedTransactionOptimismDeposit,
	funtypes.ReadonlyPartial(EthereumSignedTransactionWithBlockReferenceFields),
)

const EthSimulateV1BlockHeaderTransaction = funtypes.Union(
	EthSimulateV1LegacyBlockHeaderTransaction,
	EthSimulateV1AccessListBlockHeaderTransaction,
	EthSimulateV1FeeMarketBlockHeaderTransaction,
	EthSimulateV1BlobBlockHeaderTransaction,
	EthSimulateV1AuthorizationListBlockHeaderTransaction,
	EthSimulateV1OptimismDepositBlockHeaderTransaction,
	funtypes.Intersect(
		EthSimulateV1AdditionalProperties(knownKeysOf(ethSimulateV1UnknownTransactionTypeFields)),
		EthSimulateV1UnknownTransactionType,
	),
)

export type EthSimulateV1BlockHeader = funtypes.Static<typeof EthSimulateV1BlockHeader>
const ethSimulateV1BlockHeaderMutableFields = {
	author: EthereumAddress,
}
const ethSimulateV1BlockHeaderFields = {
	number: EthereumQuantity,
	hash: EthereumBytes32,
	timestamp: EthereumQuantity,
	gasLimit: EthereumQuantitySmall,
	gasUsed: EthereumQuantitySmall,
	baseFeePerGas: EthereumQuantity,
}
const ethSimulateV1BlockHeaderOptionalFields = {
	difficulty: EthereumQuantity,
	extraData: EthereumData,
	logsBloom: EthereumBytes256,
	miner: EthereumAddress,
	mixHash: EthereumBytes32,
	nonce: EthereumBytes16,
	parentHash: EthereumBytes32,
	receiptsRoot: EthereumBytes32,
	sha3Uncles: EthereumBytes32,
	size: EthereumQuantity,
	stateRoot: EthereumBytes32,
	transactions: funtypes.Union(funtypes.ReadonlyArray(EthereumBytes32), funtypes.ReadonlyArray(EthSimulateV1BlockHeaderTransaction)),
	transactionsRoot: EthereumBytes32,
	uncles: funtypes.ReadonlyArray(EthereumBytes32),
	excessBlobGas: EthereumQuantity,
	blobGasUsed: EthereumQuantity,
	blockAccessListHash: EthereumBytes32,
	parentBeaconBlockRoot: EthereumBytes32,
	requestsHash: EthereumBytes32,
	withdrawalsRoot: EthereumBytes32,
	withdrawals: funtypes.ReadonlyArray(EthSimulateV1Withdrawal),
	totalDifficulty: EthereumQuantity,
}
const ethSimulateV1BlockHeaderKnownKeys = knownKeysOf(
	ethSimulateV1BlockHeaderMutableFields,
	ethSimulateV1BlockHeaderFields,
	ethSimulateV1BlockHeaderOptionalFields,
)

const EthSimulateV1BlockHeaderBase = funtypes.Intersect(
	funtypes.MutablePartial(ethSimulateV1BlockHeaderMutableFields),
	funtypes.ReadonlyObject(ethSimulateV1BlockHeaderFields),
	funtypes.ReadonlyPartial(ethSimulateV1BlockHeaderOptionalFields),
)

export const EthSimulateV1BlockHeader = funtypes.Intersect(
	EthSimulateV1AdditionalProperties(ethSimulateV1BlockHeaderKnownKeys),
	EthSimulateV1BlockHeaderBase,
)

type EthSimulateV1BlockResult = funtypes.Static<typeof EthSimulateV1BlockResult>
const ethSimulateV1BlockResultFields = {
	number: EthereumQuantity,
	hash: EthereumBytes32,
	timestamp: EthereumQuantity,
	gasLimit: EthereumQuantitySmall,
	gasUsed: EthereumQuantitySmall,
	baseFeePerGas: EthereumQuantity,
	calls: EthSimulateV1CallResults,
}
const ethSimulateV1BlockResultOptionalFields = {
	transactions: funtypes.Union(funtypes.ReadonlyArray(EthereumBytes32), funtypes.ReadonlyArray(EthSimulateV1BlockHeaderTransaction)),
}
const ethSimulateV1BlockResultKnownKeys = [
	...ethSimulateV1BlockHeaderKnownKeys,
	...knownKeysOf(ethSimulateV1BlockResultFields, ethSimulateV1BlockResultOptionalFields),
]

const EthSimulateV1BlockResult = funtypes.Intersect(
	EthSimulateV1AdditionalProperties(ethSimulateV1BlockResultKnownKeys),
	EthSimulateV1BlockHeaderBase,
	funtypes.ReadonlyObject(ethSimulateV1BlockResultFields),
	funtypes.ReadonlyPartial(ethSimulateV1BlockResultOptionalFields),
)

export type EthSimulateV1Result = funtypes.Static<typeof EthSimulateV1Result>
export const EthSimulateV1Result = funtypes.ReadonlyArray(EthSimulateV1BlockResult)
