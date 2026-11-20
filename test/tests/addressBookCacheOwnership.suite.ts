import * as assert from 'node:assert'
import { test } from 'bun:test'
import { modules, recipientAddress, fakeRpcNetwork } from './confirmTransactionTestHarness.js'
import type { AddressBookEntry } from '../../app/ts/types/addressBookTypes.js'
import { addUserAddressBookEntryIfItDoesNotExist, getUserAddressBookEntries } from '../../app/ts/background/storageVariables.js'

if (recipientAddress === undefined) throw new Error('Missing recipient')
const recipientContact: AddressBookEntry = { type: 'contact', name: 'Edited recipient', address: recipientAddress, entrySource: 'User', chainId: fakeRpcNetwork.chainId }

test('a lookup cache fill inserts a missing address but never overwrites a user-edited name', async () => {
	await modules.updateUserAddressBookEntries(() => [])
	await addUserAddressBookEntryIfItDoesNotExist({ ...recipientContact, entrySource: 'OnChain' })
	assert.deepEqual(await getUserAddressBookEntries(), [{ ...recipientContact, entrySource: 'OnChain' }])
	await modules.updateUserAddressBookEntries(() => [recipientContact])
	await addUserAddressBookEntryIfItDoesNotExist({ ...recipientContact, name: 'Older chain name', entrySource: 'OnChain' })
	assert.deepEqual(await getUserAddressBookEntries(), [recipientContact])
})
