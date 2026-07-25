import type { Abi } from '../utils/ethereumPrimitives.js'
import { decodeFunctionOutput, encodeFunctionCall } from '../utils/abiRuntime.js'
import { bytes32String, dataStringWith0xStart, stringToUint8Array } from '../utils/bigint.js'
import { getStorageReaderByteCode } from '../utils/ethereumByteCodes.js'
import { EthereumBytes32 } from '../types/wire-types.js'

// EIP-1352 reserves the low 0xffff addresses for precompiles. Which addresses
// are active depends on the chain and fork, so the node is asked by attempting
// a precompile relocation before injecting code into an address in this range.
export const PRECOMPILE_RESERVED_ADDRESS_MAX = 0xffffn
export const STORAGE_READER_PRECOMPILE_RELOCATION_ADDRESS = 0xfffffffffffffffffffffffffffffffffffffffen

export const STORAGE_READER_ABI = [{
	type: 'function',
	name: 'readSlot',
	stateMutability: 'view',
	inputs: [{ name: 'slot', type: 'bytes32' }],
	outputs: [{ name: 'value', type: 'bytes32' }],
}] as const satisfies Abi

export const encodeStorageReaderCall = (slot: bigint) => stringToUint8Array(
	encodeFunctionCall(STORAGE_READER_ABI, 'readSlot', [bytes32String(slot)]),
)

export const decodeStorageReaderResult = (returnData: Uint8Array) => EthereumBytes32.parse(
	decodeFunctionOutput(STORAGE_READER_ABI, 'readSlot', dataStringWith0xStart(returnData)),
)

export const createStorageReaderAccountOverride = (relocatePrecompile: boolean) => ({
	code: getStorageReaderByteCode(),
	...(relocatePrecompile ? { movePrecompileToAddress: STORAGE_READER_PRECOMPILE_RELOCATION_ADDRESS } : {}),
})
