import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { assertActiveAddressSelectionAllowed, getActiveAddressSelection, getSelectableActiveAddresses, getWalletSelectedAccount, includePersistedAddressBookEntry, isActiveAddressSelectionAllowed } from '../../app/ts/utils/activeAddressSelection.js'
import type { AddressBookEntries } from '../../app/ts/types/addressBookTypes.js'
import { requestActiveAddressChange } from '../../app/ts/components/activeAddressChange.js'

const EOA_ADDRESS = 0x1000000000000000000000000000000000000001n
const SAFE_ADDRESS = 0x2000000000000000000000000000000000000002n
const OTHER_CHAIN_SAFE_ADDRESS = 0x3000000000000000000000000000000000000003n
const UNOWNED_SAFE_ADDRESS = 0x4000000000000000000000000000000000000004n
const UNKNOWN_OWNERS_SAFE_ADDRESS = 0x5000000000000000000000000000000000000005n
const popupMessageHandlersSource = await Bun.file(new URL('../../app/ts/background/popupMessageHandlers.ts', import.meta.url)).text()
const interceptorAccessSource = await Bun.file(new URL('../../app/ts/background/windows/interceptorAccess.ts', import.meta.url)).text()
const providerMessageHandlersSource = await Bun.file(new URL('../../app/ts/background/providerMessageHandlers.ts', import.meta.url)).text()
const activeSettingsSource = await Bun.file(new URL('../../app/ts/background/activeSettings.ts', import.meta.url)).text()
const backgroundUtilsSource = await Bun.file(new URL('../../app/ts/background/backgroundUtils.ts', import.meta.url)).text()
const providerSigningSelectionSource = await Bun.file(new URL('../../app/ts/background/signingAddressSelection.ts', import.meta.url)).text()
const signerMetadataSource = await Bun.file(new URL('../../app/ts/utils/signerMetadata.ts', import.meta.url)).text()

const activeAddresses: AddressBookEntries = [
	{ type: 'contact', name: 'Saved EOA', address: EOA_ADDRESS, entrySource: 'User', useAsActiveAddress: true, askForAddressAccess: true },
	{ type: 'safe', name: 'Current-chain Safe', address: SAFE_ADDRESS, chainId: 1n, entrySource: 'User', useAsActiveAddress: true, safeSignerAddresses: [EOA_ADDRESS] },
	{ type: 'safe', name: 'Other-chain Safe', address: OTHER_CHAIN_SAFE_ADDRESS, chainId: 10n, entrySource: 'User', useAsActiveAddress: true },
	{ type: 'safe', name: 'Unowned Safe', address: UNOWNED_SAFE_ADDRESS, chainId: 1n, entrySource: 'User', useAsActiveAddress: true, safeSignerAddresses: [OTHER_CHAIN_SAFE_ADDRESS] },
	{ type: 'safe', name: 'Unknown owners Safe', address: UNKNOWN_OWNERS_SAFE_ADDRESS, chainId: 1n, entrySource: 'User', useAsActiveAddress: true },
]

