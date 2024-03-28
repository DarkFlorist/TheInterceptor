import { EthereumAccessList, EthereumAddress, EthereumBlockTag, EthereumBytes32, EthereumData, EthereumInput, EthereumQuantity, EthereumQuantitySmall, EthereumTimestamp, LiteralConverterParserFactory } from './wire-types.js'
import * as funtypes from 'funtypes'

export type AccountOverride = funtypes.Static<typeof AccountOverride>
export const AccountOverride = funtypes.ReadonlyPartial({
	state: funtypes.ReadonlyRecord(funtypes.String, EthereumBytes32),
	stateDiff: funtypes.ReadonlyRecord(funtypes.String, EthereumBytes32),
	nonce: EthereumQuantitySmall,
	balance: EthereumQuantity,
	code: EthereumData,
	movePrecompileToAddress: EthereumAddress,
})

export type BlockOverride = funtypes.Static<typeof BlockOverride>
export const BlockOverride = funtypes.ReadonlyObject({
    number: EthereumQuantity,
    prevRandao: EthereumQuantity,
    time: EthereumTimestamp,
    gasLimit: EthereumQuantitySmall,
    feeRecipient: EthereumAddress,
    baseFeePerGas: EthereumQuantity,
})

export type BlockCall = funtypes.Static<typeof BlockCall>
export const BlockCall = funtypes.Partial({
	type: funtypes.Union(
		funtypes.Literal('0x0').withParser(LiteralConverterParserFactory('0x0', 'legacy' as const)),
		funtypes.Literal(undefined).withParser(LiteralConverterParserFactory(undefined, 'legacy' as const)),
		funtypes.Literal('0x1').withParser(LiteralConverterParserFactory('0x1', '2930' as const)),
		funtypes.Literal('0x2').withParser(LiteralConverterParserFactory('0x2', '1559' as const)),
		funtypes.Literal('0x3').withParser(LiteralConverterParserFactory('0x3', '4844' as const)),
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
		blockOverride: BlockOverride,
	})
)

export type  ethSimulateV1ParamObject = funtypes.Static<typeof ethSimulateV1ParamObject>
export const  ethSimulateV1ParamObject = funtypes.ReadonlyObject({
	blockStateCalls: funtypes.ReadonlyArray(BlockCalls),
	traceTransfers: funtypes.Boolean,
	validation: funtypes.Boolean,
})

export type EthSimulateV1Params = funtypes.Static<typeof EthSimulateV1Params>
export const EthSimulateV1Params = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_simulateV1'),
	params: funtypes.ReadonlyTuple(ethSimulateV1ParamObject, EthereumBlockTag),
})

export type EthereumEvent = funtypes.Static<typeof EthereumEvent>
export const EthereumEvent = funtypes.ReadonlyObject({
	address: EthereumAddress,
	data: EthereumInput,
	topics: funtypes.ReadonlyArray(EthereumBytes32),
}).asReadonly()

export type CallResultLog = funtypes.Static<typeof CallResultLog>
export const CallResultLog = funtypes.Intersect(
	EthereumEvent,
	funtypes.ReadonlyObject({
		logIndex: EthereumQuantity,
		blockHash: EthereumBytes32,
		blockNumber: EthereumQuantity,
	}),
	funtypes.ReadonlyPartial({ // these are not optional in the eth_simulateV1 spec, but they are not standard for logs
		transactionHash: EthereumBytes32,
		transactionIndex: EthereumQuantity,
	})
)

export type CallResultLogs = funtypes.Static<typeof CallResultLogs>
export const CallResultLogs = funtypes.ReadonlyArray(CallResultLog)

export type EthSimulateCallResultFailure = funtypes.Static<typeof EthSimulateCallResultFailure>
export const EthSimulateCallResultFailure = funtypes.ReadonlyObject({
	  status: funtypes.Literal('0x0').withParser(LiteralConverterParserFactory('0x0', 'failure' as const)),
	  returnData: EthereumData,
	  gasUsed: EthereumQuantitySmall,
	  error: funtypes.ReadonlyObject({
		  code: funtypes.Number,
		  message: funtypes.String
	  })
})

export type EthSimulateCallResultSuccess = funtypes.Static<typeof EthSimulateCallResultSuccess>
export const EthSimulateCallResultSuccess = funtypes.ReadonlyObject({
	returnData: EthereumData,
	gasUsed: EthereumQuantitySmall,
	status: funtypes.Literal('0x1').withParser(LiteralConverterParserFactory('0x1', 'success' as const)),
	logs: CallResultLogs
})


export type EthSimulateV1CallResult = funtypes.Static<typeof EthSimulateV1CallResult>
export const EthSimulateV1CallResult = funtypes.Union(EthSimulateCallResultFailure, EthSimulateCallResultSuccess)

export type EthSimulateV1CallResults = funtypes.Static<typeof EthSimulateV1CallResults>
export const EthSimulateV1CallResults = funtypes.ReadonlyArray(EthSimulateV1CallResult)

export type ethSimulateV1BlockResult = funtypes.Static<typeof ethSimulateV1BlockResult>
export const ethSimulateV1BlockResult = funtypes.ReadonlyObject({
    number: EthereumQuantity,
    hash: EthereumBytes32,
    timestamp: EthereumQuantity,
    prevRandao: EthereumQuantity,
    gasLimit: EthereumQuantitySmall,
    gasUsed: EthereumQuantitySmall,
    feeRecipient: EthereumAddress,
    baseFeePerGas: EthereumQuantity,
    calls: EthSimulateV1CallResults,
})

export type ethSimulateV1Result = funtypes.Static<typeof ethSimulateV1Result>
export const ethSimulateV1Result = funtypes.ReadonlyArray(ethSimulateV1BlockResult)
