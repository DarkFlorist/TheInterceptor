"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EthSimulateV1Result = exports.EthSimulateV1CallResults = exports.EthSimulateV1CallResult = exports.EthereumEvent = exports.EthSimulateV1Params = exports.BlockCalls = exports.MutableStateOverrides = exports.StateOverrides = exports.BlockOverrides = void 0;
const error_js_1 = require("./error.js");
const wire_types_js_1 = require("./wire-types.js");
const funtypes = require("funtypes");
const AccountOverride = funtypes.ReadonlyPartial({
    state: funtypes.ReadonlyRecord(funtypes.String, wire_types_js_1.EthereumBytes32),
    stateDiff: funtypes.ReadonlyRecord(funtypes.String, wire_types_js_1.EthereumBytes32),
    nonce: wire_types_js_1.EthereumQuantitySmall,
    balance: wire_types_js_1.EthereumQuantity,
    code: wire_types_js_1.EthereumData,
    movePrecompileToAddress: wire_types_js_1.EthereumAddress,
});
exports.BlockOverrides = funtypes.Partial({
    number: wire_types_js_1.EthereumQuantity,
    prevRandao: wire_types_js_1.EthereumBytes32,
    time: wire_types_js_1.EthereumTimestamp,
    gasLimit: wire_types_js_1.EthereumQuantitySmall,
    feeRecipient: wire_types_js_1.EthereumAddress,
    baseFeePerGas: wire_types_js_1.EthereumQuantity,
}).asReadonly();
const BlockCall = funtypes.Partial({
    type: funtypes.Union(funtypes.Literal('0x0').withParser((0, wire_types_js_1.LiteralConverterParserFactory)('0x0', 'legacy')), funtypes.Literal(undefined).withParser((0, wire_types_js_1.LiteralConverterParserFactory)(undefined, 'legacy')), funtypes.Literal('0x1').withParser((0, wire_types_js_1.LiteralConverterParserFactory)('0x1', '2930')), funtypes.Literal('0x2').withParser((0, wire_types_js_1.LiteralConverterParserFactory)('0x2', '1559')), funtypes.Literal('0x3').withParser((0, wire_types_js_1.LiteralConverterParserFactory)('0x3', '4844')), funtypes.Literal('0x4').withParser((0, wire_types_js_1.LiteralConverterParserFactory)('0x4', '7702'))),
    from: wire_types_js_1.EthereumAddress,
    nonce: wire_types_js_1.EthereumQuantity,
    maxFeePerGas: wire_types_js_1.EthereumQuantity,
    maxPriorityFeePerGas: wire_types_js_1.EthereumQuantity,
    gas: wire_types_js_1.EthereumQuantity,
    to: funtypes.Union(wire_types_js_1.EthereumAddress, funtypes.Null),
    value: wire_types_js_1.EthereumQuantity,
    input: wire_types_js_1.EthereumInput,
    chainId: wire_types_js_1.EthereumQuantity,
    accessList: wire_types_js_1.EthereumAccessList,
    authorizationList: funtypes.ReadonlyArray(funtypes.ReadonlyObject({
        chainId: wire_types_js_1.EthereumQuantity,
        address: wire_types_js_1.EthereumAddress,
        nonce: wire_types_js_1.EthereumQuantity,
    }))
});
exports.StateOverrides = funtypes.ReadonlyRecord(funtypes.String, AccountOverride);
exports.MutableStateOverrides = funtypes.Record(funtypes.String, AccountOverride);
exports.BlockCalls = funtypes.Intersect(funtypes.ReadonlyObject({
    calls: funtypes.ReadonlyArray(BlockCall),
}), funtypes.ReadonlyPartial({
    stateOverrides: exports.StateOverrides,
    blockOverrides: exports.BlockOverrides,
}));
const EthSimulateV1ParamObject = funtypes.ReadonlyObject({
    blockStateCalls: funtypes.ReadonlyArray(exports.BlockCalls),
    traceTransfers: funtypes.Boolean,
    validation: funtypes.Boolean,
});
exports.EthSimulateV1Params = funtypes.ReadonlyObject({
    method: funtypes.Literal('eth_simulateV1'),
    params: funtypes.ReadonlyTuple(EthSimulateV1ParamObject, wire_types_js_1.EthereumBlockTag),
});
exports.EthereumEvent = funtypes.ReadonlyObject({
    address: wire_types_js_1.EthereumAddress,
    data: wire_types_js_1.EthereumInput,
    topics: funtypes.ReadonlyArray(wire_types_js_1.EthereumBytes32),
}).asReadonly();
const CallResultLog = funtypes.Intersect(exports.EthereumEvent, funtypes.ReadonlyObject({
    logIndex: wire_types_js_1.EthereumQuantity,
    blockHash: funtypes.Union(wire_types_js_1.EthereumBytes32, funtypes.Null), // Base returns null for this at times
    blockNumber: wire_types_js_1.EthereumQuantity,
}), funtypes.ReadonlyPartial({
    transactionHash: wire_types_js_1.EthereumBytes32,
    transactionIndex: wire_types_js_1.EthereumQuantity,
}));
const CallResultLogs = funtypes.ReadonlyArray(CallResultLog);
const EthSimulateCallResultFailure = funtypes.ReadonlyObject({
    status: funtypes.Literal('0x0').withParser((0, wire_types_js_1.LiteralConverterParserFactory)('0x0', 'failure')),
    returnData: wire_types_js_1.EthereumData,
    gasUsed: wire_types_js_1.EthereumQuantitySmall,
    error: error_js_1.ErrorWithCodeAndOptionalData
});
const EthSimulateCallResultSuccess = funtypes.ReadonlyObject({
    returnData: wire_types_js_1.EthereumData,
    gasUsed: wire_types_js_1.EthereumQuantitySmall,
    status: funtypes.Literal('0x1').withParser((0, wire_types_js_1.LiteralConverterParserFactory)('0x1', 'success')),
    logs: CallResultLogs
});
exports.EthSimulateV1CallResult = funtypes.Union(EthSimulateCallResultFailure, EthSimulateCallResultSuccess);
exports.EthSimulateV1CallResults = funtypes.ReadonlyArray(exports.EthSimulateV1CallResult);
const EthSimulateV1BlockResult = funtypes.ReadonlyObject({
    number: wire_types_js_1.EthereumQuantity,
    hash: wire_types_js_1.EthereumBytes32,
    timestamp: wire_types_js_1.EthereumQuantity,
    gasLimit: wire_types_js_1.EthereumQuantitySmall,
    gasUsed: wire_types_js_1.EthereumQuantitySmall,
    baseFeePerGas: wire_types_js_1.EthereumQuantity,
    calls: exports.EthSimulateV1CallResults,
});
exports.EthSimulateV1Result = funtypes.ReadonlyArray(EthSimulateV1BlockResult);
