import * as assert from 'assert'
import { beforeEach, test } from 'bun:test'
import type { PendingTransactionOrSignableMessage } from '../../app/ts/types/accessRequest.js'
import { withSilencedConsole } from './consoleSilence.js'

const storageState: Record<string, unknown> = {}
const storageWrites: Record<string, unknown>[] = []
let storageReadError: Error | undefined

Object.defineProperty(globalThis, 'browser', { configurable: true, value: {
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
} })

const { appendPendingTransactionOrMessage, clearPendingTransactions, getPendingTransactionsAndMessages } = await import('../../app/ts/background/storageVariables.js')

const pendingMessage = {
	type: 'SignableMessage',
	popupOrTabId: { type: 'popup', id: 1 },
	originalRequestParameters: { method: 'personal_sign', params: ['0x', 1n] },
	simulationMode: true,
	uniqueRequestIdentifier: { requestId: 1, requestSocket: { tabId: 1, connectionName: 1n } },
	signedMessageTransaction: {
		website: { websiteOrigin: 'https://example.test', icon: undefined, title: undefined },
		created: new Date(1),
		fakeSignedFor: 1n,
		originalRequestParameters: { method: 'personal_sign', params: ['0x', 1n] },
		request: {
			method: 'personal_sign',
			params: ['0x', '0x0000000000000000000000000000000000000001'],
			interceptorRequest: true,
			usingInterceptorWithoutSigner: true,
			uniqueRequestIdentifier: { requestId: 1, requestSocket: { tabId: 1, connectionName: 1n } },
		},
		simulationMode: true,
		messageIdentifier: 1n,
	},
	created: new Date(1),
	website: { websiteOrigin: 'https://example.test', icon: undefined, title: undefined },
	activeAddress: 1n,
	approvalStatus: { status: 'WaitingForUser' },
	transactionOrMessageCreationStatus: 'Crafting',
} satisfies PendingTransactionOrSignableMessage

beforeEach(() => {
	for (const key of Object.keys(storageState)) delete storageState[key]
	storageWrites.length = 0
	storageReadError = undefined
})

test('repairs corrupt pending transaction storage without deadlocking clear', async () => {
	storageState.pendingTransactionsAndMessages = 'corrupt'

	await withSilencedConsole(async () => await clearPendingTransactions())

	assert.deepEqual(storageState.pendingTransactionsAndMessages, [])
})

test('repairs corrupt pending transaction storage before appending', async () => {
	storageState.pendingTransactionsAndMessages = 'corrupt'

	await withSilencedConsole(async () => await appendPendingTransactionOrMessage(pendingMessage))

	const restored = await getPendingTransactionsAndMessages()
	assert.equal(restored.length, 1)
	assert.equal(restored[0]?.type, 'SignableMessage')
	assert.deepEqual(restored[0]?.uniqueRequestIdentifier, pendingMessage.uniqueRequestIdentifier)
})

test('does not erase pending transaction storage after a transient read failure', async () => {
	storageState.pendingTransactionsAndMessages = [pendingMessage]
	storageReadError = new Error('Storage temporarily unavailable')

	await assert.rejects(clearPendingTransactions(), /Storage temporarily unavailable/)

	assert.deepEqual(storageState.pendingTransactionsAndMessages, [pendingMessage])
	assert.equal(storageWrites.length, 0)
})
