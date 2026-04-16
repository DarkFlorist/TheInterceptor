"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RpcNetwork = exports.RpcEntries = exports.RpcEntry = exports.BlockExplorer = exports.ChainEntry = void 0;
const funtypes = require("funtypes");
const wire_types_js_1 = require("./wire-types.js");
const addressBookTypes_js_1 = require("./addressBookTypes.js");
exports.ChainEntry = funtypes.Intersect(funtypes.ReadonlyObject({
    name: funtypes.String,
    chainId: addressBookTypes_js_1.ChainIdWithUniversal,
}));
exports.BlockExplorer = funtypes.ReadonlyObject({
    apiUrl: funtypes.String,
    apiKey: funtypes.String,
});
exports.RpcEntry = funtypes.Intersect(funtypes.ReadonlyObject({
    name: funtypes.String,
    chainId: wire_types_js_1.EthereumQuantity,
    httpsRpc: funtypes.String,
    currencyName: funtypes.String,
    currencyTicker: funtypes.String,
    primary: funtypes.Boolean,
    minimized: funtypes.Boolean,
}), funtypes.ReadonlyPartial({
    currencyLogoUri: funtypes.String,
    blockExplorer: exports.BlockExplorer
}));
exports.RpcEntries = funtypes.ReadonlyArray(exports.RpcEntry);
exports.RpcNetwork = funtypes.Union(exports.RpcEntry, funtypes.ReadonlyObject({
    httpsRpc: funtypes.Undefined,
    chainId: wire_types_js_1.EthereumQuantity,
    name: funtypes.String,
    currencyName: funtypes.Literal('Ether?'),
    currencyTicker: funtypes.Literal('ETH?'),
    primary: funtypes.Literal(false),
    minimized: funtypes.Literal(true),
}));
