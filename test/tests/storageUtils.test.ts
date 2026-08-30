import * as assert from 'assert'
import { beforeEach, describe, test } from 'bun:test'
import type { RpcEntry } from '../../app/ts/types/rpc.js'
import { withSilencedConsole } from './consoleSilence.js'

const storedItems: Record<string, unknown> = {}
const writes: Record<string, unknown>[] = []
let nextStorageReadError: Error | undefined

Object.defineProperty(globalThis, 'browser', {
	configurable: true,
	writable: true,
	value: {
		storage: {
			local: {
				get: async (keys: string | readonly string[]) => {
					if (nextStorageReadError !== undefined) {
						const error = nextStorageReadError
						nextStorageReadError = undefined
						throw error
					}
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
const { getRpcList, promoteRpcAsPrimary } = await import('../../app/ts/background/storageVariables.js')

describe('local storage codecs', () => {
	beforeEach(() => {
		for (const key of Object.keys(storedItems)) delete storedItems[key]
		writes.length = 0
		nextStorageReadError = undefined
	})

	test('serializes only present active-address properties, including explicit clears', async () => {
		await browserStorageLocalSet({ activeSigningAddress: undefined, activeSigningSafeAddress: 2n, independentActiveSimulationAddress: 1n })
		assert.deepEqual(writes[0], {
			activeSigningAddress: 'missing',
			activeSigningSafeAddress: '0x0000000000000000000000000000000000000002',
			independentActiveSimulationAddress: '0x0000000000000000000000000000000000000001',
		})

		await browserStorageLocalSet({ simulationMode: true })
		assert.deepEqual(writes[1], { simulationMode: true })
		assert.deepEqual(await browserStorageLocalGet(['activeSigningAddress', 'activeSigningSafeAddress', 'independentActiveSimulationAddress']), {
			activeSigningAddress: undefined,
			activeSigningSafeAddress: 2n,
			independentActiveSimulationAddress: 1n,
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

describe('RPC storage recovery', () => {
	const customPrimaryRpc: RpcEntry = {
		name: 'Custom primary',
		chainId: 1n,
		httpsRpc: 'https://primary.example',
		currencyName: 'Ether',
		currencyTicker: 'ETH',
		primary: true,
		minimized: true,
	}
	const customFallbackRpc: RpcEntry = {
		...customPrimaryRpc,
		name: 'Custom fallback',
		httpsRpc: 'https://fallback.example',
		primary: false,
	}

	beforeEach(async () => {
		for (const key of Object.keys(storedItems)) delete storedItems[key]
		writes.length = 0
		nextStorageReadError = undefined
		await browserStorageLocalSet({ rpcEntries: [customPrimaryRpc, customFallbackRpc] })
		writes.length = 0
	})

	test('does not overwrite custom RPCs when extension storage temporarily rejects a read', async () => {
		const storedRpcEntries = storedItems.rpcEntries
		const readError = new Error('Extension storage is temporarily unavailable')
		nextStorageReadError = readError

		await assert.rejects(promoteRpcAsPrimary(customFallbackRpc), (error: unknown) => error === readError)

		assert.equal(writes.length, 0)
		assert.deepEqual(storedItems.rpcEntries, storedRpcEntries)
	})

	test('continues to use defaults for a corrupt stored RPC value', async () => {
		storedItems.rpcEntries = 'not-an-rpc-list'

		const rpcs = await withSilencedConsole(getRpcList)

		assert.equal(rpcs[0]?.name, 'Ethereum Mainnet')
		assert.equal(rpcs[0]?.primary, true)
	})
})
