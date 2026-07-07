import { ErrorWithCodeAndOptionalData } from './error.js'
import { EthereumAccessList, EthereumAddress, EthereumBytes16, EthereumBytes256, EthereumBytes32, EthereumData, EthereumInput, EthereumQuantity, EthereumQuantitySmall, EthereumSignatureParity, EthereumSignedTransaction, EthereumTimestamp, LiteralConverterParserFactory } from './wire-types.js'
import { getInvalidJSONEncodeableValuePath } from '../utils/json.js'
import { isHexEncodedNumber } from '../utils/bigint.js'
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

const blockCallKeys = [
	'type', 'from', 'nonce', 'maxFeePerGas', 'maxPriorityFeePerGas', 'maxFeePerBlobGas',
	'gasPrice', 'gas', 'to', 'value', 'input', 'data', 'chainId', 'accessList',
	'blobVersionedHashes', 'blobs', 'r', 's', 'v', 'yParity', 'authorizationList',
] as const

const failedCallResultKeys = ['status', 'returnData', 'gasUsed', 'error', 'maxUsedGas'] as const

const successfulCallResultKeys = ['status', 'returnData', 'gasUsed', 'logs', 'maxUsedGas'] as const

const blockResultKeys = [
	'author', 'number', 'hash', 'timestamp', 'gasLimit', 'gasUsed', 'baseFeePerGas',
	'difficulty', 'extraData', 'logsBloom', 'miner', 'mixHash', 'nonce', 'parentHash',
	'receiptsRoot', 'sha3Uncles', 'size', 'stateRoot', 'transactions', 'transactionsRoot',
	'uncles', 'excessBlobGas', 'blobGasUsed', 'blockAccessListHash', 'parentBeaconBlockRoot',
	'requestsHash', 'withdrawalsRoot', 'withdrawals', 'totalDifficulty', 'calls',
] as const

const blockTransactionResultKeys = ['data', 'blockHash', 'blockNumber', 'transactionIndex'] as const

const legacyBlockHeaderTransactionKeys = [
	'type', 'hash', 'from', 'nonce', 'gasPrice', 'gas', 'to', 'value', 'input',
	'chainId', 'r', 's', 'v', 'yParity', ...blockTransactionResultKeys,
] as const

const accessListBlockHeaderTransactionKeys = [
	'type', 'hash', 'from', 'nonce', 'gasPrice', 'gas', 'to', 'value', 'input',
	'chainId', 'accessList', 'r', 's', 'v', 'yParity', ...blockTransactionResultKeys,
] as const

const feeMarketBlockHeaderTransactionKeys = [
	'type', 'hash', 'from', 'nonce', 'maxFeePerGas', 'maxPriorityFeePerGas', 'gas',
	'to', 'value', 'input', 'chainId', 'accessList', 'r', 's', 'v', 'yParity',
	'gasPrice', ...blockTransactionResultKeys,
] as const

const blobBlockHeaderTransactionKeys = [
	'type', 'hash', 'from', 'nonce', 'maxFeePerGas', 'maxPriorityFeePerGas',
	'maxFeePerBlobGas', 'gas', 'to', 'value', 'input', 'chainId', 'accessList',
	'blobVersionedHashes', 'r', 's', 'v', 'yParity', 'gasPrice',
	...blockTransactionResultKeys,
] as const

const authorizationListBlockHeaderTransactionKeys = [
	'type', 'hash', 'from', 'nonce', 'maxFeePerGas', 'maxPriorityFeePerGas', 'gas',
	'to', 'value', 'input', 'chainId', 'authorizationList', 'accessList', 'r', 's',
	'v', 'yParity', 'gasPrice', ...blockTransactionResultKeys,
] as const

const optimismDepositBlockHeaderTransactionKeys = [
	'type', 'sourceHash', 'from', 'to', 'mint', 'value', 'gas', 'data', 'hash',
	'gasPrice', 'nonce', 'blockHash', 'blockNumber', 'transactionIndex',
] as const

