"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RetrieveWebsiteAccessFilter = exports.ChangeAddOrModifyAddressWindowState = exports.SimulateGovernanceContractExecution = exports.SimulateExecutionReply = exports.SimulateExecutionReplyData = exports.GovernanceVoteInputParameters = exports.ChainChangeConfirmation = exports.ChangeActiveChain = exports.SetRpcList = exports.ImportSettingsReply = exports.ImportSettings = exports.ChangeSettings = exports.UpdateHomePage = exports.Settings = exports.InterceptorAccess = exports.InterceptorAccessReply = exports.UpdateConfirmTransactionDialogPendingTransactions = exports.UpdateConfirmTransactionDialog = exports.GetAddressBookDataReply = exports.GetAddressBookData = exports.GetAddressBookDataFilter = exports.SignerReply = exports.ConnectedToSigner = exports.SignerChainChangeConfirmation = exports.RemoveWebsiteAccess = exports.RemoveWebsiteAddressAccess = exports.AllowOrPreventAddressAccessForWebsite = exports.BlockOrAllowExternalRequests = exports.ChangeInterceptorAccess = exports.RemoveTransaction = exports.TransactionOrMessageIdentifier = exports.EnableSimulationMode = exports.RequestAccountsFromSigner = exports.ChangePage = exports.AddOrEditAddressBookEntry = exports.RemoveAddressBookEntry = exports.AddressBookCategory = exports.ModifyMakeMeRich = exports.ChangeActiveAddress = exports.InterceptorAccessChangeAddress = exports.InterceptorAccessRefresh = exports.TransactionConfirmation = exports.InterceptorMessageToInpage = exports.InterceptedRequestForward = exports.SubscriptionReplyOrCallBack = exports.RPCReply = exports.GetSimulationStackReply = exports.InpageScriptCallBack = exports.InpageScriptRequest = exports.WalletSwitchEthereumChainReply = void 0;
exports.MessageToPopup = exports.PopupMessage = exports.MessageToPopupPayload = exports.ImportSimulationStack = exports.FetchSimulationStackRequestConfirmation = exports.SetTransactionOrMessageBlockTimeManipulator = exports.ChangePreSimulationBlockTimeManipulation = exports.ForceSetGasLimitForTransaction = exports.SetEnsNameForHash = exports.DisableInterceptor = exports.OpenWebPage = exports.RetrieveWebsiteAccess = void 0;
const funtypes = require("funtypes");
const user_interface_types_js_1 = require("./user-interface-types.js");
const wire_types_js_1 = require("./wire-types.js");
const visualizer_types_js_1 = require("./visualizer-types.js");
const personal_message_definitions_js_1 = require("./personal-message-definitions.js");
const requests_js_1 = require("../utils/requests.js");
const JsonRpc_types_js_1 = require("./JsonRpc-types.js");
const addressBookTypes_js_1 = require("./addressBookTypes.js");
const exportedSettingsTypes_js_1 = require("./exportedSettingsTypes.js");
const websiteAccessTypes_js_1 = require("./websiteAccessTypes.js");
const signerTypes_js_1 = require("./signerTypes.js");
const accessRequest_js_1 = require("./accessRequest.js");
const rpc_js_1 = require("./rpc.js");
const jsonRpc_signing_types_js_1 = require("./jsonRpc-signing-types.js");
const simulationStackTypes_js_1 = require("./simulationStackTypes.js");
const interceptor_reply_messages_js_1 = require("./interceptor-reply-messages.js");
const error_js_1 = require("./error.js");
const WalletSwitchEthereumChainReplyParams = funtypes.Tuple(funtypes.Union(funtypes.ReadonlyObject({
    accept: funtypes.Literal(true),
    chainId: wire_types_js_1.EthereumQuantity,
}), funtypes.ReadonlyObject({
    accept: funtypes.Literal(false),
    chainId: wire_types_js_1.EthereumQuantity,
    error: error_js_1.ErrorWithCodeAndOptionalData
})));
exports.WalletSwitchEthereumChainReply = funtypes.ReadonlyObject({
    method: funtypes.Literal('wallet_switchEthereumChain_reply'),
    params: WalletSwitchEthereumChainReplyParams
}).asReadonly();
const InpageScriptRequestWithoutIdentifier = funtypes.Union(funtypes.ReadonlyObject({ type: funtypes.Literal('doNotReply') }), funtypes.ReadonlyObject({ method: funtypes.Literal('signer_connection_status_changed'), result: funtypes.Literal('0x') }), funtypes.ReadonlyObject({ method: funtypes.Literal('signer_reply'), result: funtypes.Unknown }), funtypes.ReadonlyObject({ method: funtypes.Literal('eth_accounts_reply'), result: funtypes.Literal('0x') }), funtypes.ReadonlyObject({ method: funtypes.Literal('signer_chainChanged'), result: funtypes.Literal('0x') }), funtypes.ReadonlyObject({ method: funtypes.Literal('connected_to_signer'), result: funtypes.ReadonlyObject({ metamaskCompatibilityMode: funtypes.Boolean, activeAddress: funtypes.String }) }), funtypes.ReadonlyObject({ method: funtypes.Literal('wallet_switchEthereumChain_reply'), result: funtypes.Literal('0x') }));
exports.InpageScriptRequest = funtypes.Intersect(funtypes.ReadonlyObject({ uniqueRequestIdentifier: requests_js_1.UniqueRequestIdentifier, type: funtypes.Literal('result') }), InpageScriptRequestWithoutIdentifier);
const ErrorReturn = funtypes.ReadonlyObject({
    method: funtypes.String,
    error: error_js_1.ErrorWithCodeAndOptionalData
});
exports.InpageScriptCallBack = funtypes.Union(ErrorReturn, funtypes.ReadonlyObject({ method: funtypes.Literal('request_signer_chainId'), result: funtypes.ReadonlyTuple() }), funtypes.ReadonlyObject({ method: funtypes.Literal('request_signer_to_wallet_switchEthereumChain'), result: wire_types_js_1.EthereumQuantity }), funtypes.ReadonlyObject({ method: funtypes.Literal('request_signer_to_eth_requestAccounts'), result: funtypes.ReadonlyTuple() }), funtypes.ReadonlyObject({ method: funtypes.Literal('request_signer_to_eth_accounts'), result: funtypes.ReadonlyTuple() }), funtypes.ReadonlyObject({ method: funtypes.Literal('disconnect'), result: funtypes.ReadonlyTuple() }), funtypes.ReadonlyObject({ method: funtypes.Literal('connect'), result: funtypes.ReadonlyTuple(wire_types_js_1.EthereumQuantity) }), funtypes.ReadonlyObject({ method: funtypes.Literal('accountsChanged'), result: funtypes.ReadonlyArray(wire_types_js_1.EthereumAddress) }), funtypes.ReadonlyObject({ method: funtypes.Literal('chainChanged'), result: wire_types_js_1.EthereumQuantity }));
exports.GetSimulationStackReply = funtypes.Union(funtypes.ReadonlyObject({ version: funtypes.Union(funtypes.Literal('1.0.0'), funtypes.Literal('1.0.1')), payload: simulationStackTypes_js_1.GetSimulationStackReplyV1 }), funtypes.ReadonlyObject({ version: funtypes.Literal('2.0.0'), payload: simulationStackTypes_js_1.GetSimulationStackReplyV2 }));
const NonForwardingRPCRequestSuccessfullReturnValue = funtypes.Union(funtypes.ReadonlyObject({ method: funtypes.Literal('eth_getBlockByNumber'), result: JsonRpc_types_js_1.GetBlockReturn }), funtypes.ReadonlyObject({ method: funtypes.Literal('eth_getBlockByHash'), result: JsonRpc_types_js_1.GetBlockReturn }), funtypes.ReadonlyObject({ method: funtypes.Literal('eth_getBalance'), result: wire_types_js_1.EthereumQuantity }), funtypes.ReadonlyObject({ method: funtypes.Literal('eth_estimateGas'), result: wire_types_js_1.EthereumQuantity }), funtypes.ReadonlyObject({ method: funtypes.Literal('eth_getTransactionByHash'), result: funtypes.Union(wire_types_js_1.EthereumSignedTransactionWithBlockData, funtypes.Null) }), funtypes.ReadonlyObject({ method: funtypes.Literal('eth_getTransactionReceipt'), result: JsonRpc_types_js_1.EthTransactionReceiptResponse }), funtypes.ReadonlyObject({ method: funtypes.Literal('eth_subscribe'), result: funtypes.String }), funtypes.ReadonlyObject({ method: funtypes.Literal('eth_newFilter'), result: funtypes.String }), funtypes.ReadonlyObject({ method: funtypes.Literal('eth_unsubscribe'), result: funtypes.Boolean }), funtypes.ReadonlyObject({ method: funtypes.Literal('eth_uninstallFilter'), result: funtypes.Boolean }), funtypes.ReadonlyObject({ method: funtypes.Literal('eth_chainId'), result: wire_types_js_1.EthereumQuantity }), funtypes.ReadonlyObject({ method: funtypes.Literal('net_version'), result: wire_types_js_1.NonHexBigInt }), funtypes.ReadonlyObject({ method: funtypes.Literal('eth_blockNumber'), result: wire_types_js_1.EthereumQuantity }), funtypes.ReadonlyObject({ method: funtypes.Literal('eth_getCode'), result: wire_types_js_1.EthereumData }), funtypes.ReadonlyObject({ method: funtypes.Literal('wallet_switchEthereumChain'), result: funtypes.Null }), funtypes.ReadonlyObject({ method: funtypes.Literal('eth_accounts'), result: funtypes.ReadonlyArray(wire_types_js_1.EthereumAddress) }), funtypes.ReadonlyObject({ method: funtypes.Literal('wallet_getPermissions'), result: funtypes.ReadonlyTuple(funtypes.ReadonlyObject({ eth_accounts: funtypes.ReadonlyObject({}) })) }), funtypes.ReadonlyObject({ method: funtypes.Literal('eth_gasPrice'), result: wire_types_js_1.EthereumQuantity }), funtypes.ReadonlyObject({ method: funtypes.Literal('eth_getTransactionCount'), result: wire_types_js_1.EthereumQuantity }), funtypes.ReadonlyObject({ method: funtypes.Literal('interceptor_getSimulationStack'), result: exports.GetSimulationStackReply }), funtypes.ReadonlyObject({ method: funtypes.Literal('eth_getLogs'), result: JsonRpc_types_js_1.EthGetLogsResponse }), funtypes.ReadonlyObject({ method: funtypes.Literal('eth_sendRawTransaction'), result: wire_types_js_1.EthereumBytes32 }), funtypes.ReadonlyObject({ method: funtypes.Literal('eth_sendTransaction'), result: wire_types_js_1.EthereumBytes32 }), funtypes.ReadonlyObject({ method: funtypes.Literal('eth_call'), result: wire_types_js_1.EthereumData }), funtypes.ReadonlyObject({ method: funtypes.Union(funtypes.Literal('personal_sign'), funtypes.Literal('eth_signTypedData_v1'), funtypes.Literal('eth_signTypedData_v2'), funtypes.Literal('eth_signTypedData_v3'), funtypes.Literal('eth_signTypedData_v4'), funtypes.Literal('eth_signTypedData')), result: funtypes.String }), funtypes.ReadonlyObject({ method: funtypes.Literal('web3_clientVersion'), result: funtypes.String }), funtypes.ReadonlyObject({ method: funtypes.Literal('eth_feeHistory'), result: JsonRpc_types_js_1.EthGetFeeHistoryResponse }), funtypes.ReadonlyObject({ method: funtypes.Literal('eth_getFilterChanges'), result: JsonRpc_types_js_1.EthGetLogsResponse }), funtypes.ReadonlyObject({ method: funtypes.Literal('eth_getFilterLogs'), result: JsonRpc_types_js_1.EthGetLogsResponse }));
const SubscriptionReturnValue = funtypes.ReadonlyObject({
    method: funtypes.Literal('newHeads'),
    result: funtypes.ReadonlyObject({
        subscription: funtypes.Literal('newHeads'),
        result: wire_types_js_1.EthereumBlockHeaderWithTransactionHashes
    })
});
const NonForwardingRPCRequestReturnValue = funtypes.Intersect(funtypes.ReadonlyObject({ type: funtypes.Literal('result') }), funtypes.Union(NonForwardingRPCRequestSuccessfullReturnValue, ErrorReturn));
const ForwardToWallet = funtypes.Intersect(// forward directly to wallet
funtypes.ReadonlyObject({ type: funtypes.Literal('forwardToSigner') }), funtypes.Union(JsonRpc_types_js_1.SendRawTransactionParams, JsonRpc_types_js_1.SendTransactionParams, jsonRpc_signing_types_js_1.PersonalSignParams, jsonRpc_signing_types_js_1.SignTypedDataParams, jsonRpc_signing_types_js_1.OldSignTypedDataParams, JsonRpc_types_js_1.WalletAddEthereumChain, JsonRpc_types_js_1.EthGetStorageAtParams));
const ReplyWithSignersReplyForward = funtypes.Intersect(funtypes.ReadonlyObject({
    type: funtypes.Literal('forwardToSigner'),
    replyWithSignersReply: funtypes.Literal(true),
    method: funtypes.String,
}), funtypes.Partial({
    params: funtypes.Unknown,
}));
exports.RPCReply = funtypes.Union(NonForwardingRPCRequestReturnValue, ForwardToWallet, ReplyWithSignersReplyForward, funtypes.ReadonlyObject({ type: funtypes.Literal('doNotReply') }));
exports.SubscriptionReplyOrCallBack = funtypes.Intersect(funtypes.ReadonlyObject({ type: funtypes.Literal('result') }), funtypes.Union(exports.InpageScriptCallBack, funtypes.Intersect(funtypes.ReadonlyObject({
    method: funtypes.String,
    subscription: funtypes.String,
}), SubscriptionReturnValue)));
const InterceptedRequestForwardWithRequestId = funtypes.Intersect(funtypes.ReadonlyObject({ requestId: funtypes.Number }), funtypes.Union(exports.RPCReply, funtypes.Intersect(funtypes.ReadonlyObject({ type: funtypes.Literal('result') }), InpageScriptRequestWithoutIdentifier)));
exports.InterceptedRequestForward = funtypes.Intersect(funtypes.ReadonlyObject({ uniqueRequestIdentifier: requests_js_1.UniqueRequestIdentifier }), funtypes.Union(exports.RPCReply, funtypes.Intersect(funtypes.ReadonlyObject({ type: funtypes.Literal('result') }), InpageScriptRequestWithoutIdentifier)));
exports.InterceptorMessageToInpage = funtypes.Intersect(funtypes.ReadonlyObject({ interceptorApproved: funtypes.Literal(true) }), funtypes.Union(InterceptedRequestForwardWithRequestId, exports.SubscriptionReplyOrCallBack));
const RefreshConfirmTransactionMetadata = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_refreshConfirmTransactionMetadata')
}).asReadonly();
exports.TransactionConfirmation = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_confirmDialog'),
    data: funtypes.Union(funtypes.Intersect(funtypes.ReadonlyObject({
        uniqueRequestIdentifier: requests_js_1.UniqueRequestIdentifier,
    }), funtypes.Union(funtypes.ReadonlyObject({
        action: funtypes.Literal('signerIncluded'),
        signerReply: funtypes.Unknown,
    }), funtypes.ReadonlyObject({
        action: funtypes.Union(funtypes.Literal('accept'), funtypes.Literal('noResponse')),
    }), funtypes.ReadonlyObject({
        action: funtypes.Literal('reject'),
        errorString: funtypes.Union(funtypes.String, funtypes.Undefined),
    }))))
});
exports.InterceptorAccessRefresh = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_interceptorAccessRefresh'),
    data: funtypes.ReadonlyObject({
        socket: requests_js_1.WebsiteSocket,
        accessRequestId: funtypes.String,
        website: websiteAccessTypes_js_1.Website,
        requestAccessToAddress: wire_types_js_1.OptionalEthereumAddress,
    }),
}).asReadonly();
const RefreshInterceptorAccessMetadata = funtypes.ReadonlyObject({ method: funtypes.Literal('popup_refreshInterceptorAccessMetadata') }).asReadonly();
exports.InterceptorAccessChangeAddress = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_interceptorAccessChangeAddress'),
    data: funtypes.ReadonlyObject({
        socket: requests_js_1.WebsiteSocket,
        accessRequestId: funtypes.String,
        website: websiteAccessTypes_js_1.Website,
        requestAccessToAddress: wire_types_js_1.OptionalEthereumAddress,
        newActiveAddress: funtypes.Union(wire_types_js_1.EthereumAddress, funtypes.Literal('signer')),
    }),
}).asReadonly();
exports.ChangeActiveAddress = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_changeActiveAddress'),
    data: funtypes.ReadonlyObject({
        simulationMode: funtypes.Boolean,
        activeAddress: funtypes.Union(wire_types_js_1.EthereumAddress, funtypes.Literal('signer'))
    })
}).asReadonly();
exports.ModifyMakeMeRich = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_modifyMakeMeRich'),
    data: funtypes.ReadonlyObject({
        add: funtypes.Boolean,
        address: funtypes.Union(funtypes.Literal('CurrentAddress'), wire_types_js_1.EthereumAddress),
    })
}).asReadonly();
exports.AddressBookCategory = funtypes.Union(funtypes.Literal('My Active Addresses'), funtypes.Literal('My Contacts'), funtypes.Literal('ERC20 Tokens'), funtypes.Literal('ERC1155 Tokens'), funtypes.Literal('Non Fungible Tokens'), funtypes.Literal('Other Contracts'));
exports.RemoveAddressBookEntry = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_removeAddressBookEntry'),
    data: funtypes.ReadonlyObject({
        address: wire_types_js_1.EthereumAddress,
        addressBookCategory: exports.AddressBookCategory,
        chainId: addressBookTypes_js_1.ChainIdWithUniversal,
    })
}).asReadonly();
exports.AddOrEditAddressBookEntry = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_addOrModifyAddressBookEntry'),
    data: addressBookTypes_js_1.AddressBookEntry,
}).asReadonly();
exports.ChangePage = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_changePage'),
    data: exportedSettingsTypes_js_1.Page,
}).asReadonly();
exports.RequestAccountsFromSigner = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_requestAccountsFromSigner'),
    data: funtypes.Boolean
}).asReadonly();
exports.EnableSimulationMode = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_enableSimulationMode'),
    data: funtypes.Boolean
}).asReadonly();
exports.TransactionOrMessageIdentifier = funtypes.Union(funtypes.ReadonlyObject({ type: funtypes.Literal('Transaction'), transactionIdentifier: wire_types_js_1.EthereumQuantity }), funtypes.ReadonlyObject({ type: funtypes.Literal('Message'), messageIdentifier: wire_types_js_1.EthereumQuantity }));
exports.RemoveTransaction = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_removeTransactionOrSignedMessage'),
    data: exports.TransactionOrMessageIdentifier
}).asReadonly();
const ResetSimulation = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_resetSimulation')
}).asReadonly();
const RefreshSimulation = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_refreshSimulation')
}).asReadonly();
exports.ChangeInterceptorAccess = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_changeInterceptorAccess'),
    data: funtypes.ReadonlyArray(funtypes.ReadonlyObject({
        removed: funtypes.Boolean,
        oldEntry: websiteAccessTypes_js_1.WebsiteAccess,
        newEntry: websiteAccessTypes_js_1.WebsiteAccess
    }))
}).asReadonly();
exports.BlockOrAllowExternalRequests = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_blockOrAllowExternalRequests'),
    data: funtypes.Object({
        website: websiteAccessTypes_js_1.Website,
        shouldBlock: funtypes.Boolean
    })
}).asReadonly();
exports.AllowOrPreventAddressAccessForWebsite = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_allowOrPreventAddressAccessForWebsite'),
    data: funtypes.Object({
        website: websiteAccessTypes_js_1.Website,
        address: wire_types_js_1.EthereumAddress,
        allowAccess: funtypes.Boolean
    })
}).asReadonly();
exports.RemoveWebsiteAddressAccess = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_removeWebsiteAddressAccess'),
    data: funtypes.Object({
        websiteOrigin: funtypes.String,
        address: wire_types_js_1.EthereumAddress
    })
}).asReadonly();
exports.RemoveWebsiteAccess = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_removeWebsiteAccess'),
    data: funtypes.Object({ websiteOrigin: funtypes.String })
}).asReadonly();
exports.SignerChainChangeConfirmation = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_signerChangeChainDialog'),
    data: WalletSwitchEthereumChainReplyParams,
}).asReadonly();
exports.ConnectedToSigner = funtypes.ReadonlyObject({
    method: funtypes.Literal('connected_to_signer'),
    params: funtypes.Tuple(funtypes.Boolean, signerTypes_js_1.SignerName),
}).asReadonly();
const SignerReplyForwardRequest = funtypes.Intersect(funtypes.ReadonlyObject({ requestId: funtypes.Number }), funtypes.Union(ForwardToWallet, ReplyWithSignersReplyForward));
exports.SignerReply = funtypes.ReadonlyObject({
    method: funtypes.Literal('signer_reply'),
    params: funtypes.Tuple(funtypes.Union(funtypes.ReadonlyObject({
        success: funtypes.Literal(true),
        forwardRequest: SignerReplyForwardRequest,
        reply: funtypes.Unknown,
    }), funtypes.ReadonlyObject({
        success: funtypes.Literal(false),
        forwardRequest: SignerReplyForwardRequest,
        error: error_js_1.ErrorWithCodeAndOptionalData
    }))),
}).asReadonly();
exports.GetAddressBookDataFilter = funtypes.Intersect(funtypes.ReadonlyObject({
    filter: exports.AddressBookCategory,
    chainId: addressBookTypes_js_1.ChainIdWithUniversal,
}).asReadonly(), funtypes.Partial({
    startIndex: funtypes.Number,
    maxIndex: funtypes.Number,
    searchString: funtypes.String,
}).asReadonly());
exports.GetAddressBookData = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_getAddressBookData'),
    data: exports.GetAddressBookDataFilter,
}).asReadonly();
const OpenAddressBook = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_openAddressBook'),
}).asReadonly();
exports.GetAddressBookDataReply = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_getAddressBookDataReply'),
    data: funtypes.ReadonlyObject({
        data: exports.GetAddressBookDataFilter,
        entries: addressBookTypes_js_1.AddressBookEntries,
        maxDataLength: funtypes.Number,
    }),
}).asReadonly();
const NewBlockArrivedOrFailedToArrive = funtypes.ReadonlyObject({
    method: funtypes.Union(funtypes.Literal('popup_new_block_arrived'), funtypes.Literal('popup_failed_to_get_block')),
    data: funtypes.ReadonlyObject({ rpcConnectionStatus: user_interface_types_js_1.RpcConnectionStatus }),
}).asReadonly();
const WebsiteIconChanged = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_websiteIconChanged'),
    data: user_interface_types_js_1.TabIconDetails
});
const SimulationUpdateStartedOrEnded = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_simulation_state_changed'),
    data: funtypes.ReadonlyObject({
        visualizedSimulatorState: funtypes.Union(visualizer_types_js_1.CompleteVisualizedSimulation, funtypes.Undefined)
    })
});
const MessageToPopupRole = funtypes.Union(funtypes.Literal('all'), funtypes.Literal('confirmTransaction'));
const MessageToPopupSimple = funtypes.ReadonlyObject({
    method: funtypes.Union(funtypes.Literal('popup_chain_update'), funtypes.Literal('popup_confirm_transaction_simulation_started'), funtypes.Literal('popup_accounts_update'), funtypes.Literal('popup_addressBookEntriesChanged'), funtypes.Literal('popup_interceptor_access_changed'), funtypes.Literal('popup_notification_removed'), funtypes.Literal('popup_signer_name_changed'), funtypes.Literal('popup_websiteAccess_changed'))
}).asReadonly();
exports.UpdateConfirmTransactionDialog = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_update_confirm_transaction_dialog'),
    data: funtypes.ReadonlyObject({
        visualizedSimulatorState: funtypes.Union(visualizer_types_js_1.CompleteVisualizedSimulation, funtypes.Undefined),
        currentBlockNumber: wire_types_js_1.EthereumQuantity,
    })
}).asReadonly();
const UpdateConfirmTransactionDialogPartial = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_update_confirm_transaction_dialog'),
    data: funtypes.Unknown
}).asReadonly();
const UpdateConfirmTransactionDialogPendingTransactionsPartial = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_update_confirm_transaction_dialog_pending_transactions'),
    data: funtypes.Unknown
}).asReadonly();
exports.UpdateConfirmTransactionDialogPendingTransactions = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_update_confirm_transaction_dialog_pending_transactions'),
    data: funtypes.ReadonlyObject({
        pendingTransactionAndSignableMessages: funtypes.ReadonlyArray(accessRequest_js_1.PendingTransactionOrSignableMessage),
        currentBlockNumber: wire_types_js_1.EthereumQuantity,
    })
}).asReadonly();
exports.InterceptorAccessReply = funtypes.ReadonlyObject({
    accessRequestId: funtypes.String,
    originalRequestAccessToAddress: wire_types_js_1.OptionalEthereumAddress,
    requestAccessToAddress: wire_types_js_1.OptionalEthereumAddress,
    userReply: funtypes.Union(funtypes.Literal('Approved'), funtypes.Literal('Rejected'), funtypes.Literal('noResponse')),
});
exports.InterceptorAccess = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_interceptorAccess'),
    data: exports.InterceptorAccessReply,
}).asReadonly();
const InterceptorAccessDialog = funtypes.ReadonlyObject({
    method: funtypes.Union(funtypes.Literal('popup_interceptorAccessDialog'), funtypes.Literal('popup_interceptor_access_dialog_pending_changed')),
    data: funtypes.ReadonlyObject({
        activeAddresses: addressBookTypes_js_1.AddressBookEntries,
        pendingAccessRequests: accessRequest_js_1.PendingAccessRequests,
    })
});
exports.Settings = funtypes.ReadonlyObject({
    activeSimulationAddress: wire_types_js_1.OptionalEthereumAddress,
    activeRpcNetwork: rpc_js_1.RpcNetwork,
    openedPage: exportedSettingsTypes_js_1.Page,
    useSignersAddressAsActiveAddress: funtypes.Boolean,
    websiteAccess: websiteAccessTypes_js_1.WebsiteAccessArray,
    simulationMode: funtypes.Boolean,
});
const PartialUpdateHomePage = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_UpdateHomePage'),
    data: funtypes.Unknown,
});
exports.UpdateHomePage = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_UpdateHomePage'),
    data: funtypes.ReadonlyObject({
        visualizedSimulatorState: funtypes.Union(visualizer_types_js_1.CompleteVisualizedSimulation, funtypes.Undefined),
        websiteAccessAddressMetadata: addressBookTypes_js_1.AddressBookEntries,
        tabState: user_interface_types_js_1.TabState,
        currentBlockNumber: funtypes.Union(wire_types_js_1.EthereumQuantity, funtypes.Undefined),
        settings: exports.Settings,
        rpcConnectionStatus: funtypes.Union(user_interface_types_js_1.RpcConnectionStatus, funtypes.Undefined),
        activeSigningAddressInThisTab: wire_types_js_1.OptionalEthereumAddress,
        tabId: funtypes.Union(funtypes.Number, funtypes.Undefined),
        rpcEntries: rpc_js_1.RpcEntries,
        interceptorDisabled: funtypes.Boolean,
        preSimulationBlockTimeManipulation: visualizer_types_js_1.BlockTimeManipulation,
    })
});
const ActiveSigningAddressChanged = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_activeSigningAddressChanged'),
    data: funtypes.ReadonlyObject({
        tabId: funtypes.Number,
        activeSigningAddress: wire_types_js_1.OptionalEthereumAddress,
    })
});
exports.ChangeSettings = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_ChangeSettings'),
    data: funtypes.ReadonlyPartial({
        useTabsInsteadOfPopup: funtypes.Boolean,
        metamaskCompatibilityMode: funtypes.Boolean,
    })
});
exports.ImportSettings = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_import_settings'),
    data: funtypes.ReadonlyObject({ fileContents: funtypes.String })
});
exports.ImportSettingsReply = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_initiate_export_settings_reply'),
    data: funtypes.Union(funtypes.ReadonlyObject({ success: funtypes.Literal(true) }), funtypes.ReadonlyObject({ success: funtypes.Literal(false), errorMessage: funtypes.String }))
});
exports.SetRpcList = funtypes.ReadonlyObject({
    method: funtypes.Union(funtypes.Literal('popup_set_rpc_list')),
    data: rpc_js_1.RpcEntries,
});
const UpdateRPCList = funtypes.ReadonlyObject({
    method: funtypes.Union(funtypes.Literal('popup_update_rpc_list')),
    data: rpc_js_1.RpcEntries,
});
exports.ChangeActiveChain = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_changeActiveRpc'),
    data: rpc_js_1.RpcEntry,
}).asReadonly();
exports.ChainChangeConfirmation = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_changeChainDialog'),
    data: funtypes.ReadonlyObject({
        rpcNetwork: rpc_js_1.RpcNetwork,
        uniqueRequestIdentifier: requests_js_1.UniqueRequestIdentifier,
        accept: funtypes.Boolean,
    }),
}).asReadonly();
const ChangeChainRequest = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_ChangeChainRequest'),
    data: user_interface_types_js_1.PendingChainChangeConfirmationPromise,
});
const SettingsUpdated = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_settingsUpdated'),
    data: exports.Settings
});
const PartiallyParsedSimulateExecutionReply = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_simulateExecutionReply'),
    data: funtypes.Unknown,
}).asReadonly();
exports.GovernanceVoteInputParameters = funtypes.ReadonlyObject({
    proposalId: wire_types_js_1.EthereumQuantity,
    support: funtypes.Union(funtypes.Boolean, wire_types_js_1.EthereumQuantity),
    reason: funtypes.Union(funtypes.Undefined, funtypes.String),
    params: funtypes.Union(funtypes.Undefined, wire_types_js_1.EthereumData),
    signature: funtypes.Union(funtypes.Undefined, wire_types_js_1.EthereumData),
    voter: funtypes.Union(funtypes.Undefined, wire_types_js_1.EthereumAddress),
});
exports.SimulateExecutionReplyData = funtypes.Union(funtypes.ReadonlyObject({
    success: funtypes.Literal(false),
    errorType: funtypes.Literal('Other'),
    transactionOrMessageIdentifier: wire_types_js_1.EthereumQuantity,
    errorMessage: funtypes.String,
}), funtypes.ReadonlyObject({
    success: funtypes.Literal(false),
    errorType: funtypes.Literal('MissingAbi'),
    transactionOrMessageIdentifier: wire_types_js_1.EthereumQuantity,
    errorMessage: funtypes.String,
    errorAddressBookEntry: addressBookTypes_js_1.AddressBookEntry,
}), funtypes.ReadonlyObject({
    success: funtypes.Literal(true),
    transactionOrMessageIdentifier: wire_types_js_1.EthereumQuantity,
    result: funtypes.ReadonlyObject({
        namedTokenIds: funtypes.ReadonlyArray(visualizer_types_js_1.NamedTokenId),
        addressBookEntries: funtypes.ReadonlyArray(addressBookTypes_js_1.AddressBookEntry),
        visualizedSimulationState: visualizer_types_js_1.VisualizedSimulationState,
        tokenPriceEstimates: funtypes.ReadonlyArray(visualizer_types_js_1.TokenPriceEstimate),
        simulationState: funtypes.Union(visualizer_types_js_1.SimulationState),
    })
}));
exports.SimulateExecutionReply = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_simulateExecutionReply'),
    data: exports.SimulateExecutionReplyData
}).asReadonly();
exports.SimulateGovernanceContractExecution = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_simulateGovernanceContractExecution'),
    data: funtypes.ReadonlyObject({ transactionIdentifier: wire_types_js_1.EthereumQuantity })
});
const SimulateGnosisSafeTransaction = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_simulateGnosisSafeTransaction'),
    data: funtypes.ReadonlyObject({
        gnosisSafeMessage: personal_message_definitions_js_1.VisualizedPersonalSignRequestSafeTx,
    })
});
const SettingsOpenedReply = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_requestSettingsReply'),
    data: funtypes.ReadonlyObject({
        useTabsInsteadOfPopup: funtypes.Boolean,
        metamaskCompatibilityMode: funtypes.Boolean,
        activeRpcNetwork: rpc_js_1.RpcNetwork,
        rpcEntries: rpc_js_1.RpcEntries,
    })
}).asReadonly();
exports.ChangeAddOrModifyAddressWindowState = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_changeAddOrModifyAddressWindowState'),
    data: funtypes.ReadonlyObject({
        windowStateId: funtypes.String,
        newState: visualizer_types_js_1.ModifyAddressWindowState,
    })
});
exports.RetrieveWebsiteAccessFilter = funtypes.ReadonlyObject({
    query: funtypes.String,
}).asReadonly();
exports.RetrieveWebsiteAccess = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_retrieveWebsiteAccess'),
    data: exports.RetrieveWebsiteAccessFilter,
}).asReadonly();
const RetrieveWebsiteAccessReply = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_retrieveWebsiteAccessReply'),
    data: funtypes.ReadonlyObject({
        websiteAccess: websiteAccessTypes_js_1.WebsiteAccessArray,
        addressAccessMetadata: addressBookTypes_js_1.AddressBookEntries
    })
}).asReadonly();
const PopupAddOrModifyAddressWindowStateInfomation = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_addOrModifyAddressWindowStateInformation'),
    data: funtypes.ReadonlyObject({
        windowStateId: funtypes.String,
        errorState: funtypes.Union(funtypes.ReadonlyObject({ message: funtypes.String, blockEditing: funtypes.Boolean }), funtypes.Undefined),
    })
});
exports.OpenWebPage = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_openWebPage'),
    data: funtypes.ReadonlyObject({
        url: funtypes.String,
        websiteSocket: requests_js_1.WebsiteSocket
    })
}).asReadonly();
exports.DisableInterceptor = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_setDisableInterceptor'),
    data: funtypes.ReadonlyObject({
        interceptorDisabled: funtypes.Boolean,
        website: websiteAccessTypes_js_1.Website,
    })
}).asReadonly();
const DisableInterceptorReply = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_setDisableInterceptorReply'),
    data: funtypes.ReadonlyObject({
        interceptorDisabled: funtypes.Boolean,
        website: websiteAccessTypes_js_1.Website,
    })
}).asReadonly();
exports.SetEnsNameForHash = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_setEnsNameForHash'),
    data: funtypes.ReadonlyObject({
        type: funtypes.Union(funtypes.Literal('nameHash'), funtypes.Literal('labelHash')),
        nameHash: wire_types_js_1.EthereumBytes32,
        name: funtypes.String
    })
}).asReadonly();
exports.ForceSetGasLimitForTransaction = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_forceSetGasLimitForTransaction'),
    data: funtypes.ReadonlyObject({
        gasLimit: wire_types_js_1.EthereumQuantity,
        transactionIdentifier: wire_types_js_1.EthereumQuantity
    })
}).asReadonly();
exports.ChangePreSimulationBlockTimeManipulation = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_changePreSimulationBlockTimeManipulation'),
    data: funtypes.ReadonlyObject({
        blockTimeManipulation: visualizer_types_js_1.BlockTimeManipulation
    })
}).asReadonly();
exports.SetTransactionOrMessageBlockTimeManipulator = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_setTransactionOrMessageBlockTimeManipulator'),
    data: funtypes.ReadonlyObject({
        transactionOrMessageIdentifier: exports.TransactionOrMessageIdentifier,
        blockTimeManipulation: visualizer_types_js_1.BlockTimeManipulationWithNoDelay
    })
}).asReadonly();
exports.FetchSimulationStackRequestConfirmation = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_fetchSimulationStackRequestConfirmation'),
    data: funtypes.ReadonlyObject({
        uniqueRequestIdentifier: requests_js_1.UniqueRequestIdentifier,
        simulationStackVersion: JsonRpc_types_js_1.SimulationStackVersion,
        accept: funtypes.Boolean,
    }),
}).asReadonly();
const FetchSimulationStackRequest = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_fetchSimulationStackRequest'),
    data: user_interface_types_js_1.PendingFetchSimulationStackRequestPromise,
});
exports.ImportSimulationStack = funtypes.ReadonlyObject({
    method: funtypes.Literal('popup_importSimulationStack'),
    data: visualizer_types_js_1.InterceptorSimulationExport,
});
exports.MessageToPopupPayload = funtypes.Union(MessageToPopupSimple, WebsiteIconChanged, exports.GetAddressBookDataReply, ChangeChainRequest, InterceptorAccessDialog, NewBlockArrivedOrFailedToArrive, SettingsUpdated, UpdateConfirmTransactionDialogPartial, UpdateConfirmTransactionDialogPendingTransactionsPartial, funtypes.ReadonlyObject({ method: funtypes.Literal('popup_initiate_export_settings'), data: funtypes.ReadonlyObject({ fileContents: funtypes.String }) }), exports.ImportSettingsReply, ActiveSigningAddressChanged, UpdateRPCList, SimulationUpdateStartedOrEnded, PartialUpdateHomePage, PartiallyParsedSimulateExecutionReply, SettingsOpenedReply, PopupAddOrModifyAddressWindowStateInfomation, DisableInterceptorReply, interceptor_reply_messages_js_1.UnexpectedErrorOccured, RetrieveWebsiteAccessReply, FetchSimulationStackRequest);
exports.PopupMessage = funtypes.Union(interceptor_reply_messages_js_1.PopupMessageReplyRequests, exports.TransactionConfirmation, exports.RemoveTransaction, ResetSimulation, RefreshSimulation, exports.ModifyMakeMeRich, exports.ChangeActiveAddress, exports.ChangePage, exports.RequestAccountsFromSigner, funtypes.ReadonlyObject({ method: funtypes.Literal('popup_refreshConfirmTransactionDialogSimulation') }), RefreshConfirmTransactionMetadata, exports.InterceptorAccess, exports.InterceptorAccessRefresh, exports.InterceptorAccessChangeAddress, RefreshInterceptorAccessMetadata, exports.ChangeInterceptorAccess, exports.ChangeActiveChain, exports.ChainChangeConfirmation, exports.EnableSimulationMode, exports.AddOrEditAddressBookEntry, exports.GetAddressBookData, exports.RemoveAddressBookEntry, OpenAddressBook, funtypes.ReadonlyObject({ method: funtypes.Literal('popup_requestNewHomeData') }), funtypes.ReadonlyObject({ method: funtypes.Literal('popup_refreshHomeData') }), funtypes.ReadonlyObject({ method: funtypes.Literal('popup_openSettings') }), funtypes.ReadonlyObject({ method: funtypes.Literal('popup_clearUnexpectedError') }), funtypes.ReadonlyObject({ method: funtypes.Literal('popup_import_settings'), data: funtypes.ReadonlyObject({ fileContents: funtypes.String }) }), funtypes.ReadonlyObject({ method: funtypes.Literal('popup_get_export_settings') }), exports.SimulateGovernanceContractExecution, SimulateGnosisSafeTransaction, funtypes.ReadonlyObject({ method: funtypes.Literal('popup_requestSettings') }), exports.ChangeSettings, exports.SetRpcList, exports.ChangeAddOrModifyAddressWindowState, exports.OpenWebPage, exports.DisableInterceptor, exports.SetEnsNameForHash, funtypes.ReadonlyObject({ method: funtypes.Literal('popup_openWebsiteAccess') }), exports.RetrieveWebsiteAccess, exports.BlockOrAllowExternalRequests, exports.AllowOrPreventAddressAccessForWebsite, exports.RemoveWebsiteAddressAccess, exports.RemoveWebsiteAccess, exports.ForceSetGasLimitForTransaction, exports.ChangePreSimulationBlockTimeManipulation, exports.SetTransactionOrMessageBlockTimeManipulator, exports.FetchSimulationStackRequestConfirmation, interceptor_reply_messages_js_1.UnexpectedErrorOccured, exports.ImportSimulationStack);
exports.MessageToPopup = funtypes.Union(funtypes.Intersect(funtypes.ReadonlyObject({ role: MessageToPopupRole }), exports.MessageToPopupPayload));
