import { toRlp as encodeRlp } from './ethereumPrimitives.js'
import { bigintToUint8Array, dataString, stringToUint8Array } from './bigint.js'
import { stripLeadingZeros } from './typed-arrays.js'
import { type DistributiveOmit, assertNever } from './typescript.js'
import type { EthereumSignedTransaction, EthereumUnsignedTransaction } from '../types/wire-types.js'

interface IUnsignedTransactionLegacy {
	readonly type: 'legacy'
	readonly from: bigint
	readonly nonce: bigint
	readonly gasPrice: bigint
	readonly gasLimit: bigint
	readonly to: bigint | null
	readonly value: bigint
	readonly input: Uint8Array
	readonly chainId?: bigint
}

interface IUnsignedTransaction2930 {
	readonly type: '2930'
	readonly from: bigint
	readonly chainId: bigint
	readonly nonce: bigint
	readonly gasPrice: bigint
	readonly gasLimit: bigint
	readonly to: bigint | null
	readonly value: bigint
	readonly input: Uint8Array
	readonly accessList: readonly {
		readonly address: bigint
		readonly storageKeys: readonly bigint[]
	}[]
}

export interface IUnsignedTransaction1559 {
	readonly type: '1559'
	readonly from: bigint
	readonly chainId: bigint
	readonly nonce: bigint
	readonly maxFeePerGas: bigint
	readonly maxPriorityFeePerGas: bigint
	readonly gasLimit: bigint
	readonly to: bigint | null
	readonly value: bigint
	readonly input: Uint8Array
	readonly accessList: readonly {
		readonly address: bigint
		readonly storageKeys: readonly bigint[]
	}[]
}

interface IOptimismDepositTransaction {
	readonly type: 'optimismDeposit'
	readonly sourceHash: bigint
	readonly from: bigint
	readonly to: bigint | null
	readonly mint: bigint | null | undefined
	readonly value: bigint
	readonly gas: bigint
	readonly data: Uint8Array
	readonly hash: bigint
}

interface IUnsignedTransaction4844 {
	readonly type: '4844'
	readonly from: bigint
	readonly chainId: bigint
	readonly nonce: bigint
	readonly maxFeePerGas: bigint
	readonly maxPriorityFeePerGas: bigint
	readonly gasLimit: bigint
	readonly to: bigint | null
	readonly value: bigint
	readonly input: Uint8Array
	readonly accessList: readonly {
		readonly address: bigint
		readonly storageKeys: readonly bigint[]
	}[]
	readonly maxFeePerBlobGas: bigint,
	readonly blobVersionedHashes: readonly bigint[]
}

export interface IUnsignedTransaction7702 {
	readonly type: '7702'
	readonly from: bigint
	readonly chainId: bigint
	readonly nonce: bigint
	readonly maxFeePerGas: bigint
	readonly maxPriorityFeePerGas: bigint
	readonly gasLimit: bigint
	readonly to: bigint | null
	readonly value: bigint
	readonly input: Uint8Array
	readonly accessList: readonly {
		readonly address: bigint
		readonly storageKeys: readonly bigint[]
	}[]
	readonly authorizationList: readonly {
		readonly chainId: bigint
		readonly address: bigint
		readonly nonce: bigint
		readonly authority?: bigint
		readonly yParity?: 'even' | 'odd'
		readonly r?: bigint
		readonly s?: bigint
	}[]
}

type ISignedTransaction7702 = {
	readonly type: '7702'
	readonly from: bigint
	readonly chainId: bigint
	readonly nonce: bigint
	readonly maxFeePerGas: bigint
	readonly maxPriorityFeePerGas: bigint
	readonly gasLimit: bigint
	readonly to: bigint | null
	readonly value: bigint
	readonly input: Uint8Array
	readonly accessList: readonly {
		readonly address: bigint
		readonly storageKeys: readonly bigint[]
	}[]
	readonly authorizationList: readonly {
		chainId: bigint,
		address: bigint,
		nonce: bigint,
		authority?: bigint,
		yParity: 'even' | 'odd',
		r: bigint,
		s: bigint
	}[]
} & ITransactionSignature1559and2930and4844

