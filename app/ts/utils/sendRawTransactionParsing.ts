import type { EthereumSendableSignedTransaction, EthereumUnsignedTransaction } from '../types/wire-types.js'
import { EthereumAddress, EthereumBytes32 } from '../types/wire-types.js'
import { dataStringWith0xStart, stringToUint8Array } from './bigint.js'
import { normalizeEip7702AuthorizationList, type NormalizedEip7702Authorization } from './eip7702Authorization.js'
import {
	keccak256,
	parseTransaction as parseSerializedTransaction,
	recoverTransactionSender,
} from './ethereumPrimitives.js'

const parseAccessList = (accessList: readonly { readonly address: `0x${ string }`, readonly storageKeys: readonly `0x${ string }`[] }[] | undefined) => {
	return (accessList ?? []).map((accessListEntry) => ({
		address: EthereumAddress.parse(accessListEntry.address),
		storageKeys: accessListEntry.storageKeys.map(EthereumBytes32.parse),
	}))
}

const parseToAddress = (address: `0x${ string }` | null | undefined) => {
	return address === undefined || address === null ? null : EthereumAddress.parse(address)
}

const parseRequiredChainId = (transactionChainId: bigint | undefined) => {
	if (transactionChainId === undefined) throw new Error('Serialized transaction is missing chainId')
	return transactionChainId
}

const parseAuthorizationParity = (yParity: number): 'even' | 'odd' => {
	if (yParity === 0) return 'even'
	if (yParity === 1) return 'odd'
	throw new Error(`Unsupported EIP-7702 authorization yParity ${ yParity }`)
}

const parseSignedAuthorization = (authorization: {
	readonly chainId: bigint
	readonly address: `0x${ string }`
	readonly nonce: bigint
	readonly r?: `0x${ string }`
	readonly s?: `0x${ string }`
	readonly yParity?: number
}) => {
	if (authorization.r === undefined || authorization.s === undefined || authorization.yParity === undefined) throw new Error('Serialized EIP-7702 authorization is missing required signature fields')
	return {
		chainId: BigInt(authorization.chainId),
		address: EthereumAddress.parse(authorization.address),
		nonce: BigInt(authorization.nonce),
		r: BigInt(authorization.r),
		s: BigInt(authorization.s),
		yParity: parseAuthorizationParity(authorization.yParity),
	}
}

const requireSignedAuthorization = (authorization: NormalizedEip7702Authorization) => {
	if (authorization.r === undefined || authorization.s === undefined || authorization.yParity === undefined) {
		throw new Error('Serialized EIP-7702 authorization is missing required signature fields')
	}
	return {
		...authorization,
		r: authorization.r,
		s: authorization.s,
		yParity: authorization.yParity,
	}
}

export type ParsedSendRawTransaction = {
	transaction: EthereumUnsignedTransaction
	signedTransaction: EthereumSendableSignedTransaction
}

export const parseSendRawTransaction = async (serializedTransactionBytes: Uint8Array): Promise<ParsedSendRawTransaction> => {
	const serializedTransaction = dataStringWith0xStart(serializedTransactionBytes)
	const parsedTransaction = parseSerializedTransaction(serializedTransaction)
	const hash = EthereumBytes32.parse(keccak256(serializedTransaction))

	if (parsedTransaction.type === 'eip1559') {
		if (parsedTransaction.gas === undefined || parsedTransaction.maxFeePerGas === undefined || parsedTransaction.maxPriorityFeePerGas === undefined || parsedTransaction.nonce === undefined || parsedTransaction.r === undefined || parsedTransaction.s === undefined || parsedTransaction.yParity === undefined) {
			throw new Error('Serialized EIP-1559 transaction is missing required fields')
		}
		const chainId = parseRequiredChainId(parsedTransaction.chainId)
		const from = recoverTransactionSender(serializedTransaction)
		const transaction = {
			type: '1559' as const,
			from: EthereumAddress.parse(from),
			chainId,
			nonce: parsedTransaction.nonce,
			maxFeePerGas: parsedTransaction.maxFeePerGas,
			maxPriorityFeePerGas: parsedTransaction.maxPriorityFeePerGas,
			gas: parsedTransaction.gas,
			to: parseToAddress(parsedTransaction.to),
			value: parsedTransaction.value ?? 0n,
			input: stringToUint8Array(parsedTransaction.data ?? '0x'),
			accessList: parseAccessList(parsedTransaction.accessList),
		}
		return {
			transaction,
			signedTransaction: {
				...transaction,
				r: BigInt(parsedTransaction.r),
				s: BigInt(parsedTransaction.s),
				yParity: parseAuthorizationParity(parsedTransaction.yParity),
				hash,
			},
		}
	}

	if (parsedTransaction.type === 'eip7702') {
		if (parsedTransaction.gas === undefined || parsedTransaction.maxFeePerGas === undefined || parsedTransaction.maxPriorityFeePerGas === undefined || parsedTransaction.nonce === undefined || parsedTransaction.r === undefined || parsedTransaction.s === undefined || parsedTransaction.yParity === undefined) {
			throw new Error('Serialized EIP-7702 transaction is missing required fields')
		}
		const chainId = parseRequiredChainId(parsedTransaction.chainId)
		const authorizationList = (await normalizeEip7702AuthorizationList((parsedTransaction.authorizationList ?? []).map(parseSignedAuthorization))).map(requireSignedAuthorization)
		const from = recoverTransactionSender(serializedTransaction)
		const transaction = {
			type: '7702' as const,
			from: EthereumAddress.parse(from),
			chainId,
			nonce: parsedTransaction.nonce,
			maxFeePerGas: parsedTransaction.maxFeePerGas,
			maxPriorityFeePerGas: parsedTransaction.maxPriorityFeePerGas,
			gas: parsedTransaction.gas,
			to: parseToAddress(parsedTransaction.to),
			value: parsedTransaction.value ?? 0n,
			input: stringToUint8Array(parsedTransaction.data ?? '0x'),
			accessList: parseAccessList(parsedTransaction.accessList),
			authorizationList,
		}
		return {
			transaction,
			signedTransaction: {
				...transaction,
				r: BigInt(parsedTransaction.r),
				s: BigInt(parsedTransaction.s),
				yParity: parseAuthorizationParity(parsedTransaction.yParity),
				hash,
			},
		}
	}

	throw new Error('No support for non-1559 and non-7702 raw transactions')
}
