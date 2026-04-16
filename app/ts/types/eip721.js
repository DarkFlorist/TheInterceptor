"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Eip712Number = exports.NumberAsBigInt = exports.EnrichedEIP712 = exports.EnrichedEIP712Message = exports.EnrichedEIP712MessageRecord = exports.EIP712Message = exports.EIP712Types = void 0;
const funtypes = require("funtypes");
const json_js_1 = require("../utils/json.js");
const solidityType_js_1 = require("./solidityType.js");
const wire_types_js_1 = require("./wire-types.js");
exports.EIP712Types = funtypes.Record(funtypes.String, funtypes.ReadonlyArray(funtypes.ReadonlyObject({ name: funtypes.String, type: funtypes.String })));
const EIP712MessageUnderlying = funtypes.ReadonlyObject({
    types: exports.EIP712Types,
    primaryType: funtypes.String,
    domain: json_js_1.JSONEncodeableObject,
    message: json_js_1.JSONEncodeableObject,
});
const EIP712MessageParser = {
    parse: value => {
        if (!(0, json_js_1.isJSON)(value) || !EIP712MessageUnderlying.test((0, json_js_1.jsonParserWithNumbersAsStringsConverter)(value)))
            return { success: false, message: `${value} is not EIP712 message` };
        return { success: true, value: EIP712MessageUnderlying.parse((0, json_js_1.jsonParserWithNumbersAsStringsConverter)(value)) };
    },
    serialize: value => {
        if (!EIP712MessageUnderlying.test(value))
            return { success: false, message: `${value} is not a EIP712 message.` };
        return { success: true, value: JSON.stringify((0, wire_types_js_1.serialize)(EIP712MessageUnderlying, value)) };
    },
};
exports.EIP712Message = funtypes.String.withParser(EIP712MessageParser);
exports.EnrichedEIP712MessageRecord = funtypes.Lazy(() => funtypes.Union(solidityType_js_1.EnrichedGroupedSolidityType, funtypes.ReadonlyObject({ type: funtypes.Literal('record'), value: funtypes.ReadonlyRecord(funtypes.String, exports.EnrichedEIP712MessageRecord) }), funtypes.ReadonlyObject({ type: funtypes.Literal('record[]'), value: funtypes.ReadonlyArray(funtypes.ReadonlyRecord(funtypes.String, exports.EnrichedEIP712MessageRecord)) })));
exports.EnrichedEIP712Message = funtypes.ReadonlyRecord(funtypes.String, exports.EnrichedEIP712MessageRecord);
exports.EnrichedEIP712 = funtypes.ReadonlyObject({
    primaryType: funtypes.String,
    message: exports.EnrichedEIP712Message,
    domain: exports.EnrichedEIP712Message,
});
const numberAsBigIntParser = {
    parse: value => {
        if (!Number.isInteger(value))
            return { success: false, message: `${value} is not integer.` };
        if (value < Number.MIN_SAFE_INTEGER || value > Number.MAX_SAFE_INTEGER)
            return { success: false, message: `${value} is out of bounds` };
        return { success: true, value: BigInt(value) };
    },
    serialize: value => {
        if (!Number.isInteger(value))
            return { success: false, message: `${value} is not integer.` };
        if (value < Number.MIN_SAFE_INTEGER || value > Number.MAX_SAFE_INTEGER)
            return { success: false, message: `${value} is out of bounds` };
        return { success: true, value: Number(value) };
    },
};
exports.NumberAsBigInt = funtypes.Number.withParser(numberAsBigIntParser);
exports.Eip712Number = funtypes.Union(wire_types_js_1.EthereumQuantity, wire_types_js_1.NonHexBigInt, exports.NumberAsBigInt);
