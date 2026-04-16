"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DecodedError = exports.ErrorWithCodeAndOptionalData = void 0;
const funtypes = require("funtypes");
exports.ErrorWithCodeAndOptionalData = funtypes.Intersect(funtypes.ReadonlyObject({
    code: funtypes.Number,
    message: funtypes.String,
}), funtypes.Partial({
    data: funtypes.String
}));
exports.DecodedError = funtypes.Intersect(exports.ErrorWithCodeAndOptionalData, funtypes.ReadonlyObject({ decodedErrorMessage: funtypes.String }));
