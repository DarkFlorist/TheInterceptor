import * as assert from 'node:assert'
import { beforeEach, describe, test } from 'bun:test'
import { MessageToPopup } from '../../app/ts/types/interceptor-messages.js'
import { PopupReplyOption } from '../../app/ts/types/interceptor-reply-messages.js'
import type { RpcEntries } from '../../app/ts/types/rpc.js'

const storedItems: Record<string, unknown> = {}
let blockNextRpcListRead = false
let releaseBlockedRead = () => undefined
let signalBlockedReadStarted = () => undefined
let blockedReadStarted = Promise.resolve()
const broadcastRpcLists: RpcEntries[] = []

Object.defineProperty(globalThis, 'browser', {
	configurable: true,
	writable: true,
	value: {
		runtime: {
			lastError: undefined,
			sendMessage: async (message: unknown) => {
				const parsed = MessageToPopup.parse(message)
				if (parsed.method === 'popup_update_rpc_list') broadcastRpcLists.push(parsed.data)
			},
		},
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

const { requestRpcList, promoteRpcAsPrimaryAndNotifyPages, setRpcListAndNotifyPages } = await import('../../app/ts/background/rpcList.js')
const { getRpcList } = await import('../../app/ts/background/rpcListStorage.js')

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
		await setRpcListAndNotifyPages(existingRpcEntries)
		broadcastRpcLists.length = 0
	})

	test('does not let primary promotion overwrite a later settings save', async () => {
		blockNextRpcListRead = true
		blockedReadStarted = new Promise<void>((resolve) => { signalBlockedReadStarted = resolve })
		const promotionPromise = promoteRpcAsPrimaryAndNotifyPages(existingRpcEntries[1])
		await blockedReadStarted

		const settingsSavePromise = setRpcListAndNotifyPages(editedRpcEntries)
		releaseBlockedRead()
		await Promise.all([promotionPromise, settingsSavePromise])

		assert.deepEqual(await getRpcList(), editedRpcEntries)
		// Pages keep the last broadcast list, so the save must be broadcast after the promotion it was queued behind.
		assert.deepEqual(broadcastRpcLists.at(-1), editedRpcEntries)
	})

	test('returns the stored list without broadcasting a change', async () => {
		const reply = await requestRpcList()
		assert.deepEqual(PopupReplyOption.parse(PopupReplyOption.serialize(reply)), { method: 'popup_requestRpcList', rpcEntries: existingRpcEntries })
		assert.deepEqual(broadcastRpcLists, [])
	})

	test('a direct request queued behind a write returns the written list', async () => {
		const settingsSavePromise = setRpcListAndNotifyPages(editedRpcEntries)
		const requestPromise = requestRpcList()
		await settingsSavePromise

		assert.deepEqual(await requestPromise, { method: 'popup_requestRpcList', rpcEntries: editedRpcEntries })
		assert.deepEqual(broadcastRpcLists, [editedRpcEntries])
	})
})
