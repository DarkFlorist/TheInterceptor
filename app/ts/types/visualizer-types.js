"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InterceptorSimulationExport = exports.InterceptorTransactionStack = exports.InterceptorStackOperation = exports.EditEnsNamedHashWindowState = exports.ModifyAddressWindowState = exports.VisualizedSimulatorState = exports.EthereumSubscriptionsAndFilters = exports.CompleteVisualizedSimulation = exports.VisualizedSimulationState = exports.MaybeSimulatedTransaction = exports.NamedTokenId = exports.SimulationResultState = exports.SimulationUpdatingState = exports.NonSimulatedAndVisualizedTransaction = exports.SimulatedAndVisualizedTransaction = exports.TransactionWithAddressBookEntries = exports.SimulationState = exports.SimulationStateBlock = exports.SimulationStateInputMinimalData = exports.SimulationStateInputMinimalDataBlock = exports.SimulationStateInput = exports.SimulationStateInputBlock = exports.SignedMessageTransaction = exports.WebsiteCreatedEthereumUnsignedTransactionOrFailed = exports.FailedToCreateWebsiteCreatedEthereumUnsignedTransaction = exports.WebsiteCreatedEthereumUnsignedTransaction = exports.SimulatedTransaction = exports.PreSimulationTransaction = exports.ProtectorResults = exports.SimulatedAndVisualizedTransactionBase = exports.NonSimulatedAndVisualizedTransactionBase = exports.BlockTimeManipulationWithNoDelay = exports.BlockTimeManipulation = exports.BlockTimeManipulationDeltaUnit = exports.TokenPriceEstimate = exports.TokenBalancesAfter = void 0;
const funtypes = require("funtypes");
const wire_types_js_1 = require("./wire-types.js");
const JsonRpc_types_js_1 = require("./JsonRpc-types.js");
const requests_js_1 = require("../utils/requests.js");
const addressBookTypes_js_1 = require("./addressBookTypes.js");
const websiteAccessTypes_js_1 = require("./websiteAccessTypes.js");
const personal_message_definitions_js_1 = require("./personal-message-definitions.js");
const rpc_js_1 = require("./rpc.js");
const jsonRpc_signing_types_js_1 = require("./jsonRpc-signing-types.js");
const ethSimulate_types_js_1 = require("./ethSimulate-types.js");
const EnrichedEthereumData_js_1 = require("./EnrichedEthereumData.js");
const error_js_1 = require("./error.js");
exports.TokenBalancesAfter = funtypes.ReadonlyArray(funtypes.ReadonlyObject({
    token: wire_types_js_1.EthereumAddress,
    tokenId: funtypes.Union(wire_types_js_1.EthereumQuantity, funtypes.Undefined),
    owner: wire_types_js_1.EthereumAddress,
    balance: funtypes.Union(wire_types_js_1.EthereumQuantity, funtypes.Undefined),
}));
exports.TokenPriceEstimate = funtypes.ReadonlyObject({
    token: funtypes.ReadonlyObject({
        address: wire_types_js_1.EthereumAddress,
        decimals: wire_types_js_1.EthereumQuantity
    }),
    quoteToken: funtypes.ReadonlyObject({
        address: wire_types_js_1.EthereumAddress,
        decimals: wire_types_js_1.EthereumQuantity
    }),
    price: wire_types_js_1.EthereumQuantity
});
exports.BlockTimeManipulationDeltaUnit = funtypes.Union(funtypes.Literal('Seconds'), funtypes.Literal('Minutes'), funtypes.Literal('Hours'), funtypes.Literal('Days'), funtypes.Literal('Weeks'), funtypes.Literal('Months'), funtypes.Literal('Years'));
exports.BlockTimeManipulation = funtypes.Union(funtypes.ReadonlyObject({
    type: funtypes.Literal('AddToTimestamp'),
    deltaToAdd: wire_types_js_1.EthereumQuantity,
    deltaUnit: exports.BlockTimeManipulationDeltaUnit,
}), funtypes.ReadonlyObject({
    type: funtypes.Literal('SetTimetamp'),
    timeToSet: wire_types_js_1.EthereumQuantity,
}));
exports.BlockTimeManipulationWithNoDelay = funtypes.Union(exports.BlockTimeManipulation, funtypes.ReadonlyObject({
    type: funtypes.Literal('No Delay'),
}));
exports.NonSimulatedAndVisualizedTransactionBase = funtypes.ReadonlyObject({
    website: websiteAccessTypes_js_1.Website,
    created: wire_types_js_1.EthereumTimestamp,
    parsedInputData: EnrichedEthereumData_js_1.EnrichedEthereumInputData,
    transactionIdentifier: wire_types_js_1.EthereumQuantity,
    originalRequestParameters: funtypes.Union(JsonRpc_types_js_1.SendTransactionParams, JsonRpc_types_js_1.SendRawTransactionParams),
    transactionStatus: funtypes.Literal('Failed To Simulate'),
    error: error_js_1.DecodedError
});
exports.SimulatedAndVisualizedTransactionBase = funtypes.Intersect(funtypes.ReadonlyObject({
    website: websiteAccessTypes_js_1.Website,
    created: wire_types_js_1.EthereumTimestamp,
    parsedInputData: EnrichedEthereumData_js_1.EnrichedEthereumInputData,
    transactionIdentifier: wire_types_js_1.EthereumQuantity,
    originalRequestParameters: funtypes.Union(JsonRpc_types_js_1.SendTransactionParams, JsonRpc_types_js_1.SendRawTransactionParams),
    tokenBalancesAfter: exports.TokenBalancesAfter,
    tokenPriceEstimates: funtypes.ReadonlyArray(exports.TokenPriceEstimate),
    tokenPriceQuoteToken: funtypes.Union(addressBookTypes_js_1.Erc20TokenEntry, funtypes.Undefined),
    gasSpent: wire_types_js_1.EthereumQuantity,
    realizedGasPrice: wire_types_js_1.EthereumQuantity,
    quarantine: funtypes.Boolean,
    quarantineReasons: funtypes.ReadonlyArray(funtypes.String),
    events: funtypes.ReadonlyArray(EnrichedEthereumData_js_1.EnrichedEthereumEventWithMetadata),
}), funtypes.Union(funtypes.ReadonlyObject({
    transactionStatus: funtypes.Literal('Transaction Succeeded'),
}), funtypes.ReadonlyObject({
    transactionStatus: funtypes.Literal('Transaction Failed'),
    error: error_js_1.DecodedError
})));
exports.ProtectorResults = funtypes.ReadonlyObject({
    quarantine: funtypes.Boolean,
    quarantineReasons: funtypes.ReadonlyArray(funtypes.String),
});
exports.PreSimulationTransaction = funtypes.ReadonlyObject({
    signedTransaction: wire_types_js_1.EthereumSendableSignedTransaction,
    website: websiteAccessTypes_js_1.Website,
    created: wire_types_js_1.EthereumTimestamp,
    originalRequestParameters: funtypes.Union(JsonRpc_types_js_1.SendTransactionParams, JsonRpc_types_js_1.SendRawTransactionParams),
    transactionIdentifier: wire_types_js_1.EthereumQuantity,
});
exports.SimulatedTransaction = funtypes.ReadonlyObject({
    realizedGasPrice: wire_types_js_1.EthereumQuantity,
    preSimulationTransaction: exports.PreSimulationTransaction,
    ethSimulateV1CallResult: ethSimulate_types_js_1.EthSimulateV1CallResult,
    tokenBalancesAfter: exports.TokenBalancesAfter,
});
exports.WebsiteCreatedEthereumUnsignedTransaction = funtypes.ReadonlyObject({
    website: websiteAccessTypes_js_1.Website,
    created: wire_types_js_1.EthereumTimestamp,
    originalRequestParameters: JsonRpc_types_js_1.OriginalSendRequestParameters,
    transactionIdentifier: wire_types_js_1.EthereumQuantity,
    success: funtypes.Literal(true),
    transaction: wire_types_js_1.EthereumUnsignedTransaction,
});
exports.FailedToCreateWebsiteCreatedEthereumUnsignedTransaction = funtypes.ReadonlyObject({
    website: websiteAccessTypes_js_1.Website,
    created: wire_types_js_1.EthereumTimestamp,
    originalRequestParameters: JsonRpc_types_js_1.OriginalSendRequestParameters,
    transactionIdentifier: wire_types_js_1.EthereumQuantity,
    success: funtypes.Literal(false),
    error: error_js_1.ErrorWithCodeAndOptionalData
});
exports.WebsiteCreatedEthereumUnsignedTransactionOrFailed = funtypes.Union(exports.WebsiteCreatedEthereumUnsignedTransaction, exports.FailedToCreateWebsiteCreatedEthereumUnsignedTransaction);
exports.SignedMessageTransaction = funtypes.ReadonlyObject({
    website: websiteAccessTypes_js_1.Website,
    created: wire_types_js_1.EthereumTimestamp,
    fakeSignedFor: wire_types_js_1.EthereumAddress,
    originalRequestParameters: jsonRpc_signing_types_js_1.SignMessageParams,
    request: requests_js_1.InterceptedRequest,
    simulationMode: funtypes.Boolean,
    messageIdentifier: wire_types_js_1.EthereumQuantity,
});
exports.SimulationStateInputBlock = funtypes.ReadonlyObject({
    stateOverrides: ethSimulate_types_js_1.StateOverrides,
    transactions: funtypes.ReadonlyArray(exports.PreSimulationTransaction),
    signedMessages: funtypes.ReadonlyArray(exports.SignedMessageTransaction),
    blockTimeManipulation: exports.BlockTimeManipulation,
    simulateWithZeroBaseFee: funtypes.Boolean,
});
exports.SimulationStateInput = funtypes.ReadonlyArray(exports.SimulationStateInputBlock);
exports.SimulationStateInputMinimalDataBlock = funtypes.ReadonlyObject({
    stateOverrides: ethSimulate_types_js_1.StateOverrides,
    transactions: funtypes.ReadonlyArray(funtypes.ReadonlyObject({ signedTransaction: wire_types_js_1.EthereumSendableSignedTransaction })),
    signedMessages: funtypes.ReadonlyArray(exports.SignedMessageTransaction),
    blockTimeManipulation: exports.BlockTimeManipulation,
    simulateWithZeroBaseFee: funtypes.Boolean,
});
exports.SimulationStateInputMinimalData = funtypes.ReadonlyArray(exports.SimulationStateInputMinimalDataBlock);
exports.SimulationStateBlock = funtypes.ReadonlyObject({
    stateOverrides: ethSimulate_types_js_1.StateOverrides,
    simulatedTransactions: funtypes.ReadonlyArray(exports.SimulatedTransaction),
    signedMessages: funtypes.ReadonlyArray(exports.SignedMessageTransaction),
    blockTimestamp: wire_types_js_1.EthereumTimestamp,
    blockTimeManipulation: exports.BlockTimeManipulation,
    blockBaseFeePerGas: wire_types_js_1.EthereumQuantity,
});
const SimulationStateSuccess = funtypes.ReadonlyObject({
    success: funtypes.Literal(true),
    simulationStateInput: exports.SimulationStateInput,
    simulatedBlocks: funtypes.ReadonlyArray(exports.SimulationStateBlock),
    blockNumber: wire_types_js_1.EthereumQuantity,
    blockTimestamp: wire_types_js_1.EthereumTimestamp,
    baseFeePerGas: wire_types_js_1.EthereumQuantity,
    simulationConductedTimestamp: wire_types_js_1.EthereumTimestamp,
    rpcNetwork: rpc_js_1.RpcNetwork,
});
exports.SimulationState = funtypes.Union(SimulationStateSuccess, funtypes.ReadonlyObject({
    success: funtypes.Literal(false),
    simulationStateInput: exports.SimulationStateInput,
    jsonRpcError: funtypes.ReadonlyObject({
        jsonrpc: funtypes.Literal('2.0'),
        id: funtypes.Union(funtypes.String, funtypes.Number),
        error: error_js_1.ErrorWithCodeAndOptionalData
    }),
    blockNumber: wire_types_js_1.EthereumQuantity,
    blockTimestamp: wire_types_js_1.EthereumTimestamp,
    baseFeePerGas: wire_types_js_1.EthereumQuantity,
    simulationConductedTimestamp: wire_types_js_1.EthereumTimestamp,
    rpcNetwork: rpc_js_1.RpcNetwork,
}));
exports.TransactionWithAddressBookEntries = funtypes.Intersect(funtypes.ReadonlyObject({
    from: addressBookTypes_js_1.AddressBookEntry,
    to: funtypes.Union(addressBookTypes_js_1.AddressBookEntry, funtypes.Undefined),
    value: wire_types_js_1.EthereumQuantity,
    input: wire_types_js_1.EthereumData,
    rpcNetwork: rpc_js_1.RpcNetwork,
    hash: wire_types_js_1.EthereumQuantity,
    gas: wire_types_js_1.EthereumQuantity,
    nonce: wire_types_js_1.EthereumQuantity,
}), funtypes.Union(funtypes.ReadonlyObject({
    type: funtypes.Union(funtypes.Literal('1559'), funtypes.Literal('7702')),
    maxFeePerGas: wire_types_js_1.EthereumQuantity,
    maxPriorityFeePerGas: wire_types_js_1.EthereumQuantity,
}), funtypes.ReadonlyObject({
    type: funtypes.Literal('4844'),
    maxFeePerGas: wire_types_js_1.EthereumQuantity,
    maxPriorityFeePerGas: wire_types_js_1.EthereumQuantity,
    maxFeePerBlobGas: wire_types_js_1.EthereumQuantity,
    blobVersionedHashes: funtypes.ReadonlyArray(wire_types_js_1.EthereumBytes32),
}), funtypes.ReadonlyObject({ type: funtypes.Union(funtypes.Literal('legacy'), funtypes.Literal('2930')) })));
exports.SimulatedAndVisualizedTransaction = funtypes.Intersect(exports.SimulatedAndVisualizedTransactionBase, funtypes.ReadonlyObject({ transaction: exports.TransactionWithAddressBookEntries }));
exports.NonSimulatedAndVisualizedTransaction = funtypes.Intersect(exports.NonSimulatedAndVisualizedTransactionBase, funtypes.ReadonlyObject({ transaction: exports.TransactionWithAddressBookEntries }));
exports.SimulationUpdatingState = funtypes.Union(funtypes.Literal('updating'), funtypes.Literal('done'), funtypes.Literal('failed'));
exports.SimulationResultState = funtypes.Union(funtypes.Literal('done'), funtypes.Literal('invalid'), funtypes.Literal('corrupted'));
exports.NamedTokenId = funtypes.ReadonlyObject({
    tokenAddress: wire_types_js_1.EthereumAddress,
    tokenId: wire_types_js_1.EthereumQuantity,
    tokenIdName: funtypes.String
});
exports.MaybeSimulatedTransaction = funtypes.Union(exports.NonSimulatedAndVisualizedTransaction, exports.SimulatedAndVisualizedTransaction);
exports.VisualizedSimulationState = funtypes.Union(funtypes.ReadonlyObject({
    success: funtypes.Literal(true),
    visualizedBlocks: funtypes.ReadonlyArray(funtypes.ReadonlyObject({
        simulatedAndVisualizedTransactions: funtypes.ReadonlyArray(exports.SimulatedAndVisualizedTransaction),
        visualizedPersonalSignRequests: funtypes.ReadonlyArray(personal_message_definitions_js_1.VisualizedPersonalSignRequest),
        blockTimeManipulation: exports.BlockTimeManipulation
    }))
}), funtypes.ReadonlyObject({
    success: funtypes.Literal(false),
    jsonRpcError: JsonRpc_types_js_1.JsonRpcErrorResponse,
    visualizedBlocks: funtypes.ReadonlyArray(funtypes.ReadonlyObject({
        simulatedAndVisualizedTransactions: funtypes.ReadonlyArray(exports.NonSimulatedAndVisualizedTransaction),
        visualizedPersonalSignRequests: funtypes.ReadonlyArray(personal_message_definitions_js_1.VisualizedPersonalSignRequest),
        blockTimeManipulation: exports.BlockTimeManipulation
    }))
}));
exports.CompleteVisualizedSimulation = funtypes.ReadonlyObject({
    addressBookEntries: funtypes.ReadonlyArray(addressBookTypes_js_1.AddressBookEntry),
    tokenPriceEstimates: funtypes.ReadonlyArray(exports.TokenPriceEstimate),
    tokenPriceQuoteToken: funtypes.Union(funtypes.Undefined, addressBookTypes_js_1.Erc20TokenEntry),
    namedTokenIds: funtypes.ReadonlyArray(exports.NamedTokenId),
    simulationState: funtypes.Union(exports.SimulationState, funtypes.Undefined),
    simulationUpdatingState: exports.SimulationUpdatingState,
    simulationResultState: exports.SimulationResultState,
    simulationId: funtypes.Number,
    visualizedSimulationState: exports.VisualizedSimulationState,
    numberOfAddressesMadeRich: funtypes.Number,
});
const NewHeadsSubscription = funtypes.ReadonlyObject({
    type: funtypes.Literal('newHeads'),
    subscriptionOrFilterId: funtypes.String,
    params: JsonRpc_types_js_1.EthSubscribeParams,
    subscriptionCreatorSocket: requests_js_1.WebsiteSocket,
});
const NewEthfilter = funtypes.ReadonlyObject({
    type: funtypes.Literal('eth_newFilter'),
    subscriptionOrFilterId: funtypes.String,
    params: JsonRpc_types_js_1.EthNewFilter,
    subscriptionCreatorSocket: requests_js_1.WebsiteSocket,
    calledInlastBlock: wire_types_js_1.EthereumQuantity,
});
exports.EthereumSubscriptionsAndFilters = funtypes.ReadonlyArray(funtypes.Union(NewEthfilter, NewHeadsSubscription));
exports.VisualizedSimulatorState = funtypes.ReadonlyObject({
    addressBookEntries: funtypes.ReadonlyArray(addressBookTypes_js_1.AddressBookEntry),
    tokenPriceEstimates: funtypes.ReadonlyArray(exports.TokenPriceEstimate),
    tokenPriceQuoteToken: funtypes.Union(addressBookTypes_js_1.Erc20TokenEntry, funtypes.Undefined),
    namedTokenIds: funtypes.ReadonlyArray(exports.NamedTokenId),
    simulationState: funtypes.Union(exports.SimulationState),
    visualizedSimulationState: exports.VisualizedSimulationState,
});
const ModifyAddressWindowStateError = funtypes.Union(funtypes.ReadonlyObject({ message: funtypes.String, blockEditing: funtypes.Boolean }), funtypes.Undefined);
exports.ModifyAddressWindowState = funtypes.ReadonlyObject({
    windowStateId: funtypes.String,
    incompleteAddressBookEntry: addressBookTypes_js_1.IncompleteAddressBookEntry,
    errorState: ModifyAddressWindowStateError,
});
exports.EditEnsNamedHashWindowState = funtypes.ReadonlyObject({
    type: funtypes.Union(funtypes.Literal('nameHash'), funtypes.Literal('labelHash')),
    nameHash: wire_types_js_1.EthereumBytes32,
    name: funtypes.Union(funtypes.Undefined, funtypes.String)
});
exports.InterceptorStackOperation = funtypes.Union(funtypes.ReadonlyObject({
    type: funtypes.Literal('Transaction'),
    preSimulationTransaction: exports.PreSimulationTransaction
}), funtypes.ReadonlyObject({
    type: funtypes.Literal('Message'),
    signedMessageTransaction: exports.SignedMessageTransaction
}), funtypes.ReadonlyObject({
    type: funtypes.Literal('TimeManipulation'),
    blockTimeManipulation: exports.BlockTimeManipulation
}));
exports.InterceptorTransactionStack = funtypes.ReadonlyObject({
    operations: funtypes.ReadonlyArray(exports.InterceptorStackOperation),
});
exports.InterceptorSimulationExport = funtypes.ReadonlyObject({
    name: funtypes.Literal('Interceptor Simulation Export'),
    version: funtypes.Literal('1.0.0'),
    eth_simulateV1: ethSimulate_types_js_1.EthSimulateV1Params,
    interceptorSimulateStack: exports.InterceptorTransactionStack,
});
