import { ErrorWithCodeAndOptionalData } from './error.js'
import {
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

const signedTransactionSignatureFields = [
	EthereumTransaction2930And1559And4844SignatureFields,
	EthereumSignatureParityFields,
	EthereumTypedTransactionVFields,
]

function validateRequestObjectShape(value: unknown) {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return { success: true as const, value }
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key === 'symbol') return { success: false as const, message: `Additional property ${ String(key) } must not be present.` }
		if (!Object.prototype.propertyIsEnumerable.call(value, key)) return { success: false as const, message: `Additional property ${ key } must not be present.` }
	}
	return { success: true as const, value }
}

function validateRequestArrayShape(value: unknown) {
	if (!Array.isArray(value)) return { success: true as const, value }
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key === 'symbol') return { success: false as const, message: `Additional property ${ String(key) } must not be present.` }
		if (key === 'length') continue
		if (!Object.prototype.propertyIsEnumerable.call(value, key)) return { success: false as const, message: `Additional property ${ key } must not be present.` }
		if (!/^(0|[1-9]\d*)$/.test(key)) return { success: false as const, message: `Additional property ${ key } must not be present.` }
	}
	return { success: true as const, value }
}

const EthSimulateV1RequestObject = funtypes.Unknown.withParser({
	parse: validateRequestObjectShape,
	serialize: validateRequestObjectShape,
})

const EthSimulateV1RequestArray = funtypes.Unknown.withParser({
	parse: validateRequestArrayShape,
	serialize: validateRequestArrayShape,
})

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

type FieldSet = Readonly<Record<string, unknown>>

const accountOverrideFields = {
	state: funtypes.Intersect(EthSimulateV1RequestObject, funtypes.ReadonlyRecord(funtypes.String, EthereumBytes32)),
	stateDiff: funtypes.Intersect(EthSimulateV1RequestObject, funtypes.ReadonlyRecord(funtypes.String, EthereumBytes32)),
	nonce: EthereumQuantitySmall,
	balance: EthereumQuantity,
	code: EthereumData,
	movePrecompileToAddress: EthereumAddress,
}

const EthSimulateV1AdditionalProperties = (...knownFieldSets: readonly FieldSet[]) => {
	const knownKeySet = new Set(knownFieldSets.flatMap(Object.keys))
	return funtypes.Unknown.withParser({
		parse: (value) => validateAdditionalProperties(value, knownKeySet),
		serialize: (value) => validateAdditionalProperties(value, knownKeySet),
	})
}

type AccountOverride = funtypes.Static<typeof AccountOverride>
const AccountOverride = funtypes.Intersect(
	EthSimulateV1RequestObject,
	funtypes.Sealed(funtypes.ReadonlyPartial(accountOverrideFields), { deep: true }),
)

const blockOverridesFields = {
	number: EthereumQuantity,
	prevRandao: EthereumBytes32,
	time: EthereumTimestamp,
	gasLimit: EthereumQuantitySmall,
	feeRecipient: EthereumAddress,
	baseFeePerGas: EthereumQuantity,
	blobBaseFee: EthereumQuantity,
}
export type BlockOverrides = funtypes.Static<typeof BlockOverrides>
export const BlockOverrides = funtypes.Intersect(
	EthSimulateV1RequestObject,
	funtypes.Sealed(funtypes.Partial(blockOverridesFields).asReadonly(), { deep: true }),
)

type BlockCall = funtypes.Static<typeof BlockCall>
const blockCallLegacyTypeFields = {
	type: funtypes.Literal('0x0').withParser(LiteralConverterParserFactory('0x0', 'legacy' as const)),
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
	accessList: funtypes.Intersect(EthSimulateV1RequestArray, funtypes.ReadonlyArray(funtypes.Intersect(
		EthSimulateV1RequestObject,
		funtypes.Sealed(funtypes.ReadonlyObject({
			address: EthereumAddress,
			storageKeys: funtypes.Intersect(EthSimulateV1RequestArray, funtypes.ReadonlyArray(EthereumBytes32)),
		}), { deep: true }),
	))),
}
const blockCallBlobFields = {
	maxFeePerBlobGas: EthereumQuantity,
	blobVersionedHashes: funtypes.Intersect(EthSimulateV1RequestArray, funtypes.ReadonlyArray(EthereumBytes32)),
	blobs: funtypes.Intersect(EthSimulateV1RequestArray, funtypes.ReadonlyArray(EthereumData)),
}
const blockCallSignatureFields = {
	r: EthereumQuantity,
	s: EthereumQuantity,
	v: EthereumQuantity,
	yParity: EthereumSignatureParity,
}
const blockCallAuthorizationListFields = {
	authorizationList: funtypes.Intersect(EthSimulateV1RequestArray, funtypes.ReadonlyArray(funtypes.Intersect(
		EthSimulateV1RequestObject,
		funtypes.Sealed(funtypes.Intersect(
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
		), { deep: true }),
	)))
}

