import * as assert from 'node:assert'
import { afterEach, test } from 'bun:test'
import { installBrowserMock } from './backgroundEthAccountsTestHarness.js'
import { runSettingsStorageTransaction } from '../../app/ts/background/settingsStorageTransaction.js'
import { userAddressBookEntriesStorageWrite } from '../../app/ts/background/storageVariables.js'
import { useTabsInsteadOfPopupStorageWrite } from '../../app/ts/background/settings.js'

let releasePendingCommit: (() => void) | undefined
let clearStorageHooks: (() => void) | undefined

afterEach(() => {
	releasePendingCommit?.()
	clearStorageHooks?.()
	releasePendingCommit = undefined
	clearStorageHooks = undefined
})

// A combined import retains one generic commit boundary, without address-book-specific bookkeeping.
test('mixed address-book and settings writes use one storage commit and preserve state on failure', async () => {
	const { setStorageHooks } = installBrowserMock()
	clearStorageHooks = () => { setStorageHooks({}) }
	const writes: unknown[] = []
	setStorageHooks({ beforeSet: async (items) => { writes.push(items) } })
	const addressBookWrite = userAddressBookEntriesStorageWrite([])
	const settingsWrite = useTabsInsteadOfPopupStorageWrite(true)
	const expected = { ...addressBookWrite, ...settingsWrite }
	const result = await runSettingsStorageTransaction(async () => ({ writes: [addressBookWrite, settingsWrite], result: 'committed' }))
	assert.equal(result, 'committed')
	assert.deepEqual(writes, [expected])
	assert.deepEqual(await browser.storage.local.get(Object.keys(expected)), expected)
	const failure = new Error('Atomic storage write failed')
	setStorageHooks({ beforeSet: async () => { throw failure } })
	await assert.rejects(runSettingsStorageTransaction(async () => ({ writes: [userAddressBookEntriesStorageWrite([]), useTabsInsteadOfPopupStorageWrite(false)], result: 'not committed' })), (error) => error === failure)
	assert.deepEqual(await browser.storage.local.get(Object.keys(expected)), expected)
})

test('settings transactions serialize plans and release the lock after a failed commit', async () => {
	const { setStorageHooks } = installBrowserMock()
	clearStorageHooks = () => { setStorageHooks({}) }
	const events: string[] = []
	const firstCommit = new Promise<void>((resolve) => { releasePendingCommit = resolve })
	setStorageHooks({ beforeSet: async () => {
		events.push('commit started')
		await firstCommit
		throw new Error('First commit failed')
	} })
	const first = runSettingsStorageTransaction(async () => {
		events.push('first plan')
		return { writes: [useTabsInsteadOfPopupStorageWrite(true)], result: undefined }
	})
	// Attach the rejection handler before releasing the commit.
	const firstRejected = assert.rejects(first, /First commit failed/u)
	const second = runSettingsStorageTransaction(async () => {
		events.push('second plan')
		return { writes: [], result: 'second result' }
	})
	await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
	assert.deepEqual(events, ['first plan', 'commit started'])
	releasePendingCommit?.()
	await firstRejected
	assert.equal(await second, 'second result')
	assert.deepEqual(events, ['first plan', 'commit started', 'second plan'])
})
