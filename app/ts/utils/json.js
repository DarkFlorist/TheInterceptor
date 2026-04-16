"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.jsonParserWithNumbersAsStringsConverter = exports.isJSON = exports.JSONEncodeableObjectArray = exports.JSONEncodeableObject = void 0;
const funtypes = require("funtypes");
const JSONEncodeable = funtypes.Lazy(() => funtypes.Union(funtypes.String, funtypes.Boolean, funtypes.Number, funtypes.ReadonlyArray(JSONEncodeable), funtypes.ReadonlyRecord(funtypes.String, JSONEncodeable)));
exports.JSONEncodeableObject = funtypes.ReadonlyRecord(funtypes.String, JSONEncodeable);
exports.JSONEncodeableObjectArray = funtypes.Union(funtypes.ReadonlyArray(JSONEncodeable));
const JSONEncodeableObjectOrArray = funtypes.Union(exports.JSONEncodeableObject, exports.JSONEncodeableObjectArray);
function isJSON(text) {
    if (typeof text !== 'string')
        return false;
    try {
        JSON.parse(text);
        return true;
    }
    catch (error) {
        return false;
    }
}
exports.isJSON = isJSON;
function jsonParserWithNumbersAsStringsConverter(jsonString) {
    const reviver = (_key, value, context) => typeof value === 'number' && context !== undefined ? context.source : value;
    // cast necessary until this is fixed: https://github.com/microsoft/TypeScript/issues/61330
    return JSON.parse(jsonString, reviver);
}
exports.jsonParserWithNumbersAsStringsConverter = jsonParserWithNumbersAsStringsConverter;
