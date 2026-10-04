import * as assert from 'assert'
import { beforeEach, test } from 'bun:test'
import { withSilencedConsole } from './consoleSilence.js'

const storageState: Record<string, unknown> = {}
const storageWrites: Record<string, unknown>[] = []
let storageReadError: Error | undefined

globalThis.browser = {
	storage: {
		local: {
			async get(keys?: string | string[] | Record<string, unknown> | null) {
				if (storageReadError !== undefined) throw storageReadError
				if (keys === undefined || keys === null) return { ...storageState }
				if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, storageState[key]]))
				if (typeof keys === 'string') return { [keys]: storageState[keys] }
				return Object.fromEntries(Object.entries(keys).map(([key, defaultValue]) => [key, key in storageState ? storageState[key] : defaultValue]))
			},
			async set(items: Record<string, unknown>) {
				storageWrites.push(items)
				Object.assign(storageState, items)
			},
			async remove(keys: string | string[]) {
				for (const key of Array.isArray(keys) ? keys : [keys]) delete storageState[key]
			},
		},
	},
} as unknown as typeof globalThis.browser

const { clearPendingTransactions } = await import('../../app/ts/background/storageVariables.js')

beforeEach(() => {
	for (const key of Object.keys(storageState)) delete storageState[key]
	storageWrites.length = 0
	storageReadError = undefined
})

test('repairs corrupt pending transaction storage without deadlocking a mutation', async () => {
	storageState.pendingTransactionsAndMessages = 'corrupt'

	await withSilencedConsole(async () => await clearPendingTransactions())

	assert.deepEqual(storageState.pendingTransactionsAndMessages, [])
})

test('does not erase pending transaction storage after a transient read failure', async () => {
	storageState.pendingTransactionsAndMessages = []
	storageReadError = new Error('Storage temporarily unavailable')

	await assert.rejects(clearPendingTransactions(), /Storage temporarily unavailable/)

	assert.deepEqual(storageState.pendingTransactionsAndMessages, [])
	assert.equal(storageWrites.length, 0)
})
