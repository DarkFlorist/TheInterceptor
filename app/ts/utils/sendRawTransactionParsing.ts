import type { EthereumUnsignedTransaction } from '../types/wire-types.js'
import { EthereumAddress, EthereumBytes32 } from '../types/wire-types.js'
import { dataStringWith0xStart, stringToUint8Array } from './bigint.js'
import { normalizeEip7702AuthorizationList } from './eip7702Authorization.js'
import {
	keccak256,
	parseTransaction as parseSerializedTransaction,
	recoverAddress,
	serializeTransaction,
} from './viem.js'

const recoverParsedTransactionAddress = async (
	serializedUnsignedTransaction: `0x${ string }`,
	signature: { r: `0x${ string }`, s: `0x${ string }`, yParity: number }
) => {
	return await recoverAddress({
		hash: keccak256(serializedUnsignedTransaction),
		signature,
	})
}

const parseAccessList = (accessList: readonly { readonly address: `0x${ string }`, readonly storageKeys: readonly `0x${ string }`[] }[] | undefined) => {
	return (accessList ?? []).map((accessListEntry) => ({
		address: EthereumAddress.parse(accessListEntry.address),
		storageKeys: accessListEntry.storageKeys.map(EthereumBytes32.parse),
	}))
}

const parseToAddress = (address: `0x${ string }` | null | undefined) => {
	return address === undefined || address === null ? null : EthereumAddress.parse(address)
}

const parseRequiredChainId = (transactionChainId: number | undefined) => {
	if (transactionChainId === undefined) throw new Error('Serialized transaction is missing chainId')
	return BigInt(transactionChainId)
}

const parseAuthorizationParity = (yParity: number): 'even' | 'odd' => {
	if (yParity === 0) return 'even'
	if (yParity === 1) return 'odd'
	throw new Error(`Unsupported EIP-7702 authorization yParity ${ yParity }`)
}

const parseSignedAuthorization = (authorization: {
	readonly chainId: number
	readonly address: `0x${ string }`
	readonly nonce: number
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

export const parseSendRawTransaction = async (serializedTransactionBytes: Uint8Array): Promise<EthereumUnsignedTransaction> => {
	const serializedTransaction = dataStringWith0xStart(serializedTransactionBytes)
	const parsedTransaction = parseSerializedTransaction(serializedTransaction)

	if (parsedTransaction.type === 'eip1559') {
		if (parsedTransaction.gas === undefined || parsedTransaction.maxFeePerGas === undefined || parsedTransaction.maxPriorityFeePerGas === undefined || parsedTransaction.nonce === undefined || parsedTransaction.r === undefined || parsedTransaction.s === undefined || parsedTransaction.yParity === undefined) {
			throw new Error('Serialized EIP-1559 transaction is missing required fields')
		}
		const chainId = parseRequiredChainId(parsedTransaction.chainId)
		const unsignedTransaction = serializeTransaction({
			type: 'eip1559',
			chainId: Number(parsedTransaction.chainId),
			nonce: parsedTransaction.nonce,
			maxFeePerGas: parsedTransaction.maxFeePerGas,
			maxPriorityFeePerGas: parsedTransaction.maxPriorityFeePerGas,
			gas: parsedTransaction.gas,
			to: parsedTransaction.to,
			value: parsedTransaction.value,
			data: parsedTransaction.data,
			accessList: parsedTransaction.accessList,
		})
		const from = await recoverParsedTransactionAddress(unsignedTransaction, {
			r: parsedTransaction.r,
			s: parsedTransaction.s,
			yParity: parsedTransaction.yParity,
		})
		return {
			type: '1559',
			from: EthereumAddress.parse(from),
			chainId,
			nonce: BigInt(parsedTransaction.nonce),
			maxFeePerGas: parsedTransaction.maxFeePerGas,
			maxPriorityFeePerGas: parsedTransaction.maxPriorityFeePerGas,
			gas: parsedTransaction.gas,
			to: parseToAddress(parsedTransaction.to),
			value: parsedTransaction.value ?? 0n,
			input: stringToUint8Array(parsedTransaction.data ?? '0x'),
			accessList: parseAccessList(parsedTransaction.accessList),
		}
	}

	if (parsedTransaction.type === 'eip7702') {
		if (parsedTransaction.gas === undefined || parsedTransaction.maxFeePerGas === undefined || parsedTransaction.maxPriorityFeePerGas === undefined || parsedTransaction.nonce === undefined || parsedTransaction.r === undefined || parsedTransaction.s === undefined || parsedTransaction.yParity === undefined) {
			throw new Error('Serialized EIP-7702 transaction is missing required fields')
		}
		const chainId = parseRequiredChainId(parsedTransaction.chainId)
		const authorizationList = await normalizeEip7702AuthorizationList((parsedTransaction.authorizationList ?? []).map(parseSignedAuthorization))
		const unsignedTransaction = serializeTransaction({
			type: 'eip7702',
			chainId: Number(parsedTransaction.chainId),
			nonce: parsedTransaction.nonce,
			maxFeePerGas: parsedTransaction.maxFeePerGas,
			maxPriorityFeePerGas: parsedTransaction.maxPriorityFeePerGas,
			gas: parsedTransaction.gas,
			to: parsedTransaction.to,
			value: parsedTransaction.value,
			data: parsedTransaction.data,
			accessList: parsedTransaction.accessList,
			authorizationList: parsedTransaction.authorizationList ?? [],
		})
		const from = await recoverParsedTransactionAddress(unsignedTransaction, {
			r: parsedTransaction.r,
			s: parsedTransaction.s,
			yParity: parsedTransaction.yParity,
		})
		return {
			type: '7702',
			from: EthereumAddress.parse(from),
			chainId,
			nonce: BigInt(parsedTransaction.nonce),
			maxFeePerGas: parsedTransaction.maxFeePerGas,
			maxPriorityFeePerGas: parsedTransaction.maxPriorityFeePerGas,
			gas: parsedTransaction.gas,
			to: parseToAddress(parsedTransaction.to),
			value: parsedTransaction.value ?? 0n,
			input: stringToUint8Array(parsedTransaction.data ?? '0x'),
			accessList: parseAccessList(parsedTransaction.accessList),
			authorizationList,
		}
	}

	throw new Error('No support for non-1559 and non-7702 raw transactions')
}