describe('active address selection', () => {
	test('uses the active wallet account and falls back to the first reported account', () => {
		assert.equal(getWalletSelectedAccount(undefined), undefined)
		assert.equal(getWalletSelectedAccount({ activeSigningAddress: undefined, signerAccounts: [] }), undefined)
		assert.equal(getWalletSelectedAccount({ activeSigningAddress: undefined, signerAccounts: [1n, 2n] }), 1n)
		assert.equal(getWalletSelectedAccount({ activeSigningAddress: 2n, signerAccounts: [1n, 2n] }), 2n)
		assert.doesNotMatch(signerMetadataSource, /getWalletSelectedAccount/u)
	})
	test('does not allow selecting an EOA or Safe in signing mode without a wallet account', () => {
		assert.deepEqual(
			getSelectableActiveAddresses(activeAddresses, false, 1n, []).map(({ address }) => address),
			[],
		)
		assert.equal(isActiveAddressSelectionAllowed('signer', activeAddresses, false, 1n, []), false)
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

	test('makes a freshly persisted entry selectable before the popup address list refreshes', () => {
		const freshAddress = 0x6000000000000000000000000000000000000006n
		const persistedEntry = { type: 'contact', name: 'Fresh address', address: freshAddress, entrySource: 'User' } as const
		const selectableAddresses = includePersistedAddressBookEntry(activeAddresses, persistedEntry)

		assert.equal(isActiveAddressSelectionAllowed(freshAddress, activeAddresses, true, 1n, []), false)
		assert.equal(isActiveAddressSelectionAllowed(freshAddress, selectableAddresses, true, 1n, []), true)
		assert.equal(selectableAddresses.at(-1), persistedEntry)
	})

	test('waits for the background to accept an active-address change', async () => {
		let sentMessage: unknown
		await requestActiveAddressChange(EOA_ADDRESS, true, async (message) => {
			sentMessage = message
			return { type: 'ChangeActiveAddressReply', ok: true }
		})

		assert.deepEqual(sentMessage, {
			method: 'popup_changeActiveAddress',
			data: { activeAddress: EOA_ADDRESS, simulationMode: true },
		})
	})

	test('surfaces background rejection of an active-address change', async () => {
		await assert.rejects(
			requestActiveAddressChange(EOA_ADDRESS, true, async () => ({
				type: 'ChangeActiveAddressReply',
				ok: false,
				message: 'The address is not available yet.',
			})),
			/The address is not available yet\./u,
		)
	})

	test('surfaces a missing background active-address reply', async () => {
		await assert.rejects(
			requestActiveAddressChange(EOA_ADDRESS, true, async () => undefined),
			/Changing the active address failed because the background page did not return a reply\./u,
		)
	})

	test('blocks alternate signing-mode selection paths from choosing arbitrary EOAs or unowned Safes', () => {
		assert.equal(isActiveAddressSelectionAllowed('signer', activeAddresses, false, 1n, [EOA_ADDRESS]), true)
		assert.equal(isActiveAddressSelectionAllowed(EOA_ADDRESS, activeAddresses, false, 1n, [EOA_ADDRESS]), true)
		assert.deepEqual(getActiveAddressSelection(EOA_ADDRESS, activeAddresses, false, 1n, [EOA_ADDRESS]), { type: 'signer', address: EOA_ADDRESS })
		assert.equal(isActiveAddressSelectionAllowed(SAFE_ADDRESS, activeAddresses, false, 1n, [EOA_ADDRESS]), true)
		assert.equal(isActiveAddressSelectionAllowed(UNOWNED_SAFE_ADDRESS, activeAddresses, false, 1n, [EOA_ADDRESS]), false)
		assert.throws(() => assertActiveAddressSelectionAllowed(OTHER_CHAIN_SAFE_ADDRESS, activeAddresses, false, 1n, [EOA_ADDRESS]), /configured for another chain/u)
	})

	test('keeps popup and access-dialog security gates on the shared selection policy', () => {
		assert.match(popupMessageHandlersSource, /selection = getActiveAddressSelection\(/u)
		assert.doesNotMatch(popupMessageHandlersSource, /activeChainSigningSafe\.safeSignerAddresses/u)
		assert.match(interceptorAccessSource, /assertActiveAddressSelectionAllowed\(address, selectableAddresses/u)
		assert.doesNotMatch(interceptorAccessSource, /address === signerAccounts\[0\]/u)
		assert.match(providerSigningSelectionSource, /selection = getActiveAddressSelection\(preference\.safeAddress/u)
		assert.doesNotMatch(providerMessageHandlersSource, /safeSignerAddresses\?\.includes\(signerAddress\)/u)
	})

	test('keeps activation choreography in the shared background orchestrator', () => {
		assert.match(activeSettingsSource, /export async function activateAddressSelection[\s\S]*?setUseSignersAddressAsActiveAddress[\s\S]*?changeActiveAddressAndChain[\s\S]*?rememberSigningAddressSelection/u)
		for (const consumerSource of [popupMessageHandlersSource, interceptorAccessSource, providerMessageHandlersSource]) {
			assert.match(consumerSource, /activateAddressSelection\(/u)
			assert.doesNotMatch(consumerSource, /setUseSignersAddressAsActiveAddress\(/u)
			assert.doesNotMatch(consumerSource, /rememberSigningAddressPreference\(/u)
		}
	})

	test('keeps background active-address resolution on the shared selection policy', () => {
		assert.match(backgroundUtilsSource, /selection = getActiveAddressSelection\(/u)
		assert.doesNotMatch(backgroundUtilsSource, /safeSignerAddresses/u)
	})

	test('keeps remembered signer selection decisions in one policy module', () => {
		assert.match(providerSigningSelectionSource, /export async function getSigningAddressSelectionTransition/u)
		assert.match(providerMessageHandlersSource, /getSigningAddressSelectionTransition\(/u)
		assert.doesNotMatch(providerMessageHandlersSource, /getSigningAddressPreferences/u)
		assert.doesNotMatch(providerMessageHandlersSource, /shouldRestoreRememberedSelection/u)
		assert.doesNotMatch(backgroundUtilsSource, /signingAddressPreferences/u)
	})
})
