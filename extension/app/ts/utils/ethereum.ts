import { keccak256, secp256k1 } from '@zoltu/ethereum-crypto'
import { rlpEncode } from '@zoltu/rlp-encoder'
import { bigintToUint8Array, dataString } from './bigint.js'
import { stripLeadingZeros } from './typed-arrays.js'
import { assertNever } from './typescript.js'
import { EthereumSignedTransaction, EthereumUnsignedTransaction } from './wire-types.js'

export interface IUnsignedTransactionLegacy {
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

export interface IUnsignedTransaction2930 {
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
		address: bigint
		storageKeys: readonly bigint[]
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
		address: bigint
		storageKeys: readonly bigint[]
	}[]
}

export interface ITransactionSignatureLegacy {
	readonly r: bigint
	readonly s: bigint
	readonly v: bigint
	readonly hash: bigint
}

export interface ITransactionSignature1559and2930 {
	readonly r: bigint
	readonly s: bigint
	readonly yParity: 'even' | 'odd'
	readonly hash: bigint
}

export type IUnsignedTransaction = IUnsignedTransactionLegacy | IUnsignedTransaction2930 | IUnsignedTransaction1559
export type ISignedTransaction1559 = IUnsignedTransaction1559 & ITransactionSignature1559and2930
export type ISignedTransactionLegacy = IUnsignedTransactionLegacy & ITransactionSignatureLegacy
export type ISignedTransaction2930 = IUnsignedTransaction2930 & ITransactionSignature1559and2930
export type ISignedTransaction = ISignedTransaction1559 | ISignedTransactionLegacy | ISignedTransaction2930

function isSignedTransaction(maybeSigned: unknown): maybeSigned is ISignedTransaction {
	return typeof maybeSigned === 'object'
		&& maybeSigned !== null
		&& 'r' in maybeSigned
		&& 's' in maybeSigned
		&& 'yParity' in maybeSigned
}

export function rlpEncodeLegacyTransactionPayload(transaction: IUnsignedTransactionLegacy): Uint8Array {
	const toEncode = [
		stripLeadingZeros(bigintToUint8Array(transaction.nonce, 32)),
		stripLeadingZeros(bigintToUint8Array(transaction.gasPrice!, 32)),
		stripLeadingZeros(bigintToUint8Array(transaction.gasLimit, 32)),
		transaction.to !== null ? bigintToUint8Array(transaction.to, 20) : new Uint8Array(0),
		stripLeadingZeros(bigintToUint8Array(transaction.value, 32)),
		new Uint8Array(transaction.input),
	]
	if (!isSignedTransaction(transaction)) {
		if ('chainId' in transaction && transaction.chainId !== undefined) {
			toEncode.push(stripLeadingZeros(bigintToUint8Array(transaction.chainId, 32)))
			toEncode.push(stripLeadingZeros(new Uint8Array(0)))
			toEncode.push(stripLeadingZeros(new Uint8Array(0)))
		}
	} else {
		toEncode.push(stripLeadingZeros(bigintToUint8Array(transaction.v, 32)))
		toEncode.push(stripLeadingZeros(bigintToUint8Array(transaction.r, 32)))
		toEncode.push(stripLeadingZeros(bigintToUint8Array(transaction.s, 32)))
	}
	return rlpEncode(toEncode)
}

export function rlpEncode2930TransactionPayload(transaction: IUnsignedTransaction2930 | ISignedTransaction2930): Uint8Array {
	const toEncode = [
		stripLeadingZeros(bigintToUint8Array(transaction.chainId, 32)),
		stripLeadingZeros(bigintToUint8Array(transaction.nonce, 32)),
		stripLeadingZeros(bigintToUint8Array(transaction.gasPrice, 32)),
		stripLeadingZeros(bigintToUint8Array(transaction.gasLimit, 32)),
		transaction.to !== null ? bigintToUint8Array(transaction.to, 20) : new Uint8Array(0),
		stripLeadingZeros(bigintToUint8Array(transaction.value, 32)),
		transaction.input,
		transaction.accessList.map(({address, storageKeys}) => [bigintToUint8Array(address, 20), storageKeys.map(slot => bigintToUint8Array(slot, 32))]),
	]
	if (isSignedTransaction(transaction) && 'yParity' in transaction) {
		toEncode.push(stripLeadingZeros(new Uint8Array([transaction.yParity === 'even' ? 0 : 1]))),
		toEncode.push(stripLeadingZeros(bigintToUint8Array(transaction.r, 32)))
		toEncode.push(stripLeadingZeros(bigintToUint8Array(transaction.s, 32)))
	}
	return rlpEncode(toEncode)
}

export function rlpEncode1559TransactionPayload(transaction: IUnsignedTransaction1559): Uint8Array {
	const toEncode = [
		stripLeadingZeros(bigintToUint8Array(transaction.chainId, 32)),
		stripLeadingZeros(bigintToUint8Array(transaction.nonce, 32)),
		stripLeadingZeros(bigintToUint8Array(transaction.maxPriorityFeePerGas, 32)),
		stripLeadingZeros(bigintToUint8Array(transaction.maxFeePerGas, 32)),
		stripLeadingZeros(bigintToUint8Array(transaction.gasLimit, 32)),
		transaction.to !== null ? bigintToUint8Array(transaction.to, 20) : new Uint8Array(0),
		stripLeadingZeros(bigintToUint8Array(transaction.value, 32)),
		transaction.input,
		transaction.accessList.map(({address, storageKeys}) => [bigintToUint8Array(address, 20), storageKeys.map(slot => bigintToUint8Array(slot, 32))]),
	]
	if (isSignedTransaction(transaction)) {
		toEncode.push(stripLeadingZeros(new Uint8Array([transaction.yParity === 'even' ? 0 : 1]))),
		toEncode.push(stripLeadingZeros(bigintToUint8Array(transaction.r, 32)))
		toEncode.push(stripLeadingZeros(bigintToUint8Array(transaction.s, 32)))
	}
	return rlpEncode(toEncode)
}

