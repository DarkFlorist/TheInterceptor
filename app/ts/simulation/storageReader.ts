const EVM_OPCODE = {
	CALLDATALOAD: 0x35,
	SLOAD: 0x54,
	MSTORE: 0x52,
	PUSH1: 0x60,
	RETURN: 0xf3,
} as const

const push1 = (value: number): readonly [number, number] => [EVM_OPCODE.PUSH1, value]

// EIP-1352 reserves the low 0xffff addresses for precompiles. Which addresses
// are active depends on the chain and fork, so the node is asked by attempting
// a precompile relocation before injecting code into an address in this range.
export const PRECOMPILE_RESERVED_ADDRESS_MAX = 0xffffn
export const STORAGE_READER_PRECOMPILE_RELOCATION_ADDRESS = 0xfffffffffffffffffffffffffffffffffffffffen

// Reads the storage slot supplied as the first 32 bytes of calldata and returns
// its 32-byte value. Stack comments list the top item first.
export const STORAGE_READER_RUNTIME_BYTECODE = new Uint8Array([
	...push1(0x00),            // [calldataOffset]
	EVM_OPCODE.CALLDATALOAD,   // [slot]
	EVM_OPCODE.SLOAD,          // [value]
	...push1(0x00),            // [memoryOffset, value]
	EVM_OPCODE.MSTORE,         // [] — memory[0x00:0x20] = value
	...push1(0x20),            // [returnLength]
	...push1(0x00),            // [returnOffset, returnLength]
	EVM_OPCODE.RETURN,         // return memory[0x00:0x20]
])

export const createStorageReaderAccountOverride = (relocatePrecompile: boolean) => ({
	code: STORAGE_READER_RUNTIME_BYTECODE,
	...(relocatePrecompile ? { movePrecompileToAddress: STORAGE_READER_PRECOMPILE_RELOCATION_ADDRESS } : {}),
})
