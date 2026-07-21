import { max } from './bigint.js'

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