const unknownBlockHeaderTransactionKeys = ['type', 'hash'] as const

function getSignedBlockHeaderTransactionKeys(value: unknown) {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return legacyBlockHeaderTransactionKeys
	const type = Object.getOwnPropertyDescriptor(value, 'type')?.value
	switch (type) {
		case '2930':
		case '0x1':
			return accessListBlockHeaderTransactionKeys
		case '1559':
		case '0x2':
			return feeMarketBlockHeaderTransactionKeys
		case '4844':
		case '0x3':
			return blobBlockHeaderTransactionKeys
		case '7702':
		case '0x4':
			return authorizationListBlockHeaderTransactionKeys
		case 'optimismDeposit':
		case '0x7e':
			return optimismDepositBlockHeaderTransactionKeys
		default:
			return legacyBlockHeaderTransactionKeys
	}
}

const EthSimulateV1SignedTransactionAdditionalProperties = funtypes.Unknown.withParser({
	parse: (value) => validateAdditionalProperties(value, new Set(getSignedBlockHeaderTransactionKeys(value))),
	serialize: (value) => validateAdditionalProperties(value, new Set(getSignedBlockHeaderTransactionKeys(value))),
})

function validateAdditionalProperties(value: unknown, knownKeys: ReadonlySet<string>) {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return { success: false as const, message: 'Additional properties must be on an object.' }
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key === 'symbol') return { success: false as const, message: `Additional property ${ String(key) } must be JSON encodeable.` }
		if (knownKeys.has(key)) continue
		if (!Object.prototype.propertyIsEnumerable.call(value, key)) return { success: false as const, message: `Additional property ${ key } must be JSON encodeable.` }
		const nestedValue = Object.getOwnPropertyDescriptor(value, key)?.value
		if (getInvalidJSONEncodeableValuePath(nestedValue) !== undefined) return { success: false as const, message: `Additional property ${ key } must be JSON encodeable.` }
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
const BlockCall = funtypes.Intersect(
	EthSimulateV1AdditionalProperties(blockCallKeys),
	funtypes.Partial({
		type: funtypes.Union(
			funtypes.Literal('0x0').withParser(LiteralConverterParserFactory('0x0', 'legacy' as const)),
			funtypes.Literal(undefined).withParser(LiteralConverterParserFactory(undefined, 'legacy' as const)),
			funtypes.Literal('0x1').withParser(LiteralConverterParserFactory('0x1', '2930' as const)),
			funtypes.Literal('0x2').withParser(LiteralConverterParserFactory('0x2', '1559' as const)),
			funtypes.Literal('0x3').withParser(LiteralConverterParserFactory('0x3', '4844' as const)),
			funtypes.Literal('0x4').withParser(LiteralConverterParserFactory('0x4', '7702' as const)),
		),
		from: EthereumAddress,
		nonce: EthereumQuantity,
		maxFeePerGas: EthereumQuantity,
		maxPriorityFeePerGas: EthereumQuantity,
		maxFeePerBlobGas: EthereumQuantity,
		gasPrice: EthereumQuantity,
		gas: EthereumQuantity,
		to: funtypes.Union(EthereumAddress, funtypes.Null),
		value: EthereumQuantity,
		input: EthereumInput,
		data: EthereumInput,
		chainId: EthereumQuantity,
		accessList: EthereumAccessList,
		blobVersionedHashes: funtypes.ReadonlyArray(EthereumBytes32),
		blobs: funtypes.ReadonlyArray(EthereumData),
		r: EthereumQuantity,
		s: EthereumQuantity,
		v: EthereumQuantity,
		yParity: EthereumSignatureParity,
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
	})
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
const EthSimulateCallResultFailure = funtypes.Intersect(
	EthSimulateV1AdditionalProperties(failedCallResultKeys),
	funtypes.ReadonlyObject({
		status: funtypes.Literal('0x0').withParser(LiteralConverterParserFactory('0x0', 'failure' as const)),
		returnData: EthereumData,
		gasUsed: EthereumQuantitySmall,
		error: ErrorWithCodeAndOptionalData
	}),
	funtypes.ReadonlyPartial({
		maxUsedGas: EthereumQuantitySmall,
	}),
)

type EthSimulateCallResultSuccess = funtypes.Static<typeof EthSimulateCallResultSuccess>
const EthSimulateCallResultSuccess = funtypes.Intersect(
	EthSimulateV1AdditionalProperties(successfulCallResultKeys),
	funtypes.ReadonlyObject({
		returnData: EthereumData,
		gasUsed: EthereumQuantitySmall,
		status: funtypes.Literal('0x1').withParser(LiteralConverterParserFactory('0x1', 'success' as const)),
		logs: CallResultLogs
	}),
	funtypes.ReadonlyPartial({
		maxUsedGas: EthereumQuantitySmall,
	}),
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

const EthSimulateV1UnknownTransactionType = funtypes.ReadonlyObject({
	hash: EthereumBytes32,
	type: funtypes.String.withConstraint((type) => {
		if (!isHexEncodedNumber(type)) return false
		const alreadyHandled = ['0x0', '0x1', '0x2', '0x3', '0x4', '0x7e']
		return !alreadyHandled.includes(type)
	}),
})

const EthSimulateV1BlockHeaderTransaction = funtypes.Union(
	funtypes.Intersect(
		EthSimulateV1SignedTransactionAdditionalProperties,
		EthereumSignedTransaction,
		funtypes.ReadonlyPartial({
			data: EthereumInput,
			gasPrice: EthereumQuantity,
			blockHash: funtypes.Union(EthereumBytes32, funtypes.Null),
			blockNumber: funtypes.Union(EthereumQuantity, funtypes.Null),
			transactionIndex: funtypes.Union(EthereumQuantity, funtypes.Null),
		}),
	),
	funtypes.Intersect(
		EthSimulateV1AdditionalProperties(unknownBlockHeaderTransactionKeys),
		EthSimulateV1UnknownTransactionType,
	),
)

export type EthSimulateV1BlockHeader = funtypes.Static<typeof EthSimulateV1BlockHeader>
export const EthSimulateV1BlockHeader = funtypes.Intersect(
	funtypes.MutablePartial({
		author: EthereumAddress,
	}),
	funtypes.ReadonlyObject({
		number: EthereumQuantity,
		hash: EthereumBytes32,
		timestamp: EthereumQuantity,
		gasLimit: EthereumQuantitySmall,
		gasUsed: EthereumQuantitySmall,
		baseFeePerGas: EthereumQuantity,
	}),
	funtypes.ReadonlyPartial({
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
	}),
)

type EthSimulateV1BlockResult = funtypes.Static<typeof EthSimulateV1BlockResult>
const EthSimulateV1BlockResult = funtypes.Intersect(
	EthSimulateV1AdditionalProperties(blockResultKeys),
	EthSimulateV1BlockHeader,
	funtypes.ReadonlyObject({
		number: EthereumQuantity,
		hash: EthereumBytes32,
		timestamp: EthereumQuantity,
		gasLimit: EthereumQuantitySmall,
		gasUsed: EthereumQuantitySmall,
		baseFeePerGas: EthereumQuantity,
		calls: EthSimulateV1CallResults,
	}),
	funtypes.ReadonlyPartial({
		transactions: funtypes.Union(funtypes.ReadonlyArray(EthereumBytes32), funtypes.ReadonlyArray(EthSimulateV1BlockHeaderTransaction)),
	}),
)

export type EthSimulateV1Result = funtypes.Static<typeof EthSimulateV1Result>
export const EthSimulateV1Result = funtypes.ReadonlyArray(EthSimulateV1BlockResult)
