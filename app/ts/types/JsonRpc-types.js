"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OriginalSendRequestParameters = exports.SupportedEthereumJsonRpcRequestMethods = exports.EthereumJsonRpcRequest = exports.InterceptorError = exports.GetFilterLogs = exports.GetFilterChanges = exports.UninstallFilter = exports.EthNewFilter = exports.FeeHistory = exports.WalletAddEthereumChain = exports.GetSimulationStack = exports.SimulationStackVersion = exports.GetTransactionCount = exports.GetCode = exports.SwitchEthereumChainParams = exports.EthGetStorageAtParams = exports.EthUnSubscribeParams = exports.EthSubscribeParams = exports.EthBlockByHashParams = exports.EthBlockByNumberParams = exports.EthBalanceParams = exports.EthGetLogsParams = exports.EthCallParams = exports.EstimateGasParams = exports.TransactionReceiptParams = exports.EthereumChainReply = exports.EthereumAccountsReply = exports.SendRawTransactionParams = exports.SendTransactionParams = exports.TransactionByHashParams = exports.JsonRpcResponse = exports.JsonRpcErrorResponse = exports.GetBlockReturn = exports.EthTransactionReceiptResponse = exports.PartialEthereumTransaction = exports.EthBalanceChanges = exports.EthGetFeeHistoryResponse = exports.EthGetLogsResponse = exports.EthGetLogsRequest = exports.EthGetStorageAtResponse = void 0;
const funtypes = require("funtypes");
const wire_types_js_1 = require("./wire-types.js");
const typed_arrays_js_1 = require("../utils/typed-arrays.js");
const ethSimulate_types_js_1 = require("./ethSimulate-types.js");
const jsonRpc_signing_types_js_1 = require("./jsonRpc-signing-types.js");
const error_js_1 = require("./error.js");
exports.EthGetStorageAtResponse = funtypes.Union(wire_types_js_1.EthereumBytes32, funtypes.String.withParser({ parse: x => x === '0x' ? { success: true, value: null } : { success: false, message: `eth_getStorageAt didn't return 32 bytes of data nor 0x.` } }));
exports.EthGetLogsRequest = funtypes.Intersect(funtypes.Union(funtypes.ReadonlyObject({ blockHash: wire_types_js_1.EthereumBytes32 }).asReadonly(), funtypes.Partial({ fromBlock: wire_types_js_1.EthereumBlockTag, toBlock: wire_types_js_1.EthereumBlockTag }).asReadonly()), funtypes.Partial({
    address: funtypes.Union(wire_types_js_1.EthereumAddress, funtypes.ReadonlyArray(wire_types_js_1.EthereumAddress), funtypes.Null),
    topics: funtypes.ReadonlyArray(funtypes.Union(wire_types_js_1.EthereumBytes32, funtypes.ReadonlyArray(wire_types_js_1.EthereumBytes32), funtypes.Null)),
}).asReadonly());
exports.EthGetLogsResponse = funtypes.ReadonlyArray(funtypes.ReadonlyObject({
    removed: funtypes.Boolean,
    logIndex: funtypes.Union(wire_types_js_1.EthereumQuantity, funtypes.Null),
    transactionIndex: funtypes.Union(wire_types_js_1.EthereumQuantity, funtypes.Null),
    transactionHash: funtypes.Union(wire_types_js_1.EthereumBytes32, funtypes.Null),
    blockHash: funtypes.Union(wire_types_js_1.EthereumBytes32, funtypes.Null),
    blockNumber: funtypes.Union(wire_types_js_1.EthereumQuantity, funtypes.Null),
    address: wire_types_js_1.EthereumAddress,
    data: wire_types_js_1.EthereumInput,
    topics: funtypes.ReadonlyArray(wire_types_js_1.EthereumBytes32),
}).asReadonly());
exports.EthGetFeeHistoryResponse = funtypes.Intersect(funtypes.ReadonlyObject({
    baseFeePerGas: funtypes.ReadonlyArray(wire_types_js_1.EthereumQuantity),
    gasUsedRatio: funtypes.ReadonlyArray(funtypes.Number),
    oldestBlock: wire_types_js_1.EthereumQuantity,
}), funtypes.ReadonlyPartial({
    reward: funtypes.ReadonlyArray(funtypes.ReadonlyArray(wire_types_js_1.EthereumQuantity))
}));
exports.EthBalanceChanges = funtypes.ReadonlyArray(funtypes.ReadonlyObject({
    address: wire_types_js_1.EthereumAddress,
    before: wire_types_js_1.EthereumQuantity,
    after: wire_types_js_1.EthereumQuantity,
}).asReadonly());
exports.PartialEthereumTransaction = funtypes.ReadonlyPartial({
    from: wire_types_js_1.EthereumAddress,
    gas: wire_types_js_1.EthereumQuantity,
    value: wire_types_js_1.EthereumQuantity,
    to: funtypes.Union(wire_types_js_1.EthereumAddress, funtypes.Null),
    gasPrice: wire_types_js_1.EthereumQuantity,
    maxPriorityFeePerGas: funtypes.Union(wire_types_js_1.EthereumQuantity, funtypes.Null), // etherscan sets this field to null, remove this if etherscan fixes this
    maxFeePerGas: funtypes.Union(wire_types_js_1.EthereumQuantity, funtypes.Null), // etherscan sets this field to null, remove this if etherscan fixes this
    data: wire_types_js_1.EthereumData,
    input: wire_types_js_1.EthereumData,
}).withConstraint((PartialEthereumTransaction) => {
    if (PartialEthereumTransaction.input !== undefined && PartialEthereumTransaction.data !== undefined) {
        return (0, typed_arrays_js_1.areEqualUint8Arrays)(PartialEthereumTransaction.input, PartialEthereumTransaction.data);
    }
    return true;
})
    .withConstraint((x) => {
    if (x.gasPrice !== undefined)
        return x.maxPriorityFeePerGas === undefined && x.maxFeePerGas === undefined;
    if (x.maxPriorityFeePerGas !== undefined)
        return x.maxFeePerGas !== undefined && x.gasPrice === undefined;
    if (x.maxFeePerGas !== undefined)
        return x.gasPrice === undefined; /* && x.maxPriorityFeePerGas !== undefined*/ //Remix doesn't send "maxPriorityFeePerGas" with "maxFeePerGas"
    return true;
});
exports.EthTransactionReceiptResponse = funtypes.Union(funtypes.Null, funtypes.Intersect(funtypes.MutablePartial({
    author: wire_types_js_1.EthereumAddress,
}), funtypes.Intersect(funtypes.Union(funtypes.ReadonlyObject({
    type: funtypes.Union(funtypes.Union(funtypes.Literal('0x0').withParser((0, wire_types_js_1.LiteralConverterParserFactory)('0x0', 'legacy')), funtypes.Literal(undefined).withParser((0, wire_types_js_1.LiteralConverterParserFactory)(undefined, 'legacy'))), funtypes.Literal('0x0').withParser((0, wire_types_js_1.LiteralConverterParserFactory)('0x0', 'legacy')), funtypes.Literal('0x1').withParser((0, wire_types_js_1.LiteralConverterParserFactory)('0x1', '2930')), funtypes.Literal('0x2').withParser((0, wire_types_js_1.LiteralConverterParserFactory)('0x2', '1559'))),
}), funtypes.ReadonlyObject({
    type: funtypes.Literal('0x4').withParser((0, wire_types_js_1.LiteralConverterParserFactory)('0x4', '7702')),
    authorizationList: funtypes.ReadonlyArray(funtypes.ReadonlyObject({
        chainId: wire_types_js_1.EthereumQuantity,
        address: wire_types_js_1.EthereumAddress,
        nonce: wire_types_js_1.EthereumQuantity,
        yParity: funtypes.Union(funtypes.Literal('0x0').withParser((0, wire_types_js_1.LiteralConverterParserFactory)('0x0', 'even')), funtypes.Literal('0x1').withParser((0, wire_types_js_1.LiteralConverterParserFactory)('0x1', 'odd'))),
        r: wire_types_js_1.EthereumQuantity,
        s: wire_types_js_1.EthereumQuantity
    }))
}), funtypes.ReadonlyObject({
    type: funtypes.Literal('0x3').withParser((0, wire_types_js_1.LiteralConverterParserFactory)('0x3', '4844')),
    blobGasUsed: wire_types_js_1.EthereumQuantity,
    blobGasPrice: wire_types_js_1.EthereumQuantity,
})), funtypes.ReadonlyObject({
    blockHash: wire_types_js_1.EthereumBytes32,
    blockNumber: wire_types_js_1.EthereumQuantity,
    transactionHash: wire_types_js_1.EthereumBytes32,
    transactionIndex: wire_types_js_1.EthereumQuantity,
    contractAddress: funtypes.Union(funtypes.Null, wire_types_js_1.EthereumAddress),
    cumulativeGasUsed: wire_types_js_1.EthereumQuantity,
    gasUsed: wire_types_js_1.EthereumQuantity,
    effectiveGasPrice: wire_types_js_1.EthereumQuantity,
    from: wire_types_js_1.EthereumAddress,
    to: funtypes.Union(funtypes.Null, wire_types_js_1.EthereumAddress),
    logs: exports.EthGetLogsResponse,
    logsBloom: wire_types_js_1.EthereumBytes256,
    status: funtypes.Union(funtypes.Literal('0x0').withParser((0, wire_types_js_1.LiteralConverterParserFactory)('0x0', 'failure')), funtypes.Literal('0x1').withParser((0, wire_types_js_1.LiteralConverterParserFactory)('0x1', 'success'))),
}))));
exports.GetBlockReturn = funtypes.Union(wire_types_js_1.EthereumBlockHeader, wire_types_js_1.EthereumBlockHeaderWithTransactionHashes);
const JsonRpcSuccessResponse = funtypes.ReadonlyObject({
    jsonrpc: funtypes.Literal('2.0'),
    id: funtypes.Union(funtypes.String, funtypes.Number),
    result: funtypes.Unknown,
}).asReadonly();
exports.JsonRpcErrorResponse = funtypes.ReadonlyObject({
    jsonrpc: funtypes.Literal('2.0'),
    id: funtypes.Union(funtypes.String, funtypes.Number),
    error: error_js_1.ErrorWithCodeAndOptionalData
}).asReadonly();
exports.JsonRpcResponse = funtypes.Union(exports.JsonRpcErrorResponse, JsonRpcSuccessResponse);
exports.TransactionByHashParams = funtypes.ReadonlyObject({
    method: funtypes.Literal('eth_getTransactionByHash'),
    params: funtypes.ReadonlyTuple(wire_types_js_1.EthereumBytes32)
});
exports.SendTransactionParams = funtypes.ReadonlyObject({
    method: funtypes.Literal('eth_sendTransaction'),
    params: funtypes.ReadonlyTuple(exports.PartialEthereumTransaction)
});
exports.SendRawTransactionParams = funtypes.ReadonlyObject({
    method: funtypes.Literal('eth_sendRawTransaction'),
    params: funtypes.ReadonlyTuple(wire_types_js_1.EthereumData),
});
exports.EthereumAccountsReply = funtypes.ReadonlyTuple(funtypes.Union(funtypes.ReadonlyObject({
    type: funtypes.Literal('success'),
    accounts: funtypes.ReadonlyArray(wire_types_js_1.EthereumAddress),
    requestAccounts: funtypes.Boolean,
}), funtypes.ReadonlyObject({
    type: funtypes.Literal('error'),
    requestAccounts: funtypes.Boolean,
    error: funtypes.Intersect(funtypes.ReadonlyObject({
        code: funtypes.Number,
        message: funtypes.String,
    }), funtypes.Partial({
        data: funtypes.Unknown
    }))
})));
exports.EthereumChainReply = funtypes.ReadonlyArray(wire_types_js_1.EthereumQuantity);
exports.TransactionReceiptParams = funtypes.ReadonlyObject({
    method: funtypes.Literal('eth_getTransactionReceipt'),
    params: funtypes.ReadonlyTuple(wire_types_js_1.EthereumBytes32)
});
exports.EstimateGasParams = funtypes.ReadonlyObject({
    method: funtypes.Literal('eth_estimateGas'),
    params: funtypes.Union(funtypes.ReadonlyTuple(exports.PartialEthereumTransaction), funtypes.ReadonlyTuple(exports.PartialEthereumTransaction, wire_types_js_1.EthereumBlockTag))
});
exports.EthCallParams = funtypes.ReadonlyObject({
    method: funtypes.Literal('eth_call'),
    params: funtypes.ReadonlyTuple(exports.PartialEthereumTransaction, wire_types_js_1.EthereumBlockTag)
}).asReadonly();
exports.EthGetLogsParams = funtypes.ReadonlyObject({
    method: funtypes.Literal('eth_getLogs'),
    params: funtypes.ReadonlyTuple(exports.EthGetLogsRequest)
}).asReadonly();
exports.EthBalanceParams = funtypes.ReadonlyObject({
    method: funtypes.Literal('eth_getBalance'),
    params: funtypes.ReadonlyTuple(wire_types_js_1.EthereumAddress, wire_types_js_1.EthereumBlockTag)
});
exports.EthBlockByNumberParams = funtypes.ReadonlyObject({
    method: funtypes.Literal('eth_getBlockByNumber'),
    params: funtypes.ReadonlyTuple(wire_types_js_1.EthereumBlockTag, funtypes.Boolean)
});
exports.EthBlockByHashParams = funtypes.ReadonlyObject({
    method: funtypes.Literal('eth_getBlockByHash'),
    params: funtypes.ReadonlyTuple(wire_types_js_1.EthereumBytes32, funtypes.Boolean)
});
exports.EthSubscribeParams = funtypes.ReadonlyObject({
    method: funtypes.Literal('eth_subscribe'),
    params: funtypes.ReadonlyTuple(funtypes.Union(funtypes.Literal('newHeads'), funtypes.Literal('logs'), funtypes.Literal('newPendingTransactions'), funtypes.Literal('syncing')))
});
exports.EthUnSubscribeParams = funtypes.ReadonlyObject({
    method: funtypes.Literal('eth_unsubscribe'),
    params: funtypes.ReadonlyTuple(funtypes.String)
});
exports.EthGetStorageAtParams = funtypes.ReadonlyObject({
    method: funtypes.Literal('eth_getStorageAt'),
    params: funtypes.ReadonlyTuple(wire_types_js_1.EthereumAddress, wire_types_js_1.EthereumQuantity, wire_types_js_1.EthereumBlockTag)
});
exports.SwitchEthereumChainParams = funtypes.ReadonlyObject({
    method: funtypes.Literal('wallet_switchEthereumChain'),
    params: funtypes.Tuple(funtypes.ReadonlyObject({ chainId: wire_types_js_1.EthereumQuantity }).asReadonly()),
}).asReadonly();
exports.GetCode = funtypes.ReadonlyObject({
    method: funtypes.Literal('eth_getCode'),
    params: funtypes.ReadonlyTuple(wire_types_js_1.EthereumAddress, wire_types_js_1.EthereumBlockTag)
}).asReadonly();
const RequestPermissions = funtypes.ReadonlyObject({
    method: funtypes.Literal('wallet_requestPermissions'),
    params: funtypes.ReadonlyTuple(funtypes.ReadonlyObject({ eth_accounts: funtypes.ReadonlyObject({}) }))
}).asReadonly();
exports.GetTransactionCount = funtypes.ReadonlyObject({
    method: funtypes.Literal('eth_getTransactionCount'),
    params: funtypes.ReadonlyTuple(wire_types_js_1.EthereumAddress, wire_types_js_1.EthereumBlockTag)
}).asReadonly();
const EthSign = funtypes.ReadonlyObject({
    method: funtypes.Literal('eth_sign'),
    params: funtypes.ReadonlyTuple(wire_types_js_1.EthereumAddress, funtypes.String),
}).asReadonly();
exports.SimulationStackVersion = funtypes.Union(funtypes.Literal('1.0.0'), funtypes.Literal('1.0.1'), funtypes.Literal('2.0.0'));
exports.GetSimulationStack = funtypes.ReadonlyObject({
    method: funtypes.Literal('interceptor_getSimulationStack'),
    params: funtypes.ReadonlyTuple(exports.SimulationStackVersion)
}).asReadonly();
exports.WalletAddEthereumChain = funtypes.ReadonlyObject({
    method: funtypes.Literal('wallet_addEthereumChain'),
    params: funtypes.Tuple(funtypes.Intersect(funtypes.ReadonlyObject({
        chainId: wire_types_js_1.EthereumQuantity,
        chainName: funtypes.String,
        nativeCurrency: funtypes.ReadonlyObject({
            name: funtypes.String,
            symbol: funtypes.String,
            decimals: funtypes.Number,
        }),
        rpcUrls: funtypes.ReadonlyArray(funtypes.String),
    }), funtypes.Partial({
        blockExplorerUrls: funtypes.ReadonlyArray(funtypes.String),
        iconUrls: funtypes.ReadonlyArray(funtypes.String),
    }).asReadonly()))
});
const Web3ClientVersion = funtypes.ReadonlyObject({
    method: funtypes.Literal('web3_clientVersion'),
    params: funtypes.ReadonlyTuple()
});
//https://docs.infura.io/networks/ethereum/json-rpc-methods/eth_feehistory
const EthereumQuantityBetween1And1024 = wire_types_js_1.EthereumQuantity.withConstraint((x) => x >= 1n && x <= 1024n);
exports.FeeHistory = funtypes.ReadonlyObject({
    method: funtypes.Literal('eth_feeHistory'),
    params: funtypes.Union(funtypes.ReadonlyTuple(EthereumQuantityBetween1And1024, wire_types_js_1.EthereumBlockTag), funtypes.ReadonlyTuple(EthereumQuantityBetween1And1024, wire_types_js_1.EthereumBlockTag, funtypes.ReadonlyArray(funtypes.Number)))
});
exports.EthNewFilter = funtypes.ReadonlyObject({
    method: funtypes.Literal('eth_newFilter'),
    params: funtypes.ReadonlyTuple(funtypes.ReadonlyPartial({
        fromBlock: wire_types_js_1.EthereumBlockTag,
        toBlock: wire_types_js_1.EthereumBlockTag,
        address: wire_types_js_1.EthereumAddress,
        topics: funtypes.ReadonlyArray(funtypes.Union(wire_types_js_1.EthereumBytes32, funtypes.ReadonlyArray(wire_types_js_1.EthereumBytes32), funtypes.Null)),
        blockhash: wire_types_js_1.EthereumBytes32,
    }))
});
exports.UninstallFilter = funtypes.ReadonlyObject({
    method: funtypes.Literal('eth_uninstallFilter'),
    params: funtypes.ReadonlyTuple(funtypes.String)
});
exports.GetFilterChanges = funtypes.ReadonlyObject({
    method: funtypes.Literal('eth_getFilterChanges'),
    params: funtypes.ReadonlyTuple(funtypes.String)
});
exports.GetFilterLogs = funtypes.ReadonlyObject({
    method: funtypes.Literal('eth_getFilterLogs'),
    params: funtypes.ReadonlyTuple(funtypes.String)
});
exports.InterceptorError = funtypes.ReadonlyObject({
    method: funtypes.Literal('InterceptorError'),
    params: funtypes.Unknown,
});
exports.EthereumJsonRpcRequest = funtypes.Union(exports.EthBlockByNumberParams, exports.EthBlockByHashParams, exports.EthBalanceParams, exports.EstimateGasParams, exports.TransactionByHashParams, exports.TransactionReceiptParams, exports.SendTransactionParams, exports.SendRawTransactionParams, exports.EthCallParams, exports.EthSubscribeParams, exports.EthUnSubscribeParams, funtypes.ReadonlyObject({ method: funtypes.Literal('eth_blockNumber') }), funtypes.ReadonlyObject({ method: funtypes.Literal('eth_chainId') }), funtypes.ReadonlyObject({ method: funtypes.Literal('net_version') }), exports.GetCode, jsonRpc_signing_types_js_1.PersonalSignParams, jsonRpc_signing_types_js_1.SignTypedDataParams, jsonRpc_signing_types_js_1.OldSignTypedDataParams, exports.SwitchEthereumChainParams, RequestPermissions, funtypes.ReadonlyObject({ method: funtypes.Literal('wallet_getPermissions') }), funtypes.ReadonlyObject({ method: funtypes.Literal('eth_accounts') }), funtypes.ReadonlyObject({ method: funtypes.Literal('eth_requestAccounts') }), funtypes.ReadonlyObject({ method: funtypes.Literal('eth_gasPrice') }), exports.GetTransactionCount, exports.GetSimulationStack, exports.EthGetStorageAtParams, exports.EthGetLogsParams, EthSign, ethSimulate_types_js_1.EthSimulateV1Params, exports.WalletAddEthereumChain, Web3ClientVersion, exports.FeeHistory, exports.EthNewFilter, exports.UninstallFilter, exports.GetFilterChanges, exports.GetFilterLogs, exports.InterceptorError);
exports.SupportedEthereumJsonRpcRequestMethods = funtypes.ReadonlyObject({
    method: funtypes.Union(exports.EthereumJsonRpcRequest.alternatives[0].fields.method, ...exports.EthereumJsonRpcRequest.alternatives.map(x => x.fields.method)),
});
exports.OriginalSendRequestParameters = funtypes.Union(exports.SendTransactionParams, exports.SendRawTransactionParams);
