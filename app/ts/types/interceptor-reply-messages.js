"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PopupReplyOption = exports.PopupMessageReplyRequests = exports.RequestAbiAndNameFromBlockExplorer = exports.PopupRequestsReplies = exports.RequestIdentifyAddress = exports.SimulationMetadata = exports.EnrichedRichListElement = exports.UnexpectedErrorOccured = void 0;
const funtypes = require("funtypes");
const addressBookTypes_js_1 = require("../types/addressBookTypes.js");
const wire_types_js_1 = require("./wire-types.js");
const visualizer_types_js_1 = require("./visualizer-types.js");
exports.UnexpectedErrorOccured = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_UnexpectedErrorOccured'),
    data: funtypes.ReadonlyObject({ timestamp: wire_types_js_1.EthereumTimestamp, message: funtypes.String })
});
exports.EnrichedRichListElement = funtypes.ReadonlyObject({
    addressBookEntry: addressBookTypes_js_1.AddressBookEntry,
    makingRich: funtypes.Boolean,
    type: funtypes.Union(funtypes.Literal('PreviousActiveAddress'), funtypes.Literal('UserAdded'), funtypes.Literal('CurrentActiveAddress')),
});
const RequestMakeMeRichDataReply = funtypes.ReadonlyObject({
    type: funtypes.Literal('RequestMakeMeRichDataReply'),
    richList: funtypes.ReadonlyArray(exports.EnrichedRichListElement),
    makeCurrentAddressRich: funtypes.Boolean,
});
const RequestActiveAddressesReply = funtypes.ReadonlyObject({
    type: funtypes.Literal('RequestActiveAddressesReply'),
    activeAddresses: funtypes.ReadonlyArray(addressBookTypes_js_1.AddressBookEntry)
});
const RequestSimulationModeReply = funtypes.ReadonlyObject({
    type: funtypes.Literal('RequestSimulationModeReply'),
    simulationMode: funtypes.Boolean
});
const RequestLatestUnexpectedErrorReply = funtypes.ReadonlyObject({
    type: funtypes.Literal('RequestLatestUnexpectedErrorReply'),
    latestUnexpectedError: funtypes.Union(funtypes.Undefined, exports.UnexpectedErrorOccured),
});
const RequestInterceptorSimulationInputReply = funtypes.ReadonlyObject({
    type: funtypes.Literal('RequestInterceptorSimulationInputReply'),
    ethSimulateV1InputString: funtypes.String
});
const RequestCompleteVisualizedSimulationReply = funtypes.ReadonlyObject({
    type: funtypes.Literal('RequestCompleteVisualizedSimulationReply'),
    visualizedSimulatorState: funtypes.Union(visualizer_types_js_1.CompleteVisualizedSimulation, funtypes.Undefined)
});
exports.SimulationMetadata = funtypes.ReadonlyObject({
    namedTokenIds: funtypes.ReadonlyArray(visualizer_types_js_1.NamedTokenId),
    addressBookEntries: funtypes.ReadonlyArray(addressBookTypes_js_1.AddressBookEntry),
    ens: funtypes.ReadonlyObject({
        ensNameHashes: funtypes.ReadonlyArray(funtypes.ReadonlyObject({
            nameHash: wire_types_js_1.EthereumQuantity,
            name: funtypes.Union(funtypes.String, funtypes.Undefined)
        })),
        ensLabelHashes: funtypes.ReadonlyArray(funtypes.ReadonlyObject({
            labelHash: wire_types_js_1.EthereumQuantity,
            label: funtypes.Union(funtypes.String, funtypes.Undefined)
        }))
    })
});
const RequestSimulationMetadataReply = funtypes.ReadonlyObject({
    type: funtypes.Literal('RequestSimulationMetadata'),
    metadata: exports.SimulationMetadata
});
const RequestAbiAndNameFromBlockExplorerReply = funtypes.ReadonlyObject({
    type: funtypes.Literal('RequestAbiAndNameFromBlockExplorer'),
    data: funtypes.Union(funtypes.ReadonlyObject({
        success: funtypes.Literal(true),
        abi: funtypes.Union(funtypes.String, funtypes.Undefined),
        contractName: funtypes.String,
    }), funtypes.ReadonlyObject({
        success: funtypes.Literal(false),
        error: funtypes.String,
    }))
}).asReadonly();
exports.RequestIdentifyAddress = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_requestIdentifyAddress'),
    data: funtypes.ReadonlyObject({
        address: wire_types_js_1.EthereumAddress
    })
}).asReadonly();
const RequestIdentifyAddressReply = funtypes.ReadonlyObject({
    type: funtypes.Literal('RequestIdentifyAddress'),
    data: funtypes.ReadonlyObject({
        addressBookEntry: addressBookTypes_js_1.AddressBookEntry
    })
}).asReadonly();
exports.PopupRequestsReplies = {
    popup_requestMakeMeRichData: RequestMakeMeRichDataReply,
    popup_requestActiveAddresses: RequestActiveAddressesReply,
    popup_requestSimulationMode: RequestSimulationModeReply,
    popup_requestLatestUnexpectedError: RequestLatestUnexpectedErrorReply,
    popup_requestInterceptorSimulationInput: RequestInterceptorSimulationInputReply,
    popup_requestCompleteVisualizedSimulation: RequestCompleteVisualizedSimulationReply,
    popup_requestSimulationMetadata: RequestSimulationMetadataReply,
    popup_requestAbiAndNameFromBlockExplorer: RequestAbiAndNameFromBlockExplorerReply,
    popup_requestIdentifyAddress: RequestIdentifyAddressReply,
};
exports.RequestAbiAndNameFromBlockExplorer = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_requestAbiAndNameFromBlockExplorer'),
    data: funtypes.ReadonlyObject({ address: wire_types_js_1.EthereumAddress, chainId: addressBookTypes_js_1.ChainIdWithUniversal })
}).asReadonly();
exports.PopupMessageReplyRequests = funtypes.Union(exports.RequestAbiAndNameFromBlockExplorer, exports.RequestIdentifyAddress, funtypes.ReadonlyObject({ method: funtypes.Literal('popup_requestMakeMeRichData') }), funtypes.ReadonlyObject({ method: funtypes.Literal('popup_requestActiveAddresses') }), funtypes.ReadonlyObject({ method: funtypes.Literal('popup_requestSimulationMode') }), funtypes.ReadonlyObject({ method: funtypes.Literal('popup_requestLatestUnexpectedError') }), funtypes.ReadonlyObject({ method: funtypes.Literal('popup_requestInterceptorSimulationInput') }), funtypes.ReadonlyObject({ method: funtypes.Literal('popup_requestCompleteVisualizedSimulation') }), funtypes.ReadonlyObject({ method: funtypes.Literal('popup_requestSimulationMetadata') }));
exports.PopupReplyOption = funtypes.Union(RequestMakeMeRichDataReply, RequestActiveAddressesReply, RequestSimulationModeReply, RequestLatestUnexpectedErrorReply, RequestInterceptorSimulationInputReply, RequestCompleteVisualizedSimulationReply, RequestSimulationMetadataReply, RequestAbiAndNameFromBlockExplorerReply, RequestIdentifyAddressReply, funtypes.Undefined);
