import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { addressEditEntry } from '../../app/ts/components/ui-utils.js'
import { getAddressBookEntryForEdit } from '../../app/ts/components/pages/ConfirmTransaction.js'
import { doAddressBookChainIdsMatch } from '../../app/ts/types/addressBookTypes.js'

describe('address edit entry state', () => {
	test('preserves chain ID zero when opening an address for editing', () => {
		const editState = addressEditEntry({
			type: 'contact',
			name: 'Chain zero contact',
			address: 1n,
			entrySource: 'User',
			chainId: 0n,
		})

		assert.equal(editState.incompleteAddressBookEntry.chainId, 0n)
		assert.equal(doAddressBookChainIdsMatch(0n, 1n), false)
		assert.equal(doAddressBookChainIdsMatch(undefined, 1n), true)
	})

	test('does not reopen with a stale ABI after the current address book entry has removed it', () => {
		const address = 0xe72ecea44b6d8b2b3cf5171214d9730e86213ca2n
		const staleClickedEntry = {
			type: 'contract',
			name: 'Contract with stale ABI',
			address,
			entrySource: 'User',
			chainId: 1n,
			abi: '[{"type":"function","name":"stale","inputs":[],"outputs":[],"stateMutability":"view"}]',
		} as const
		const currentSavedEntry = {
			type: 'contract',
			name: 'Contract without ABI',
			address,
			entrySource: 'User',
			chainId: 1n,
		} as const

		assert.equal('abi' in currentSavedEntry, false)

		const editState = addressEditEntry(getAddressBookEntryForEdit(staleClickedEntry, [currentSavedEntry]))

		assert.equal(editState.incompleteAddressBookEntry.abi, undefined)
	})
})
