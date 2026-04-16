"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EnrichedEthereumEventWithMetadata = exports.EnsEvent = exports.TokenEvent = exports.TokenVisualizerResultWithMetadata = exports.TokenVisualizerNFTAllApprovalEvent = exports.TokenVisualizerErc721Event = exports.TokenVisualizerErc20Event = exports.EnrichedEthereumEvents = exports.EnrichedEthereumEvent = exports.ParsedEnsEvent = exports.TokenVisualizerResult = exports.ParsedEvent = exports.EnrichedEthereumInputData = exports.SolidityVariable = void 0;
const funtypes = require("funtypes");
const wire_types_js_1 = require("./wire-types.js");
const solidityType_js_1 = require("./solidityType.js");
const addressBookTypes_js_1 = require("./addressBookTypes.js");
const ens_js_1 = require("./ens.js");
exports.SolidityVariable = funtypes.ReadonlyObject({
    typeValue: solidityType_js_1.PureGroupedSolidityType,
    paramName: funtypes.String
});
exports.EnrichedEthereumInputData = funtypes.Union(funtypes.ReadonlyObject({
    input: wire_types_js_1.EthereumInput,
    type: funtypes.Literal('NonParsed')
}), funtypes.ReadonlyObject({
    input: wire_types_js_1.EthereumInput,
    type: funtypes.Literal('Parsed'),
    name: funtypes.String, // eg. 'Transfer'
    args: funtypes.ReadonlyArray(exports.SolidityVariable), // TODO: add support for structs (abiV2)
}));
exports.ParsedEvent = funtypes.ReadonlyObject({
    isParsed: funtypes.Literal('Parsed'),
    name: funtypes.String, // eg. 'Transfer'
    signature: funtypes.String, // eg. 'Transfer(address,address,uint256)'
    args: funtypes.ReadonlyArray(exports.SolidityVariable), // TODO: add support for structs (abiV2)
    address: wire_types_js_1.EthereumAddress,
    loggersAddressBookEntry: addressBookTypes_js_1.AddressBookEntry,
    data: wire_types_js_1.EthereumInput,
    topics: funtypes.ReadonlyArray(wire_types_js_1.EthereumBytes32),
});
const NonParsedEvent = funtypes.ReadonlyObject({
    isParsed: funtypes.Literal('NonParsed'),
    address: wire_types_js_1.EthereumAddress,
    loggersAddressBookEntry: addressBookTypes_js_1.AddressBookEntry,
    data: wire_types_js_1.EthereumInput,
    topics: funtypes.ReadonlyArray(wire_types_js_1.EthereumBytes32),
});
exports.TokenVisualizerResult = funtypes.Intersect(funtypes.ReadonlyObject({
    from: wire_types_js_1.EthereumAddress,
    to: wire_types_js_1.EthereumAddress,
    tokenAddress: wire_types_js_1.EthereumAddress,
}), funtypes.Union(funtypes.ReadonlyObject({
    amount: wire_types_js_1.EthereumQuantity,
    type: funtypes.Literal('ERC20'),
    isApproval: funtypes.Boolean,
}), funtypes.ReadonlyObject({
    tokenId: wire_types_js_1.EthereumQuantity,
    type: funtypes.Literal('ERC721'),
    isApproval: funtypes.Boolean,
}), funtypes.ReadonlyObject({
    type: funtypes.Literal('NFT All approval'),
    allApprovalAdded: funtypes.Boolean, // true if approval is added, and false if removed
    isApproval: funtypes.Literal(true),
}), funtypes.ReadonlyObject({
    type: funtypes.Literal('ERC1155'),
    operator: wire_types_js_1.EthereumAddress,
    tokenId: wire_types_js_1.EthereumQuantity,
    amount: wire_types_js_1.EthereumQuantity,
    isApproval: funtypes.Literal(false),
})));
const EnsFuseName = funtypes.Union(funtypes.Literal('Cannot Unwrap Name'), funtypes.Literal('Cannot Burn Fuses'), funtypes.Literal('Cannot Transfer'), funtypes.Literal('Cannot Set Resolver'), funtypes.Literal('Cannot Set Time To Live'), funtypes.Literal('Cannot Create Subdomain'), funtypes.Literal('Parent Domain Cannot Control'), funtypes.Literal('Cannot Approve'), funtypes.Literal('Is .eth domain'), funtypes.Literal('Can Extend Expiry'), funtypes.Literal('Can Do Everything'));
exports.ParsedEnsEvent = funtypes.Intersect(exports.ParsedEvent, funtypes.ReadonlyObject({ type: funtypes.Literal('ENS') }), funtypes.Union(funtypes.ReadonlyObject({
    subType: funtypes.Literal('ENSAddrChanged'),
    logInformation: funtypes.ReadonlyObject({
        node: wire_types_js_1.EthereumBytes32,
        to: wire_types_js_1.EthereumAddress,
    }),
}), funtypes.ReadonlyObject({
    subType: funtypes.Literal('ENSAddressChanged'),
    logInformation: funtypes.ReadonlyObject({
        node: wire_types_js_1.EthereumBytes32,
        to: wire_types_js_1.EthereumData,
        coinType: wire_types_js_1.EthereumQuantity,
    }),
}), funtypes.ReadonlyObject({
    subType: funtypes.Literal('ENSTransfer'),
    logInformation: funtypes.ReadonlyObject({
        node: wire_types_js_1.EthereumBytes32,
        owner: wire_types_js_1.EthereumAddress,
    }),
}), funtypes.ReadonlyObject({
    subType: funtypes.Literal('ENSTextChangedKeyValue'),
    logInformation: funtypes.ReadonlyObject({
        node: wire_types_js_1.EthereumBytes32,
        indexedKey: wire_types_js_1.EthereumData,
        key: funtypes.String,
        value: funtypes.String,
    }),
}), funtypes.ReadonlyObject({
    subType: funtypes.Literal('ENSTextChanged'),
    logInformation: funtypes.ReadonlyObject({
        node: wire_types_js_1.EthereumBytes32,
        indexedKey: wire_types_js_1.EthereumData,
        key: funtypes.String
    }),
}), funtypes.ReadonlyObject({
    subType: funtypes.Literal('ENSReverseClaimed'),
    logInformation: funtypes.ReadonlyObject({
        node: wire_types_js_1.EthereumBytes32,
        address: wire_types_js_1.EthereumAddress,
    }),
}), funtypes.ReadonlyObject({
    subType: funtypes.Literal('ENSNewTTL'),
    logInformation: funtypes.ReadonlyObject({
        node: wire_types_js_1.EthereumBytes32,
        ttl: wire_types_js_1.EthereumQuantity
    }),
}), funtypes.ReadonlyObject({
    subType: funtypes.Literal('ENSNewResolver'),
    logInformation: funtypes.ReadonlyObject({
        node: wire_types_js_1.EthereumBytes32,
        address: wire_types_js_1.EthereumAddress,
    }),
}), funtypes.ReadonlyObject({
    subType: funtypes.Literal('ENSNameUnwrapped'),
    logInformation: funtypes.ReadonlyObject({
        node: wire_types_js_1.EthereumBytes32,
        owner: wire_types_js_1.EthereumAddress,
    }),
}), funtypes.ReadonlyObject({
    subType: funtypes.Literal('ENSNameChanged'),
    logInformation: funtypes.ReadonlyObject({
        node: wire_types_js_1.EthereumBytes32,
        name: funtypes.String,
    }),
}), funtypes.ReadonlyObject({
    subType: funtypes.Literal('ENSExpiryExtended'),
    logInformation: funtypes.ReadonlyObject({
        node: wire_types_js_1.EthereumBytes32,
        expires: wire_types_js_1.EthereumQuantity,
    }),
}), funtypes.ReadonlyObject({
    subType: funtypes.Literal('ENSContentHashChanged'),
    logInformation: funtypes.ReadonlyObject({
        node: wire_types_js_1.EthereumBytes32,
        hash: wire_types_js_1.EthereumData,
    }),
}), funtypes.ReadonlyObject({
    subType: funtypes.Union(funtypes.Literal('ENSNewOwner')),
    logInformation: funtypes.ReadonlyObject({
        node: wire_types_js_1.EthereumBytes32,
        owner: wire_types_js_1.EthereumAddress,
        labelHash: wire_types_js_1.EthereumBytes32,
    }),
}), funtypes.ReadonlyObject({
    subType: funtypes.Literal('ENSControllerNameRenewed'),
    logInformation: funtypes.ReadonlyObject({
        name: funtypes.String,
        labelHash: wire_types_js_1.EthereumBytes32,
        cost: wire_types_js_1.EthereumQuantity,
        expires: wire_types_js_1.EthereumQuantity,
    }),
}), funtypes.ReadonlyObject({
    subType: funtypes.Literal('ENSControllerNameRegistered'),
    logInformation: funtypes.ReadonlyObject({
        name: funtypes.String,
        labelHash: wire_types_js_1.EthereumBytes32,
        owner: wire_types_js_1.EthereumAddress,
        cost: wire_types_js_1.EthereumQuantity,
        expires: wire_types_js_1.EthereumQuantity,
    }),
}), funtypes.ReadonlyObject({
    subType: funtypes.Literal('ENSBaseRegistrarNameRenewed'),
    logInformation: funtypes.ReadonlyObject({
        labelHash: wire_types_js_1.EthereumBytes32,
        expires: wire_types_js_1.EthereumQuantity
    }),
}), funtypes.ReadonlyObject({
    subType: funtypes.Literal('ENSBaseRegistrarNameRegistered'),
    logInformation: funtypes.ReadonlyObject({
        labelHash: wire_types_js_1.EthereumBytes32,
        owner: wire_types_js_1.EthereumAddress,
        expires: wire_types_js_1.EthereumQuantity
    }),
}), funtypes.ReadonlyObject({
    subType: funtypes.Literal('ENSFusesSet'),
    logInformation: funtypes.ReadonlyObject({
        node: wire_types_js_1.EthereumBytes32,
        fuses: funtypes.ReadonlyArray(EnsFuseName),
    }),
}), funtypes.ReadonlyObject({
    subType: funtypes.Literal('ENSNameWrapped'),
    logInformation: funtypes.ReadonlyObject({
        node: wire_types_js_1.EthereumBytes32,
        fuses: funtypes.ReadonlyArray(EnsFuseName),
        owner: wire_types_js_1.EthereumAddress,
        name: funtypes.String,
        expires: wire_types_js_1.EthereumQuantity
    }),
})));
exports.EnrichedEthereumEvent = funtypes.Union(funtypes.Intersect(NonParsedEvent, funtypes.ReadonlyObject({ type: funtypes.Literal('NonParsed') })), exports.ParsedEnsEvent, funtypes.Intersect(exports.ParsedEvent, funtypes.Union(funtypes.ReadonlyObject({ type: funtypes.Literal('Parsed') }), funtypes.ReadonlyObject({ type: funtypes.Literal('TokenEvent'), logInformation: exports.TokenVisualizerResult }))));
exports.EnrichedEthereumEvents = funtypes.ReadonlyArray(exports.EnrichedEthereumEvent);
exports.TokenVisualizerErc20Event = funtypes.ReadonlyObject({
    logObject: funtypes.Union(funtypes.Undefined, exports.EnrichedEthereumEvent),
    type: funtypes.Literal('ERC20'),
    from: addressBookTypes_js_1.AddressBookEntry,
    to: addressBookTypes_js_1.AddressBookEntry,
    token: addressBookTypes_js_1.Erc20TokenEntry,
    amount: wire_types_js_1.EthereumQuantity,
    isApproval: funtypes.Boolean,
});
exports.TokenVisualizerErc721Event = funtypes.ReadonlyObject({
    logObject: funtypes.Union(funtypes.Undefined, exports.EnrichedEthereumEvent),
    type: funtypes.Literal('ERC721'),
    from: addressBookTypes_js_1.AddressBookEntry,
    to: addressBookTypes_js_1.AddressBookEntry,
    token: addressBookTypes_js_1.Erc721Entry,
    tokenId: wire_types_js_1.EthereumQuantity,
    isApproval: funtypes.Boolean,
});
const TokenVisualizerErc1155Event = funtypes.ReadonlyObject({
    logObject: funtypes.Union(funtypes.Undefined, exports.EnrichedEthereumEvent),
    type: funtypes.Literal('ERC1155'),
    from: addressBookTypes_js_1.AddressBookEntry,
    to: addressBookTypes_js_1.AddressBookEntry,
    token: addressBookTypes_js_1.Erc1155Entry,
    tokenId: wire_types_js_1.EthereumQuantity,
    tokenIdName: funtypes.Union(funtypes.String, funtypes.Undefined),
    amount: wire_types_js_1.EthereumQuantity,
    isApproval: funtypes.Literal(false),
});
exports.TokenVisualizerNFTAllApprovalEvent = funtypes.ReadonlyObject({
    logObject: funtypes.Union(funtypes.Undefined, exports.ParsedEvent),
    type: funtypes.Literal('NFT All approval'),
    from: addressBookTypes_js_1.AddressBookEntry,
    to: addressBookTypes_js_1.AddressBookEntry,
    token: funtypes.Union(addressBookTypes_js_1.Erc721Entry, addressBookTypes_js_1.Erc1155Entry),
    allApprovalAdded: funtypes.Boolean, // true if approval is added, and false if removed
    isApproval: funtypes.Literal(true),
});
exports.TokenVisualizerResultWithMetadata = funtypes.Union(exports.TokenVisualizerErc20Event, exports.TokenVisualizerErc721Event, TokenVisualizerErc1155Event, exports.TokenVisualizerNFTAllApprovalEvent);
exports.TokenEvent = funtypes.Intersect(exports.ParsedEvent, funtypes.ReadonlyObject({
    type: funtypes.Literal('TokenEvent'),
    logInformation: exports.TokenVisualizerResultWithMetadata
}));
exports.EnsEvent = funtypes.Intersect(exports.ParsedEvent, funtypes.ReadonlyObject({ type: funtypes.Literal('ENS') }), funtypes.Union(funtypes.ReadonlyObject({
    subType: funtypes.Literal('ENSAddrChanged'),
    logInformation: funtypes.ReadonlyObject({
        node: ens_js_1.MaybeENSNameHash,
        to: addressBookTypes_js_1.AddressBookEntry,
    }),
}), funtypes.ReadonlyObject({
    subType: funtypes.Literal('ENSAddressChanged'),
    logInformation: funtypes.ReadonlyObject({
        node: ens_js_1.MaybeENSNameHash,
        to: wire_types_js_1.EthereumData,
        coinType: wire_types_js_1.EthereumQuantity,
    }),
}), funtypes.ReadonlyObject({
    subType: funtypes.Literal('ENSTransfer'),
    logInformation: funtypes.ReadonlyObject({
        node: ens_js_1.MaybeENSNameHash,
        owner: addressBookTypes_js_1.AddressBookEntry,
    }),
}), funtypes.ReadonlyObject({
    subType: funtypes.Literal('ENSTextChangedKeyValue'),
    logInformation: funtypes.ReadonlyObject({
        node: ens_js_1.MaybeENSNameHash,
        indexedKey: wire_types_js_1.EthereumData,
        key: funtypes.String,
        value: funtypes.String,
    }),
}), funtypes.ReadonlyObject({
    subType: funtypes.Literal('ENSTextChanged'),
    logInformation: funtypes.ReadonlyObject({
        node: ens_js_1.MaybeENSNameHash,
        indexedKey: wire_types_js_1.EthereumData,
        key: funtypes.String
    }),
}), funtypes.ReadonlyObject({
    subType: funtypes.Literal('ENSReverseClaimed'),
    logInformation: funtypes.ReadonlyObject({
        node: ens_js_1.MaybeENSNameHash,
        address: addressBookTypes_js_1.AddressBookEntry,
    }),
}), funtypes.ReadonlyObject({
    subType: funtypes.Literal('ENSNewTTL'),
    logInformation: funtypes.ReadonlyObject({
        node: ens_js_1.MaybeENSNameHash,
        ttl: wire_types_js_1.EthereumQuantity
    }),
}), funtypes.ReadonlyObject({
    subType: funtypes.Literal('ENSNewResolver'),
    logInformation: funtypes.ReadonlyObject({
        node: ens_js_1.MaybeENSNameHash,
        address: addressBookTypes_js_1.AddressBookEntry,
    }),
}), funtypes.ReadonlyObject({
    subType: funtypes.Literal('ENSNameUnwrapped'),
    logInformation: funtypes.ReadonlyObject({
        node: ens_js_1.MaybeENSNameHash,
        owner: addressBookTypes_js_1.AddressBookEntry,
    }),
}), funtypes.ReadonlyObject({
    subType: funtypes.Literal('ENSNameChanged'),
    logInformation: funtypes.ReadonlyObject({
        node: ens_js_1.MaybeENSNameHash,
        name: funtypes.String,
    }),
}), funtypes.ReadonlyObject({
    subType: funtypes.Literal('ENSExpiryExtended'),
    logInformation: funtypes.ReadonlyObject({
        node: ens_js_1.MaybeENSNameHash,
        expires: wire_types_js_1.EthereumQuantity,
    }),
}), funtypes.ReadonlyObject({
    subType: funtypes.Literal('ENSContentHashChanged'),
    logInformation: funtypes.ReadonlyObject({
        node: ens_js_1.MaybeENSNameHash,
        hash: wire_types_js_1.EthereumData,
    }),
}), funtypes.ReadonlyObject({
    subType: funtypes.Literal('ENSFusesSet'),
    logInformation: funtypes.ReadonlyObject({
        node: ens_js_1.MaybeENSNameHash,
        fuses: funtypes.ReadonlyArray(EnsFuseName),
    }),
}), funtypes.ReadonlyObject({
    subType: funtypes.Literal('ENSControllerNameRenewed'),
    logInformation: funtypes.ReadonlyObject({
        name: funtypes.String,
        labelHash: ens_js_1.MaybeENSLabelHash,
        cost: wire_types_js_1.EthereumQuantity,
        expires: wire_types_js_1.EthereumQuantity,
    }),
}), funtypes.ReadonlyObject({
    subType: funtypes.Literal('ENSControllerNameRegistered'),
    logInformation: funtypes.ReadonlyObject({
        name: funtypes.String,
        labelHash: ens_js_1.MaybeENSLabelHash,
        owner: addressBookTypes_js_1.AddressBookEntry,
        cost: wire_types_js_1.EthereumQuantity,
        expires: wire_types_js_1.EthereumQuantity,
    }),
}), funtypes.ReadonlyObject({
    subType: funtypes.Literal('ENSBaseRegistrarNameRenewed'),
    logInformation: funtypes.ReadonlyObject({
        labelHash: ens_js_1.MaybeENSLabelHash,
        expires: wire_types_js_1.EthereumQuantity
    }),
}), funtypes.ReadonlyObject({
    subType: funtypes.Literal('ENSBaseRegistrarNameRegistered'),
    logInformation: funtypes.ReadonlyObject({
        labelHash: ens_js_1.MaybeENSLabelHash,
        owner: addressBookTypes_js_1.AddressBookEntry,
        expires: wire_types_js_1.EthereumQuantity
    }),
}), funtypes.ReadonlyObject({
    subType: funtypes.Literal('ENSNewOwner'),
    logInformation: funtypes.ReadonlyObject({
        node: ens_js_1.MaybeENSNameHash,
        owner: addressBookTypes_js_1.AddressBookEntry,
        labelHash: ens_js_1.MaybeENSLabelHash,
    }),
}), funtypes.ReadonlyObject({
    subType: funtypes.Literal('ENSNameWrapped'),
    logInformation: funtypes.ReadonlyObject({
        node: ens_js_1.MaybeENSNameHash,
        fuses: funtypes.ReadonlyArray(EnsFuseName),
        owner: addressBookTypes_js_1.AddressBookEntry,
        name: funtypes.String,
        expires: wire_types_js_1.EthereumQuantity
    }),
})));
exports.EnrichedEthereumEventWithMetadata = funtypes.Union(funtypes.Intersect(NonParsedEvent, funtypes.ReadonlyObject({ type: funtypes.Literal('NonParsed') })), funtypes.Intersect(exports.ParsedEvent, funtypes.ReadonlyObject({ type: funtypes.Literal('Parsed') })), exports.EnsEvent, exports.TokenEvent);