type ITransactionSignatureLegacy = {
	readonly r: bigint
	readonly s: bigint
	readonly hash: bigint
} & ({
	readonly v: bigint
} | {
	readonly yParity: 'even' | 'odd'
	readonly chainId: bigint
})

type ITransactionSignature1559and2930and4844 = {
	readonly r: bigint
	readonly s: bigint
	readonly yParity: 'even' | 'odd'
	readonly hash: bigint
}

type IUnsignedTransaction = IUnsignedTransactionLegacy | IUnsignedTransaction2930 | IUnsignedTransaction1559 | IUnsignedTransaction4844 | IUnsignedTransaction7702
type ISignedTransaction1559 = IUnsignedTransaction1559 & ITransactionSignature1559and2930and4844
type ISignedTransactionLegacy = IUnsignedTransactionLegacy & ITransactionSignatureLegacy
type ISignedTransaction2930 = IUnsignedTransaction2930 & ITransactionSignature1559and2930and4844
type ISignedTransaction4844 = IUnsignedTransaction4844 & ITransactionSignature1559and2930and4844
type ISignedTransaction = ISignedTransaction1559 | ISignedTransactionLegacy | ISignedTransaction2930 | ISignedTransaction4844 | IOptimismDepositTransaction | ISignedTransaction7702

function calculateV(transaction: DistributiveOmit<ITransactionSignatureLegacy, 'hash'>): bigint {
	if ('v' in transaction) return transaction.v
	return (transaction.yParity === 'even' ? 0n : 1n) + 35n + 2n * transaction.chainId
}

function parityFromV(v: bigint): 'even' | 'odd' {
	if (v === 0n) return 'even'
	if (v === 1n) return 'odd'
	throw new Error(`Unsupported transaction v for typed transaction: ${v}`)
}

type RlpEncodeableData = Uint8Array | RlpEncodeableData[]
type RlpValue = `0x${ string }` | readonly RlpValue[]
export function rlpEncode(data: RlpEncodeableData[]): Uint8Array {
	function rlpEncodeArray(data: RlpEncodeableData): RlpValue {
		if (!Array.isArray(data)) return `0x${ dataString(data) }`
		return data.map((x) => rlpEncodeArray(x))
	}
	return stringToUint8Array(encodeRlp(data.map((x) => rlpEncodeArray(x)), 'hex'))
}

const encodeTransactionRecipient = (recipient: bigint | null) => recipient === null ? new Uint8Array(0) : bigintToUint8Array(recipient, 20)

const encodeTransactionAccessList = (accessList: readonly { address: bigint, storageKeys: readonly bigint[] }[]) => {
	return accessList.map(({ address, storageKeys }) => [bigintToUint8Array(address, 20), storageKeys.map((slot) => bigintToUint8Array(slot, 32))])
}

const encodeTransactionSignature = (transaction: { yParity: 'even' | 'odd', r: bigint, s: bigint }) => [
	stripLeadingZeros(new Uint8Array([transaction.yParity === 'even' ? 0 : 1])),
	stripLeadingZeros(bigintToUint8Array(transaction.r, 32)),
	stripLeadingZeros(bigintToUint8Array(transaction.s, 32)),
]

function rlpEncodeSignedLegacyTransactionPayload(transaction: DistributiveOmit<ISignedTransactionLegacy, 'hash'>): Uint8Array {
	return rlpEncode([
		stripLeadingZeros(bigintToUint8Array(transaction.nonce, 32)),
		stripLeadingZeros(bigintToUint8Array(transaction.gasPrice!, 32)),
		stripLeadingZeros(bigintToUint8Array(transaction.gasLimit, 32)),
		encodeTransactionRecipient(transaction.to),
		stripLeadingZeros(bigintToUint8Array(transaction.value, 32)),
		new Uint8Array(transaction.input),
		stripLeadingZeros(bigintToUint8Array(calculateV(transaction), 32)),
		(stripLeadingZeros(bigintToUint8Array(transaction.r, 32))),
		stripLeadingZeros(bigintToUint8Array(transaction.s, 32)),
	])
}

