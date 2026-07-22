import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { getCodeByteCode } from '../../app/ts/utils/ethereumByteCodes.js'

const PUSH1 = 0x60
const PUSH2 = 0x61
const PUSH32 = 0x7f
const JUMPDEST = 0x5b
const INVALID = 0xfe

type Instruction = {
	offset: number
	opcode: number
	operand: bigint | undefined
}

const decodeExecutableInstructions = (bytecode: Uint8Array): readonly Instruction[] => {
	const instructions: Instruction[] = []
	for (let offset = 0; offset < bytecode.length;) {
		const opcode = bytecode[offset]
		if (opcode === undefined) throw new Error('Instruction offset exceeds bytecode length')
		if (opcode === INVALID) break
		const operandLength = opcode >= PUSH1 && opcode <= PUSH32 ? opcode - PUSH1 + 1 : 0
		if (offset + operandLength >= bytecode.length) throw new Error('Push operand exceeds bytecode length')
		let operand: bigint | undefined
		if (operandLength > 0) {
			operand = 0n
			for (let operandIndex = 1; operandIndex <= operandLength; operandIndex++) {
				const operandByte = bytecode[offset + operandIndex]
				if (operandByte === undefined) throw new Error('Push operand exceeds bytecode length')
				operand = operand * 256n + BigInt(operandByte)
			}
		}
		instructions.push({ offset, opcode, operand })
		offset += operandLength + 1
	}
	return instructions
}

describe('embedded EVM bytecode', () => {
	test('GetCode static labels target JUMPDEST instructions', () => {
		const bytecode = getCodeByteCode()
		const instructions = decodeExecutableInstructions(bytecode)
		const instructionByOffset = new Map(instructions.map((instruction) => [instruction.offset, instruction]))
		const lastInstruction = instructions.at(-1)
		if (lastInstruction === undefined) throw new Error('GetCode bytecode has no executable instructions')
		const lastOperandLength = lastInstruction.opcode >= PUSH1 && lastInstruction.opcode <= PUSH32 ? lastInstruction.opcode - PUSH1 + 1 : 0
		const executableLength = lastInstruction.offset + lastOperandLength + 1
		const staticLabels = instructions
			.filter((instruction) => instruction.opcode === PUSH2 && instruction.operand !== undefined)
			.map((instruction) => Number(instruction.operand))
			.filter((target) => target < executableLength)

		assert.ok(staticLabels.length > 0)
		for (const target of staticLabels) assert.equal(instructionByOffset.get(target)?.opcode, JUMPDEST, `Static label 0x${ target.toString(16) } must target JUMPDEST`)
		for (const reviewedTarget of [0x54, 0x6a, 0xf8]) assert.equal(instructionByOffset.get(reviewedTarget)?.opcode, JUMPDEST, `Reviewed target 0x${ reviewedTarget.toString(16) } must remain JUMPDEST`)
		assert.equal(instructionByOffset.get(0x41)?.opcode, 0x36, 'ABI argument bounds check must include CALLDATASIZE')
	})
})
