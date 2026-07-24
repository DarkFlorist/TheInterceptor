import { describe, test } from 'bun:test'
import * as assert from 'assert'
import { createStorageReaderAccountOverride, decodeStorageReaderResult, encodeStorageReaderCall, STORAGE_READER_ABI, STORAGE_READER_PRECOMPILE_RELOCATION_ADDRESS } from '../../app/ts/simulation/storageReader.js'
import { decodeFunctionDataStrict, encodeFunctionReturn } from '../../app/ts/utils/abiRuntime.js'
import { bytes32String, dataStringWith0xStart, stringToUint8Array } from '../../app/ts/utils/bigint.js'
import { getStorageReaderByteCode } from '../../app/ts/utils/ethereumByteCodes.js'

describe('compiled storage reader contract', () => {
	test('uses the compiled runtime bytecode in state overrides', () => {
		const accountOverride = createStorageReaderAccountOverride(false)

		assert.deepEqual(accountOverride, { code: getStorageReaderByteCode() })
		assert.equal(accountOverride.code.length > 0, true)
	})

	test('relocates precompiles while installing the compiled runtime bytecode', () => {
		const accountOverride = createStorageReaderAccountOverride(true)

		assert.deepEqual(accountOverride.code, getStorageReaderByteCode())
		assert.equal(accountOverride.movePrecompileToAddress, STORAGE_READER_PRECOMPILE_RELOCATION_ADDRESS)
	})

	test('ABI-encodes the selected slot and decodes the bytes32 result', () => {
		const requestedSlot = 0x42n
		const encodedCall = encodeStorageReaderCall(requestedSlot)
		const decodedCall = decodeFunctionDataStrict(STORAGE_READER_ABI, dataStringWith0xStart(encodedCall))

		assert.equal(decodedCall.functionName, 'readSlot')
		assert.deepEqual(decodedCall.args, [bytes32String(requestedSlot)])

		const storageValue = 0x1234n
		const encodedResult = encodeFunctionReturn(STORAGE_READER_ABI, 'readSlot', [bytes32String(storageValue)])
		assert.equal(decodeStorageReaderResult(stringToUint8Array(encodedResult)), storageValue)
	})

	test('rejects a malformed contract result', () => {
		assert.throws(() => decodeStorageReaderResult(new Uint8Array()))
	})
})
