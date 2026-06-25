import type { EthereumUnsignedTransaction } from '../types/wire-types.js'
import { EthereumAddress } from '../types/wire-types.js'
import { dataStringWith0xStart, stringToUint8Array } from './bigint.js'
import {
	keccak256,
	parseTransaction as parseSerializedTransaction,
	recoverAddress,
	recoverAuthorizationAddress,
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

export const parseSendRawTransaction = async (serializedTransactionBytes: Uint8Array, activeChainId: bigint): Promise<EthereumUnsignedTransaction> => {
	const serializedTransaction = dataStringWith0xStart(serializedTransactionBytes)
	const parsedTransaction = parseSerializedTransaction(serializedTransaction)

	if (parsedTransaction.type === 'eip1559') {
		if (parsedTransaction.gas === undefined || parsedTransaction.maxFeePerGas === undefined || parsedTransaction.maxPriorityFeePerGas === undefined || parsedTransaction.nonce === undefined || parsedTransaction.r === undefined || parsedTransaction.s === undefined || parsedTransaction.yParity === undefined) {
			throw new Error('Serialized EIP-1559 transaction is missing required fields')
		}
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
			chainId: activeChainId,
			nonce: BigInt(parsedTransaction.nonce),
			maxFeePerGas: parsedTransaction.maxFeePerGas,
			maxPriorityFeePerGas: parsedTransaction.maxPriorityFeePerGas,
			gas: parsedTransaction.gas,
			to: parsedTransaction.to === undefined ? null : EthereumAddress.parse(parsedTransaction.to),
			value: parsedTransaction.value ?? 0n,
			input: stringToUint8Array(parsedTransaction.data ?? '0x'),
			accessList: [],
		}
	}

	if (parsedTransaction.type === 'eip7702') {
		if (parsedTransaction.gas === undefined || parsedTransaction.maxFeePerGas === undefined || parsedTransaction.maxPriorityFeePerGas === undefined || parsedTransaction.nonce === undefined || parsedTransaction.r === undefined || parsedTransaction.s === undefined || parsedTransaction.yParity === undefined) {
			throw new Error('Serialized EIP-7702 transaction is missing required fields')
		}
		const authorizationList = await Promise.all((parsedTransaction.authorizationList ?? []).map(async (authorization) => ({
			chainId: BigInt(authorization.chainId),
			address: EthereumAddress.parse(authorization.address),
			nonce: BigInt(authorization.nonce),
			authority: EthereumAddress.parse(await recoverAuthorizationAddress({ authorization })),
		})))
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
			chainId: activeChainId,
			nonce: BigInt(parsedTransaction.nonce),
			maxFeePerGas: parsedTransaction.maxFeePerGas,
			maxPriorityFeePerGas: parsedTransaction.maxPriorityFeePerGas,
			gas: parsedTransaction.gas,
			to: parsedTransaction.to === undefined ? null : EthereumAddress.parse(parsedTransaction.to),
			value: parsedTransaction.value ?? 0n,
			input: stringToUint8Array(parsedTransaction.data ?? '0x'),
			accessList: [],
			authorizationList,
		}
	}

	throw new Error('No support for non-1559 and non-7702 raw transactions')
}
