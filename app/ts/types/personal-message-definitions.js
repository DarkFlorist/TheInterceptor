"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PersonalSignRequestIdentifiedEIP712Message = exports.VisualizedPersonalSignRequest = exports.VisualizedPersonalSignRequestSafeTx = exports.SafeTx = exports.VisualizedPersonalSignRequestPermit2 = exports.VisualizedPersonalSignRequestPermit = exports.OpenSeaOrderMessageWithAddressBookEntries = exports.SeaPortSingleConsiderationWithAddressBookEntries = exports.SeaPortSingleOfferWithAddressBookEntries = exports.OpenSeaOrderMessage = exports.Permit2 = void 0;
const funtypes = require("funtypes");
const wire_types_js_1 = require("./wire-types.js");
const rpc_js_1 = require("./rpc.js");
const requests_js_1 = require("../utils/requests.js");
const addressBookTypes_js_1 = require("./addressBookTypes.js");
const websiteAccessTypes_js_1 = require("./websiteAccessTypes.js");
const signerTypes_js_1 = require("./signerTypes.js");
const eip721_js_1 = require("./eip721.js");
const EnrichedEthereumData_js_1 = require("./EnrichedEthereumData.js");
const EIP2612Message = funtypes.ReadonlyObject({
    types: funtypes.ReadonlyObject({
        EIP712Domain: funtypes.Tuple(funtypes.ReadonlyObject({
            name: funtypes.Literal('name'),
            type: funtypes.Literal('string'),
        }), funtypes.ReadonlyObject({
            name: funtypes.Literal('version'),
            type: funtypes.Literal('string'),
        }), funtypes.ReadonlyObject({
            name: funtypes.Literal('chainId'),
            type: funtypes.Literal('uint256'),
        }), funtypes.ReadonlyObject({
            name: funtypes.Literal('verifyingContract'),
            type: funtypes.Literal('address'),
        })),
        Permit: funtypes.Tuple(funtypes.ReadonlyObject({
            name: funtypes.Literal('owner'),
            type: funtypes.Literal('address'),
        }), funtypes.ReadonlyObject({
            name: funtypes.Literal('spender'),
            type: funtypes.Literal('address'),
        }), funtypes.ReadonlyObject({
            name: funtypes.Literal('value'),
            type: funtypes.Literal('uint256'),
        }), funtypes.ReadonlyObject({
            name: funtypes.Literal('nonce'),
            type: funtypes.Literal('uint256'),
        }), funtypes.ReadonlyObject({
            name: funtypes.Literal('deadline'),
            type: funtypes.Literal('uint256'),
        })),
    }),
    primaryType: funtypes.Literal('Permit'),
    domain: funtypes.ReadonlyObject({
        name: funtypes.String,
        version: wire_types_js_1.NonHexBigInt,
        chainId: wire_types_js_1.NonHexBigInt,
        verifyingContract: wire_types_js_1.EthereumAddress,
    }),
    message: funtypes.ReadonlyObject({
        owner: wire_types_js_1.EthereumAddress,
        spender: wire_types_js_1.EthereumAddress,
        value: wire_types_js_1.NonHexBigInt,
        nonce: funtypes.Number,
        deadline: funtypes.Number,
    }),
});
exports.Permit2 = funtypes.ReadonlyObject({
    types: funtypes.ReadonlyObject({
        PermitSingle: funtypes.Tuple(funtypes.ReadonlyObject({
            name: funtypes.Literal('details'),
            type: funtypes.Literal('PermitDetails'),
        }), funtypes.ReadonlyObject({
            name: funtypes.Literal('spender'),
            type: funtypes.Literal('address'),
        }), funtypes.ReadonlyObject({
            name: funtypes.Literal('sigDeadline'),
            type: funtypes.Literal('uint256'),
        })),
        PermitDetails: funtypes.Tuple(funtypes.ReadonlyObject({
            name: funtypes.Literal('token'),
            type: funtypes.Literal('address'),
        }), funtypes.ReadonlyObject({
            name: funtypes.Literal('amount'),
            type: funtypes.Literal('uint160'),
        }), funtypes.ReadonlyObject({
            name: funtypes.Literal('expiration'),
            type: funtypes.Literal('uint48'),
        }), funtypes.ReadonlyObject({
            name: funtypes.Literal('nonce'),
            type: funtypes.Literal('uint48'),
        })),
        EIP712Domain: funtypes.Tuple(funtypes.ReadonlyObject({
            name: funtypes.Literal('name'),
            type: funtypes.Literal('string'),
        }), funtypes.ReadonlyObject({
            name: funtypes.Literal('chainId'),
            type: funtypes.Literal('uint256'),
        }), funtypes.ReadonlyObject({
            name: funtypes.Literal('verifyingContract'),
            type: funtypes.Literal('address'),
        }))
    }),
    domain: funtypes.ReadonlyObject({
        name: funtypes.Literal('Permit2'),
        chainId: wire_types_js_1.NonHexBigInt,
        verifyingContract: wire_types_js_1.EthereumAddress,
    }),
    primaryType: funtypes.Literal('PermitSingle'),
    message: funtypes.ReadonlyObject({
        details: funtypes.ReadonlyObject({
            token: wire_types_js_1.EthereumAddress,
            amount: wire_types_js_1.NonHexBigInt,
            expiration: wire_types_js_1.NonHexBigInt,
            nonce: wire_types_js_1.NonHexBigInt,
        }),
        spender: wire_types_js_1.EthereumAddress,
        sigDeadline: wire_types_js_1.NonHexBigInt,
    })
});
const SeaPortItemType = funtypes.Union(funtypes.Literal('0').withParser((0, wire_types_js_1.LiteralConverterParserFactory)('0', 'NATIVE')), funtypes.Literal('1').withParser((0, wire_types_js_1.LiteralConverterParserFactory)('1', 'ERC20')), funtypes.Literal('2').withParser((0, wire_types_js_1.LiteralConverterParserFactory)('2', 'ERC721')), funtypes.Literal('3').withParser((0, wire_types_js_1.LiteralConverterParserFactory)('3', 'ERC1155')), funtypes.Literal('4').withParser((0, wire_types_js_1.LiteralConverterParserFactory)('4', 'ERC721_WITH_CRITERIA')), funtypes.Literal('5').withParser((0, wire_types_js_1.LiteralConverterParserFactory)('5', 'ERC1155_WITH_CRITERIA')));
const SeaPortOrderType = funtypes.Union(funtypes.Literal('0').withParser((0, wire_types_js_1.LiteralConverterParserFactory)('0', 'FULL_OPEN')), funtypes.Literal('1').withParser((0, wire_types_js_1.LiteralConverterParserFactory)('1', 'PARTIAL_OPEN')), funtypes.Literal('2').withParser((0, wire_types_js_1.LiteralConverterParserFactory)('2', 'FULL_RESTRICTED')), funtypes.Literal('3').withParser((0, wire_types_js_1.LiteralConverterParserFactory)('3', 'PARTIAL_RESTRICTED')), funtypes.Literal('4').withParser((0, wire_types_js_1.LiteralConverterParserFactory)('4', 'CONTRACT')));
const SeaPortSingleOffer = funtypes.ReadonlyObject({
    itemType: SeaPortItemType,
    token: wire_types_js_1.EthereumAddress,
    identifierOrCriteria: wire_types_js_1.NonHexBigInt,
    startAmount: wire_types_js_1.NonHexBigInt,
    endAmount: wire_types_js_1.NonHexBigInt
});
const SeaPortSingleConsideration = funtypes.ReadonlyObject({
    itemType: SeaPortItemType,
    token: wire_types_js_1.EthereumAddress,
    identifierOrCriteria: wire_types_js_1.NonHexBigInt,
    startAmount: wire_types_js_1.NonHexBigInt,
    endAmount: wire_types_js_1.NonHexBigInt,
    recipient: wire_types_js_1.EthereumAddress
});
exports.OpenSeaOrderMessage = funtypes.ReadonlyObject({
    offerer: wire_types_js_1.EthereumAddress,
    offer: funtypes.ReadonlyArray(SeaPortSingleOffer),
    consideration: funtypes.ReadonlyArray(SeaPortSingleConsideration),
    startTime: wire_types_js_1.NonHexBigInt,
    endTime: wire_types_js_1.NonHexBigInt,
    orderType: SeaPortOrderType,
    zone: wire_types_js_1.EthereumAddress,
    zoneHash: wire_types_js_1.EthereumBytes32,
    salt: wire_types_js_1.NonHexBigInt,
    conduitKey: wire_types_js_1.EthereumBytes32,
    totalOriginalConsiderationItems: wire_types_js_1.NonHexBigInt,
    counter: wire_types_js_1.NonHexBigInt,
});
const OpenSeaOrder = funtypes.ReadonlyObject({
    types: funtypes.ReadonlyObject({
        EIP712Domain: funtypes.Tuple(funtypes.ReadonlyObject({
            name: funtypes.Literal('name'),
            type: funtypes.Literal('string'),
        }), funtypes.ReadonlyObject({
            name: funtypes.Literal('version'),
            type: funtypes.Literal('string'),
        }), funtypes.ReadonlyObject({
            name: funtypes.Literal('chainId'),
            type: funtypes.Literal('uint256'),
        }), funtypes.ReadonlyObject({
            name: funtypes.Literal('verifyingContract'),
            type: funtypes.Literal('address'),
        })),
        OrderComponents: funtypes.Tuple(funtypes.ReadonlyObject({
            name: funtypes.Literal('offerer'),
            type: funtypes.Literal('address'),
        }), funtypes.ReadonlyObject({
            name: funtypes.Literal('zone'),
            type: funtypes.Literal('address'),
        }), funtypes.ReadonlyObject({
            name: funtypes.Literal('offer'),
            type: funtypes.Literal('OfferItem[]'),
        }), funtypes.ReadonlyObject({
            name: funtypes.Literal('consideration'),
            type: funtypes.Literal('ConsiderationItem[]'),
        }), funtypes.ReadonlyObject({
            name: funtypes.Literal('orderType'),
            type: funtypes.Literal('uint8'),
        }), funtypes.ReadonlyObject({
            name: funtypes.Literal('startTime'),
            type: funtypes.Literal('uint256'),
        }), funtypes.ReadonlyObject({
            name: funtypes.Literal('endTime'),
            type: funtypes.Literal('uint256'),
        }), funtypes.ReadonlyObject({
            name: funtypes.Literal('zoneHash'),
            type: funtypes.Literal('bytes32'),
        }), funtypes.ReadonlyObject({
            name: funtypes.Literal('salt'),
            type: funtypes.Literal('uint256'),
        }), funtypes.ReadonlyObject({
            name: funtypes.Literal('conduitKey'),
            type: funtypes.Literal('bytes32'),
        }), funtypes.ReadonlyObject({
            name: funtypes.Literal('counter'),
            type: funtypes.Literal('uint256'),
        })),
        OfferItem: funtypes.Tuple(funtypes.ReadonlyObject({
            name: funtypes.Literal('itemType'),
            type: funtypes.Literal('uint8'),
        }), funtypes.ReadonlyObject({
            name: funtypes.Literal('token'),
            type: funtypes.Literal('address'),
        }), funtypes.ReadonlyObject({
            name: funtypes.Literal('identifierOrCriteria'),
            type: funtypes.Literal('uint256'),
        }), funtypes.ReadonlyObject({
            name: funtypes.Literal('startAmount'),
            type: funtypes.Literal('uint256'),
        }), funtypes.ReadonlyObject({
            name: funtypes.Literal('endAmount'),
            type: funtypes.Literal('uint256'),
        })),
        ConsiderationItem: funtypes.Tuple(funtypes.ReadonlyObject({
            name: funtypes.Literal('itemType'),
            type: funtypes.Literal('uint8'),
        }), funtypes.ReadonlyObject({
            name: funtypes.Literal('token'),
            type: funtypes.Literal('address'),
        }), funtypes.ReadonlyObject({
            name: funtypes.Literal('identifierOrCriteria'),
            type: funtypes.Literal('uint256'),
        }), funtypes.ReadonlyObject({
            name: funtypes.Literal('startAmount'),
            type: funtypes.Literal('uint256'),
        }), funtypes.ReadonlyObject({
            name: funtypes.Literal('endAmount'),
            type: funtypes.Literal('uint256'),
        }), funtypes.ReadonlyObject({
            name: funtypes.Literal('recipient'),
            type: funtypes.Literal('address'),
        }))
    }),
    primaryType: funtypes.Literal('OrderComponents'),
    domain: funtypes.ReadonlyObject({
        name: funtypes.Literal('Seaport'),
        version: funtypes.Literal('1.5'),
        chainId: wire_types_js_1.NonHexBigInt,
        verifyingContract: wire_types_js_1.EthereumAddress,
    }),
    message: exports.OpenSeaOrderMessage
});
exports.SeaPortSingleOfferWithAddressBookEntries = funtypes.ReadonlyObject({
    itemType: SeaPortItemType,
    token: addressBookTypes_js_1.AddressBookEntry,
    identifierOrCriteria: wire_types_js_1.NonHexBigInt,
    startAmount: wire_types_js_1.NonHexBigInt,
    endAmount: wire_types_js_1.NonHexBigInt
});
exports.SeaPortSingleConsiderationWithAddressBookEntries = funtypes.ReadonlyObject({
    itemType: SeaPortItemType,
    token: addressBookTypes_js_1.AddressBookEntry,
    identifierOrCriteria: wire_types_js_1.NonHexBigInt,
    startAmount: wire_types_js_1.NonHexBigInt,
    endAmount: wire_types_js_1.NonHexBigInt,
    recipient: addressBookTypes_js_1.AddressBookEntry
});
exports.OpenSeaOrderMessageWithAddressBookEntries = funtypes.ReadonlyObject({
    offerer: addressBookTypes_js_1.AddressBookEntry,
    offer: funtypes.ReadonlyArray(exports.SeaPortSingleOfferWithAddressBookEntries),
    consideration: funtypes.ReadonlyArray(exports.SeaPortSingleConsiderationWithAddressBookEntries),
    startTime: wire_types_js_1.NonHexBigInt,
    endTime: wire_types_js_1.NonHexBigInt,
    orderType: SeaPortOrderType,
    zone: addressBookTypes_js_1.AddressBookEntry,
    zoneHash: wire_types_js_1.EthereumBytes32,
    salt: wire_types_js_1.NonHexBigInt,
    conduitKey: wire_types_js_1.EthereumBytes32,
    totalOriginalConsiderationItems: wire_types_js_1.NonHexBigInt,
    counter: wire_types_js_1.NonHexBigInt,
});
const PersonalSignRequestBase = funtypes.Intersect(funtypes.ReadonlyObject({
    activeAddress: addressBookTypes_js_1.AddressBookEntry,
    rpcNetwork: rpc_js_1.RpcNetwork,
    request: requests_js_1.InterceptedRequest,
    simulationMode: funtypes.Boolean,
    signerName: signerTypes_js_1.SignerName,
    quarantineReasons: funtypes.ReadonlyArray(funtypes.String),
    quarantine: funtypes.Boolean,
    account: addressBookTypes_js_1.AddressBookEntry,
    website: websiteAccessTypes_js_1.Website,
    created: wire_types_js_1.EthereumTimestamp,
    rawMessage: funtypes.String,
    stringifiedMessage: funtypes.String,
    messageIdentifier: wire_types_js_1.EthereumQuantity,
}), funtypes.ReadonlyPartial({
    isValidMessage: funtypes.Boolean,
}));
const VisualizedPersonalSignRequestNotParsed = funtypes.Intersect(PersonalSignRequestBase, funtypes.ReadonlyObject({
    method: funtypes.Union(funtypes.Literal('personal_sign'), funtypes.Literal('eth_signTypedData'), funtypes.Literal('eth_signTypedData_v1'), funtypes.Literal('eth_signTypedData_v2'), funtypes.Literal('eth_signTypedData_v3'), funtypes.Literal('eth_signTypedData_v4')),
    type: funtypes.Literal('NotParsed'),
    message: funtypes.String,
    messageHash: funtypes.Union(funtypes.String, funtypes.Undefined),
}));
const EthSignTyped = funtypes.Union(funtypes.Literal('eth_signTypedData_v1'), funtypes.Literal('eth_signTypedData_v2'), funtypes.Literal('eth_signTypedData_v3'), funtypes.Literal('eth_signTypedData_v4'));
const VisualizedPersonalSignRequestEIP712 = funtypes.Intersect(PersonalSignRequestBase, funtypes.ReadonlyObject({
    method: EthSignTyped,
    type: funtypes.Literal('EIP712'),
    message: eip721_js_1.EnrichedEIP712,
    messageHash: funtypes.String,
    domainHash: funtypes.String,
}));
exports.VisualizedPersonalSignRequestPermit = funtypes.Intersect(PersonalSignRequestBase, funtypes.ReadonlyObject({
    method: EthSignTyped,
    type: funtypes.Literal('Permit'),
    message: EIP2612Message,
    owner: addressBookTypes_js_1.AddressBookEntry,
    spender: addressBookTypes_js_1.AddressBookEntry,
    verifyingContract: addressBookTypes_js_1.AddressBookEntry,
    messageHash: funtypes.String,
    domainHash: funtypes.String,
}));
exports.VisualizedPersonalSignRequestPermit2 = funtypes.Intersect(PersonalSignRequestBase, funtypes.ReadonlyObject({
    method: EthSignTyped,
    type: funtypes.Literal('Permit2'),
    message: exports.Permit2,
    token: addressBookTypes_js_1.AddressBookEntry,
    spender: addressBookTypes_js_1.AddressBookEntry,
    verifyingContract: addressBookTypes_js_1.AddressBookEntry,
    messageHash: funtypes.String,
    domainHash: funtypes.String,
}));
const VisualizedPersonalSignRequestOrderComponents = funtypes.Intersect(PersonalSignRequestBase, funtypes.ReadonlyObject({
    method: EthSignTyped,
    type: funtypes.Literal('OrderComponents'),
    message: exports.OpenSeaOrderMessageWithAddressBookEntries,
    messageHash: funtypes.String,
    domainHash: funtypes.String,
}));
exports.SafeTx = funtypes.ReadonlyObject({
    types: funtypes.ReadonlyObject({
        SafeTx: funtypes.ReadonlyTuple(funtypes.ReadonlyObject({ name: funtypes.Literal('to'), type: funtypes.Literal('address') }), funtypes.ReadonlyObject({ name: funtypes.Literal('value'), type: funtypes.Literal('uint256') }), funtypes.ReadonlyObject({ name: funtypes.Literal('data'), type: funtypes.Literal('bytes') }), funtypes.ReadonlyObject({ name: funtypes.Literal('operation'), type: funtypes.Literal('uint8') }), funtypes.ReadonlyObject({ name: funtypes.Literal('safeTxGas'), type: funtypes.Literal('uint256') }), funtypes.ReadonlyObject({ name: funtypes.Literal('baseGas'), type: funtypes.Literal('uint256') }), funtypes.ReadonlyObject({ name: funtypes.Literal('gasPrice'), type: funtypes.Literal('uint256') }), funtypes.ReadonlyObject({ name: funtypes.Literal('gasToken'), type: funtypes.Literal('address') }), funtypes.ReadonlyObject({ name: funtypes.Literal('refundReceiver'), type: funtypes.Literal('address') }), funtypes.ReadonlyObject({ name: funtypes.Literal('nonce'), type: funtypes.Literal('uint256') })),
        EIP712Domain: funtypes.ReadonlyTuple(funtypes.Partial({ name: funtypes.Literal('chainId'), type: funtypes.Literal('uint256') }), funtypes.ReadonlyObject({ name: funtypes.Literal('verifyingContract'), type: funtypes.Literal('address') })),
    }),
    primaryType: funtypes.Literal('SafeTx'),
    domain: funtypes.Intersect(funtypes.Partial({
        chainId: funtypes.Union(wire_types_js_1.EthereumQuantity, wire_types_js_1.NonHexBigInt)
    }), funtypes.ReadonlyObject({
        verifyingContract: wire_types_js_1.EthereumAddress,
    })),
    message: funtypes.ReadonlyObject({
        to: wire_types_js_1.EthereumAddress,
        value: wire_types_js_1.NonHexBigInt,
        data: wire_types_js_1.EthereumInput,
        operation: wire_types_js_1.NonHexBigInt,
        safeTxGas: wire_types_js_1.NonHexBigInt,
        baseGas: wire_types_js_1.NonHexBigInt,
        gasPrice: wire_types_js_1.NonHexBigInt,
        gasToken: wire_types_js_1.EthereumAddress,
        refundReceiver: wire_types_js_1.EthereumAddress,
        nonce: wire_types_js_1.NonHexBigInt,
    })
});
exports.VisualizedPersonalSignRequestSafeTx = funtypes.Intersect(PersonalSignRequestBase, funtypes.ReadonlyObject({
    method: EthSignTyped,
    type: funtypes.Literal('SafeTx'),
    message: exports.SafeTx,
    parsedMessageDataAddressBookEntries: funtypes.ReadonlyArray(addressBookTypes_js_1.AddressBookEntry),
    parsedMessageData: EnrichedEthereumData_js_1.EnrichedEthereumInputData,
    gasToken: addressBookTypes_js_1.AddressBookEntry,
    to: addressBookTypes_js_1.AddressBookEntry,
    refundReceiver: addressBookTypes_js_1.AddressBookEntry,
    verifyingContract: addressBookTypes_js_1.AddressBookEntry,
    messageHash: funtypes.String,
    domainHash: funtypes.String,
    safeTxHash: funtypes.String,
}));
exports.VisualizedPersonalSignRequest = funtypes.Union(VisualizedPersonalSignRequestNotParsed, VisualizedPersonalSignRequestEIP712, exports.VisualizedPersonalSignRequestPermit, exports.VisualizedPersonalSignRequestPermit2, exports.VisualizedPersonalSignRequestSafeTx, VisualizedPersonalSignRequestOrderComponents);
exports.PersonalSignRequestIdentifiedEIP712Message = funtypes.Union(EIP2612Message, exports.Permit2, OpenSeaOrder, exports.SafeTx);
