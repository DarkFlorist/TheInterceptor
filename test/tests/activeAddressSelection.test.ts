import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { getSelectableActiveAddresses, isActiveAddressSelectionAllowed } from '../../app/ts/utils/activeAddressSelection.js'
import type { AddressBookEntries } from '../../app/ts/types/addressBookTypes.js'

const EOA_ADDRESS = 0x1000000000000000000000000000000000000001n
const SAFE_ADDRESS = 0x2000000000000000000000000000000000000002n
const OTHER_CHAIN_SAFE_ADDRESS = 0x3000000000000000000000000000000000000003n
const UNOWNED_SAFE_ADDRESS = 0x4000000000000000000000000000000000000004n
const UNKNOWN_OWNERS_SAFE_ADDRESS = 0x5000000000000000000000000000000000000005n

const activeAddresses: AddressBookEntries = [
	{ type: 'contact', name: 'Saved EOA', address: EOA_ADDRESS, entrySource: 'User', useAsActiveAddress: true, askForAddressAccess: true },
	{ type: 'safe', name: 'Current-chain Safe', address: SAFE_ADDRESS, chainId: 1n, entrySource: 'User', useAsActiveAddress: true, safeSignerAddresses: [EOA_ADDRESS] },
	{ type: 'safe', name: 'Other-chain Safe', address: OTHER_CHAIN_SAFE_ADDRESS, chainId: 10n, entrySource: 'User', useAsActiveAddress: true },
	{ type: 'safe', name: 'Unowned Safe', address: UNOWNED_SAFE_ADDRESS, chainId: 1n, entrySource: 'User', useAsActiveAddress: true, safeSignerAddresses: [OTHER_CHAIN_SAFE_ADDRESS] },
	{ type: 'safe', name: 'Unknown owners Safe', address: UNKNOWN_OWNERS_SAFE_ADDRESS, chainId: 1n, entrySource: 'User', useAsActiveAddress: true },
]

describe('active address selection', () => {
	test('allows current-chain Safes but not arbitrary EOAs in signing mode without a wallet account', () => {
		assert.deepEqual(
			getSelectableActiveAddresses(activeAddresses, false, 1n, []).map(({ address }) => address),
			[SAFE_ADDRESS, UNOWNED_SAFE_ADDRESS, UNKNOWN_OWNERS_SAFE_ADDRESS],
		)
	})

	test('shows only current-chain Safes owned by the wallet-selected signer account', () => {
		assert.deepEqual(
			getSelectableActiveAddresses(activeAddresses, false, 1n, [EOA_ADDRESS]).map(({ address }) => address),
			[SAFE_ADDRESS],
		)
	})

	test('keeps arbitrary EOAs and Safes available in simulation mode', () => {
		assert.deepEqual(
			getSelectableActiveAddresses(activeAddresses, true, 1n, [EOA_ADDRESS]).map(({ address }) => address),
			[EOA_ADDRESS, SAFE_ADDRESS, UNOWNED_SAFE_ADDRESS, UNKNOWN_OWNERS_SAFE_ADDRESS],
		)
	})

	test('blocks alternate signing-mode selection paths from choosing arbitrary EOAs or unowned Safes', () => {
		assert.equal(isActiveAddressSelectionAllowed('signer', activeAddresses, false, 1n, [EOA_ADDRESS]), true)
		assert.equal(isActiveAddressSelectionAllowed(EOA_ADDRESS, activeAddresses, false, 1n, [EOA_ADDRESS]), false)
		assert.equal(isActiveAddressSelectionAllowed(SAFE_ADDRESS, activeAddresses, false, 1n, [EOA_ADDRESS]), true)
		assert.equal(isActiveAddressSelectionAllowed(UNOWNED_SAFE_ADDRESS, activeAddresses, false, 1n, [EOA_ADDRESS]), false)
	})
})
