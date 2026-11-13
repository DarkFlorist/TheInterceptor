import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { createPendingDialogReply } from '../../app/ts/background/windows/pendingDialogReply.js'
import type { UniqueRequestIdentifier } from '../../app/ts/utils/requests.js'

const waitingRequest: UniqueRequestIdentifier = { requestId: 8, requestSocket: { tabId: 4, connectionName: 6n } }
const otherRequests: readonly UniqueRequestIdentifier[] = [
	{ requestId: 7, requestSocket: { tabId: 4, connectionName: 6n } },
	{ requestId: 8, requestSocket: { tabId: 3, connectionName: 6n } },
	{ requestId: 8, requestSocket: { tabId: 4, connectionName: 5n } },
]

const settlesWithin = async <T>(promise: Promise<T>) => await Promise.race([
	promise.then((value) => ({ settled: true as const, value })),
	new Promise<{ settled: false }>((resolve) => setTimeout(() => resolve({ settled: false }), 20)),
])

describe('pending dialog reply', () => {
	test('ignores a value for any other request and keeps waiting', async () => {
		const pendingReply = createPendingDialogReply<string>(waitingRequest)
		for (const otherRequest of otherRequests) assert.equal(pendingReply.tryResolve(otherRequest, 'late answer'), false)
		assert.deepEqual(await settlesWithin(pendingReply.reply), { settled: false })
	})

	test('takes the value for the request it waits for', async () => {
		const pendingReply = createPendingDialogReply<string>(waitingRequest)
		assert.equal(pendingReply.tryResolve(otherRequests[0] ?? waitingRequest, 'late answer'), false)
		assert.equal(pendingReply.tryResolve({ requestId: 8, requestSocket: { tabId: 4, connectionName: 6n } }, 'own answer'), true)
		assert.deepEqual(await settlesWithin(pendingReply.reply), { settled: true, value: 'own answer' })
	})
})
