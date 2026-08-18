import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { assertActiveAddressSelectionAllowed, getActiveAddressSelection, getDisplayedSigningAddressSelection, getOptimisticActiveAddressSelection, getSelectableActiveAddresses, getWalletSelectedAccount, includePersistedAddressBookEntry, isActiveAddressSelectionAllowed, isSignerConnectedForMode, resolveActiveAddressForMode } from '../../app/ts/utils/activeAddressSelection.js'
import type { AddressBookEntries } from '../../app/ts/types/addressBookTypes.js'
import { requestActiveAddressChange } from '../../app/ts/components/activeAddressChange.js'
import { getActiveAddressEntry } from '../../app/ts/components/subcomponents/address.js'

const EOA_ADDRESS = 0x1000000000000000000000000000000000000001n
const OTHER_EOA_ADDRESS = 0x1000000000000000000000000000000000000002n
const SAFE_ADDRESS = 0x2000000000000000000000000000000000000002n
const OTHER_CHAIN_SAFE_ADDRESS = 0x3000000000000000000000000000000000000003n
const UNOWNED_SAFE_ADDRESS = 0x4000000000000000000000000000000000000004n
const UNKNOWN_OWNERS_SAFE_ADDRESS = 0x5000000000000000000000000000000000000005n
const popupMessageHandlersSource = await Bun.file(new URL('../../app/ts/background/popupMessageHandlers.ts', import.meta.url)).text()
const interceptorAccessSource = await Bun.file(new URL('../../app/ts/background/windows/interceptorAccess.ts', import.meta.url)).text()
const providerMessageHandlersSource = await Bun.file(new URL('../../app/ts/background/providerMessageHandlers.ts', import.meta.url)).text()
const activeSettingsSource = await Bun.file(new URL('../../app/ts/background/activeSettings.ts', import.meta.url)).text()
const backgroundUtilsSource = await Bun.file(new URL('../../app/ts/background/backgroundUtils.ts', import.meta.url)).text()
const backgroundSource = await Bun.file(new URL('../../app/ts/background/background.ts', import.meta.url)).text()
const providerSigningSelectionSource = await Bun.file(new URL('../../app/ts/background/signingAddressSelection.ts', import.meta.url)).text()
const signerMetadataSource = await Bun.file(new URL('../../app/ts/utils/signerMetadata.ts', import.meta.url)).text()
const interceptorAccessUiSource = await Bun.file(new URL('../../app/ts/components/pages/InterceptorAccess.tsx', import.meta.url)).text()
const appSource = await Bun.file(new URL('../../app/ts/components/App.tsx', import.meta.url)).text()
const homeSource = await Bun.file(new URL('../../app/ts/components/pages/Home.tsx', import.meta.url)).text()
const simulationStackPageSource = await Bun.file(new URL('../../app/ts/components/pages/SimulationStackPage.tsx', import.meta.url)).text()

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

	test('keeps optimistic simulation and signing selections in separate state', () => {
		assert.deepEqual(getOptimisticActiveAddressSelection(EOA_ADDRESS, true, [SAFE_ADDRESS]), {
			mode: 'simulation',
			activeSimulationAddress: EOA_ADDRESS,
			useSignersAddressAsActiveAddress: false,
		})
		assert.deepEqual(getOptimisticActiveAddressSelection('signer', true, [EOA_ADDRESS]), {
			mode: 'simulation',
			activeSimulationAddress: EOA_ADDRESS,
			useSignersAddressAsActiveAddress: true,
		})
		assert.deepEqual(getOptimisticActiveAddressSelection(SAFE_ADDRESS, false, [EOA_ADDRESS]), {
			mode: 'signing',
			displayedSigningAddress: SAFE_ADDRESS,
		})
	})

	test('resolves one mode-aware address and Safe-signing state for every popup consumer', () => {
		assert.deepEqual(resolveActiveAddressForMode(activeAddresses, true, EOA_ADDRESS, { type: 'safe', address: SAFE_ADDRESS }, 1n, [EOA_ADDRESS], EOA_ADDRESS), {
			activeAddress: EOA_ADDRESS,
			activeAddressBookEntry: activeAddresses[0],
			safeSigningMode: false,
		})
		assert.deepEqual(resolveActiveAddressForMode(activeAddresses, true, OTHER_CHAIN_SAFE_ADDRESS, { type: 'safe', address: SAFE_ADDRESS }, 1n, [EOA_ADDRESS], EOA_ADDRESS), {
			activeAddress: undefined,
			activeAddressBookEntry: undefined,
			safeSigningMode: false,
		})
		assert.deepEqual(resolveActiveAddressForMode(activeAddresses, false, EOA_ADDRESS, { type: 'safe', address: SAFE_ADDRESS }, 1n, [EOA_ADDRESS], EOA_ADDRESS), {
			activeAddress: SAFE_ADDRESS,
			activeAddressBookEntry: activeAddresses[1],
			safeSigningMode: true,
		})
		assert.deepEqual(resolveActiveAddressForMode(activeAddresses, false, EOA_ADDRESS, { type: 'safe', address: OTHER_CHAIN_SAFE_ADDRESS }, 1n, [EOA_ADDRESS], EOA_ADDRESS), {
			activeAddress: EOA_ADDRESS,
			activeAddressBookEntry: activeAddresses[0],
			safeSigningMode: false,
		})
		for (const consumerSource of [appSource, homeSource, simulationStackPageSource]) {
			assert.match(consumerSource, /resolveActiveAddressForMode\(/u)
			assert.doesNotMatch(consumerSource, /displayedSigningAddress\.value === undefined \? undefined : getWalletSelectedAccount/u)
		}
		assert.doesNotMatch(appSource, /simulationMode\.value \? activeSimulationAddress\.value : displayedSigningAddress\.value/u)
		assert.doesNotMatch(homeSource, /param\.simulationMode\.value \? param\.activeSimulationAddress : param\.displayedSigningAddress/u)
		assert.doesNotMatch(simulationStackPageSource, /simulationMode\.value \? activeSimulationAddress\.value : displayedSigningAddress\.value/u)
	})

	test('prefers the current-chain Safe over an earlier contact with the same signing address', () => {
		const contactWithSafeAddress = { type: 'contact', name: 'Safe address contact', address: SAFE_ADDRESS, entrySource: 'User', useAsActiveAddress: true, askForAddressAccess: true } as const
		assert.deepEqual(resolveActiveAddressForMode([contactWithSafeAddress, ...activeAddresses], false, EOA_ADDRESS, { type: 'safe', address: SAFE_ADDRESS }, 1n, [EOA_ADDRESS], EOA_ADDRESS), {
			activeAddress: SAFE_ADDRESS,
			activeAddressBookEntry: activeAddresses[1],
			safeSigningMode: true,
		})
	})

	test('falls back to the wallet account instead of presenting an unowned Safe as the active signing account', () => {
		assert.deepEqual(resolveActiveAddressForMode(activeAddresses, false, EOA_ADDRESS, { type: 'safe', address: SAFE_ADDRESS }, 1n, [OTHER_CHAIN_SAFE_ADDRESS], EOA_ADDRESS), {
			activeAddress: EOA_ADDRESS,
			activeAddressBookEntry: activeAddresses[0],
			safeSigningMode: false,
		})
	})

	test('uses a selected wallet EOA directly as the active signing address', () => {
		assert.deepEqual(resolveActiveAddressForMode(activeAddresses, false, SAFE_ADDRESS, { type: 'walletAccount', address: EOA_ADDRESS }, 1n, [EOA_ADDRESS, OTHER_EOA_ADDRESS], OTHER_EOA_ADDRESS), {
			activeAddress: EOA_ADDRESS,
			activeAddressBookEntry: activeAddresses[0],
			safeSigningMode: false,
		})
	})

	test('does not mistake a wallet EOA for a same-address Safe on another chain', () => {
		const sameAddressOtherChainSafe = { ...activeAddresses[2], address: EOA_ADDRESS }
		assert.deepEqual(resolveActiveAddressForMode([...activeAddresses, sameAddressOtherChainSafe], false, SAFE_ADDRESS, { type: 'walletAccount', address: EOA_ADDRESS }, 1n, [EOA_ADDRESS, OTHER_EOA_ADDRESS], OTHER_EOA_ADDRESS), {
			activeAddress: EOA_ADDRESS,
			activeAddressBookEntry: activeAddresses[0],
			safeSigningMode: false,
		})
	})

	test('classifies the displayed wallet account separately from a displayed Safe', () => {
		assert.deepEqual(getDisplayedSigningAddressSelection(EOA_ADDRESS, undefined), { type: 'walletAccount', address: EOA_ADDRESS })
		assert.deepEqual(getDisplayedSigningAddressSelection(SAFE_ADDRESS, SAFE_ADDRESS), { type: 'safe', address: SAFE_ADDRESS })
		assert.equal(getDisplayedSigningAddressSelection(undefined, SAFE_ADDRESS), undefined)
	})

	test('keeps an explicitly selected Safe when its address matches the wallet account', () => {
		const selfOwnedSafe = { ...activeAddresses[1], safeSignerAddresses: [SAFE_ADDRESS] }
		assert.deepEqual(getActiveAddressSelection(SAFE_ADDRESS, [activeAddresses[0], selfOwnedSafe], false, 1n, [SAFE_ADDRESS]), {
			type: 'addressBookEntry',
			entry: selfOwnedSafe,
		})
		assert.deepEqual(resolveActiveAddressForMode([activeAddresses[0], selfOwnedSafe], false, EOA_ADDRESS, { type: 'safe', address: SAFE_ADDRESS }, 1n, [SAFE_ADDRESS], SAFE_ADDRESS), {
			activeAddress: SAFE_ADDRESS,
			activeAddressBookEntry: selfOwnedSafe,
			safeSigningMode: true,
		})
	})

	test('does not present an invalid signing Safe when no wallet fallback is available', () => {
		assert.deepEqual(resolveActiveAddressForMode(activeAddresses, false, EOA_ADDRESS, { type: 'safe', address: SAFE_ADDRESS }, 1n, [], undefined), {
			activeAddress: undefined,
			activeAddressBookEntry: undefined,
			safeSigningMode: false,
		})
	})

	test('does not fall back to the wallet account before a signing address is configured', () => {
		assert.deepEqual(resolveActiveAddressForMode(activeAddresses, false, EOA_ADDRESS, undefined, 1n, [EOA_ADDRESS], EOA_ADDRESS), {
			activeAddress: undefined,
			activeAddressBookEntry: undefined,
			safeSigningMode: false,
		})
	})

	test('uses current-chain metadata instead of an earlier wrong-chain entry for the same address', () => {
		const wrongChainEntry = { ...activeAddresses[0], name: 'Wrong-chain EOA', chainId: 10n, askForAddressAccess: false }
		const currentChainEntry = { ...activeAddresses[0], name: 'Current-chain EOA', chainId: 1n, askForAddressAccess: true }
		const duplicatedAddressEntries = [wrongChainEntry, currentChainEntry, ...activeAddresses.slice(1)]

		assert.deepEqual(resolveActiveAddressForMode(duplicatedAddressEntries, true, EOA_ADDRESS, { type: 'safe', address: SAFE_ADDRESS }, 1n, [EOA_ADDRESS], EOA_ADDRESS), {
			activeAddress: EOA_ADDRESS,
			activeAddressBookEntry: currentChainEntry,
			safeSigningMode: false,
		})
		assert.deepEqual(resolveActiveAddressForMode(duplicatedAddressEntries, false, EOA_ADDRESS, { type: 'safe', address: SAFE_ADDRESS }, 1n, [OTHER_CHAIN_SAFE_ADDRESS], EOA_ADDRESS), {
			activeAddress: EOA_ADDRESS,
			activeAddressBookEntry: currentChainEntry,
			safeSigningMode: false,
		})
	})

	test('uses unknown UI metadata instead of another chain\'s entry', () => {
		const address = 0x6161616161616161616161616161616161616161n
		const entry = getActiveAddressEntry(address, [{
			type: 'contact',
			name: 'Wrong-chain label',
			address,
			chainId: 10n,
			entrySource: 'User',
			useAsActiveAddress: true,
			askForAddressAccess: false,
		}], 1n)
		assert.notEqual(entry.name, 'Wrong-chain label')
		assert.equal(entry.askForAddressAccess, true)
	})

	test('treats an owner wallet as connected while a Safe is the displayed signing account', () => {
		assert.equal(isSignerConnectedForMode(false, undefined, { signerAccounts: [EOA_ADDRESS] }), true)
		assert.equal(isSignerConnectedForMode(false, undefined, { signerAccounts: [] }), false)
		assert.equal(isSignerConnectedForMode(true, EOA_ADDRESS, { signerAccounts: [EOA_ADDRESS] }), true)
		assert.equal(isSignerConnectedForMode(true, SAFE_ADDRESS, { signerAccounts: [EOA_ADDRESS] }), false)
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

	test('replaces stale metadata for a just-persisted entry', () => {
		const staleEntry = { type: 'safe', name: 'Stale Safe', address: SAFE_ADDRESS, chainId: 1n, entrySource: 'User', safeSignerAddresses: [] } as const
		const persistedEntry = { ...staleEntry, name: 'Updated Safe', safeSignerAddresses: [EOA_ADDRESS] }
		const selectableAddresses = includePersistedAddressBookEntry([staleEntry], persistedEntry)

		assert.deepEqual(selectableAddresses, [persistedEntry])
		assert.equal(isActiveAddressSelectionAllowed(SAFE_ADDRESS, selectableAddresses, false, 1n, [EOA_ADDRESS]), true)
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
		assert.equal(isActiveAddressSelectionAllowed(EOA_ADDRESS, activeAddresses, false, 1n, [EOA_ADDRESS]), false)
		assert.equal(getActiveAddressSelection(EOA_ADDRESS, activeAddresses, false, 1n, [EOA_ADDRESS]), undefined)
		assert.equal(isActiveAddressSelectionAllowed(SAFE_ADDRESS, activeAddresses, false, 1n, [EOA_ADDRESS]), true)
		assert.equal(isActiveAddressSelectionAllowed(UNOWNED_SAFE_ADDRESS, activeAddresses, false, 1n, [EOA_ADDRESS]), false)
		assert.throws(() => assertActiveAddressSelectionAllowed(OTHER_CHAIN_SAFE_ADDRESS, activeAddresses, false, 1n, [EOA_ADDRESS]), /configured for another chain/u)
	})

	test('keeps popup and access-dialog security gates on the shared selection policy', () => {
		assert.match(popupMessageHandlersSource, /selection = getActiveAddressSelection\(/u)
		assert.doesNotMatch(popupMessageHandlersSource, /activeChainSigningSafe\.safeSignerAddresses/u)
		assert.match(interceptorAccessSource, /return assertActiveAddressSelectionAllowed\(addressSelection, selectableAddresses/u)
		assert.match(interceptorAccessSource, /approvedAddressSelection \?\? await getAllowedAddressSelectionForAccessRequest/u)
		assert.equal(interceptorAccessSource.match(/includePersistedAddressBookEntry\(activeAddresses, request(?:ed)?Entry\)/gu)?.length, 1)
		assert.match(interceptorAccessSource, /requestedEntry\?\.address !== address \|\| requestedEntry\.type !== 'safe'/u)
		assert.match(interceptorAccessUiSource, /includePersistedAddressBookEntry\(activeAddresses\.value, persistedEntry\)/u)
		assert.match(interceptorAccessUiSource, /\(address: bigint \| 'signer', persistedEntry\?: AddressBookEntry\) => setActiveAddressAndInformAboutIt\(selectedAccessRequest\.accessRequestId, address, persistedEntry\)/u)
		assert.match(providerSigningSelectionSource, /selection = getActiveAddressSelection\(preference\.safeAddress/u)
		assert.doesNotMatch(providerMessageHandlersSource, /safeSignerAddresses\?\.includes\(signerAddress\)/u)
	})

	test('keeps activation choreography in the shared background orchestrator', () => {
		assert.match(activeSettingsSource, /export async function activateAddressSelection[\s\S]*?setUseSignersAddressAsActiveAddress[\s\S]*?changeActiveAddressAndChain[\s\S]*?rememberSigningAddressSelection/u)
		assert.doesNotMatch(activeSettingsSource, /inferredSafeEntryOnActiveChain/u)
		assert.match(activeSettingsSource, /Signing address changes must identify whether the selection is the signer or a Safe\./u)
		assert.match(providerMessageHandlersSource, /!settings\.simulationMode \? \{ signingAddressSelection: 'signer'/u)
		assert.match(activeSettingsSource, /export async function activateUserSelectedAddress[\s\S]*?activateAddressSelection\([\s\S]*?acknowledgeActiveAddressSelectionResetNotice\(\)/u)
		const explicitPopupSelectionHandler = popupMessageHandlersSource.slice(
			popupMessageHandlersSource.indexOf('export async function changeActiveAddress('),
			popupMessageHandlersSource.indexOf('export async function modifyMakeMeRich('),
		)
		assert.match(explicitPopupSelectionHandler, /activateUserSelectedAddress\(/u)
		assert.doesNotMatch(explicitPopupSelectionHandler, /activateAddressSelection\(/u)
		assert.match(interceptorAccessSource, /activateUserSelectedAddress\(/u)
		assert.doesNotMatch(interceptorAccessSource, /activateAddressSelection\(/u)
		assert.match(providerMessageHandlersSource, /activateAddressSelection\(/u)
		assert.doesNotMatch(providerMessageHandlersSource, /activateUserSelectedAddress\(/u)
		for (const consumerSource of [explicitPopupSelectionHandler, interceptorAccessSource, providerMessageHandlersSource]) {
			assert.doesNotMatch(consumerSource, /setUseSignersAddressAsActiveAddress\(/u)
			assert.doesNotMatch(consumerSource, /rememberSigningAddressPreference\(/u)
		}
	})

	test('keeps background active-address resolution on the shared selection policy', () => {
		assert.match(backgroundUtilsSource, /resolveActiveAddressForMode\(/u)
		assert.match(backgroundSource, /resolveActiveAddressForMode\(/u)
		assert.doesNotMatch(backgroundUtilsSource, /resolveSigningSafe\(/u)
		assert.doesNotMatch(backgroundSource, /resolveSigningSafe\(/u)
		assert.doesNotMatch(backgroundSource, /getSafeSigningEntry/u)
		assert.doesNotMatch(backgroundUtilsSource, /getActiveAddressSelection\(/u)
		assert.doesNotMatch(providerSigningSelectionSource, /resolveConfiguredSigningSafe/u)
		assert.match(providerSigningSelectionSource, /getConfiguredSigningSafeForChain[\s\S]*?resolveSigningSafe\(/u)
		assert.doesNotMatch(backgroundUtilsSource, /safeSignerAddresses/u)
		assert.doesNotMatch(backgroundUtilsSource, /isSafeOnAnotherChain/u)
		assert.doesNotMatch(backgroundUtilsSource, /chainEntries\.find/u)
		assert.match(backgroundUtilsSource, /const addressBookEntries = await getConfiguredActiveAddressBookEntries\(settings\)[\s\S]*?tabStates\.map/u)
		assert.doesNotMatch(backgroundUtilsSource, /tabStates\.map\(async \(state\) => \{[\s\S]*?getConfiguredActiveAddressBookEntries/u)
	})

	test('keeps remembered signer selection decisions in one policy module', () => {
		assert.match(providerSigningSelectionSource, /export async function getSigningAddressSelectionTransition/u)
		assert.match(providerMessageHandlersSource, /getSigningAddressSelectionTransition\(/u)
		assert.doesNotMatch(providerMessageHandlersSource, /getSigningAddressPreferences/u)
		assert.doesNotMatch(providerMessageHandlersSource, /shouldActivateWalletAccountSelection/u)
		assert.doesNotMatch(backgroundUtilsSource, /signingAddressPreferences/u)
	})
})