function rlpEncodeSigned2930TransactionPayload(transaction: DistributiveOmit<ISignedTransaction2930, 'hash'>): Uint8Array {
	return rlpEncode([
		stripLeadingZeros(bigintToUint8Array(transaction.chainId, 32)),
		stripLeadingZeros(bigintToUint8Array(transaction.nonce, 32)),
		stripLeadingZeros(bigintToUint8Array(transaction.gasPrice, 32)),
		stripLeadingZeros(bigintToUint8Array(transaction.gasLimit, 32)),
		encodeTransactionRecipient(transaction.to),
		stripLeadingZeros(bigintToUint8Array(transaction.value, 32)),
		transaction.input,
		encodeTransactionAccessList(transaction.accessList),
		...encodeTransactionSignature(transaction),
	])
}

function rlpEncodeSigned1559TransactionPayload(transaction: DistributiveOmit<ISignedTransaction1559, 'hash'>): Uint8Array {
	return rlpEncode([
		stripLeadingZeros(bigintToUint8Array(transaction.chainId, 32)),
		stripLeadingZeros(bigintToUint8Array(transaction.nonce, 32)),
		stripLeadingZeros(bigintToUint8Array(transaction.maxPriorityFeePerGas, 32)),
		stripLeadingZeros(bigintToUint8Array(transaction.maxFeePerGas, 32)),
		stripLeadingZeros(bigintToUint8Array(transaction.gasLimit, 32)),
		encodeTransactionRecipient(transaction.to),
		stripLeadingZeros(bigintToUint8Array(transaction.value, 32)),
		transaction.input,
		encodeTransactionAccessList(transaction.accessList),
		...encodeTransactionSignature(transaction),
	])
}
function rlpEncodeSigned7702TransactionPayload(transaction: DistributiveOmit<ISignedTransaction7702, 'hash'>): Uint8Array {
	return rlpEncode([
		stripLeadingZeros(bigintToUint8Array(transaction.chainId, 32)),
		stripLeadingZeros(bigintToUint8Array(transaction.nonce, 32)),
		stripLeadingZeros(bigintToUint8Array(transaction.maxPriorityFeePerGas, 32)),
		stripLeadingZeros(bigintToUint8Array(transaction.maxFeePerGas, 32)),
		stripLeadingZeros(bigintToUint8Array(transaction.gasLimit, 32)),
		encodeTransactionRecipient(transaction.to),
		stripLeadingZeros(bigintToUint8Array(transaction.value, 32)),
		transaction.input,
		encodeTransactionAccessList(transaction.accessList),
		transaction.authorizationList.map(({ chainId, address, nonce, yParity, r, s }) => [
			stripLeadingZeros(bigintToUint8Array(chainId, 32)),
			bigintToUint8Array(address, 20),
			stripLeadingZeros(bigintToUint8Array(nonce, 32)),
			stripLeadingZeros(new Uint8Array([yParity === 'even' ? 0 : 1])),
			stripLeadingZeros(bigintToUint8Array(r, 32)),
			stripLeadingZeros(bigintToUint8Array(s, 32)),
		]),
		...encodeTransactionSignature(transaction),
	])
}

function rlpEncodeSigned4844TransactionPayload(transaction: DistributiveOmit<ISignedTransaction4844, 'hash'>): Uint8Array {
	return rlpEncode([
		stripLeadingZeros(bigintToUint8Array(transaction.chainId, 32)),
		stripLeadingZeros(bigintToUint8Array(transaction.nonce, 32)),
		stripLeadingZeros(bigintToUint8Array(transaction.maxPriorityFeePerGas, 32)),
		stripLeadingZeros(bigintToUint8Array(transaction.maxFeePerGas, 32)),
		stripLeadingZeros(bigintToUint8Array(transaction.gasLimit, 32)),
		encodeTransactionRecipient(transaction.to),
		stripLeadingZeros(bigintToUint8Array(transaction.value, 32)),
		transaction.input,
		encodeTransactionAccessList(transaction.accessList),
		stripLeadingZeros(bigintToUint8Array(transaction.maxFeePerBlobGas, 32)),
		transaction.blobVersionedHashes.map((blobVersionedHash) => bigintToUint8Array(blobVersionedHash, 32)),
		...encodeTransactionSignature(transaction),
	])
}

