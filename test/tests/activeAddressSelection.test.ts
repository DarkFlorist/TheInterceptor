import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { getSelectableActiveAddresses } from '../../app/ts/components/App.js'
import type { AddressBookEntries } from '../../app/ts/types/addressBookTypes.js'

const EOA_ADDRESS = 0x1000000000000000000000000000000000000001n
const SAFE_ADDRESS = 0x2000000000000000000000000000000000000002n
const OTHER_CHAIN_SAFE_ADDRESS = 0x3000000000000000000000000000000000000003n

const activeAddresses: AddressBookEntries = [
	{ type: 'contact', name: 'Saved EOA', address: EOA_ADDRESS, entrySource: 'User', useAsActiveAddress: true, askForAddressAccess: true },
	{ type: 'safe', name: 'Current-chain Safe', address: SAFE_ADDRESS, chainId: 1n, entrySource: 'User', useAsActiveAddress: true },
	{ type: 'safe', name: 'Other-chain Safe', address: OTHER_CHAIN_SAFE_ADDRESS, chainId: 10n, entrySource: 'User', useAsActiveAddress: true },
]

describe('active address selection', () => {
	test('allows saved EOAs and current-chain Safes in signing mode when no wallet account is available', () => {
		assert.deepEqual(
			getSelectableActiveAddresses(activeAddresses, false, 1n, []).map(({ address }) => address),
			[EOA_ADDRESS, SAFE_ADDRESS],
		)
	})

	test('keeps the wallet account authoritative for EOAs when a signer is available', () => {
		assert.deepEqual(
			getSelectableActiveAddresses(activeAddresses, false, 1n, [EOA_ADDRESS]).map(({ address }) => address),
			[SAFE_ADDRESS],
		)
	})
})
