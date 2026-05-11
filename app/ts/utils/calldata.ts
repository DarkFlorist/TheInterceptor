import type { Abi } from 'viem'
import { dataStringWith0xStart, stringifyJSONWithBigInts } from './bigint.js'
import * as funtypes from 'funtypes'
import { EthereumAddress, EthereumQuantity } from '../types/wire-types.js'
import { decodeCallDataLoose } from './abiRuntime.js'

const erc20andErc721FunctionSignatures = [
	{
		type: 'function',
		name: 'transfer',
		stateMutability: 'nonpayable',
		inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }],
		outputs: [{ name: 'success', type: 'bool' }],
	},
	{
		type: 'function',
		name: 'transferFrom',
		stateMutability: 'nonpayable',
		inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }],
		outputs: [{ name: 'success', type: 'bool' }],
	},
	{
		type: 'function',
		name: 'approve',
		stateMutability: 'nonpayable',
		inputs: [{ name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }],
		outputs: [{ name: 'success', type: 'bool' }],
	},
	{
		type: 'function',
		name: 'setApprovalForAll',
		stateMutability: 'nonpayable',
		inputs: [{ name: 'operator', type: 'address' }, { name: 'approved', type: 'bool' }],
		outputs: [],
	},
] as const satisfies Abi

type CallDataType = funtypes.Static<typeof CallDataType>
const CallDataType = funtypes.Union(
	funtypes.ReadonlyObject({
		name: funtypes.Literal('transfer'),
		arguments: funtypes.ReadonlyObject({
			to: EthereumAddress,
			value: EthereumQuantity,
		})
	}),
	funtypes.ReadonlyObject({
		name: funtypes.Literal('transferFrom'),
		arguments: funtypes.ReadonlyObject({
			from: EthereumAddress,
			to: EthereumAddress,
			value: EthereumQuantity,
		})
	}),
	funtypes.ReadonlyObject({
		name: funtypes.Literal('approve'),
		arguments: funtypes.ReadonlyObject({
			spender: EthereumAddress,
			value: EthereumQuantity,
		})
	}),
	funtypes.ReadonlyObject({
		name: funtypes.Literal('setApprovalForAll'),
		arguments: funtypes.ReadonlyObject({
			operator: EthereumAddress,
			approved: funtypes.Boolean,
		})
	}),
)

export function parseTransaction(transaction: { input?: Uint8Array, from: bigint }) {
	if (!('input' in transaction) || transaction.input === undefined || transaction.input.length < 4) return undefined
	const parsed = decodeCallDataLoose(erc20andErc721FunctionSignatures, dataStringWith0xStart(transaction.input))
	if (parsed === undefined) return undefined

	// https://github.com/ForbesLindesay/funtypes/issues/53
	// a bit hacky as there's no bigint funtype, so we convert bigints to strings and then parse them into bigits
	return CallDataType.parse(JSON.parse(stringifyJSONWithBigInts({
		name: parsed.name,
		arguments: parsed.namedArgs,
	})))
}

export function get4Byte(data: Uint8Array) {
	if (data.buffer.byteLength < 4) return undefined // always calls fallback method
	return new DataView(data.buffer, 0, 4).getUint32(0)
}

export function get4ByteString(data: Uint8Array): string | undefined {
	const num = get4Byte(data)
	if (num === undefined) return undefined
	const hexString = num.toString(16)
	const zerosToPad = Math.max(0, 8 - hexString.length)
	return '0x' + '0'.repeat(zerosToPad) + hexString
}