const BlockCall = funtypes.Union(
	funtypes.Intersect(
		EthSimulateV1RequestObject,
		funtypes.Sealed(funtypes.Intersect(
			funtypes.Partial(blockCallCommonFields),
			funtypes.Partial(blockCallGasPriceFields),
			funtypes.Partial(blockCallFeeMarketFields),
			funtypes.Partial(blockCallAccessListFields),
			funtypes.Partial(blockCallBlobFields),
			funtypes.Partial(blockCallAuthorizationListFields),
			funtypes.Partial(blockCallSignatureFields),
		), { deep: true }),
	),
	funtypes.Intersect(
		EthSimulateV1RequestObject,
		funtypes.Sealed(funtypes.Intersect(
			funtypes.ReadonlyObject(blockCallLegacyTypeFields),
			funtypes.Partial(blockCallCommonFields),
			funtypes.Partial(blockCallGasPriceFields),
			funtypes.Partial(blockCallSignatureFields),
		), { deep: true }),
	),
	funtypes.Intersect(
		EthSimulateV1RequestObject,
		funtypes.Sealed(funtypes.Intersect(
			funtypes.ReadonlyObject(blockCall2930TypeFields),
			funtypes.Partial(blockCallCommonFields),
			funtypes.Partial(blockCallGasPriceFields),
			funtypes.Partial(blockCallAccessListFields),
			funtypes.Partial(blockCallSignatureFields),
		), { deep: true }),
	),
	funtypes.Intersect(
		EthSimulateV1RequestObject,
		funtypes.Sealed(funtypes.Intersect(
			funtypes.ReadonlyObject(blockCall1559TypeFields),
			funtypes.Partial(blockCallCommonFields),
			funtypes.Partial(blockCallFeeMarketFields),
			funtypes.Partial(blockCallAccessListFields),
			funtypes.Partial(blockCallSignatureFields),
		), { deep: true }),
	),
	funtypes.Intersect(
		EthSimulateV1RequestObject,
		funtypes.Sealed(funtypes.Intersect(
			funtypes.ReadonlyObject(blockCall4844TypeFields),
			funtypes.Partial(blockCallCommonFields),
			funtypes.Partial(blockCallFeeMarketFields),
			funtypes.Partial(blockCallAccessListFields),
			funtypes.Partial(blockCallBlobFields),
			funtypes.Partial(blockCallSignatureFields),
		), { deep: true }),
	),
	funtypes.Intersect(
		EthSimulateV1RequestObject,
		funtypes.Sealed(funtypes.Intersect(
			funtypes.ReadonlyObject(blockCall7702TypeFields),
			funtypes.Partial(blockCallCommonFields),
			funtypes.Partial(blockCallFeeMarketFields),
			funtypes.Partial(blockCallAccessListFields),
			funtypes.Partial(blockCallAuthorizationListFields),
			funtypes.Partial(blockCallSignatureFields),
		), { deep: true }),
	)
)

export type StateOverrides = funtypes.Static<typeof StateOverrides>
export const StateOverrides = funtypes.Intersect(EthSimulateV1RequestObject, funtypes.ReadonlyRecord(funtypes.String, AccountOverride))

export type MutableStateOverrides = funtypes.Static<typeof MutableStateOverrides>
export const MutableStateOverrides = funtypes.Intersect(EthSimulateV1RequestObject, funtypes.Record(funtypes.String, AccountOverride))

export type BlockCalls = funtypes.Static<typeof BlockCalls>
const blockCallsFields = {
	calls: funtypes.Intersect(EthSimulateV1RequestArray, funtypes.ReadonlyArray(BlockCall)),
}
const blockCallsOptionalFields = {
	stateOverrides: StateOverrides,
	blockOverrides: BlockOverrides,
}
export const BlockCalls = funtypes.Intersect(
	EthSimulateV1RequestObject,
	funtypes.Sealed(funtypes.Intersect(
		funtypes.ReadonlyObject(blockCallsFields),
		funtypes.ReadonlyPartial(blockCallsOptionalFields),
	), { deep: true }),
)

