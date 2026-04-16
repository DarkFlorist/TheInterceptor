"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SignMessageParams = exports.SignTypedDataParams = exports.PersonalSignParams = exports.OldSignTypedDataParams = void 0;
const funtypes = require("funtypes");
const wire_types_js_1 = require("./wire-types.js");
const eip721_js_1 = require("./eip721.js");
exports.OldSignTypedDataParams = funtypes.ReadonlyObject({
    method: funtypes.Literal('eth_signTypedData'),
    params: funtypes.ReadonlyTuple(funtypes.ReadonlyArray(funtypes.ReadonlyObject({
        name: funtypes.String,
        type: funtypes.String,
    })), wire_types_js_1.EthereumAddress),
});
exports.PersonalSignParams = funtypes.ReadonlyObject({
    method: funtypes.Literal('personal_sign'),
    params: funtypes.Union(funtypes.ReadonlyTuple(funtypes.String, wire_types_js_1.EthereumAddress, funtypes.Union(funtypes.String, funtypes.Undefined, funtypes.Null)), // message, account, password
    funtypes.ReadonlyTuple(funtypes.String, wire_types_js_1.EthereumAddress) // message, account
    )
});
exports.SignTypedDataParams = funtypes.ReadonlyObject({
    method: funtypes.Union(funtypes.Literal('eth_signTypedData_v1'), funtypes.Literal('eth_signTypedData_v2'), funtypes.Literal('eth_signTypedData_v3'), funtypes.Literal('eth_signTypedData_v4')),
    params: funtypes.ReadonlyTuple(wire_types_js_1.EthereumAddress, eip721_js_1.EIP712Message), // address that will sign the message, typed data
});
exports.SignMessageParams = funtypes.Union(exports.PersonalSignParams, exports.SignTypedDataParams, exports.OldSignTypedDataParams);