function rlpEncodeUnsignedLegacyTransactionPayload(transaction: IUnsignedTransactionLegacy): Uint8Array {
	const toEncode = [
		stripLeadingZeros(bigintToUint8Array(transaction.nonce, 32)),
		stripLeadingZeros(bigintToUint8Array(transaction.gasPrice!, 32)),
		stripLeadingZeros(bigintToUint8Array(transaction.gasLimit, 32)),
		encodeTransactionRecipient(transaction.to),
		stripLeadingZeros(bigintToUint8Array(transaction.value, 32)),
		new Uint8Array(transaction.input),
	]
	if ('chainId' in transaction && transaction.chainId !== undefined) {
		toEncode.push(stripLeadingZeros(bigintToUint8Array(transaction.chainId, 32)))
		toEncode.push(stripLeadingZeros(new Uint8Array(0)))
		toEncode.push(stripLeadingZeros(new Uint8Array(0)))
	}
	return rlpEncode(toEncode)
}

function rlpEncodeUnsigned2930TransactionPayload(transaction: IUnsignedTransaction2930 | ISignedTransaction2930): Uint8Array {
	return rlpEncode([
		stripLeadingZeros(bigintToUint8Array(transaction.chainId, 32)),
		stripLeadingZeros(bigintToUint8Array(transaction.nonce, 32)),
		stripLeadingZeros(bigintToUint8Array(transaction.gasPrice, 32)),
		stripLeadingZeros(bigintToUint8Array(transaction.gasLimit, 32)),
		encodeTransactionRecipient(transaction.to),
		stripLeadingZeros(bigintToUint8Array(transaction.value, 32)),
		transaction.input,
		encodeTransactionAccessList(transaction.accessList),
	])
}

function rlpEncodeUnsigned1559TransactionPayload(transaction: IUnsignedTransaction1559): Uint8Array {
	const toEncode = [
		stripLeadingZeros(bigintToUint8Array(transaction.chainId, 32)),
		stripLeadingZeros(bigintToUint8Array(transaction.nonce, 32)),
		stripLeadingZeros(bigintToUint8Array(transaction.maxPriorityFeePerGas, 32)),
		stripLeadingZeros(bigintToUint8Array(transaction.maxFeePerGas, 32)),
		stripLeadingZeros(bigintToUint8Array(transaction.gasLimit, 32)),
		encodeTransactionRecipient(transaction.to),
		stripLeadingZeros(bigintToUint8Array(transaction.value, 32)),
		transaction.input,
		encodeTransactionAccessList(transaction.accessList),
	]
	return rlpEncode(toEncode)
}

function rlpEncodeUnsigned4844TransactionPayload(transaction: IUnsignedTransaction4844): Uint8Array {
	const toEncode = [
		stripLeadingZeros(bigintToUint8Array(transaction.chainId, 32)),
		stripLeadingZeros(bigintToUint8Array(transaction.nonce, 32)),
		stripLeadingZeros(bigintToUint8Array(transaction.maxPriorityFeePerGas, 32)),
		stripLeadingZeros(bigintToUint8Array(transaction.maxFeePerGas, 32)),
		stripLeadingZeros(bigintToUint8Array(transaction.gasLimit, 32)),
		encodeTransactionRecipient(transaction.to),
		stripLeadingZeros(bigintToUint8Array(transaction.value, 32)),
		transaction.input,
		encodeTransactionAccessList(transaction.accessList),
		stripLeadingZeros(bigintToUint8Array(transaction.maxFeePerBlobGas, 32)),
		transaction.blobVersionedHashes.map((blobVersionedHash) => bigintToUint8Array(blobVersionedHash, 32)),
	]
	return rlpEncode(toEncode)
}

