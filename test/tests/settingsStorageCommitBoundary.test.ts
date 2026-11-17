import * as assert from 'node:assert'
import { test } from 'bun:test'
import { installBrowserMock } from './backgroundEthAccountsTestHarness.js'

test('mixed writes share one atomic commit and each owner boundary runs once', async () => {
	installBrowserMock()
	const { runSettingsStorageTransaction } = await import('../../app/ts/background/settingsStorageTransaction.js')
	const { prepareStorageTransactionWrite } = await import('../../app/ts/background/storageTransactionWrite.js')
	const events: string[] = []
	const boundary = async (commit: () => Promise<void>) => {
		events.push('before')
		await commit()
		events.push('after')
	}
	const originalSet = browser.storage.local.set
	const writes: unknown[] = []
	browser.storage.local.set = async (items) => { events.push('commit'); writes.push(items) }
	try {
		await runSettingsStorageTransaction(async () => ({ writes: [prepareStorageTransactionWrite({ useTabsInsteadOfPopup: true }, boundary), prepareStorageTransactionWrite({ metamaskCompatibilityMode: true }, boundary), { simulationMode: false }], result: undefined }))
		assert.deepEqual(events, ['before', 'commit', 'after'])
		assert.deepEqual(writes, [{ useTabsInsteadOfPopup: true, metamaskCompatibilityMode: true, simulationMode: false }])
		events.length = 0
		const failure = new Error('Atomic storage write failed')
		browser.storage.local.set = async () => { events.push('failed commit'); throw failure }
		await assert.rejects(runSettingsStorageTransaction(async () => ({ writes: [prepareStorageTransactionWrite({ useTabsInsteadOfPopup: false }, boundary)], result: undefined })), (error) => error === failure)
		assert.deepEqual(events, ['before', 'failed commit'])
	} finally {
		browser.storage.local.set = originalSet
	}
})
