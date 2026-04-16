"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PopupOrTabId = exports.WebsiteAccessArray = exports.WebsiteAccess = exports.WebsiteAddressAccess = exports.Website = void 0;
const funtypes = require("funtypes");
const wire_types_js_1 = require("./wire-types.js");
exports.Website = funtypes.ReadonlyObject({
    websiteOrigin: funtypes.String,
    icon: funtypes.Union(funtypes.String, funtypes.Undefined),
    title: funtypes.Union(funtypes.String, funtypes.Undefined),
});
exports.WebsiteAddressAccess = funtypes.ReadonlyObject({
    address: wire_types_js_1.EthereumAddress,
    access: funtypes.Boolean,
}).asReadonly();
exports.WebsiteAccess = funtypes.Intersect(funtypes.ReadonlyObject({
    website: exports.Website,
    addressAccess: funtypes.Union(funtypes.ReadonlyArray(exports.WebsiteAddressAccess), funtypes.Undefined),
}), funtypes.ReadonlyPartial({
    access: funtypes.Boolean,
    interceptorDisabled: funtypes.Boolean,
    declarativeNetRequestBlockMode: funtypes.Union(funtypes.Literal('block-all'), funtypes.Literal('disabled'))
}));
exports.WebsiteAccessArray = funtypes.ReadonlyArray(exports.WebsiteAccess);
exports.PopupOrTabId = funtypes.ReadonlyObject({
    id: funtypes.Number,
    type: funtypes.Union(funtypes.Literal('tab'), funtypes.Literal('popup'))
});
