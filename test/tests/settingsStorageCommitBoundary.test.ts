import * as assert from 'node:assert'
import { test } from 'bun:test'
import { installBrowserMock } from './backgroundEthAccountsTestHarness.js'
import { runSettingsStorageTransaction } from '../../app/ts/background/settingsStorageTransaction.js'

// A combined import must retain one generic commit boundary, without address-book-specific callbacks or bookkeeping.
test('mixed name and settings writes use one storage commit and propagate its failure', async () => {
	installBrowserMock()
	const originalSet = browser.storage.local.set
	const writes: unknown[] = []
	browser.storage.local.set = async (items) => { writes.push(items) }
	try {
		const result = await runSettingsStorageTransaction(async () => ({ writes: [{ userAddressBookEntriesV3: [], ensNameHashes: [] }, { ensLabelHashes: [], useTabsInsteadOfPopup: true }], result: 'committed' }))
		assert.equal(result, 'committed')
		assert.deepEqual(writes, [{ userAddressBookEntriesV3: [], ensNameHashes: [], ensLabelHashes: [], useTabsInsteadOfPopup: true }])
		const failure = new Error('Atomic storage write failed')
		browser.storage.local.set = async () => { throw failure }
		await assert.rejects(runSettingsStorageTransaction(async () => ({ writes: [{ ensNameHashes: [] }, { useTabsInsteadOfPopup: false }], result: 'not committed' })), (error) => error === failure)
	} finally {
		browser.storage.local.set = originalSet
	}
})

test('settings transactions serialize read-modify-write plans and release the lock after a failed commit', async () => {
	installBrowserMock()
	const originalSet = browser.storage.local.set
	const events: string[] = []
	let releaseFirstCommit: () => void = () => { throw new Error('Missing commit release') }
	const firstCommit = new Promise<void>((resolve) => { releaseFirstCommit = resolve })
	browser.storage.local.set = async () => {
		events.push('commit started')
		await firstCommit
		throw new Error('First commit failed')
	}
	try {
		const first = runSettingsStorageTransaction(async () => {
			events.push('first plan')
			return { writes: [{ useTabsInsteadOfPopup: true }], result: undefined }
		})
		// Attach a rejection handler before releasing the commit.
		const firstRejected = assert.rejects(first, /First commit failed/u)
		const second = runSettingsStorageTransaction(async () => {
			events.push('second plan')
			return { writes: [], result: 'second result' }
		})
		await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
		assert.deepEqual(events, ['first plan', 'commit started'])
		releaseFirstCommit()
		await firstRejected
		assert.equal(await second, 'second result')
		assert.deepEqual(events, ['first plan', 'commit started', 'second plan'])
	} finally {
		releaseFirstCommit()
		browser.storage.local.set = originalSet
	}
})
