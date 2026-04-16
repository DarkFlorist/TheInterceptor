"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IncompleteAddressBookEntry = exports.AddressBookEntryType = exports.AddressBookEntries = exports.AddressBookEntry = exports.ContractEntry = exports.ContactEntries = exports.ContactEntry = exports.Erc1155Entry = exports.Erc721Entry = exports.Erc20TokenEntry = exports.DeclarativeNetRequestBlockMode = exports.EntrySource = exports.ChainIdWithUniversal = void 0;
const funtypes = require("funtypes");
const wire_types_js_1 = require("./wire-types.js");
exports.ChainIdWithUniversal = funtypes.Union(wire_types_js_1.EthereumQuantity, funtypes.Literal('AllChains'));
exports.EntrySource = funtypes.Union(funtypes.Literal('DarkFloristMetadata'), funtypes.Literal('User'), funtypes.Literal('Interceptor'), funtypes.Literal('OnChain'), funtypes.Literal('FilledIn'));
exports.DeclarativeNetRequestBlockMode = funtypes.Union(funtypes.Literal('block-all'), funtypes.Literal('disabled'));
exports.Erc20TokenEntry = funtypes.ReadonlyObject({
    type: funtypes.Literal('ERC20'),
    name: funtypes.String,
    address: wire_types_js_1.EthereumAddress,
    symbol: funtypes.String,
    decimals: wire_types_js_1.EthereumQuantity,
    entrySource: exports.EntrySource,
}).And(funtypes.Partial({
    logoUri: funtypes.String,
    abi: funtypes.String,
    useAsActiveAddress: funtypes.Boolean,
    askForAddressAccess: funtypes.Union(funtypes.Boolean, funtypes.Literal(undefined).withParser((0, wire_types_js_1.LiteralConverterParserFactory)(undefined, true))),
    declarativeNetRequestBlockMode: exports.DeclarativeNetRequestBlockMode,
    chainId: exports.ChainIdWithUniversal,
}));
exports.Erc721Entry = funtypes.ReadonlyObject({
    type: funtypes.Literal('ERC721'),
    name: funtypes.String,
    address: wire_types_js_1.EthereumAddress,
    symbol: funtypes.String,
    entrySource: exports.EntrySource,
}).And(funtypes.Partial({
    protocol: funtypes.String,
    logoUri: funtypes.String,
    abi: funtypes.String,
    useAsActiveAddress: funtypes.Boolean,
    askForAddressAccess: funtypes.Union(funtypes.Boolean, funtypes.Literal(undefined).withParser((0, wire_types_js_1.LiteralConverterParserFactory)(undefined, true))),
    declarativeNetRequestBlockMode: exports.DeclarativeNetRequestBlockMode,
    chainId: exports.ChainIdWithUniversal,
}));
exports.Erc1155Entry = funtypes.ReadonlyObject({
    type: funtypes.Literal('ERC1155'),
    name: funtypes.String,
    address: wire_types_js_1.EthereumAddress,
    symbol: funtypes.String,
    decimals: funtypes.Undefined,
    entrySource: exports.EntrySource,
}).And(funtypes.Partial({
    protocol: funtypes.String,
    logoUri: funtypes.String,
    abi: funtypes.String,
    useAsActiveAddress: funtypes.Boolean,
    askForAddressAccess: funtypes.Union(funtypes.Boolean, funtypes.Literal(undefined).withParser((0, wire_types_js_1.LiteralConverterParserFactory)(undefined, true))),
    declarativeNetRequestBlockMode: exports.DeclarativeNetRequestBlockMode,
    chainId: exports.ChainIdWithUniversal,
}));
exports.ContactEntry = funtypes.ReadonlyObject({
    type: funtypes.Literal('contact'),
    name: funtypes.String,
    address: wire_types_js_1.EthereumAddress,
    entrySource: funtypes.Union(exports.EntrySource, funtypes.Literal(undefined).withParser((0, wire_types_js_1.LiteralConverterParserFactory)(undefined, 'User'))),
}).And(funtypes.Partial({
    logoUri: funtypes.String,
    abi: funtypes.String,
    useAsActiveAddress: funtypes.Boolean,
    askForAddressAccess: funtypes.Union(funtypes.Boolean, funtypes.Literal(undefined).withParser((0, wire_types_js_1.LiteralConverterParserFactory)(undefined, true))),
    declarativeNetRequestBlockMode: exports.DeclarativeNetRequestBlockMode,
    chainId: exports.ChainIdWithUniversal,
}));
exports.ContactEntries = funtypes.ReadonlyArray(exports.ContactEntry);
exports.ContractEntry = funtypes.ReadonlyObject({
    type: funtypes.Literal('contract'),
    name: funtypes.String,
    address: wire_types_js_1.EthereumAddress,
    entrySource: exports.EntrySource,
}).And(funtypes.Partial({
    protocol: funtypes.String,
    logoUri: funtypes.String,
    abi: funtypes.String,
    useAsActiveAddress: funtypes.Boolean,
    askForAddressAccess: funtypes.Union(funtypes.Boolean, funtypes.Literal(undefined).withParser((0, wire_types_js_1.LiteralConverterParserFactory)(undefined, true))),
    declarativeNetRequestBlockMode: exports.DeclarativeNetRequestBlockMode,
    chainId: exports.ChainIdWithUniversal,
}));
exports.AddressBookEntry = funtypes.Union(exports.ContactEntry, exports.Erc20TokenEntry, exports.Erc721Entry, exports.Erc1155Entry, exports.ContractEntry);
exports.AddressBookEntries = funtypes.ReadonlyArray(exports.AddressBookEntry);
exports.AddressBookEntryType = funtypes.Union(funtypes.Literal('contact'), funtypes.Literal('contract'), funtypes.Literal('ERC20'), funtypes.Literal('ERC1155'), funtypes.Literal('ERC721'));
exports.IncompleteAddressBookEntry = funtypes.ReadonlyObject({
    addingAddress: funtypes.Boolean, // if false, we are editing addess
    type: exports.AddressBookEntryType,
    address: funtypes.Union(funtypes.String, funtypes.Undefined),
    askForAddressAccess: funtypes.Boolean,
    name: funtypes.Union(funtypes.String, funtypes.Undefined),
    symbol: funtypes.Union(funtypes.String, funtypes.Undefined),
    decimals: funtypes.Union(wire_types_js_1.EthereumQuantity, funtypes.Undefined),
    logoUri: funtypes.Union(funtypes.String, funtypes.Undefined),
    entrySource: exports.EntrySource,
    abi: funtypes.Union(funtypes.String, funtypes.Undefined),
    useAsActiveAddress: funtypes.Union(funtypes.Undefined, funtypes.Boolean),
    declarativeNetRequestBlockMode: funtypes.Union(funtypes.Undefined, exports.DeclarativeNetRequestBlockMode),
    chainId: exports.ChainIdWithUniversal,
});
