import { max } from './bigint.js'

// Protocol gas schedule:
// - 21,000 is the base transaction cost from the Ethereum Yellow Paper gas schedule.
// - 32,000 is the contract-creation surcharge introduced by EIP-2.
// - Calldata costs 4 gas per zero byte and 16 per nonzero byte after EIP-2028.
// - EIP-3860 charges 2 gas for each 32-byte word of contract initcode.
// - EIP-7623's calldata floor assigns 1 token to a zero byte and 4 to a nonzero
//   byte, then charges 10 gas per token.
// See https://ethereum.github.io/yellowpaper/paper.pdf and https://eips.ethereum.org/EIPS/eip-2,
// https://eips.ethereum.org/EIPS/eip-2028, https://eips.ethereum.org/EIPS/eip-3860,
// and https://eips.ethereum.org/EIPS/eip-7623.
const TRANSACTION_BASE_GAS = 21_000n
const CONTRACT_CREATION_GAS = 32_000n
const INITCODE_WORD_GAS = 2n
const ZERO_CALLDATA_BYTE_GAS = 4n
const NON_ZERO_CALLDATA_BYTE_GAS = 16n
const CALLDATA_FLOOR_TOKEN_GAS = 10n

export function getMinimumTransactionGasLimit(input: Uint8Array, isContractCreation: boolean) {
	let calldataGas = 0n
	let calldataFloorTokens = 0n
	for (const byte of input) {
		if (byte === 0) {
			calldataGas += ZERO_CALLDATA_BYTE_GAS
			calldataFloorTokens += 1n
		} else {
			calldataGas += NON_ZERO_CALLDATA_BYTE_GAS
			calldataFloorTokens += 4n
		}
	}
	const creationGas = isContractCreation
		? CONTRACT_CREATION_GAS + BigInt(Math.ceil(input.length / 32)) * INITCODE_WORD_GAS
		: 0n
	const intrinsicGas = TRANSACTION_BASE_GAS + calldataGas + creationGas
	const calldataFloorGas = TRANSACTION_BASE_GAS + calldataFloorTokens * CALLDATA_FLOOR_TOKEN_GAS
	return max(intrinsicGas, calldataFloorGas)
}
