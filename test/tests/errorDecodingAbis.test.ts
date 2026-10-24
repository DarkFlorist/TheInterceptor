import * as assert from 'assert'
import { describe, test } from 'bun:test'

const storageState: Record<string, unknown> = {}
Object.defineProperty(globalThis, 'browser', { value: {
	storage: { local: {
		async get() { return { ...storageState } },
		async set(items: Record<string, unknown>) { Object.assign(storageState, items) },
		async remove(keys: string | string[]) {
			for (const key of Array.isArray(keys) ? keys : [keys]) delete storageState[key]
		},
	} },
}, configurable: true, writable: true })

const { getErrorDecodingAbis } = await import('../../app/ts/background/errorDecodingAbis.js')
const { encodeErrorString, encodePanic } = await import('./errorDataFixtures.js')
const { NEW_BLOCK_ABORT } = await import('../../app/ts/utils/constants.js')

describe('error decoding ABI lookup', () => {
	test('returns the recipient ABI when metadata lookup succeeds', async () => {
		const abis = await getErrorDecodingAbis(['0x12345678'], async () => ({ abi: '[{"type":"error","name":"Failure","inputs":[]}]' }))

		assert.deepEqual(abis, ['[{"type":"error","name":"Failure","inputs":[]}]'])
	})

	test('does not query recipient metadata when every error decodes without an ABI', async () => {
		const errorStringData = encodeErrorString('STF')
		const panicData = encodePanic(0x11n)
		let metadataLookupCount = 0
		const abis = await getErrorDecodingAbis(['0x', undefined, errorStringData, panicData], async () => {
			metadataLookupCount++
			throw new Error('intrinsic gas too low')
		})

		assert.deepEqual(abis, [])
		assert.equal(metadataLookupCount, 0)
	})

	test('queries recipient metadata once when any of the errors is a custom error selector', async () => {
		let metadataLookupCount = 0
		const abis = await getErrorDecodingAbis(['0x', '0x12345678', '0x87654321'], async () => {
			metadataLookupCount++
			return { abi: '[{"type":"error","name":"Failure","inputs":[]}]' }
		})

		assert.deepEqual(abis, ['[{"type":"error","name":"Failure","inputs":[]}]'])
		assert.equal(metadataLookupCount, 1)
	})

	test('preserves the original error when optional metadata lookup fails', async () => {
		const originalConsoleWarn = console.warn
		const originalConsoleError = console.error
		const warnings: unknown[] = []
		console.warn = (...messages: unknown[]) => { warnings.push(...messages) }
		console.error = () => undefined
		try {
			const abis = await getErrorDecodingAbis(['0x12345678'], async () => {
				throw new Error('intrinsic gas too low')
			})

			assert.deepEqual(abis, [])
			assert.equal(warnings.some((warning) => typeof warning === 'string' && warning.includes('code=error_decoding_abi_lookup_failed') && warning.includes('Showing the original error without contract ABI decoding.')), true)
		} finally {
			console.warn = originalConsoleWarn
			console.error = originalConsoleError
		}
	})

	test('propagates new-block aborts from metadata lookup', async () => {
		await assert.rejects(
			async () => await getErrorDecodingAbis(['0x12345678'], async () => { throw NEW_BLOCK_ABORT }),
			(error) => error === NEW_BLOCK_ABORT,
		)
	})
})
