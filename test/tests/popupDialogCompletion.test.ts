import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { removeAddressBookEntryAndClose } from '../../app/ts/AddressBook.js'
import { readAndImportSettingsFile, withObjectUrl } from '../../app/ts/components/pages/SettingsView.js'
import type { AddressBookEntry } from '../../app/ts/types/addressBookTypes.js'
import { flushMicrotasks } from '../harness/async.js'

describe('popup dialogs finish only after their async work', () => {
	test('closes address removal only after the background mutation succeeds', async () => {
		const entry: AddressBookEntry = { type: 'contact', name: 'Test', address: 1n, entrySource: 'User', chainId: 1n, useAsActiveAddress: false, askForAddressAccess: true }
		const removal = Promise.withResolvers<void>()
		let closeCount = 0
		const action = removeAddressBookEntryAndClose(async () => await removal.promise, entry, () => { closeCount += 1 })

		await flushMicrotasks()
		assert.equal(closeCount, 0)
		removal.resolve()
		await action
		assert.equal(closeCount, 1)

		await assert.rejects(removeAddressBookEntryAndClose(async () => { throw new Error('remove failed') }, entry, () => { closeCount += 1 }), /remove failed/)
		assert.equal(closeCount, 1)
	})

	test('awaits settings file reads and propagates import failures', async () => {
		let importedContents: string | undefined
		await readAndImportSettingsFile({ text: async () => '{"version": 1}' }, async (contents) => { importedContents = contents })
		assert.equal(importedContents, '{"version": 1}')
		await assert.rejects(readAndImportSettingsFile({ text: async () => { throw new Error('read failed') } }, async () => undefined), /read failed/)
	})

	test('revokes settings download object URLs after the click task', () => {
		const revokedUrls: string[] = []
		let cleanup: () => void = () => undefined
		const urlApi = {
			createObjectURL: () => 'blob:test-settings',
			revokeObjectURL: (url: string) => { revokedUrls.push(url) },
		}
		const usedUrl = withObjectUrl(new Blob(['settings']), (url) => url, urlApi, (scheduledCleanup) => { cleanup = scheduledCleanup })
		assert.equal(usedUrl, 'blob:test-settings')
		assert.deepEqual(revokedUrls, [])
		cleanup()
		assert.deepEqual(revokedUrls, ['blob:test-settings'])
	})
})