type EthSimulateV1ParamObject = funtypes.Static<typeof EthSimulateV1ParamObject>
const ethSimulateV1ParamObjectFields = {
	blockStateCalls: funtypes.Intersect(EthSimulateV1RequestArray, funtypes.ReadonlyArray(BlockCalls)),
}
const ethSimulateV1ParamObjectOptionalFields = {
	traceTransfers: funtypes.Boolean,
	validation: funtypes.Boolean,
	returnFullTransactions: funtypes.Boolean,
}
const EthSimulateV1ParamObject = funtypes.Intersect(
	EthSimulateV1RequestObject,
	funtypes.Sealed(funtypes.Intersect(
		funtypes.ReadonlyObject(ethSimulateV1ParamObjectFields),
		funtypes.ReadonlyPartial(ethSimulateV1ParamObjectOptionalFields),
	), { deep: true }),
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
	EthSimulateV1AdditionalProperties(ethSimulateCallResultFailureFields, ethSimulateCallResultOptionalFields),
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
	EthSimulateV1AdditionalProperties(ethSimulateCallResultSuccessFields, ethSimulateCallResultOptionalFields),
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

// These response-side transaction branches intentionally mirror the handled
// block transaction variants from wire-types so eth_simulateV1 can enforce the
// same branch-specific field knowledge while still validating extra JSON-safe
// properties on top of the parsed transaction shape.
const EthSimulateV1LegacyBlockHeaderTransaction = funtypes.Intersect(
	EthSimulateV1AdditionalProperties(
		EthereumUnsignedTransactionLegacyFields,
		EthereumUnsignedTransactionLegacyOptionalFields,
		MessageSignatureFields,
		EthereumSignatureParityFields,
		EthereumSignedTransactionWithBlockReferenceFields,
	),
	EthereumSignedTransactionLegacy,
	funtypes.ReadonlyPartial(EthereumSignedTransactionWithBlockReferenceFields),
)

const EthSimulateV1AccessListBlockHeaderTransaction = funtypes.Intersect(
	EthSimulateV1AdditionalProperties(
		EthereumUnsignedTransaction2930Fields,
		EthereumTransactionAccessListFields,
		...signedTransactionSignatureFields,
		EthereumSignedTransactionWithBlockReferenceFields,
	),
	EthereumSignedTransaction2930,
	funtypes.ReadonlyPartial(EthereumSignedTransactionWithBlockReferenceFields),
)

const EthSimulateV1FeeMarketBlockHeaderTransaction = funtypes.Intersect(
	EthSimulateV1AdditionalProperties(
		EthereumUnsignedTransaction1559Fields,
		EthereumTransactionAccessListFields,
		...signedTransactionSignatureFields,
		EthereumSignedTransactionBlockGasPriceFields,
		EthereumSignedTransactionWithBlockReferenceFields,
	),
	EthereumSignedTransaction1559,
	funtypes.ReadonlyPartial({
		...EthereumSignedTransactionBlockGasPriceFields,
		...EthereumSignedTransactionWithBlockReferenceFields,
	}),
)

const EthSimulateV1BlobBlockHeaderTransaction = funtypes.Intersect(
	EthSimulateV1AdditionalProperties(
		EthereumUnsignedTransaction4844Fields,
		EthereumTransactionAccessListFields,
		...signedTransactionSignatureFields,
		EthereumSignedTransactionBlockGasPriceFields,
		EthereumSignedTransactionWithBlockReferenceFields,
	),
	EthereumSignedTransaction4844,
	funtypes.ReadonlyPartial({
		...EthereumSignedTransactionBlockGasPriceFields,
		...EthereumSignedTransactionWithBlockReferenceFields,
	}),
)

const EthSimulateV1AuthorizationListBlockHeaderTransaction = funtypes.Intersect(
	EthSimulateV1AdditionalProperties(
		EthereumSignedTransaction7702Fields,
		EthereumTransactionAccessListFields,
		...signedTransactionSignatureFields,
		EthereumSignedTransactionBlockGasPriceFields,
		EthereumSignedTransactionWithBlockReferenceFields,
	),
	EthereumSignedTransaction7702,
	funtypes.ReadonlyPartial({
		...EthereumSignedTransactionBlockGasPriceFields,
		...EthereumSignedTransactionWithBlockReferenceFields,
	}),
)

const EthSimulateV1OptimismDepositBlockHeaderTransaction = funtypes.Intersect(
	EthSimulateV1AdditionalProperties(
		EthereumSignedTransactionOptimismDepositFields,
		EthereumSignedTransactionWithBlockReferenceFields,
	),
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
		EthSimulateV1AdditionalProperties(ethSimulateV1UnknownTransactionTypeFields),
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

const EthSimulateV1BlockHeaderBase = funtypes.Intersect(
	funtypes.MutablePartial(ethSimulateV1BlockHeaderMutableFields),
	funtypes.ReadonlyObject(ethSimulateV1BlockHeaderFields),
	funtypes.ReadonlyPartial(ethSimulateV1BlockHeaderOptionalFields),
)

export const EthSimulateV1BlockHeader = funtypes.Intersect(
	EthSimulateV1AdditionalProperties(
		ethSimulateV1BlockHeaderMutableFields,
		ethSimulateV1BlockHeaderFields,
		ethSimulateV1BlockHeaderOptionalFields,
	),
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

const EthSimulateV1BlockResult = funtypes.Intersect(
	EthSimulateV1AdditionalProperties(
		ethSimulateV1BlockHeaderMutableFields,
		ethSimulateV1BlockHeaderFields,
		ethSimulateV1BlockHeaderOptionalFields,
		ethSimulateV1BlockResultFields,
		ethSimulateV1BlockResultOptionalFields,
	),
	EthSimulateV1BlockHeaderBase,
	funtypes.ReadonlyObject(ethSimulateV1BlockResultFields),
	funtypes.ReadonlyPartial(ethSimulateV1BlockResultOptionalFields),
)

export type EthSimulateV1Result = funtypes.Static<typeof EthSimulateV1Result>
export const EthSimulateV1Result = funtypes.ReadonlyArray(EthSimulateV1BlockResult)
