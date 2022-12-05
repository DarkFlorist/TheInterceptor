import { ERC20_APPROVAL_4BYTES, ERC20_TRANSFER_4BYTES, ERC20_TRANSFER_FROM_4BYTES, ERC721_APPROVAL_FOR_ALL_4BYTES } from './constants'
import { decodeMethod } from '@zoltu/ethereum-abi-encoder'

const TRANSFER_PARAMS = [
	{
		internalType: 'address',
		name: 'to',
		type: 'address'
	},
	{
		internalType: 'uint256',
		name: 'amount',
		type: 'uint256'
	}
]

const TRANSFER_FROM_PARAMS = [
	{
		internalType: 'address',
		name: 'sender',
		type: 'address'
	},
	{
		internalType: 'address',
		name: 'to',
		type: 'address'
	},
	{
		internalType: 'uint256',
		name: 'amount',
		type: 'uint256'
	}
]

const APPROVAL_PARAMS = [
	{
		internalType: 'address',
		name: 'spender',
		type: 'address'
	},
	{
		internalType: 'uint256',
		name: 'amount',
		type: 'uint256'
	},
]

const APPROVAL_FOR_ALL = [
	{
		internalType: 'address',
		name: 'spender',
		type: 'address'
	},
	{
		internalType: 'bool',
		name: 'approved',
		type: 'bool'
	}
]

export function getTransferInfoFromTx(transaction: {input?: Uint8Array, from: bigint}) {
	if (!('input' in transaction) || transaction.input === undefined || transaction.input.length < 4) return undefined

	const data = transaction.input

	const functionSig = new DataView(data.buffer, 0, 4).getUint32(0)

	if (functionSig == ERC20_TRANSFER_4BYTES) return {...parseTransfer(data), from: transaction.from}
	else if (functionSig == ERC20_TRANSFER_FROM_4BYTES) return parseTransferFrom(data)

	return undefined
}

export function getApprovalInfoFromTx(transaction: {input?: Uint8Array, from: bigint}) {
	if (!('input' in transaction) || transaction.input === undefined || transaction.input.length < 4) return undefined

	const data = transaction.input

	const functionSig = new DataView(data.buffer, 0, 4).getUint32(0)

	if (functionSig == ERC20_APPROVAL_4BYTES) return {...parseApproval(data), from: transaction.from}
	else if (functionSig == ERC721_APPROVAL_FOR_ALL_4BYTES) {
		const { spender, approval } = parseApprovalForAll(data)
		if (!approval) return undefined
		return { spender, from: transaction.from}
	}

	return undefined
}

export function parseTransfer(data: Uint8Array) {
	const { to, amount } = decodeMethod(ERC20_TRANSFER_4BYTES, TRANSFER_PARAMS, data) as { to: bigint, amount: bigint }
	return {
		to,
		amount,
	}
}

export function parseTransferFrom(data: Uint8Array) {
	const { from, to, amount } = decodeMethod(ERC20_TRANSFER_FROM_4BYTES, TRANSFER_FROM_PARAMS, data) as { from: bigint, to: bigint, amount: bigint }
	return {
		from,
		to,
		amount,
	}
}

export function parseApproval(data: Uint8Array) {
	const { spender } = decodeMethod(ERC20_APPROVAL_4BYTES, APPROVAL_PARAMS, data) as { spender: bigint, amount: bigint }
	return {
		spender
	}
}

export function parseApprovalForAll(data: Uint8Array) {
	const { spender, approval } = decodeMethod(ERC721_APPROVAL_FOR_ALL_4BYTES, APPROVAL_FOR_ALL, data) as { spender: bigint, approval: boolean }
	return {
		spender,
		approval
	}
}

export function get4Byte(data: Uint8Array) {
	if (data.buffer.byteLength < 4) return undefined // always calls fallback method
	return new DataView(data.buffer, 0, 4).getUint32(0)
}
