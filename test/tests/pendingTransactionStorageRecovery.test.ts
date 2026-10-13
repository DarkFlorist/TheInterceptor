import * as assert from 'node:assert'
import { test } from 'bun:test'
import { clearPendingTransactions } from '../../app/ts/background/storageVariables.js'
import type { BrowserMock } from '../harness/browserMock.js'
import { createPerTestBrowserMockInstaller } from '../harness/perTest.js'
import { withSilencedConsole } from './consoleSilence.js'

const pendingTransactionsStorageKey = 'pendingTransactionsAndMessages'

const installBrowserMock = createPerTestBrowserMockInstaller()

const installMockWithStoredPendingTransactions = (storedPendingTransactions: unknown) => installBrowserMock({
	storage: { local: { [pendingTransactionsStorageKey]: storedPendingTransactions } },
})

const readStoredPendingTransactions = (mock: BrowserMock) => mock.readStorage()[pendingTransactionsStorageKey]

test('repairs corrupt pending transaction storage without deadlocking a mutation', async () => {
	const browserMock = installMockWithStoredPendingTransactions('corrupt')

	await withSilencedConsole(async () => await clearPendingTransactions())

	assert.deepEqual(readStoredPendingTransactions(browserMock), [])
})

test('does not erase pending transaction storage after a transient read failure', async () => {
	const browserMock = installMockWithStoredPendingTransactions([])
	const storageWrites: unknown[] = []
	const storeItems = browserMock.browser.storage.local.set
	browserMock.browser.storage.local.get = async () => { throw new Error('Storage temporarily unavailable') }
	browserMock.browser.storage.local.set = async (items) => {
		storageWrites.push(items)
		await storeItems(items)
	}

	await assert.rejects(clearPendingTransactions(), /Storage temporarily unavailable/)

	assert.deepEqual(readStoredPendingTransactions(browserMock), [])
	assert.equal(storageWrites.length, 0)
})
