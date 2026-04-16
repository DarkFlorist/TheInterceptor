"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PendingFetchSimulationStackRequestPromise = exports.PendingChainChangeConfirmationPromise = exports.RpcConnectionStatus = exports.TabState = exports.TabIconDetails = exports.TabIcon = void 0;
const funtypes = require("funtypes");
const wire_types_js_1 = require("./wire-types.js");
const requests_js_1 = require("../utils/requests.js");
const websiteAccessTypes_js_1 = require("./websiteAccessTypes.js");
const signerTypes_js_1 = require("./signerTypes.js");
const constants_js_1 = require("../utils/constants.js");
const rpc_js_1 = require("./rpc.js");
const JsonRpc_types_js_1 = require("./JsonRpc-types.js");
const error_js_1 = require("./error.js");
exports.TabIcon = funtypes.Union(funtypes.Literal(constants_js_1.ICON_ACTIVE), funtypes.Literal(constants_js_1.ICON_ACCESS_DENIED), funtypes.Literal(constants_js_1.ICON_NOT_ACTIVE), funtypes.Literal(constants_js_1.ICON_SIMULATING), funtypes.Literal(constants_js_1.ICON_SIGNING), funtypes.Literal(constants_js_1.ICON_SIGNING_NOT_SUPPORTED), funtypes.Literal(constants_js_1.ICON_INTERCEPTOR_DISABLED), funtypes.Literal(constants_js_1.ICON_ACTIVE_WITH_SHIELD), funtypes.Literal(constants_js_1.ICON_ACCESS_DENIED_WITH_SHIELD), funtypes.Literal(constants_js_1.ICON_NOT_ACTIVE_WITH_SHIELD), funtypes.Literal(constants_js_1.ICON_SIMULATING_WITH_SHIELD), funtypes.Literal(constants_js_1.ICON_SIGNING_WITH_SHIELD), funtypes.Literal(constants_js_1.ICON_SIGNING_NOT_SUPPORTED_WITH_SHIELD));
exports.TabIconDetails = funtypes.ReadonlyObject({
    icon: exports.TabIcon,
    iconReason: funtypes.String,
});
exports.TabState = funtypes.ReadonlyObject({
    tabId: funtypes.Number,
    website: funtypes.Union(websiteAccessTypes_js_1.Website, funtypes.Undefined),
    signerConnected: funtypes.Boolean,
    signerName: signerTypes_js_1.SignerName,
    signerAccounts: funtypes.ReadonlyArray(wire_types_js_1.EthereumAddress),
    signerAccountError: funtypes.Union(error_js_1.ErrorWithCodeAndOptionalData, funtypes.Undefined),
    signerChain: funtypes.Union(wire_types_js_1.EthereumQuantity, funtypes.Undefined),
    tabIconDetails: exports.TabIconDetails,
    activeSigningAddress: wire_types_js_1.OptionalEthereumAddress,
});
exports.RpcConnectionStatus = funtypes.Union(funtypes.Undefined, funtypes.ReadonlyObject({
    isConnected: funtypes.Boolean,
    lastConnnectionAttempt: wire_types_js_1.EthereumTimestamp,
    rpcNetwork: rpc_js_1.RpcNetwork,
    latestBlock: funtypes.Union(funtypes.Undefined, wire_types_js_1.EthereumBlockHeader),
    retrying: funtypes.Boolean,
}));
exports.PendingChainChangeConfirmationPromise = funtypes.ReadonlyObject({
    website: websiteAccessTypes_js_1.Website,
    popupOrTabId: websiteAccessTypes_js_1.PopupOrTabId,
    request: requests_js_1.InterceptedRequest,
    rpcNetwork: rpc_js_1.RpcNetwork,
    simulationMode: funtypes.Boolean,
});
exports.PendingFetchSimulationStackRequestPromise = funtypes.ReadonlyObject({
    website: websiteAccessTypes_js_1.Website,
    popupOrTabId: websiteAccessTypes_js_1.PopupOrTabId,
    simulationStackVersion: JsonRpc_types_js_1.SimulationStackVersion,
    uniqueRequestIdentifier: requests_js_1.UniqueRequestIdentifier,
});
