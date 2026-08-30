import * as assert from 'node:assert'
import { beforeEach, describe, test } from 'bun:test'
import type { RpcEntries } from '../../app/ts/types/rpc.js'

const storedItems: Record<string, unknown> = {}
let blockNextRpcListRead = false
let releaseBlockedRead = () => undefined
let signalBlockedReadStarted = () => undefined
let blockedReadStarted = Promise.resolve()

Object.defineProperty(globalThis, 'browser', {
	configurable: true,
	writable: true,
	value: {
		storage: {
			local: {
				get: async (keys: string | readonly string[]) => {
					const requestedKeys = Array.isArray(keys) ? keys : [keys]
					const snapshot = Object.fromEntries(requestedKeys.filter((key) => key in storedItems).map((key) => [key, storedItems[key]]))
					if (!blockNextRpcListRead || !requestedKeys.includes('rpcEntries')) return snapshot
					blockNextRpcListRead = false
					signalBlockedReadStarted()
					await new Promise<void>((resolve) => { releaseBlockedRead = resolve })
					return snapshot
				},
				set: async (items: Record<string, unknown>) => { Object.assign(storedItems, items) },
				remove: async () => undefined,
			},
		},
	},
})

const { getRpcList, promoteRpcAsPrimary, setRpcList } = await import('../../app/ts/background/storageVariables.js')

const existingRpcEntries = [
	{
		name: 'Primary RPC',
		chainId: 1n,
		httpsRpc: 'https://primary.invalid',
		currencyName: 'Ether',
		currencyTicker: 'ETH',
		primary: true,
		minimized: true,
	},
	{
		name: 'Secondary RPC',
		chainId: 1n,
		httpsRpc: 'https://secondary.invalid',
		currencyName: 'Ether',
		currencyTicker: 'ETH',
		primary: false,
		minimized: true,
	},
] as const satisfies RpcEntries

const editedRpcEntries = [
	...existingRpcEntries,
	{
		name: 'User RPC',
		chainId: 10n,
		httpsRpc: 'https://user.invalid',
		currencyName: 'Ether',
		currencyTicker: 'ETH',
		primary: true,
		minimized: false,
	},
] as const satisfies RpcEntries

describe('RPC list concurrency', () => {
	beforeEach(async () => {
		for (const key of Object.keys(storedItems)) delete storedItems[key]
		blockNextRpcListRead = false
		releaseBlockedRead = () => undefined
		signalBlockedReadStarted = () => undefined
		blockedReadStarted = Promise.resolve()
		await setRpcList(existingRpcEntries)
	})

	test('does not let primary promotion overwrite a later settings save', async () => {
		blockNextRpcListRead = true
		blockedReadStarted = new Promise<void>((resolve) => { signalBlockedReadStarted = resolve })
		const promotionPromise = promoteRpcAsPrimary(existingRpcEntries[1])
		await blockedReadStarted

		const settingsSavePromise = setRpcList(editedRpcEntries)
		releaseBlockedRead()
		await Promise.all([promotionPromise, settingsSavePromise])

		assert.deepEqual(await getRpcList(), editedRpcEntries)
	})
})