export function serializeTransactionToBytes(transaction: IUnsignedTransaction | ISignedTransaction): Uint8Array {
	switch (transaction.type) {
		case 'legacy': return rlpEncodeLegacyTransactionPayload(transaction)
		case '2930': return new Uint8Array([1, ...rlpEncode2930TransactionPayload(transaction)])
		case '1559': return new Uint8Array([2, ...rlpEncode1559TransactionPayload(transaction)])
		default: assertNever(transaction)
	}
}

export function serializeTransactionToString(transaction: ISignedTransaction) {
	return `0x${dataString(serializeTransactionToBytes(transaction))}`
}

export async function signTransaction<T extends IUnsignedTransaction>(privateKey: bigint, unsignedTransaction: T): Promise<ISignedTransaction> {
	if (unsignedTransaction.type === 'legacy') throw new Error('Cannot sign legacy transaction')
	const serializedUnsignedTransaction = serializeTransactionToBytes(unsignedTransaction)
	const unsignedHash = await keccak256.hash(serializedUnsignedTransaction)
	const { r, s, recoveryParameter } = await secp256k1.sign(privateKey, unsignedHash)
	const yParity = recoveryParameter === 0 ? 'even' : 'odd'
	const hash = await keccak256.hash(serializeTransactionToBytes({ ...unsignedTransaction, r, s, yParity }))
	return { ...unsignedTransaction, r, s, yParity, hash }
}

export type FormBundleTransaction = {
	from: bigint,
	to: bigint,
	value: bigint,
	input: Uint8Array,
	gasLimit: bigint,
	nonce: bigint
}

export async function create2Address(deployerAddress: bigint, deploymentBytecodeOrHash: Uint8Array | bigint, salt: bigint = 0n) {
	const deploymentBytecodeHash = typeof deploymentBytecodeOrHash === 'bigint' ? deploymentBytecodeOrHash : await keccak256.hash(deploymentBytecodeOrHash)
	return await keccak256.hash([0xff, ...bigintToUint8Array(deployerAddress, 20), ...bigintToUint8Array(salt, 32), ...bigintToUint8Array(deploymentBytecodeHash, 32)]) & 0xffffffffffffffffffffffffffffffffffffffffn
}

export function EthereumUnsignedTransactionToUnsignedTransaction(transaction: EthereumUnsignedTransaction): IUnsignedTransaction {
	switch (transaction.type) {
		case '1559': return {
			type: '1559',
			from: transaction.from,
			chainId: transaction.chainId,
			nonce: transaction.nonce,
			maxFeePerGas: transaction.maxFeePerGas,
			maxPriorityFeePerGas: transaction.maxPriorityFeePerGas,
			gasLimit: transaction.gas,
			to: transaction.to,
			value: transaction.value,
			input: transaction.input,
			accessList: transaction.accessList !== undefined ? transaction.accessList : []
		}
		case 'legacy': return {
			type: 'legacy',
			from: transaction.from,
			chainId: transaction.chainId,
			nonce: transaction.nonce,
			gasPrice: transaction.gasPrice,
			gasLimit: transaction.gas,
			to: transaction.to,
			value: transaction.value,
			input: transaction.input
		}
		case '2930': return {
			type: '2930',
			from: transaction.from,
			chainId: transaction.chainId,
			nonce: transaction.nonce,
			gasPrice: transaction.gasPrice,
			gasLimit: transaction.gas,
			to: transaction.to,
			value: transaction.value,
			input: transaction.input,
			accessList: transaction.accessList !== undefined ? transaction.accessList : []
		}
	}
}

export function EthereumSignedTransactionToSignedTransaction(transaction: EthereumSignedTransaction): ISignedTransaction {
	switch (transaction.type) {
		case '1559': return {
			type: '1559',
			from: transaction.from,
			chainId: transaction.chainId,
			nonce: transaction.nonce,
			maxFeePerGas: transaction.maxFeePerGas,
			maxPriorityFeePerGas: transaction.maxPriorityFeePerGas,
			gasLimit: transaction.gas,
			to: transaction.to,
			value: transaction.value,
			input: transaction.input,
			accessList: transaction.accessList !== undefined ? transaction.accessList : [],
			r: transaction.r,
			s: transaction.s,
			yParity: transaction.yParity,
			hash: transaction.hash,
		}
		case '2930': return {
			type: '2930',
			from: transaction.from,
			chainId: transaction.chainId,
			nonce: transaction.nonce,
			gasPrice: transaction.gasPrice,
			gasLimit: transaction.gas,
			to: transaction.to,
			value: transaction.value,
			input: transaction.input,
			accessList: transaction.accessList !== undefined ? transaction.accessList : [],
			r: transaction.r,
			s: transaction.s,
			yParity: transaction.yParity,
			hash: transaction.hash,
		}
		case 'legacy': return {
			type: 'legacy',
			from: transaction.from,
			chainId: transaction.chainId,
			nonce: transaction.nonce,
			gasPrice: transaction.gasPrice,
			gasLimit: transaction.gas,
			to: transaction.to,
			value: transaction.value,
			input: transaction.input,
			r: transaction.r,
			s: transaction.s,
			v: transaction.v,
			hash: transaction.hash,
		}
	}
}

export function truncateAddr(address: string, charactersFromEachEnd: number = 7) {
	return `0x${address.substring(2, 2 + charactersFromEachEnd)}…${address.substring(address.length - charactersFromEachEnd, address.length)}`
}
