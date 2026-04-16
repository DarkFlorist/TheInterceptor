"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.interleave = exports.replaceElementInReadonlyArray = exports.getUniqueItemsByProperties = exports.stripLeadingZeros = exports.areEqualArrays = exports.areEqualUint8Arrays = void 0;
function areEqualUint8Arrays(first, second) {
    if (first === second)
        return true;
    if (first === undefined)
        return second === undefined;
    if (second === undefined)
        return first === undefined;
    if (first.length !== second.length)
        return false;
    return first.every((value, index) => value === second[index]);
}
exports.areEqualUint8Arrays = areEqualUint8Arrays;
function areEqualArrays(first, second) {
    if (first === second)
        return true;
    if (first.length !== second.length)
        return false;
    return first.every((value, index) => value === second[index]);
}
exports.areEqualArrays = areEqualArrays;
function stripLeadingZeros(byteArray) {
    let i = 0;
    for (; i < byteArray.length; ++i) {
        if (byteArray[i] !== 0)
            break;
    }
    const result = new Uint8Array(byteArray.length - i);
    for (let j = 0; j < result.length; ++j) {
        const byte = byteArray[i + j];
        if (byte === undefined)
            throw new Error('byte array is too short');
        result[j] = byte;
    }
    return result;
}
exports.stripLeadingZeros = stripLeadingZeros;
const arePropValuesEqual = (subject, target, propNames) => propNames.every(propName => subject[propName] === target[propName]);
const getUniqueItemsByProperties = (items, propNames) => items.filter((item, index, array) => index === array.findIndex(foundItem => arePropValuesEqual(foundItem, item, propNames)));
exports.getUniqueItemsByProperties = getUniqueItemsByProperties;
function replaceElementInReadonlyArray(originalArray, index, newValue) {
    if (index < 0 || index >= originalArray.length)
        throw new Error('Index is out of bounds');
    const newArray = [...originalArray];
    newArray[index] = newValue;
    return newArray;
}
exports.replaceElementInReadonlyArray = replaceElementInReadonlyArray;
function interleave(arr, addBetween) {
    return arr.reduce((acc, curr, index) => {
        if (index !== arr.length - 1)
            acc.push(curr, addBetween);
        else
            acc.push(curr);
        return acc;
    }, []);
}
exports.interleave = interleave;
