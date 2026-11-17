import * as assert from 'node:assert'
import { spyOn, test } from 'bun:test'
import { modules, recipientAddress, fakeRpcNetwork, withSilencedConsole } from './confirmTransactionTestHarness.js'
import type { AddressBookEntry } from '../../app/ts/types/addressBookTypes.js'
const { getAddressBookRevision, writeAddressBookStorage } = await import('../../app/ts/background/addressBookRevision.js')
const { cacheIdentifiedAddressBookEntry, getUserAddressBookEntries, addEnsNodeHash, addEnsLabelHash } = await import('../../app/ts/background/storageVariables.js')
if (recipientAddress === undefined) throw new Error('Missing recipient')
const recipientContact: AddressBookEntry = { type: 'contact', name: 'Edited recipient', address: recipientAddress, entrySource: 'User', chainId: fakeRpcNetwork.chainId }

// Settings imports and individual name writes share the storage setter's revision boundary.
test('failed name writes and unrelated settings writes do not advance the address-book revision', async () => {
	const { browserStorageLocalSet } = await import('../../app/ts/utils/storageUtils.js')
	const revisionBefore = getAddressBookRevision()
	await browserStorageLocalSet({ useTabsInsteadOfPopup: false })
	assert.equal(getAddressBookRevision(), revisionBefore)
	const failure = new Error('name storage unavailable')
	const write = spyOn(browser.storage.local, 'set').mockImplementationOnce(async () => { throw failure })
	try {
		await assert.rejects(writeAddressBookStorage({ ensNameHashes: [] }), (error) => error === failure)
		assert.equal(getAddressBookRevision(), revisionBefore)
	} finally {
		write.mockRestore()
	}
})

// The explicit writer is covered independently for each codec field, with no production key registry that could hide an omitted key.
test('explicit name writes advance after success, not failure, and an atomic settings import advances once', async () => {
	const writes = [
		{ userAddressBookEntriesV3: [] },
		{ ensNameHashes: [] },
		{ ensLabelHashes: [] },
	]
	const failure = new Error('Name storage unavailable')
	for (const items of writes) {
		const revisionBefore = getAddressBookRevision()
		const write = spyOn(browser.storage.local, 'set').mockImplementationOnce(async () => { throw failure })
		try {
			await assert.rejects(writeAddressBookStorage(items), (error) => error === failure)
			assert.equal(getAddressBookRevision(), revisionBefore)
		} finally {
			write.mockRestore()
		}
		await writeAddressBookStorage(items)
		assert.equal(getAddressBookRevision(), revisionBefore + 1)
	}
	const { runSettingsStorageTransaction } = await import('../../app/ts/background/settingsStorageTransaction.js')
	const { prepareAddressBookWrite } = await import('../../app/ts/background/addressBookRevision.js')
	const revisionBeforeBatch = getAddressBookRevision()
	await runSettingsStorageTransaction(async () => ({ writes: [prepareAddressBookWrite({ ensNameHashes: [], ensLabelHashes: [] }), { useTabsInsteadOfPopup: true }], result: undefined }))
	assert.equal(getAddressBookRevision(), revisionBeforeBatch + 1)
})

test('an identification cache fill persists a new name without advancing the edited-name revision or overwriting a user edit', async () => {
	await modules.updateUserAddressBookEntries(() => modules.defaultActiveAddresses)
	const revisionBefore = getAddressBookRevision()
	await cacheIdentifiedAddressBookEntry({ ...recipientContact, entrySource: 'OnChain' })
	assert.equal((await getUserAddressBookEntries()).some((entry) => entry.address === recipientContact.address), true)
	assert.equal(getAddressBookRevision(), revisionBefore)
	await modules.updateUserAddressBookEntries(() => [recipientContact])
	const revisionAfterEdit = getAddressBookRevision()
	await cacheIdentifiedAddressBookEntry({ ...recipientContact, name: 'Older chain name', entrySource: 'OnChain' })
	assert.equal((await getUserAddressBookEntries()).find((entry) => entry.address === recipientContact.address)?.name, recipientContact.name)
	assert.equal(getAddressBookRevision(), revisionAfterEdit)
})

test('ENS lookup cache fills and repair-on-read do not masquerade as edited names', async () => {
	const { cacheEnsNodeHash, cacheEnsLabelHash, getEnsNodeHashes, getEnsLabelHashes } = await import('../../app/ts/background/storageVariables.js')
	const revisionBefore = getAddressBookRevision()
	await cacheEnsNodeHash('lookup-only.eth')
	await cacheEnsLabelHash('lookup-only')
	assert.equal((await getEnsNodeHashes()).some((entry) => entry.name === 'lookup-only.eth'), true)
	assert.equal((await getEnsLabelHashes()).some((entry) => entry.label === 'lookup-only'), true)
	await browser.storage.local.set({ userAddressBookEntriesV3: 'unreadable' })
	await withSilencedConsole(async () => await getUserAddressBookEntries())
	assert.equal(getAddressBookRevision(), revisionBefore)
	await addEnsNodeHash('manually-edited.eth')
	await addEnsLabelHash('manually-edited')
	assert.equal(getAddressBookRevision(), revisionBefore + 2)
})
