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

const { getSimulationErrorAbis } = await import('../../app/ts/background/simulationErrorAbi.js')
const { NEW_BLOCK_ABORT } = await import('../../app/ts/utils/constants.js')

describe('simulation error ABI lookup', () => {
	test('returns the recipient ABI when metadata lookup succeeds', async () => {
		const abis = await getSimulationErrorAbis('0x12345678', async () => ({ abi: '[{"type":"error","name":"Failure","inputs":[]}]' }))

		assert.deepEqual(abis, ['[{"type":"error","name":"Failure","inputs":[]}]'])
	})

	test('does not query recipient metadata when the simulation error has no revert data', async () => {
		let metadataLookupCalled = false
		const abis = await getSimulationErrorAbis('0x', async () => {
			metadataLookupCalled = true
			throw new Error('intrinsic gas too low')
		})

		assert.deepEqual(abis, [])
		assert.equal(metadataLookupCalled, false)
	})

	test('preserves the simulation failure when optional metadata lookup fails', async () => {
		const originalConsoleWarn = console.warn
		const originalConsoleError = console.error
		console.warn = () => undefined
		console.error = () => undefined
		try {
			const abis = await getSimulationErrorAbis('0x12345678', async () => {
				throw new Error('intrinsic gas too low')
			})

			assert.deepEqual(abis, [])
		} finally {
			console.warn = originalConsoleWarn
			console.error = originalConsoleError
		}
	})

	test('propagates new-block aborts from metadata lookup', async () => {
		await assert.rejects(
			async () => await getSimulationErrorAbis('0x12345678', async () => { throw NEW_BLOCK_ABORT }),
			(error) => error === NEW_BLOCK_ABORT,
		)
	})
})
