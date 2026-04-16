"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GetSimulationStackReplyV2 = exports.GetSimulationStackReplyV1 = void 0;
const funtypes = require("funtypes");
const wire_types_js_1 = require("./wire-types.js");
const visualizer_types_js_1 = require("./visualizer-types.js");
const JsonRpc_types_js_1 = require("./JsonRpc-types.js");
const ethSimulate_types_js_1 = require("./ethSimulate-types.js");
const RevertErrorParser = {
    parse: (value) => {
        if (!value.startsWith('Reverted '))
            return { success: true, value };
        const parseResult = wire_types_js_1.BytesParser.parse(value.slice('Reverted '.length));
        if (!parseResult.success)
            return parseResult;
        const decoded = new TextDecoder().decode(parseResult.value);
        return { success: true, value: decoded };
    },
    serialize: (value) => {
        const encoded = new TextEncoder().encode(value);
        const serializationResult = wire_types_js_1.BytesParser.serialize(encoded);
        if (!serializationResult.success)
            return serializationResult;
        return { success: true, value: `Reverted ${serializationResult.value}` };
    }
};
const OldMulticallLog = funtypes.Object({
    loggersAddress: wire_types_js_1.EthereumAddress,
    data: wire_types_js_1.EthereumInput,
    topics: funtypes.ReadonlyArray(wire_types_js_1.EthereumBytes32),
}).asReadonly();
exports.GetSimulationStackReplyV1 = funtypes.ReadonlyArray(funtypes.Intersect(wire_types_js_1.EthereumUnsignedTransaction, funtypes.Union(funtypes.Object({
    statusCode: funtypes.Literal(1).withParser((0, wire_types_js_1.LiteralConverterParserFactory)(1, 'success')),
    gasSpent: wire_types_js_1.EthereumQuantity,
    returnValue: wire_types_js_1.EthereumData,
    events: funtypes.ReadonlyArray(OldMulticallLog),
    balanceChanges: JsonRpc_types_js_1.EthBalanceChanges,
}).asReadonly(), funtypes.Object({
    statusCode: funtypes.Literal(0).withParser((0, wire_types_js_1.LiteralConverterParserFactory)(0, 'failure')),
    gasSpent: wire_types_js_1.EthereumQuantity,
    error: funtypes.String.withParser(RevertErrorParser),
    returnValue: wire_types_js_1.EthereumData,
}).asReadonly()), funtypes.Object({
    realizedGasPrice: wire_types_js_1.EthereumQuantity,
    gasLimit: wire_types_js_1.EthereumQuantity,
    maxPriorityFeePerGas: wire_types_js_1.EthereumQuantity,
    balanceChanges: JsonRpc_types_js_1.EthBalanceChanges
}).asReadonly()));
exports.GetSimulationStackReplyV2 = funtypes.ReadonlyObject({
    stateOverrides: ethSimulate_types_js_1.StateOverrides,
    transactions: funtypes.ReadonlyArray(funtypes.ReadonlyObject({ simulatedTransaction: visualizer_types_js_1.SimulatedTransaction, ethBalanceChanges: JsonRpc_types_js_1.EthBalanceChanges }).asReadonly())
});
