import * as assert from 'assert'
import { test } from 'bun:test'
import multiSendLibrary from '../fixtures/gnosis-safe-libraries/MultiSendCallOnly.json'
import signMessageLibrary from '../fixtures/gnosis-safe-libraries/SignMessageLib.json'
import { createGnosisSafeTx, assertInterceptorGnosisSafeTransactionPolicy } from '../../app/ts/gnosisSafe/gnosisSafeCore.js'
import { encodeGnosisSafeBatch, decodeGnosisSafeBatch, validateGnosisSafeDelegateCode, GNOSIS_SAFE_MULTI_SEND_CALL_ONLY, GNOSIS_SAFE_MULTI_SEND_ABI, GNOSIS_SAFE_SIGN_MESSAGE_LIB, GNOSIS_SAFE_SIGN_MESSAGE_ABI } from '../../app/ts/gnosisSafe/gnosisSafeDelegateCalls.js'
import { encodeFunctionCall } from '../../app/ts/utils/abiRuntime.js'
import { stringToUint8Array } from '../../app/ts/utils/bigint.js'

const calls = [{ to: 42n, value: 0n, data: new Uint8Array([1, 2]) }, { to: 43n, value: 123n, data: new Uint8Array() }]
const batch = () => createGnosisSafeTx(1n, 123n, { to: GNOSIS_SAFE_MULTI_SEND_CALL_ONLY, operation: 1n, value: 0n, input: encodeGnosisSafeBatch(calls) }, 7n)

test('Gnosis Safe batch retains call order and values in one constrained delegate proposal', () => {
	assert.deepEqual(decodeGnosisSafeBatch(batch().message.data), calls)
	assert.doesNotThrow(() => assertInterceptorGnosisSafeTransactionPolicy(batch()))
	assert.throws(() => assertInterceptorGnosisSafeTransactionPolicy({ ...batch(), message: { ...batch().message, value: 1n } }), /zero outer value/)
	assert.throws(() => encodeGnosisSafeBatch([calls[0]]), /between 2 and 100/)
	assert.throws(() => encodeGnosisSafeBatch(Array.from({ length: 101 }, () => calls[0])), /between 2 and 100/)
	assert.throws(() => encodeGnosisSafeBatch([{ ...calls[0], to: 0n }, calls[1]]), /destination/)
	assert.throws(() => encodeGnosisSafeBatch([{ ...calls[0], data: new Uint8Array(100_000) }, calls[1]]), /encoded bytes/)
	for (const packed of ['0x01' + '00'.repeat(84), '0x00', '0x' + '00'.repeat(84) + '01']) {
		assert.throws(() => decodeGnosisSafeBatch(stringToUint8Array(encodeFunctionCall(GNOSIS_SAFE_MULTI_SEND_ABI, 'multiSend', [packed]))))
	}
	assert.throws(() => decodeGnosisSafeBatch(new Uint8Array([...batch().message.data, 0])), /canonical/)
})

test('delegate proposals require the exact deployed Gnosis Safe library bytecode at the review block', async () => {
	const requestedBlocks: bigint[] = []
	for (const [safeTx, library] of [
		[batch(), multiSendLibrary],
		[createGnosisSafeTx(1n, 123n, { to: GNOSIS_SAFE_SIGN_MESSAGE_LIB, operation: 1n, value: 0n, input: stringToUint8Array(encodeFunctionCall(GNOSIS_SAFE_SIGN_MESSAGE_ABI, 'signMessage', ['0x' + '12'.repeat(32)])) }, 7n), signMessageLibrary],
	] as const) {
		await validateGnosisSafeDelegateCode({ getCode: async (_address: bigint, block: bigint) => { requestedBlocks.push(block); return stringToUint8Array(library.deployedBytecode) } }, safeTx, 100n)
		await assert.rejects(validateGnosisSafeDelegateCode({ getCode: async () => new Uint8Array() }, safeTx, 100n), /missing or has unexpected bytecode/)
		await assert.rejects(validateGnosisSafeDelegateCode({ getCode: async () => new Uint8Array([1]) }, safeTx, 100n), /unexpected bytecode/)
	}
	assert.deepEqual(requestedBlocks, [100n, 100n])
})


test('SignMessageLib uses the canonical bytes selector and dynamic argument layout', () => {
	const digest = '12'.repeat(32)
	// Independent ABI vector for the v1.4.1 contract cited beside GNOSIS_SAFE_SIGN_MESSAGE_ABI: selector, offset, byte length, payload.
	const expected = '0x85a5affe' + '0'.repeat(62) + '20' + '0'.repeat(62) + '20' + digest
	assert.equal(encodeFunctionCall(GNOSIS_SAFE_SIGN_MESSAGE_ABI, 'signMessage', [`0x${ digest }`]), expected)
	const proposal = createGnosisSafeTx(1n, 123n, { to: GNOSIS_SAFE_SIGN_MESSAGE_LIB, operation: 1n, value: 0n, input: stringToUint8Array(expected) }, 7n)
	assert.doesNotThrow(() => assertInterceptorGnosisSafeTransactionPolicy(proposal))
	// signMessage(bytes32) has a different selector and is not an entry point of the deployed library.
	assert.throws(() => assertInterceptorGnosisSafeTransactionPolicy({ ...proposal, message: { ...proposal.message, data: stringToUint8Array(`0xa08519b5${ digest }`) } }))
})
