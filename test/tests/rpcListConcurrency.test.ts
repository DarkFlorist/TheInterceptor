import * as assert from 'node:assert'
import { beforeEach, describe, test } from 'bun:test'
import { getRpcList, promoteRpcAsPrimary, setRpcList } from '../../app/ts/background/storageVariables.js'
import type { RpcEntries } from '../../app/ts/types/rpc.js'
import type { StorageKeys } from '../harness/browserMock.js'
import { createPerTestBrowserMockInstaller } from '../harness/perTest.js'

const installBrowserMock = createPerTestBrowserMockInstaller()

const requestsRpcEntries = (keys: StorageKeys) => (typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : []).includes('rpcEntries')

// Lets a test hold the next rpcEntries read after it has taken its storage snapshot, so another writer can run while the first read-modify-write is paused.
function installBrowserMockWithBlockableRpcListRead() {
	const browserMock = installBrowserMock()
	const readStorage = browserMock.browser.storage.local.get
	let nextBlockedRead: { readonly started: PromiseWithResolvers<void>, readonly released: PromiseWithResolvers<void> } | undefined
	browserMock.browser.storage.local.get = async (keys) => {
		const snapshot = await readStorage(keys)
		if (nextBlockedRead === undefined || !requestsRpcEntries(keys)) return snapshot
		const { started, released } = nextBlockedRead
		nextBlockedRead = undefined
		started.resolve()
		await released.promise
		return snapshot
	}
	return {
		blockNextRpcListRead: () => {
			const blockedRead = { started: Promise.withResolvers<void>(), released: Promise.withResolvers<void>() }
			nextBlockedRead = blockedRead
			return { started: blockedRead.started.promise, release: () => { blockedRead.released.resolve() } }
		},
	}
}

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
	let rpcListStorage: ReturnType<typeof installBrowserMockWithBlockableRpcListRead>

	beforeEach(async () => {
		rpcListStorage = installBrowserMockWithBlockableRpcListRead()
		await setRpcList(existingRpcEntries)
	})

	test('does not let primary promotion overwrite a later settings save', async () => {
		const blockedRead = rpcListStorage.blockNextRpcListRead()
		const promotionPromise = promoteRpcAsPrimary(existingRpcEntries[1])
		await blockedRead.started

		const settingsSavePromise = setRpcList(editedRpcEntries)
		blockedRead.release()
		await Promise.all([promotionPromise, settingsSavePromise])

		assert.deepEqual(await getRpcList(), editedRpcEntries)
	})
})
