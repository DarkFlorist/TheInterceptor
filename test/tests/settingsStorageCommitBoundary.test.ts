import * as assert from 'node:assert'
import { test } from 'bun:test'
import { installBrowserMock } from './backgroundEthAccountsTestHarness.js'

test('mixed writes commit atomically and advance the name revision once, only after success', async () => {
	installBrowserMock()
	const { runSettingsStorageTransaction } = await import('../../app/ts/background/settingsStorageTransaction.js')
	const { prepareAddressBookWrite, getAddressBookRevision } = await import('../../app/ts/background/addressBookRevision.js')
	const before = getAddressBookRevision()
	const originalSet = browser.storage.local.set
	const writes: unknown[] = []
	browser.storage.local.set = async (items) => { assert.equal(getAddressBookRevision(), before); writes.push(items) }
	try {
		await runSettingsStorageTransaction(async () => ({ writes: [prepareAddressBookWrite({ ensNameHashes: [] }), prepareAddressBookWrite({ ensLabelHashes: [] }), { useTabsInsteadOfPopup: true }], result: undefined }))
		assert.equal(getAddressBookRevision(), before + 1)
		assert.deepEqual(writes, [{ ensNameHashes: [], ensLabelHashes: [], useTabsInsteadOfPopup: true }])
		const failure = new Error('Atomic storage write failed')
		browser.storage.local.set = async () => { throw failure }
		await assert.rejects(runSettingsStorageTransaction(async () => ({ writes: [prepareAddressBookWrite({ ensNameHashes: [] }), { useTabsInsteadOfPopup: false }], result: undefined })), (error) => error === failure)
		assert.equal(getAddressBookRevision(), before + 1)
	} finally { browser.storage.local.set = originalSet }
})
