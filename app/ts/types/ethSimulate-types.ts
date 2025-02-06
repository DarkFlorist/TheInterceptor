import { EthereumAccessList, EthereumAddress, EthereumBlockTag, EthereumBytes32, EthereumData, EthereumInput, EthereumQuantity, EthereumQuantitySmall, EthereumTimestamp, LiteralConverterParserFactory } from './wire-types.js'
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

type BlockOverrides = funtypes.Static<typeof BlockOverrides>
const BlockOverrides = funtypes.Partial({
    number: EthereumQuantity,
    prevRandao: EthereumBytes32,
    time: EthereumTimestamp,
    gasLimit: EthereumQuantitySmall,
    feeRecipient: EthereumAddress,
    baseFeePerGas: EthereumQuantity,
}).asReadonly()

type BlockCall = funtypes.Static<typeof BlockCall>
const BlockCall = funtypes.Partial({
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
	gas: EthereumQuantity,
	to: funtypes.Union(EthereumAddress, funtypes.Null),
	value: EthereumQuantity,
	input: EthereumInput,
	chainId: EthereumQuantity,
	accessList: EthereumAccessList,
	authorizationList: funtypes.ReadonlyArray(funtypes.ReadonlyObject({
		chainId: EthereumQuantity,
		address: EthereumAddress,
		nonce: EthereumQuantity,
	}))
})

export type StateOverrides = funtypes.Static<typeof StateOverrides>
export const StateOverrides = funtypes.ReadonlyRecord(funtypes.String, AccountOverride)

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
const EthSimulateV1ParamObject = funtypes.ReadonlyObject({
	blockStateCalls: funtypes.ReadonlyArray(BlockCalls),
	traceTransfers: funtypes.Boolean,
	validation: funtypes.Boolean,
})

export type EthSimulateV1Params = funtypes.Static<typeof EthSimulateV1Params>
export const EthSimulateV1Params = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_simulateV1'),
	params: funtypes.ReadonlyTuple(EthSimulateV1ParamObject, EthereumBlockTag),
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
	})
)

type CallResultLogs = funtypes.Static<typeof CallResultLogs>
const CallResultLogs = funtypes.ReadonlyArray(CallResultLog)

type EthSimulateCallResultFailure = funtypes.Static<typeof EthSimulateCallResultFailure>
const EthSimulateCallResultFailure = funtypes.ReadonlyObject({
	  status: funtypes.Literal('0x0').withParser(LiteralConverterParserFactory('0x0', 'failure' as const)),
	  returnData: EthereumData,
	  gasUsed: EthereumQuantitySmall,
	  error: funtypes.ReadonlyObject({
		  code: funtypes.Number,
		  message: funtypes.String
	  })
})

type EthSimulateCallResultSuccess = funtypes.Static<typeof EthSimulateCallResultSuccess>
const EthSimulateCallResultSuccess = funtypes.ReadonlyObject({
	returnData: EthereumData,
	gasUsed: EthereumQuantitySmall,
	status: funtypes.Literal('0x1').withParser(LiteralConverterParserFactory('0x1', 'success' as const)),
	logs: CallResultLogs
})

export type EthSimulateV1CallResult = funtypes.Static<typeof EthSimulateV1CallResult>
export const EthSimulateV1CallResult = funtypes.Union(EthSimulateCallResultFailure, EthSimulateCallResultSuccess)

export type EthSimulateV1CallResults = funtypes.Static<typeof EthSimulateV1CallResults>
export const EthSimulateV1CallResults = funtypes.ReadonlyArray(EthSimulateV1CallResult)

type EthSimulateV1BlockResult = funtypes.Static<typeof EthSimulateV1BlockResult>
const EthSimulateV1BlockResult = funtypes.ReadonlyObject({
    number: EthereumQuantity,
    hash: EthereumBytes32,
    timestamp: EthereumQuantity,
    gasLimit: EthereumQuantitySmall,
    gasUsed: EthereumQuantitySmall,
    baseFeePerGas: EthereumQuantity,
    calls: EthSimulateV1CallResults,
})

export type EthSimulateV1Result = funtypes.Static<typeof EthSimulateV1Result>
export const EthSimulateV1Result = funtypes.ReadonlyArray(EthSimulateV1BlockResult)
