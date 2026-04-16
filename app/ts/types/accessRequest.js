"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PendingTransactionOrSignableMessage = exports.PendingTransaction = exports.SimulatedPendingTransaction = exports.ConfirmTransactionTransactionSingleVisualization = exports.PendingAccessRequests = exports.PendingAccessRequest = void 0;
const funtypes = require("funtypes");
const websiteAccessTypes_js_1 = require("./websiteAccessTypes.js");
const addressBookTypes_js_1 = require("./addressBookTypes.js");
const wire_types_js_1 = require("./wire-types.js");
const signerTypes_js_1 = require("./signerTypes.js");
const requests_js_1 = require("../utils/requests.js");
const visualizer_types_js_1 = require("./visualizer-types.js");
const personal_message_definitions_js_1 = require("./personal-message-definitions.js");
const JsonRpc_types_js_1 = require("./JsonRpc-types.js");
const jsonRpc_signing_types_js_1 = require("./jsonRpc-signing-types.js");
const error_js_1 = require("./error.js");
exports.PendingAccessRequest = funtypes.ReadonlyObject({
    website: websiteAccessTypes_js_1.Website,
    requestAccessToAddress: funtypes.Union(addressBookTypes_js_1.AddressBookEntry, funtypes.Undefined),
    originalRequestAccessToAddress: funtypes.Union(addressBookTypes_js_1.AddressBookEntry, funtypes.Undefined),
    associatedAddresses: funtypes.ReadonlyArray(addressBookTypes_js_1.AddressBookEntry),
    signerAccounts: funtypes.ReadonlyArray(wire_types_js_1.EthereumAddress),
    signerName: signerTypes_js_1.SignerName,
    simulationMode: funtypes.Boolean,
    popupOrTabId: websiteAccessTypes_js_1.PopupOrTabId,
    socket: requests_js_1.WebsiteSocket,
    request: funtypes.Union(requests_js_1.InterceptedRequest, funtypes.Undefined),
    activeAddress: wire_types_js_1.OptionalEthereumAddress,
    accessRequestId: funtypes.String,
}).asReadonly();
exports.PendingAccessRequests = funtypes.ReadonlyArray(exports.PendingAccessRequest);
const ConfirmTransactionSimulationBaseData = funtypes.ReadonlyObject({
    activeAddress: wire_types_js_1.EthereumAddress,
    simulationMode: funtypes.Boolean,
    simulationStartedTimestamp: wire_types_js_1.EthereumTimestamp,
    uniqueRequestIdentifier: requests_js_1.UniqueRequestIdentifier,
    transactionToSimulate: visualizer_types_js_1.WebsiteCreatedEthereumUnsignedTransactionOrFailed,
    signerName: signerTypes_js_1.SignerName,
});
const ConfirmTransactionDialogState = funtypes.Intersect(ConfirmTransactionSimulationBaseData, funtypes.ReadonlyObject({
    addressBookEntries: funtypes.ReadonlyArray(addressBookTypes_js_1.AddressBookEntry),
    tokenPriceEstimates: funtypes.ReadonlyArray(visualizer_types_js_1.TokenPriceEstimate),
    namedTokenIds: funtypes.ReadonlyArray(visualizer_types_js_1.NamedTokenId),
    simulationState: visualizer_types_js_1.SimulationState,
    activeAddress: wire_types_js_1.OptionalEthereumAddress,
    visualizedSimulationState: visualizer_types_js_1.VisualizedSimulationState
}));
const ConfirmTransactionSimulationStateChanged = funtypes.ReadonlyObject({
    statusCode: funtypes.Literal('success'),
    data: ConfirmTransactionDialogState
});
const ConfirmTransactionSimulationFailed = funtypes.ReadonlyObject({
    statusCode: funtypes.Literal('failed'),
    data: funtypes.Intersect(ConfirmTransactionSimulationBaseData, funtypes.ReadonlyObject({
        error: error_js_1.DecodedError,
        simulationState: funtypes.ReadonlyObject({
            blockNumber: wire_types_js_1.EthereumQuantity,
            simulationConductedTimestamp: wire_types_js_1.EthereumTimestamp,
        })
    }))
}).asReadonly();
exports.ConfirmTransactionTransactionSingleVisualization = funtypes.Union(ConfirmTransactionSimulationFailed, ConfirmTransactionSimulationStateChanged);
const PendingTransactionApprovalStatus = funtypes.Union(funtypes.ReadonlyObject({ status: funtypes.Union(funtypes.Literal('WaitingForUser'), funtypes.Literal('WaitingForSigner')) }), funtypes.ReadonlyObject({
    status: funtypes.Union(funtypes.Literal('SignerError')),
    code: funtypes.Number,
    message: funtypes.String,
}));
const SimulatedPendingTransactionBase = funtypes.ReadonlyObject({
    type: funtypes.Literal('Transaction'),
    popupOrTabId: websiteAccessTypes_js_1.PopupOrTabId,
    originalRequestParameters: JsonRpc_types_js_1.OriginalSendRequestParameters,
    uniqueRequestIdentifier: requests_js_1.UniqueRequestIdentifier,
    simulationMode: funtypes.Boolean,
    activeAddress: wire_types_js_1.EthereumAddress,
    created: wire_types_js_1.EthereumTimestamp,
    transactionIdentifier: wire_types_js_1.EthereumQuantity,
    website: websiteAccessTypes_js_1.Website,
    approvalStatus: PendingTransactionApprovalStatus,
});
exports.SimulatedPendingTransaction = funtypes.Intersect(SimulatedPendingTransactionBase, funtypes.ReadonlyObject({ popupVisualisation: exports.ConfirmTransactionTransactionSingleVisualization }), funtypes.Union(funtypes.ReadonlyObject({
    transactionOrMessageCreationStatus: funtypes.Literal('Simulated'),
    transactionToSimulate: visualizer_types_js_1.WebsiteCreatedEthereumUnsignedTransaction,
}), funtypes.ReadonlyObject({
    transactionOrMessageCreationStatus: funtypes.Literal('FailedToSimulate'),
    transactionToSimulate: visualizer_types_js_1.FailedToCreateWebsiteCreatedEthereumUnsignedTransaction,
})));
const CraftingTransactionPendingTransaction = funtypes.Intersect(SimulatedPendingTransactionBase, funtypes.ReadonlyObject({ transactionOrMessageCreationStatus: funtypes.Literal('Crafting') }));
const WaitingForSimulationPendingTransaction = funtypes.Intersect(SimulatedPendingTransactionBase, funtypes.ReadonlyObject({
    transactionToSimulate: visualizer_types_js_1.WebsiteCreatedEthereumUnsignedTransaction,
    transactionOrMessageCreationStatus: funtypes.Literal('Simulating')
}));
exports.PendingTransaction = funtypes.Union(CraftingTransactionPendingTransaction, WaitingForSimulationPendingTransaction, exports.SimulatedPendingTransaction);
const PendingSignableMessage = funtypes.Intersect(funtypes.ReadonlyObject({
    type: funtypes.Literal('SignableMessage'),
    popupOrTabId: websiteAccessTypes_js_1.PopupOrTabId,
    originalRequestParameters: jsonRpc_signing_types_js_1.SignMessageParams,
    simulationMode: funtypes.Boolean,
    uniqueRequestIdentifier: requests_js_1.UniqueRequestIdentifier,
    signedMessageTransaction: visualizer_types_js_1.SignedMessageTransaction,
    created: wire_types_js_1.EthereumTimestamp,
    website: websiteAccessTypes_js_1.Website,
    activeAddress: wire_types_js_1.EthereumAddress,
    approvalStatus: PendingTransactionApprovalStatus,
}), funtypes.Union(funtypes.ReadonlyObject({ transactionOrMessageCreationStatus: funtypes.Literal('Simulated'), visualizedPersonalSignRequest: personal_message_definitions_js_1.VisualizedPersonalSignRequest }), funtypes.ReadonlyObject({ transactionOrMessageCreationStatus: funtypes.Union(funtypes.Literal('Crafting'), funtypes.Literal('Simulating')) })));
exports.PendingTransactionOrSignableMessage = funtypes.Union(PendingSignableMessage, exports.PendingTransaction);
