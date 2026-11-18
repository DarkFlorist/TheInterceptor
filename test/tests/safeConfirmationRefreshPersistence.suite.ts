import * as assert from 'assert'
import { test } from 'bun:test'
import { persistSafeConfirmationRefresh } from '../../app/ts/background/safeSignerSelectionRefresh.js'
import { getPendingTransactionsAndMessages } from '../../app/ts/background/storageVariables.js'
import { getSafePendingFlow } from '../../app/ts/safe/safePendingFlow.js'
import { browserMock } from './confirmTransactionTestHarness.js'

// A Safe refresh merges only into a stored request that still has its kind of Safe flow; otherwise there is nothing to merge, so nothing is written and the refresh is not reported stored.
test('does not write or report stored a Safe refresh for a request without a matching Safe flow', async () => {
	const [stored] = await getPendingTransactionsAndMessages()
	if (stored === undefined) throw new Error('missing the seeded pending transaction')
	assert.equal(getSafePendingFlow(stored), undefined)
	const writes: Record<string, unknown>[] = []
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		writes.push(items)
		writeStoredItems()
	})
	assert.equal(await persistSafeConfirmationRefresh(stored), false)
	assert.deepEqual(writes, [])
})
