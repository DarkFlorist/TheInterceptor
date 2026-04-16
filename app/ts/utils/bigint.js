"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generate256BitRandomBigInt = exports.dateToBigintSeconds = exports.bigintSecondsToDate = exports.calculateWeightedPercentile = exports.isHexEncodedNumber = exports.abs = exports.max = exports.min = exports.bytesToUnsigned = exports.stringifyJSONWithBigInts = exports.bigintToUint8Array = exports.dataStringWith0xStart = exports.dataString = exports.stringToUint8Array = exports.bytes32String = exports.stringToAddress = exports.checksummedAddress = exports.addressStringWithout0x = exports.addressString = exports.nanoString = exports.bigintToRoundedPrettyDecimalString = exports.bigintToNumberFormatParts = exports.bigintToDecimalString = void 0;
const ethers_1 = require("ethers");
function bigintToDecimalString(value, power) {
    const integerPart = (0, exports.abs)(value / 10n ** power);
    const fractionalPart = (0, exports.abs)(value % 10n ** power);
    const sign = value < 0n ? '-' : '';
    if (fractionalPart === 0n)
        return `${sign}${integerPart.toString(10)}`;
    return `${sign}${integerPart.toString(10)}.${fractionalPart.toString(10).padStart(Number(power), '0').replace(/0+$/, '')}`;
}
exports.bigintToDecimalString = bigintToDecimalString;
const bigintToNumberFormatParts = (amount, decimals = 18n, maximumSignificantDigits = 4) => {
    const floatValue = Number(ethers_1.ethers.formatUnits(amount, decimals));
    let formatterOptions = { useGrouping: false, maximumFractionDigits: 3 };
    // maintain accuracy if value is a fraction of 1 ex 0.00001
    if (floatValue % 1 === floatValue)
        formatterOptions.maximumSignificantDigits = maximumSignificantDigits;
    // apply only compacting with prefixes for values >= 10k or values <= -10k
    if (Math.abs(floatValue) >= 1e4) {
        formatterOptions = { minimumFractionDigits: 0, notation: 'compact' };
    }
    const formatter = new Intl.NumberFormat('en-US', formatterOptions);
    const parts = formatter.formatToParts(floatValue);
    const partsMap = new Map();
    for (const part of parts) {
        if (part.type === 'compact') {
            // replace American format with Metric prefixes https://www.ibiblio.org/units/prefixes.html
            const prefix = part.value.replace('K', 'k').replace('B', 'G');
            partsMap.set(part.type, prefix);
            continue;
        }
        partsMap.set(part.type, part.value);
    }
    return partsMap;
};
exports.bigintToNumberFormatParts = bigintToNumberFormatParts;
const bigintToRoundedPrettyDecimalString = (amount, decimals, maximumSignificantDigits = 4) => {
    const numberParts = (0, exports.bigintToNumberFormatParts)(amount, decimals, maximumSignificantDigits);
    let numberString = '';
    for (const [_type, value] of numberParts)
        numberString += value;
    return numberString;
};
exports.bigintToRoundedPrettyDecimalString = bigintToRoundedPrettyDecimalString;
const nanoString = (value) => bigintToDecimalString(value, 9n);
exports.nanoString = nanoString;
const addressString = (address) => `0x${address.toString(16).padStart(40, '0')}`;
exports.addressString = addressString;
const addressStringWithout0x = (address) => address.toString(16).padStart(40, '0');
exports.addressStringWithout0x = addressStringWithout0x;
const checksummedAddress = (address) => ethers_1.ethers.getAddress((0, exports.addressString)(address));
exports.checksummedAddress = checksummedAddress;
function stringToAddress(addressString) {
    if (addressString === undefined)
        return undefined;
    const trimmedAddress = addressString.trim();
    if (!ethers_1.ethers.isAddress(trimmedAddress))
        return undefined;
    return BigInt(trimmedAddress);
}
exports.stringToAddress = stringToAddress;
const bytes32String = (bytes32) => `0x${bytes32.toString(16).padStart(64, '0')}`;
exports.bytes32String = bytes32String;
function stringToUint8Array(data) {
    const dataLength = (data.length - 2) / 2;
    if (dataLength === 0)
        return new Uint8Array();
    return bigintToUint8Array(BigInt(data), dataLength);
}
exports.stringToUint8Array = stringToUint8Array;
function dataString(data) {
    if (data === null)
        return '';
    return Array.from(data).map(x => x.toString(16).padStart(2, '0')).join('');
}
exports.dataString = dataString;
function dataStringWith0xStart(data) {
    return `0x${dataString(data)}`;
}
exports.dataStringWith0xStart = dataStringWith0xStart;
function bigintToUint8Array(value, numberOfBytes) {
    if (typeof value === 'number')
        value = BigInt(value);
    if (value >= 2n ** BigInt(numberOfBytes * 8) || value < 0n)
        throw new Error(`Cannot fit ${value} into a ${numberOfBytes}-byte unsigned integer.`);
    const result = new Uint8Array(numberOfBytes);
    for (let i = 0; i < result.length; ++i) {
        result[i] = Number((value >> BigInt(numberOfBytes - i - 1) * 8n) & 0xffn);
    }
    return result;
}
exports.bigintToUint8Array = bigintToUint8Array;
// biome-ignore lint/suspicious/noExplicitAny: matches JSON.stringify signature
function stringifyJSONWithBigInts(value, space) {
    return JSON.stringify(value, (_key, value) => {
        if (typeof value === 'bigint')
            return `0x${value.toString(16)}`;
        if (value instanceof Uint8Array)
            return '0x' + Array.from(value).map(b => b.toString(16).padStart(2, '0')).join('');
        return value;
    }, space);
}
exports.stringifyJSONWithBigInts = stringifyJSONWithBigInts;
function bytesToUnsigned(bytes) {
    let value = 0n;
    for (const byte of bytes) {
        value = (value << 8n) + BigInt(byte);
    }
    return value;
}
exports.bytesToUnsigned = bytesToUnsigned;
const min = (left, right) => left < right ? left : right;
exports.min = min;
const max = (left, right) => left > right ? left : right;
exports.max = max;
const abs = (x) => (x < 0n) ? -1n * x : x;
exports.abs = abs;
function isHexEncodedNumber(input) {
    const hexNumberRegex = /^(0x)?[0-9a-fA-F]+$/;
    return hexNumberRegex.test(input);
}
exports.isHexEncodedNumber = isHexEncodedNumber;
function calculateWeightedPercentile(data, percentile) {
    if (data.length === 0)
        return 0n;
    if (percentile < 0 || percentile > 100 || data.map((point) => point.weight).some((weight) => weight < 0))
        throw new Error('Invalid input');
    const sortedData = [...data].sort((a, b) => a.dataPoint < b.dataPoint ? -1 : a.dataPoint > b.dataPoint ? 1 : 0);
    const cumulativeWeights = sortedData.map((point) => point.weight).reduce((acc, w, i) => [...acc, (acc[i] ?? 0n) + w], [0n]);
    const totalWeight = cumulativeWeights[cumulativeWeights.length - 1];
    if (totalWeight === undefined)
        throw new Error('Invalid input');
    const targetIndex = percentile * totalWeight / 100n;
    const index = cumulativeWeights.findIndex(w => w >= targetIndex);
    if (index === -1)
        throw new Error('Invalid input');
    const lowerIndex = index === 0 ? 0 : index - 1;
    const upperIndex = index;
    const lowerValue = sortedData[lowerIndex];
    const upperValue = sortedData[upperIndex];
    const lowerWeight = cumulativeWeights[lowerIndex];
    const upperWeight = cumulativeWeights[upperIndex];
    if (lowerWeight === undefined || upperWeight === undefined || lowerValue === undefined || upperValue === undefined)
        throw new Error('weights were undefined');
    if (lowerIndex === upperIndex)
        return lowerValue.dataPoint;
    const interpolation = (targetIndex - lowerWeight) / (upperWeight - lowerWeight);
    return lowerValue.dataPoint + (upperValue.dataPoint - lowerValue.dataPoint) * interpolation;
}
exports.calculateWeightedPercentile = calculateWeightedPercentile;
const bigintSecondsToDate = (seconds) => {
    if (seconds > 8640000000000n)
        throw new Error(`Too big seconds value: ${seconds}`);
    if (seconds < 0)
        throw new Error(`Got negative seconds: ${seconds}`);
    return new Date(Number(seconds) * 1000);
};
exports.bigintSecondsToDate = bigintSecondsToDate;
const dateToBigintSeconds = (date) => BigInt(date.getTime()) / 1000n;
exports.dateToBigintSeconds = dateToBigintSeconds;
function generate256BitRandomBigInt() {
    const cryptoInterface = globalThis.crypto;
    if (cryptoInterface === undefined || cryptoInterface.getRandomValues === undefined) {
        throw new Error("Secure random number generator is not available in this environment");
    }
    const randomBytes = new Uint8Array(32);
    cryptoInterface.getRandomValues(randomBytes);
    return bytesToUnsigned(randomBytes);
}
exports.generate256BitRandomBigInt = generate256BitRandomBigInt;
