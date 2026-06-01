import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { doesReplyMatchViewFilter } from '../../app/ts/AddressBook.js'

describe('AddressBook query matching', () => {
	test('accepts replies for the current chain, filter, and search string', () => {
		assert.equal(
			doesReplyMatchViewFilter(
				{
					activeFilter: 'My Contacts',
					searchString: 'alice',
					chain: { chainId: 1n, name: 'Ethereum Mainnet' },
				},
				{ chainId: 1n, filter: 'My Contacts', searchString: 'alice' },
			),
			true,
		)
	})

	test('rejects stale replies when only the search string differs', () => {
		assert.equal(
			doesReplyMatchViewFilter(
				{
					activeFilter: 'My Contacts',
					searchString: 'alice',
					chain: { chainId: 1n, name: 'Ethereum Mainnet' },
				},
				{ chainId: 1n, filter: 'My Contacts', searchString: 'bob' },
			),
			false,
		)
	})

	test('rejects stale replies when only the filter differs', () => {
		assert.equal(
			doesReplyMatchViewFilter(
				{
					activeFilter: 'My Contacts',
					searchString: '',
					chain: { chainId: 1n, name: 'Ethereum Mainnet' },
				},
				{ chainId: 1n, filter: 'My Active Addresses', searchString: '' },
			),
			false,
		)
	})
})
