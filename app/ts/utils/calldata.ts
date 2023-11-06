import { ethers } from 'ethers'
import { dataStringWith0xStart, stringifyJSONWithBigInts } from './bigint.js'
import * as funtypes from 'funtypes'
import { EthereumAddress, EthereumQuantity } from '../types/wire-types.js'

const erc20andErc721FunctionSignatures = [
	'function transfer(address to, uint256 value) public returns (bool success)',
	'function transferFrom(address from, address to, uint256 value) public returns (bool success)',
	'function approve(address spender, uint256 value) public returns (bool success)',
	'function setApprovalForAll(address operator, bool approved)',
]

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
	const iface = new ethers.Interface(erc20andErc721FunctionSignatures)
	const parsed = iface.parseTransaction({ data: dataStringWith0xStart(transaction.input) })
	if (parsed === null) return undefined

	// https://github.com/ForbesLindesay/funtypes/issues/53
	// a bit hacky as there's no bigint funtype, so we convert bigints to strings and then parse them into bigits
	return CallDataType.parse(JSON.parse(stringifyJSONWithBigInts({
		name: parsed.name,
		arguments: parsed.args.toObject(),
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
