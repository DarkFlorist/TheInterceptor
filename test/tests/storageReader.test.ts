import { describe, test } from 'bun:test'
import * as assert from 'assert'
import { STORAGE_READER_RUNTIME_BYTECODE } from '../../app/ts/simulation/storageReader.js'
import { bigintToUint8Array, bytesToUnsigned } from '../../app/ts/utils/bigint.js'

const executeStorageReader = (calldata: Uint8Array, storage: ReadonlyMap<bigint, bigint>) => {
	const stack: bigint[] = []
	const memory = new Uint8Array(32)
	const pop = () => {
		const value = stack.pop()
		if (value === undefined) throw new Error('storage reader test interpreter stack underflow')
		return value
	}

	for (let programCounter = 0; programCounter < STORAGE_READER_RUNTIME_BYTECODE.length; programCounter++) {
		const opcode = STORAGE_READER_RUNTIME_BYTECODE[programCounter]
		switch (opcode) {
			case 0x35: { // CALLDATALOAD
				const offset = Number(pop())
				const word = new Uint8Array(32)
				word.set(calldata.slice(offset, offset + word.length))
				stack.push(bytesToUnsigned(word))
				break
			}
			case 0x52: { // MSTORE
				const offset = Number(pop())
				const value = pop()
				if (offset + 32 > memory.length) throw new Error('storage reader test interpreter memory overflow')
				memory.set(bigintToUint8Array(value, 32), offset)
				break
			}
			case 0x54: // SLOAD
				stack.push(storage.get(pop()) ?? 0n)
				break
			case 0x60: { // PUSH1
				programCounter++
				const value = STORAGE_READER_RUNTIME_BYTECODE[programCounter]
				if (value === undefined) throw new Error('storage reader PUSH1 is missing its operand')
				stack.push(BigInt(value))
				break
			}
			case 0xf3: { // RETURN
				const offset = Number(pop())
				const length = Number(pop())
				return memory.slice(offset, offset + length)
			}
			default: throw new Error(`unsupported storage reader opcode: ${ opcode?.toString(16) ?? 'missing' }`)
		}
	}
	throw new Error('storage reader bytecode did not return')
}

describe('storage reader runtime bytecode', () => {
	test('loads the calldata-selected storage slot as a 32-byte word', () => {
		const requestedSlot = 0x42n
		const storageValue = 0x1234n
		const storage = new Map<bigint, bigint>([
			[0n, 0xdeadn],
			[requestedSlot, storageValue],
		])

		const result = executeStorageReader(bigintToUint8Array(requestedSlot, 32), storage)

		assert.deepEqual(result, bigintToUint8Array(storageValue, 32))
	})

	test('returns a zero word for an unset slot', () => {
		const result = executeStorageReader(bigintToUint8Array(0x42n, 32), new Map())

		assert.deepEqual(result, new Uint8Array(32))
	})
})
