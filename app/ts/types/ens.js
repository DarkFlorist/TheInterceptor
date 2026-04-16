"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MaybeENSLabelHashes = exports.ENSLabelHashes = exports.MaybeENSLabelHash = exports.ENSNameHashes = exports.MaybeENSNameHashes = exports.MaybeENSNameHash = void 0;
const funtypes = require("funtypes");
const wire_types_js_1 = require("./wire-types.js");
exports.MaybeENSNameHash = funtypes.ReadonlyObject({
    nameHash: wire_types_js_1.EthereumBytes32,
    name: funtypes.Union(funtypes.String, funtypes.Undefined),
});
exports.MaybeENSNameHashes = funtypes.ReadonlyArray(exports.MaybeENSNameHash);
const ENSNameHash = funtypes.ReadonlyObject({
    nameHash: wire_types_js_1.EthereumBytes32,
    name: funtypes.String,
});
exports.ENSNameHashes = funtypes.ReadonlyArray(ENSNameHash);
const ENSLabelHash = funtypes.ReadonlyObject({
    labelHash: wire_types_js_1.EthereumBytes32,
    label: funtypes.String,
});
exports.MaybeENSLabelHash = funtypes.ReadonlyObject({
    labelHash: wire_types_js_1.EthereumBytes32,
    label: funtypes.Union(funtypes.String, funtypes.Undefined),
});
exports.ENSLabelHashes = funtypes.ReadonlyArray(ENSLabelHash);
exports.MaybeENSLabelHashes = funtypes.ReadonlyArray(exports.MaybeENSLabelHash);
