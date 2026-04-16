"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.modifyObject = exports.getWithDefault = exports.createGuard = exports.assertIsObject = exports.assertUnreachable = exports.assertNever = void 0;
function assertNever(value) {
    throw new Error(`Unhandled discriminated union member: ${JSON.stringify(value)}`);
}
exports.assertNever = assertNever;
function assertUnreachable(value) {
    throw new Error(`Unreachable! (${value})`);
}
exports.assertUnreachable = assertUnreachable;
function isObject(maybe) {
    return typeof maybe === 'object' && maybe !== null && !Array.isArray(maybe);
}
function assertIsObject(maybe) {
    if (!isObject(maybe))
        throw new Error(`Expected object but got ${typeof maybe}`);
}
exports.assertIsObject = assertIsObject;
function createGuard(check) {
    return (maybe) => check(maybe) !== undefined;
}
exports.createGuard = createGuard;
function getWithDefault(map, key, defaultValue) {
    const previousValue = map.get(key);
    if (previousValue === undefined)
        return defaultValue;
    return previousValue;
}
exports.getWithDefault = getWithDefault;
function modifyObject(original, subObject) {
    return { ...original, ...subObject };
}
exports.modifyObject = modifyObject;
