import * as assert from 'assert'
import { test } from 'bun:test'
import multiSendLibrary from '../fixtures/safe-libraries/MultiSendCallOnly.json'
import signMessageLibrary from '../fixtures/safe-libraries/SignMessageLib.json'
import { createSafeTx, assertInterceptorSafeTransactionPolicy } from '../../app/ts/safe/safeCore.js'
import { encodeSafeBatch, decodeSafeBatch, validateSafeDelegateCode, SAFE_MULTI_SEND_CALL_ONLY, SAFE_MULTI_SEND_ABI, SAFE_SIGN_MESSAGE_LIB, SAFE_SIGN_MESSAGE_ABI } from '../../app/ts/safe/safeDelegateCalls.js'
import { encodeFunctionCall } from '../../app/ts/utils/abiRuntime.js'
import { stringToUint8Array } from '../../app/ts/utils/bigint.js'

const calls = [{ to: 42n, value: 0n, data: new Uint8Array([1, 2]) }, { to: 43n, value: 123n, data: new Uint8Array() }]
const batch = () => createSafeTx(1n, 123n, { to: SAFE_MULTI_SEND_CALL_ONLY, operation: 1n, value: 0n, input: encodeSafeBatch(calls) }, 7n)

test('Safe batch retains call order and values in one constrained delegate proposal', () => {
	assert.deepEqual(decodeSafeBatch(batch().message.data), calls)
	assert.doesNotThrow(() => assertInterceptorSafeTransactionPolicy(batch()))
	assert.throws(() => assertInterceptorSafeTransactionPolicy({ ...batch(), message: { ...batch().message, value: 1n } }), /zero outer value/)
	assert.throws(() => encodeSafeBatch([calls[0]]), /between 2 and 100/)
	assert.throws(() => encodeSafeBatch(Array.from({ length: 101 }, () => calls[0])), /between 2 and 100/)
	assert.throws(() => encodeSafeBatch([{ ...calls[0], to: 0n }, calls[1]]), /destination/)
	assert.throws(() => encodeSafeBatch([{ ...calls[0], data: new Uint8Array(100_000) }, calls[1]]), /encoded bytes/)
	for (const packed of ['0x01' + '00'.repeat(84), '0x00', '0x' + '00'.repeat(84) + '01']) {
		assert.throws(() => decodeSafeBatch(stringToUint8Array(encodeFunctionCall(SAFE_MULTI_SEND_ABI, 'multiSend', [packed]))))
	}
	assert.throws(() => decodeSafeBatch(new Uint8Array([...batch().message.data, 0])), /canonical/)
})

test('delegate proposals require the exact deployed Safe library bytecode at the review block', async () => {
	const requestedBlocks: bigint[] = []
	for (const [safeTx, library] of [
		[batch(), multiSendLibrary],
		[createSafeTx(1n, 123n, { to: SAFE_SIGN_MESSAGE_LIB, operation: 1n, value: 0n, input: stringToUint8Array(encodeFunctionCall(SAFE_SIGN_MESSAGE_ABI, 'signMessage', ['0x' + '12'.repeat(32)])) }, 7n), signMessageLibrary],
	] as const) {
		await validateSafeDelegateCode({ getCode: async (_address: bigint, block: bigint) => { requestedBlocks.push(block); return stringToUint8Array(library.deployedBytecode) } }, safeTx, 100n)
		await assert.rejects(validateSafeDelegateCode({ getCode: async () => new Uint8Array() }, safeTx, 100n), /missing or has unexpected bytecode/)
		await assert.rejects(validateSafeDelegateCode({ getCode: async () => new Uint8Array([1]) }, safeTx, 100n), /unexpected bytecode/)
	}
	assert.deepEqual(requestedBlocks, [100n, 100n])
})