function rlpEncodeUnsigned7702TransactionPayload(transaction: IUnsignedTransaction7702): Uint8Array {
	const toEncode = [
		stripLeadingZeros(bigintToUint8Array(transaction.chainId, 32)),
		stripLeadingZeros(bigintToUint8Array(transaction.nonce, 32)),
		stripLeadingZeros(bigintToUint8Array(transaction.maxPriorityFeePerGas, 32)),
		stripLeadingZeros(bigintToUint8Array(transaction.maxFeePerGas, 32)),
		stripLeadingZeros(bigintToUint8Array(transaction.gasLimit, 32)),
		encodeTransactionRecipient(transaction.to),
		stripLeadingZeros(bigintToUint8Array(transaction.value, 32)),
		transaction.input,
		encodeTransactionAccessList(transaction.accessList),
		transaction.authorizationList.map(({ chainId, address, nonce }) => [
			stripLeadingZeros(bigintToUint8Array(chainId, 32)),
			bigintToUint8Array(address, 20),
			stripLeadingZeros(bigintToUint8Array(nonce, 32)),
		]),
	]
	return rlpEncode(toEncode)
}

export function serializeSignedTransactionToBytes(transaction: DistributiveOmit<ISignedTransaction, 'hash'>): Uint8Array {
	switch (transaction.type) {
		case 'legacy': return rlpEncodeSignedLegacyTransactionPayload(transaction)
		case '2930': return new Uint8Array([1, ...rlpEncodeSigned2930TransactionPayload(transaction)])
		case '1559': return new Uint8Array([2, ...rlpEncodeSigned1559TransactionPayload(transaction)])
		case '7702': return new Uint8Array([4, ...rlpEncodeSigned7702TransactionPayload(transaction)])
		case '4844': return new Uint8Array([3, ...rlpEncodeSigned4844TransactionPayload(transaction)])
		case 'optimismDeposit': throw new Error('Serializing optimismDeposit (0x7e) transaction is not supported')
		default: assertNever(transaction)
	}
}

export function serializeUnsignedTransactionToBytes(transaction: IUnsignedTransaction): Uint8Array {
	switch (transaction.type) {
		case 'legacy': return rlpEncodeUnsignedLegacyTransactionPayload(transaction)
		case '2930': return new Uint8Array([1, ...rlpEncodeUnsigned2930TransactionPayload(transaction)])
		case '1559': return new Uint8Array([2, ...rlpEncodeUnsigned1559TransactionPayload(transaction)])
		case '7702': return new Uint8Array([4, ...rlpEncodeUnsigned7702TransactionPayload(transaction)])
		case '4844': return new Uint8Array([3, ...rlpEncodeUnsigned4844TransactionPayload(transaction)])
		default: assertNever(transaction)
	}
}

export function EthereumUnsignedTransactionToUnsignedTransaction(transaction: EthereumUnsignedTransaction): IUnsignedTransaction {
	switch (transaction.type) {
		case '7702':
		case '4844':
		case '2930':
		case '1559': {
			const { gas, ...other } = transaction
			return {
				...other,
				gasLimit: gas,
				accessList: transaction.accessList !== undefined ? transaction.accessList : []
			}
		}
		case 'legacy': {
			const { gas, ...other } = transaction
			return {
				...other,
				gasLimit: gas,
			}
		}
	}
}

export function EthereumSignedTransactionToSignedTransaction(transaction: EthereumSignedTransaction): ISignedTransaction {
	switch (transaction.type) {
		case '4844':
		case '2930':
		case '7702':
		case '1559': return {
			...transaction,
			yParity: 'yParity' in transaction ? transaction.yParity : parityFromV(transaction.v),
			gasLimit: transaction.gas,
			accessList: transaction.accessList !== undefined ? transaction.accessList : [],
		}
		case 'legacy': return {
			...transaction,
			gasLimit: transaction.gas,
		}
		case 'optimismDeposit': return transaction
		default: assertNever(transaction)
	}
}

export function truncateAddr(address: string, charactersFromEachEnd = 7) {
	return `0x${address.substring(2, 2 + charactersFromEachEnd)}…${address.substring(address.length - charactersFromEachEnd, address.length)}`
}
