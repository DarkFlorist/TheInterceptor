import * as assert from 'assert'
import { beforeEach, describe, test } from 'bun:test'

const storageState: Record<string, unknown> = {}

Object.defineProperty(globalThis, 'browser', {
	configurable: true,
	writable: true,
	value: {
		storage: {
			local: {
				async get(keys?: string | readonly string[]) {
					if (keys === undefined) return { ...storageState }
					const requestedKeys = Array.isArray(keys) ? keys : [keys]
					return Object.fromEntries(requestedKeys.filter((key) => key in storageState).map((key) => [key, storageState[key]]))
				},
				async set(items: Record<string, unknown>) {
					Object.assign(storageState, items)
				},
				async remove(keys: string | readonly string[]) {
					for (const key of Array.isArray(keys) ? keys : [keys]) delete storageState[key]
				},
			},
		},
	},
})

const { updatePendingRequests } = await import('../../app/ts/background/storageVariables.js')
const { pendingTerminalRepliesWriteBrand } = await import('../../app/ts/utils/storageUtils.js')

describe('reply outbox write lease', () => {
	beforeEach(() => {
		for (const key of Object.keys(storageState)) delete storageState[key]
	})

	// The combined pending-request and outbox write must hold the outbox lock its lease came from; otherwise an outbox read outside the lock, or before another outbox write, could be stored over a newer outbox.
	test('refuses a lease whose outbox lock was released and writes nothing', async () => {
		storageState.pendingTerminalReplies = []
		const releasedLease = { [pendingTerminalRepliesWriteBrand]: true as const, storageItems: { pendingTerminalReplies: ['stale'] }, isOutboxLockHeld: () => false }
		await assert.rejects(updatePendingRequests(() => [], releasedLease), /outbox lock it was prepared under was released/)
		assert.deepEqual(storageState, { pendingTerminalReplies: [] })
	})

	test('stores the outbox items of a held lease in the same write as the pending requests', async () => {
		const heldLease = { [pendingTerminalRepliesWriteBrand]: true as const, storageItems: { pendingTerminalReplies: [] }, isOutboxLockHeld: () => true }
		await updatePendingRequests(() => [], heldLease)
		assert.deepEqual(storageState, { pendingTransactionsAndMessages: [], pendingTerminalReplies: [] })
	})
})
