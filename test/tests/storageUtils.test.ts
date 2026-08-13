import * as assert from 'assert'
import { beforeEach, describe, test } from 'bun:test'

const storedItems: Record<string, unknown> = {}
const writes: Record<string, unknown>[] = []

Object.defineProperty(globalThis, 'browser', {
	configurable: true,
	writable: true,
	value: {
		storage: {
			local: {
				get: async (keys: string | readonly string[]) => {
					const requestedKeys = Array.isArray(keys) ? keys : [keys]
					return Object.fromEntries(requestedKeys.filter((key) => key in storedItems).map((key) => [key, storedItems[key]]))
				},
				set: async (items: Record<string, unknown>) => {
					writes.push(items)
					Object.assign(storedItems, items)
				},
				remove: async () => undefined,
			},
		},
	},
})

const { browserStorageLocalGet, browserStorageLocalSet } = await import('../../app/ts/utils/storageUtils.js')

describe('local storage codecs', () => {
	beforeEach(() => {
		for (const key of Object.keys(storedItems)) delete storedItems[key]
		writes.length = 0
	})

	test('serializes only present active-address properties, including explicit clears', async () => {
		await browserStorageLocalSet({ activeSigningAddress: undefined, activeSimulationAddress: 1n })
		assert.deepEqual(writes[0], {
			activeSigningAddress: 'missing',
			activeSimulationAddress: '0x0000000000000000000000000000000000000001',
		})

		await browserStorageLocalSet({ simulationMode: true })
		assert.deepEqual(writes[1], { simulationMode: true })
		assert.deepEqual(await browserStorageLocalGet(['activeSigningAddress', 'activeSimulationAddress']), {
			activeSigningAddress: undefined,
			activeSimulationAddress: 1n,
		})
	})

	test('distinguishes absent, explicitly cleared, and corrupt active-address properties', async () => {
		assert.deepEqual(await browserStorageLocalGet('activeSigningAddress'), {})

		storedItems.activeSigningAddress = 'missing'
		assert.deepEqual(await browserStorageLocalGet('activeSigningAddress'), { activeSigningAddress: undefined })

		storedItems.activeSigningAddress = 'not-an-address'
		await assert.rejects(browserStorageLocalGet('activeSigningAddress'))
	})
})
