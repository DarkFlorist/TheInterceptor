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

const { appendPendingTransactionOrMessage, clearPendingTransactions, getPendingSafeProposalStores, getPendingTransactionsAndMessages, movePendingSafeProposalToOutbox, removePendingSafeProposalStore } = await import('../../app/ts/background/storageVariables.js')
const { browserStorageLocalSet2 } = await import('../../app/ts/utils/storageUtils.js')

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

const outboxEntryFor = (pending: PendingTransactionOrSignableMessage) => ({ chainId: 1n, signerReply: '0x01', proposal: pending })

test('moves a pending request to the Safe proposal outbox together with its terminal replies in one storage write', async () => {
	const otherMessage = { ...pendingMessage, uniqueRequestIdentifier: { requestId: 2, requestSocket: { tabId: 1, connectionName: 1n } } }
	await appendPendingTransactionOrMessage(pendingMessage)
	await appendPendingTransactionOrMessage(otherMessage)
	storageWrites.length = 0
	const terminalReply = { method: 'personal_sign' as const, type: 'result' as const, result: '0x01', uniqueRequestIdentifier: pendingMessage.uniqueRequestIdentifier }

	await movePendingSafeProposalToOutbox(pendingMessage.uniqueRequestIdentifier, outboxEntryFor, async () => [terminalReply])

	assert.equal(storageWrites.length, 1)
	assert.deepEqual(Object.keys(storageWrites[0] ?? {}).sort(), ['pendingSafeProposalStores', 'pendingTerminalReplies', 'pendingTransactionsAndMessages'])
	assert.deepEqual((await getPendingTransactionsAndMessages()).map((pending) => pending.uniqueRequestIdentifier.requestId), [2])
	assert.deepEqual((await getPendingSafeProposalStores()).map((entry) => entry.proposal.uniqueRequestIdentifier.requestId), [1])
	await removePendingSafeProposalStore(pendingMessage.uniqueRequestIdentifier)
	assert.deepEqual(await getPendingSafeProposalStores(), [])
})

test('keeps every pending request readable when a deferred Safe signer reply was stored without its chain', async () => {
	const unrelatedMessage = { ...pendingMessage, uniqueRequestIdentifier: { requestId: 2, requestSocket: { tabId: 1, connectionName: 1n } } }
	// Written by an intermediate build before deferred replies recorded their chain.
	await browserStorageLocalSet2({ pendingTransactionsAndMessages: [{ ...pendingMessage, deferredSafeSignerReply: { signerReply: '0x01', terminalReplyQueued: true } }, unrelatedMessage] })

	const pendingRequests = await getPendingTransactionsAndMessages()
	assert.deepEqual(pendingRequests.map((pending) => pending.uniqueRequestIdentifier.requestId), [1, 2])
	assert.deepEqual(pendingRequests[0]?.deferredSafeSignerReply, { signerReply: '0x01', terminalReplyQueued: true })
})

test('writes nothing when the pending request moved to the outbox is gone', async () => {
	let terminalRepliesRead = false

	await movePendingSafeProposalToOutbox(pendingMessage.uniqueRequestIdentifier, outboxEntryFor, async () => {
		terminalRepliesRead = true
		return []
	})

	assert.equal(terminalRepliesRead, false)
	assert.equal(storageWrites.length, 0)
})

test('keeps corrupt pending storage instead of discarding it when moving a request to the outbox', async () => {
	storageState.pendingTransactionsAndMessages = 'corrupt'

	await assert.rejects(movePendingSafeProposalToOutbox(pendingMessage.uniqueRequestIdentifier, outboxEntryFor, async () => []))

	assert.equal(storageState.pendingTransactionsAndMessages, 'corrupt')
	assert.equal(storageWrites.length, 0)
})
