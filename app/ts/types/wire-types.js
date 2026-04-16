"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.serialize = exports.EthereumBlockHeader = exports.EthereumBlockHeaderTransaction = exports.EthereumBlockHeaderWithTransactionHashes = exports.EthereumSignedTransactionWithBlockData = exports.EthereumSignedTransaction = exports.EthereumSendableSignedTransaction = exports.EthereumSignedTransaction1559 = exports.OptionalEthereumUnsignedTransaction = exports.EthereumUnsignedTransaction = exports.EthereumAccessList = exports.EthereumInput = exports.EthereumBlockTag = exports.EthereumTimestamp = exports.EthereumBytes256 = exports.EthereumBytes32 = exports.EthereumAddressOrMissing = exports.OptionalEthereumAddress = exports.EthereumAddress = exports.EthereumData = exports.EthereumQuantitySmall = exports.EthereumQuantity = exports.NonHexBigInt = exports.LiteralConverterParserFactory = exports.BytesParser = void 0;
const funtypes = require("funtypes");
const bigint_js_1 = require("../utils/bigint.js");
const BigIntParser = {
    parse: value => {
        if (!/^0x([a-fA-F0-9]{1,64})$/.test(value))
            return { success: false, message: `${value} is not a hex string encoded number.` };
        return { success: true, value: BigInt(value) };
    },
    serialize: value => {
        if (typeof value !== 'bigint')
            return { success: false, message: `${typeof value} is not a bigint.` };
        if (value < 0n)
            return { success: false, message: `${typeof value} is not a non negative bigint.` };
        return { success: true, value: `0x${value.toString(16)}` };
    },
};
const SmallIntParser = {
    parse: value => {
        if (!/^0x([a-fA-F0-9]{1,64})$/.test(value))
            return { success: false, message: `${value} is not a hex string encoded number.` };
        if (BigInt(value) >= 2n ** 64n)
            return { success: false, message: `${value} must be smaller than 2^64.` };
        return { success: true, value: BigInt(value) };
    },
    serialize: value => {
        if (value >= 2n ** 64n)
            return { success: false, message: `${value} must be smaller than 2^64.` };
        if (typeof value !== 'bigint')
            return { success: false, message: `${typeof value} is not a bigint.` };
        if (value < 0n)
            return { success: false, message: `${typeof value} is not a non negative bigint.` };
        return { success: true, value: `0x${value.toString(16)}` };
    },
};
const AddressParser = {
    parse: value => {
        if (!/^0x([a-fA-F0-9]{40})$/.test(value))
            return { success: false, message: `${value} is not a hex string encoded address.` };
        return { success: true, value: BigInt(value) };
    },
    serialize: value => {
        if (typeof value !== 'bigint')
            return { success: false, message: `${typeof value} is not a bigint.` };
        if (value < 0n)
            return { success: false, message: `${typeof value} is not a non negative bigint.` };
        return { success: true, value: `0x${value.toString(16).padStart(40, '0')}` };
    },
};
const Bytes32Parser = {
    parse: value => {
        if (!/^0x([a-fA-F0-9]{64})$/.test(value))
            return { success: false, message: `${value} is not a hex string encoded 32 byte value.` };
        return { success: true, value: BigInt(value) };
    },
    serialize: value => {
        if (typeof value !== 'bigint')
            return { success: false, message: `${typeof value} is not a bigint.` };
        if (value < 0n)
            return { success: false, message: `${typeof value} is not a non negative bigint.` };
        return { success: true, value: `0x${value.toString(16).padStart(64, '0')}` };
    },
};
const Bytes256Parser = {
    parse: value => {
        if (!/^0x([a-fA-F0-9]{512})$/.test(value))
            return { success: false, message: `${value} is not a hex string encoded 256 byte value.` };
        return { success: true, value: BigInt(value) };
    },
    serialize: value => {
        if (typeof value !== 'bigint')
            return { success: false, message: `${typeof value} is not a bigint.` };
        if (value < 0n)
            return { success: false, message: `${typeof value} is not a non negative bigint.` };
        return { success: true, value: `0x${value.toString(16).padStart(512, '0')}` };
    },
};
const Bytes16Parser = {
    parse: value => {
        if (!/^0x([a-fA-F0-9]{16})$/.test(value))
            return { success: false, message: `${value} is not a hex string encoded 256 byte value.` };
        return { success: true, value: BigInt(value) };
    },
    serialize: value => {
        if (typeof value !== 'bigint')
            return { success: false, message: `${typeof value} is not a bigint.` };
        if (value < 0n)
            return { success: false, message: `${typeof value} is not a non negative bigint.` };
        return { success: true, value: `0x${value.toString(16).padStart(16, '0')}` };
    },
};
exports.BytesParser = {
    parse: value => {
        const match = /^(?:0x)?([a-fA-F0-9]*)$/.exec(value);
        if (match === null)
            return { success: false, message: `Expected a hex string encoded byte array with an optional '0x' prefix but received ${value}` };
        const normalized = match[1];
        if (normalized === undefined)
            return { success: false, message: `Expected a hex string encoded byte array with an optional '0x' prefix but received ${value}` };
        if (normalized.length % 2)
            return { success: false, message: 'Hex string encoded byte array must be an even number of charcaters long.' };
        const bytes = new Uint8Array(normalized.length / 2);
        for (let i = 0; i < normalized.length; i += 2) {
            bytes[i / 2] = Number.parseInt(`${normalized[i]}${normalized[i + 1]}`, 16);
        }
        return { success: true, value: new Uint8Array(bytes) };
    },
    serialize: value => {
        if (!(value instanceof Uint8Array))
            return { success: false, message: `${typeof value} is not a Uint8Array.` };
        let result = '';
        for (let i = 0; i < value.length; ++i) {
            const val = value[i];
            if (val === undefined)
                return { success: false, message: `${typeof value} is not a Uint8Array.` };
            result += ('0' + val.toString(16)).slice(-2);
        }
        return { success: true, value: `0x${result}` };
    }
};
const TimestampParser = {
    parse: value => {
        if (!/^0x([a-fA-F0-9]*)$/.test(value))
            return { success: false, message: `${value} is not a hex string encoded timestamp.` };
        return { success: true, value: new Date(Number.parseInt(value, 16) * 1000) };
    },
    serialize: value => {
        if (!(value instanceof Date))
            return { success: false, message: `${typeof value} is not a Date.` };
        return { success: true, value: `0x${Math.floor(value.valueOf() / 1000).toString(16)}` };
    },
};
const OptionalBytesParser = {
    parse: value => exports.BytesParser.parse(value || '0x'),
    serialize: value => exports.BytesParser.serialize(value || new Uint8Array()),
};
const LiteralConverterParserFactory = (input, output) => {
    return {
        parse: value => (value === input) ? { success: true, value: output } : { success: false, message: `${value} was expected to be literal.` },
        serialize: value => (value === output) ? { success: true, value: input } : { success: false, message: `${value} was expected to be literal.` }
    };
};
exports.LiteralConverterParserFactory = LiteralConverterParserFactory;
const BigIntParserNonHex = {
    parse: value => {
        if (!/^[0-9]+$/.test(value))
            return { success: false, message: `${value} is not a string encoded number.` };
        return { success: true, value: BigInt(value) };
    },
    serialize: value => {
        if (typeof value !== 'bigint')
            return { success: false, message: `${typeof value} is not a bigint.` };
        return { success: true, value: `${value.toString()}` };
    },
};
exports.NonHexBigInt = funtypes.String.withParser(BigIntParserNonHex);
//
// Ethereum
//
exports.EthereumQuantity = funtypes.String.withParser(BigIntParser);
exports.EthereumQuantitySmall = funtypes.String.withParser(SmallIntParser);
exports.EthereumData = funtypes.String.withParser(exports.BytesParser);
exports.EthereumAddress = funtypes.String.withParser(AddressParser);
exports.OptionalEthereumAddress = funtypes.Union(exports.EthereumAddress, funtypes.Undefined);
exports.EthereumAddressOrMissing = funtypes.Union(exports.EthereumAddress, funtypes.Literal('missing').withParser((0, exports.LiteralConverterParserFactory)('missing', undefined)));
exports.EthereumBytes32 = funtypes.String.withParser(Bytes32Parser);
exports.EthereumBytes256 = funtypes.String.withParser(Bytes256Parser);
const EthereumBytes16 = funtypes.String.withParser(Bytes16Parser);
exports.EthereumTimestamp = funtypes.String.withParser(TimestampParser);
exports.EthereumBlockTag = funtypes.Union(exports.EthereumQuantitySmall, exports.EthereumBytes32, funtypes.Literal('latest'), funtypes.Literal('pending'), funtypes.Literal('finalized'));
exports.EthereumInput = funtypes.Union(funtypes.String, funtypes.Undefined).withParser(OptionalBytesParser);
exports.EthereumAccessList = funtypes.ReadonlyArray(funtypes.ReadonlyObject({
    address: exports.EthereumAddress,
    storageKeys: funtypes.ReadonlyArray(exports.EthereumBytes32)
}).asReadonly());
const EthereumUnsignedTransactionLegacy = funtypes.Intersect(funtypes.ReadonlyObject({
    type: funtypes.Union(funtypes.Literal('0x0').withParser((0, exports.LiteralConverterParserFactory)('0x0', 'legacy')), funtypes.Literal(undefined).withParser((0, exports.LiteralConverterParserFactory)(undefined, 'legacy'))),
    from: exports.EthereumAddress,
    nonce: exports.EthereumQuantity,
    gasPrice: exports.EthereumQuantity,
    gas: exports.EthereumQuantity,
    to: funtypes.Union(exports.EthereumAddress, funtypes.Null),
    value: exports.EthereumQuantity,
    input: exports.EthereumInput,
}).asReadonly(), funtypes.Partial({
    chainId: exports.EthereumQuantity,
}).asReadonly());
const EthereumUnsignedTransaction2930 = funtypes.Intersect(funtypes.ReadonlyObject({
    type: funtypes.Literal('0x1').withParser((0, exports.LiteralConverterParserFactory)('0x1', '2930')),
    from: exports.EthereumAddress,
    nonce: exports.EthereumQuantity,
    gasPrice: exports.EthereumQuantity,
    gas: exports.EthereumQuantity,
    to: funtypes.Union(exports.EthereumAddress, funtypes.Null),
    value: exports.EthereumQuantity,
    input: exports.EthereumInput,
    chainId: exports.EthereumQuantity,
}).asReadonly(), funtypes.Partial({
    accessList: exports.EthereumAccessList,
}).asReadonly());
const EthereumUnsignedTransaction1559 = funtypes.Intersect(funtypes.ReadonlyObject({
    type: funtypes.Literal('0x2').withParser((0, exports.LiteralConverterParserFactory)('0x2', '1559')),
    from: exports.EthereumAddress,
    nonce: exports.EthereumQuantity,
    maxFeePerGas: exports.EthereumQuantity,
    maxPriorityFeePerGas: exports.EthereumQuantity,
    gas: exports.EthereumQuantity,
    to: funtypes.Union(exports.EthereumAddress, funtypes.Null),
    value: exports.EthereumQuantity,
    input: exports.EthereumInput,
    chainId: exports.EthereumQuantity,
}).asReadonly(), funtypes.Partial({
    accessList: exports.EthereumAccessList,
}).asReadonly());
const EthereumUnsignedTransaction7702 = funtypes.Intersect(funtypes.ReadonlyObject({
    type: funtypes.Literal('0x4').withParser((0, exports.LiteralConverterParserFactory)('0x4', '7702')),
    from: exports.EthereumAddress,
    nonce: exports.EthereumQuantity,
    maxFeePerGas: exports.EthereumQuantity,
    maxPriorityFeePerGas: exports.EthereumQuantity,
    gas: exports.EthereumQuantity,
    to: funtypes.Union(exports.EthereumAddress, funtypes.Null),
    value: exports.EthereumQuantity,
    input: exports.EthereumInput,
    chainId: exports.EthereumQuantity,
    authorizationList: funtypes.ReadonlyArray(funtypes.ReadonlyObject({
        chainId: exports.EthereumQuantity,
        address: exports.EthereumAddress,
        nonce: exports.EthereumQuantity,
    }))
}).asReadonly(), funtypes.Partial({
    accessList: exports.EthereumAccessList,
}).asReadonly());
const EthereumUnsignedTransaction4844 = funtypes.Intersect(funtypes.ReadonlyObject({
    type: funtypes.Literal('0x3').withParser((0, exports.LiteralConverterParserFactory)('0x3', '4844')),
    from: exports.EthereumAddress,
    nonce: exports.EthereumQuantity,
    maxFeePerGas: exports.EthereumQuantity,
    maxPriorityFeePerGas: exports.EthereumQuantity,
    gas: exports.EthereumQuantity,
    to: funtypes.Union(exports.EthereumAddress, funtypes.Null),
    value: exports.EthereumQuantity,
    input: exports.EthereumInput,
    chainId: exports.EthereumQuantity,
    maxFeePerBlobGas: exports.EthereumQuantity,
    blobVersionedHashes: funtypes.ReadonlyArray(exports.EthereumBytes32),
}).asReadonly(), funtypes.Partial({
    accessList: exports.EthereumAccessList,
}).asReadonly());
exports.EthereumUnsignedTransaction = funtypes.Union(EthereumUnsignedTransactionLegacy, EthereumUnsignedTransaction2930, EthereumUnsignedTransaction1559, EthereumUnsignedTransaction4844, EthereumUnsignedTransaction7702);
const OptionalEthereumUnsignedTransaction1559 = funtypes.Intersect(funtypes.ReadonlyObject({
    type: funtypes.Literal('0x2').withParser((0, exports.LiteralConverterParserFactory)('0x2', '1559')),
    from: exports.EthereumAddress,
    nonce: exports.EthereumQuantity,
    to: funtypes.Union(exports.EthereumAddress, funtypes.Null),
    value: exports.EthereumQuantity,
    input: exports.EthereumInput,
    chainId: exports.EthereumQuantity,
}).asReadonly(), funtypes.Partial({
    gas: exports.EthereumQuantity,
    maxFeePerGas: exports.EthereumQuantity,
    maxPriorityFeePerGas: exports.EthereumQuantity,
    accessList: exports.EthereumAccessList,
}).asReadonly());
const OptionalEthereumUnsignedTransaction4844 = funtypes.Intersect(funtypes.ReadonlyObject({
    type: funtypes.Literal('0x3').withParser((0, exports.LiteralConverterParserFactory)('0x3', '4844')),
    from: exports.EthereumAddress,
    nonce: exports.EthereumQuantity,
    to: funtypes.Union(exports.EthereumAddress, funtypes.Null),
    value: exports.EthereumQuantity,
    input: exports.EthereumInput,
    chainId: exports.EthereumQuantity,
    maxFeePerBlobGas: exports.EthereumQuantity,
    blobVersionedHashes: funtypes.ReadonlyArray(exports.EthereumBytes32),
}).asReadonly(), funtypes.Partial({
    gas: exports.EthereumQuantity,
    maxFeePerGas: exports.EthereumQuantity,
    maxPriorityFeePerGas: exports.EthereumQuantity,
    accessList: exports.EthereumAccessList,
}).asReadonly());
const OptionalEthereumUnsignedTransaction7702 = funtypes.Intersect(funtypes.ReadonlyObject({
    type: funtypes.Literal('0x4').withParser((0, exports.LiteralConverterParserFactory)('0x4', '7702')),
    from: exports.EthereumAddress,
    nonce: exports.EthereumQuantity,
    to: funtypes.Union(exports.EthereumAddress, funtypes.Null),
    value: exports.EthereumQuantity,
    input: exports.EthereumInput,
    chainId: exports.EthereumQuantity,
    authorizationList: funtypes.ReadonlyArray(funtypes.ReadonlyObject({
        chainId: exports.EthereumQuantity,
        address: exports.EthereumAddress,
        nonce: exports.EthereumQuantity,
    }))
}).asReadonly(), funtypes.Partial({
    gas: exports.EthereumQuantity,
    maxFeePerGas: exports.EthereumQuantity,
    maxPriorityFeePerGas: exports.EthereumQuantity,
    accessList: exports.EthereumAccessList,
}).asReadonly());
exports.OptionalEthereumUnsignedTransaction = funtypes.Union(EthereumUnsignedTransactionLegacy, EthereumUnsignedTransaction2930, OptionalEthereumUnsignedTransaction1559, OptionalEthereumUnsignedTransaction4844, OptionalEthereumUnsignedTransaction7702);
const EthereumTransaction2930And1559And4844Signature = funtypes.Intersect(funtypes.ReadonlyObject({
    r: exports.EthereumQuantity,
    s: exports.EthereumQuantity,
    hash: exports.EthereumBytes32,
}), funtypes.Union(funtypes.ReadonlyObject({ yParity: funtypes.Union(funtypes.Literal('0x0').withParser((0, exports.LiteralConverterParserFactory)('0x0', 'even')), funtypes.Literal('0x1').withParser((0, exports.LiteralConverterParserFactory)('0x1', 'odd'))) }), funtypes.ReadonlyObject({ v: exports.EthereumQuantity })));
const MessageSignature = funtypes.ReadonlyObject({
    r: exports.EthereumQuantity,
    s: exports.EthereumQuantity,
    hash: exports.EthereumBytes32,
    v: exports.EthereumQuantity,
});
const EthereumTransactionLegacySignature = funtypes.Intersect(MessageSignature, funtypes.Union(funtypes.ReadonlyObject({
    v: exports.EthereumQuantity,
}), funtypes.ReadonlyObject({
    yParity: funtypes.Union(funtypes.Literal('0x0').withParser((0, exports.LiteralConverterParserFactory)('0x0', 'even')), funtypes.Literal('0x1').withParser((0, exports.LiteralConverterParserFactory)('0x1', 'odd'))),
    chainId: exports.EthereumQuantity,
})));
const EthereumSignedTransactionOptimismDeposit = funtypes.ReadonlyObject({
    type: funtypes.Literal('0x7e').withParser((0, exports.LiteralConverterParserFactory)('0x7e', 'optimismDeposit')),
    sourceHash: exports.EthereumBytes32,
    from: exports.EthereumAddress,
    to: funtypes.Union(exports.EthereumAddress, funtypes.Null),
    mint: funtypes.Union(exports.EthereumQuantity, funtypes.Null, funtypes.Undefined),
    value: exports.EthereumQuantity,
    gas: exports.EthereumQuantity,
    data: exports.EthereumInput,
    hash: exports.EthereumBytes32,
    gasPrice: exports.EthereumQuantity,
    nonce: exports.EthereumQuantity,
});
const EthereumSignedTransactionLegacy = funtypes.Intersect(EthereumUnsignedTransactionLegacy, EthereumTransactionLegacySignature);
const EthereumSignedTransaction2930 = funtypes.Intersect(EthereumUnsignedTransaction2930, EthereumTransaction2930And1559And4844Signature);
const EthereumSignedTransaction7702 = funtypes.Intersect(funtypes.ReadonlyObject({
    type: funtypes.Literal('0x4').withParser((0, exports.LiteralConverterParserFactory)('0x4', '7702')),
    from: exports.EthereumAddress,
    nonce: exports.EthereumQuantity,
    maxFeePerGas: exports.EthereumQuantity,
    maxPriorityFeePerGas: exports.EthereumQuantity,
    gas: exports.EthereumQuantity,
    to: funtypes.Union(exports.EthereumAddress, funtypes.Null),
    value: exports.EthereumQuantity,
    input: exports.EthereumInput,
    chainId: exports.EthereumQuantity,
    authorizationList: funtypes.ReadonlyArray(funtypes.ReadonlyObject({
        chainId: exports.EthereumQuantity,
        address: exports.EthereumAddress,
        nonce: exports.EthereumQuantity,
        r: exports.EthereumQuantity,
        s: exports.EthereumQuantity,
        yParity: funtypes.Union(funtypes.Literal('0x0').withParser((0, exports.LiteralConverterParserFactory)('0x0', 'even')), funtypes.Literal('0x1').withParser((0, exports.LiteralConverterParserFactory)('0x1', 'odd')))
    }))
}).asReadonly(), funtypes.Partial({
    accessList: exports.EthereumAccessList,
}).asReadonly(), EthereumTransaction2930And1559And4844Signature);
exports.EthereumSignedTransaction1559 = funtypes.Intersect(EthereumUnsignedTransaction1559, EthereumTransaction2930And1559And4844Signature);
const EthereumSignedTransaction4844 = funtypes.Intersect(EthereumUnsignedTransaction4844, EthereumTransaction2930And1559And4844Signature);
exports.EthereumSendableSignedTransaction = funtypes.Union(EthereumSignedTransactionLegacy, EthereumSignedTransaction2930, exports.EthereumSignedTransaction1559, EthereumSignedTransaction4844, EthereumSignedTransaction7702);
exports.EthereumSignedTransaction = funtypes.Union(exports.EthereumSendableSignedTransaction, EthereumSignedTransactionOptimismDeposit);
exports.EthereumSignedTransactionWithBlockData = funtypes.Intersect(funtypes.Union(EthereumSignedTransactionLegacy, EthereumSignedTransaction2930, funtypes.Intersect(exports.EthereumSignedTransaction1559, funtypes.ReadonlyObject({ gasPrice: exports.EthereumQuantity })), funtypes.Intersect(EthereumSignedTransaction4844, funtypes.ReadonlyObject({ gasPrice: exports.EthereumQuantity })), funtypes.Intersect(EthereumSignedTransaction7702, funtypes.ReadonlyObject({ gasPrice: exports.EthereumQuantity }))), funtypes.ReadonlyObject({
    data: exports.EthereumInput,
    blockHash: funtypes.Union(exports.EthereumBytes32, funtypes.Null),
    blockNumber: funtypes.Union(exports.EthereumQuantity, funtypes.Null),
    transactionIndex: funtypes.Union(exports.EthereumQuantity, funtypes.Null),
    v: exports.EthereumQuantity,
}));
const EthereumWithdrawal = funtypes.ReadonlyObject({
    index: exports.EthereumQuantity,
    validatorIndex: exports.EthereumQuantity,
    address: exports.EthereumAddress,
    amount: exports.EthereumQuantity,
});
const EthereumBlockHeaderWithoutTransactions = funtypes.Intersect(funtypes.MutablePartial({
    author: exports.EthereumAddress,
}), funtypes.Intersect(funtypes.ReadonlyObject({
    difficulty: exports.EthereumQuantity,
    extraData: exports.EthereumData,
    gasLimit: exports.EthereumQuantity,
    gasUsed: exports.EthereumQuantity,
    hash: exports.EthereumBytes32,
    logsBloom: exports.EthereumBytes256,
    miner: exports.EthereumAddress,
    mixHash: exports.EthereumBytes32,
    nonce: EthereumBytes16,
    number: exports.EthereumQuantity,
    parentHash: exports.EthereumBytes32,
    receiptsRoot: exports.EthereumBytes32,
    sha3Uncles: exports.EthereumBytes32,
    stateRoot: exports.EthereumBytes32,
    timestamp: exports.EthereumTimestamp,
    size: exports.EthereumQuantity,
    uncles: funtypes.ReadonlyArray(exports.EthereumBytes32),
    baseFeePerGas: funtypes.Union(exports.EthereumQuantity, funtypes.Undefined),
    transactionsRoot: exports.EthereumBytes32,
}), funtypes.ReadonlyPartial({
    excessBlobGas: exports.EthereumQuantity,
    blobGasUsed: exports.EthereumQuantity,
    parentBeaconBlockRoot: exports.EthereumBytes32,
    withdrawalsRoot: exports.EthereumBytes32, // missing from old block
    withdrawals: funtypes.ReadonlyArray(EthereumWithdrawal), // missing from old block
    totalDifficulty: exports.EthereumQuantity, // missing from new blocks
})));
exports.EthereumBlockHeaderWithTransactionHashes = funtypes.Union(funtypes.Null, funtypes.Intersect(EthereumBlockHeaderWithoutTransactions, funtypes.ReadonlyObject({ transactions: funtypes.ReadonlyArray(exports.EthereumBytes32) })));
const EthereumUnknownTransactionType = funtypes.ReadonlyObject({
    hash: exports.EthereumBytes32,
    type: funtypes.String.withConstraint((type) => {
        if (!(0, bigint_js_1.isHexEncodedNumber)(type))
            return false;
        const alreadyHandled = ['0x0', '0x1', '0x2', '0x3', '0x4', '0x7e'];
        if (alreadyHandled.includes(type))
            return false;
        return true;
    })
});
exports.EthereumBlockHeaderTransaction = funtypes.Union(exports.EthereumSignedTransaction, EthereumUnknownTransactionType);
exports.EthereumBlockHeader = funtypes.Union(funtypes.Null, funtypes.Intersect(EthereumBlockHeaderWithoutTransactions, funtypes.ReadonlyObject({ transactions: funtypes.ReadonlyArray(exports.EthereumBlockHeaderTransaction) })));
//
// Helpers
//
function serialize(funtype, value) {
    return funtype.serialize(value);
}
exports.serialize = serialize;
