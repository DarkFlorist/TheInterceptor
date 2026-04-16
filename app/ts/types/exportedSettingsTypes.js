"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExportedSettings = exports.ActiveAddress = exports.Page = void 0;
const funtypes = require("funtypes");
const rpc_js_1 = require("./rpc.js");
const wire_types_js_1 = require("./wire-types.js");
const addressBookTypes_js_1 = require("./addressBookTypes.js");
const websiteAccessTypes_js_1 = require("./websiteAccessTypes.js");
const visualizer_types_js_1 = require("./visualizer-types.js");
exports.Page = funtypes.Union(funtypes.ReadonlyObject({ page: funtypes.Literal('Home') }), funtypes.ReadonlyObject({ page: funtypes.Literal('AddNewAddress'), state: visualizer_types_js_1.ModifyAddressWindowState }), funtypes.ReadonlyObject({ page: funtypes.Literal('ModifyAddress'), state: visualizer_types_js_1.ModifyAddressWindowState }), funtypes.ReadonlyObject({ page: funtypes.Literal('ChangeActiveAddress') }), funtypes.ReadonlyObject({ page: funtypes.Literal('AccessList') }), funtypes.ReadonlyObject({ page: funtypes.Literal('Settings') }), funtypes.ReadonlyObject({ page: funtypes.Literal('EditEnsNamedHash'), state: visualizer_types_js_1.EditEnsNamedHashWindowState }));
exports.ActiveAddress = funtypes.ReadonlyObject({
    name: funtypes.String,
    address: wire_types_js_1.EthereumAddress,
    askForAddressAccess: funtypes.Union(funtypes.Boolean, funtypes.Literal(undefined).withParser((0, wire_types_js_1.LiteralConverterParserFactory)(undefined, true))),
}).asReadonly();
const ActiveAddressArray = funtypes.ReadonlyArray(exports.ActiveAddress);
exports.ExportedSettings = funtypes.Union(funtypes.ReadonlyObject({
    name: funtypes.Literal('InterceptorSettingsAndAddressBook'),
    version: funtypes.Literal('1.0'),
    exportedDate: funtypes.String,
    settings: funtypes.ReadonlyObject({
        activeSimulationAddress: wire_types_js_1.OptionalEthereumAddress,
        activeChain: wire_types_js_1.EthereumQuantity,
        useSignersAddressAsActiveAddress: funtypes.Boolean,
        websiteAccess: websiteAccessTypes_js_1.WebsiteAccessArray,
        simulationMode: funtypes.Boolean,
        addressInfos: ActiveAddressArray,
        contacts: funtypes.Union(funtypes.Undefined, addressBookTypes_js_1.ContactEntries),
        useTabsInsteadOfPopup: funtypes.Boolean,
    })
}), funtypes.ReadonlyObject({
    name: funtypes.Literal('InterceptorSettingsAndAddressBook'),
    version: funtypes.Literal('1.1'),
    exportedDate: funtypes.String,
    settings: funtypes.ReadonlyObject({
        activeSimulationAddress: wire_types_js_1.OptionalEthereumAddress,
        rpcNetwork: rpc_js_1.RpcNetwork,
        useSignersAddressAsActiveAddress: funtypes.Boolean,
        websiteAccess: websiteAccessTypes_js_1.WebsiteAccessArray,
        simulationMode: funtypes.Boolean,
        addressInfos: ActiveAddressArray,
        contacts: funtypes.Union(funtypes.Undefined, addressBookTypes_js_1.ContactEntries),
        useTabsInsteadOfPopup: funtypes.Boolean,
    })
}), funtypes.ReadonlyObject({
    name: funtypes.Literal('InterceptorSettingsAndAddressBook'),
    version: funtypes.Literal('1.2'),
    exportedDate: funtypes.String,
    settings: funtypes.ReadonlyObject({
        activeSimulationAddress: wire_types_js_1.OptionalEthereumAddress,
        rpcNetwork: rpc_js_1.RpcNetwork,
        useSignersAddressAsActiveAddress: funtypes.Boolean,
        websiteAccess: websiteAccessTypes_js_1.WebsiteAccessArray,
        simulationMode: funtypes.Boolean,
        addressInfos: ActiveAddressArray,
        contacts: funtypes.Union(funtypes.Undefined, addressBookTypes_js_1.ContactEntries),
        useTabsInsteadOfPopup: funtypes.Boolean,
        metamaskCompatibilityMode: funtypes.Boolean,
    })
}), funtypes.ReadonlyObject({
    name: funtypes.Literal('InterceptorSettingsAndAddressBook'),
    version: funtypes.Literal('1.3'),
    exportedDate: funtypes.String,
    settings: funtypes.ReadonlyObject({
        activeSimulationAddress: wire_types_js_1.OptionalEthereumAddress,
        rpcNetwork: rpc_js_1.RpcNetwork,
        openedPage: exports.Page,
        useSignersAddressAsActiveAddress: funtypes.Boolean,
        websiteAccess: websiteAccessTypes_js_1.WebsiteAccessArray,
        simulationMode: funtypes.Boolean,
        addressInfos: ActiveAddressArray,
        contacts: funtypes.Union(funtypes.Undefined, addressBookTypes_js_1.ContactEntries),
        useTabsInsteadOfPopup: funtypes.Boolean,
        metamaskCompatibilityMode: funtypes.Boolean,
    })
}), funtypes.ReadonlyObject({
    name: funtypes.Literal('InterceptorSettingsAndAddressBook'),
    version: funtypes.Literal('1.4'),
    exportedDate: funtypes.String,
    settings: funtypes.ReadonlyObject({
        activeSimulationAddress: wire_types_js_1.OptionalEthereumAddress,
        rpcNetwork: rpc_js_1.RpcNetwork,
        openedPage: exports.Page,
        useSignersAddressAsActiveAddress: funtypes.Boolean,
        websiteAccess: websiteAccessTypes_js_1.WebsiteAccessArray,
        simulationMode: funtypes.Boolean,
        addressBookEntries: addressBookTypes_js_1.AddressBookEntries,
        useTabsInsteadOfPopup: funtypes.Boolean,
        metamaskCompatibilityMode: funtypes.Boolean,
    })
}));
