import type { ActiveAddress, ExportedSettings } from '../types/exportedSettingsTypes.js'
import type { AddressBookEntries, AddressBookEntry } from '../types/addressBookTypes.js'
import type { EthereumAddress } from '../types/wire-types.js'
import { getUniqueItemsByProperties } from '../utils/typed-arrays.js'
import { defaultActiveAddresses, defaultRpcs, delegateClearingPreferencesStorageWrite, metamaskCompatibilityModeStorageWrite, pageStorageWrite, safeAppsCompatibilityModeStorageWrite, signingAddressPreferencesStorageWrite, simulationModeStorageWrite, useSignersAddressAsActiveAddressStorageWrite, useTabsInsteadOfPopupStorageWrite, websiteAccessStorageWrite } from './settings.js'
import { getUserAddressBookEntries, userAddressBookEntriesStorageWrite } from './storageVariables.js'
import { runSettingsStorageTransaction } from './settingsStorageTransaction.js'

function getImportedAddressBookEntries(settings: ExportedSettings['settings'], previousEntries: AddressBookEntries) {
	if ('addressBookEntries' in settings) return settings.addressBookEntries
	const convertActiveAddressToAddressBookEntry = (info: ActiveAddress): AddressBookEntry => ({ ...info, type: 'contact' as const, useAsActiveAddress: true, entrySource: 'User' as const })
	return getUniqueItemsByProperties(previousEntries.concat(settings.addressInfos.map((x) => convertActiveAddressToAddressBookEntry(x))).concat(settings.contacts ?? []), ['address'])
}

function getImportedSimulationModeStorageWrite(settings: ExportedSettings['settings'], defaultActiveAddress: EthereumAddress) {
	// Pre-1.5 exports contain the legacy address shared by signing and simulation. Apply the same explicit default reset as startup rather than heuristically assigning ambiguous state to either independent mode.
	const hasIndependentAddresses = 'signingAddressPreferences' in settings
	return simulationModeStorageWrite({
		simulationMode: settings.simulationMode,
		rpcNetwork: 'rpcNetwork' in settings ? settings.rpcNetwork : defaultRpcs[0],
		activeSimulationAddress: hasIndependentAddresses ? settings.activeSimulationAddress : defaultActiveAddress,
		activeSigningAddress: undefined,
		activeSigningSafeAddress: hasIndependentAddresses ? settings.activeSigningSafeAddress : undefined,
	})
}

// The import composes the storage owners' writes into one settings storage transaction: it names no storage key itself, and a failed write changes nothing, so there is nothing to roll back.
export async function importSettingsAndAddressBook(exportedSettings: ExportedSettings) {
	const defaultActiveAddress = defaultActiveAddresses[0]?.address
	if (defaultActiveAddress === undefined) throw new Error('Default active address was missing')
	const settings = exportedSettings.settings
	// Supported fields come from each decoded schema, so newer versions inherit existing import behavior without extending version predicates.
	await runSettingsStorageTransaction(async () => ({
		result: undefined,
		writes: [
			delegateClearingPreferencesStorageWrite('delegateClearingPreferences' in settings ? settings.delegateClearingPreferences : []),
			...'openedPage' in settings ? [pageStorageWrite(settings.openedPage)] : [],
			userAddressBookEntriesStorageWrite(getImportedAddressBookEntries(settings, await getUserAddressBookEntries())),
			getImportedSimulationModeStorageWrite(settings, defaultActiveAddress),
			signingAddressPreferencesStorageWrite('signingAddressPreferences' in settings ? settings.signingAddressPreferences : []),
			useSignersAddressAsActiveAddressStorageWrite(settings.useSignersAddressAsActiveAddress),
			websiteAccessStorageWrite(settings.websiteAccess),
			useTabsInsteadOfPopupStorageWrite(settings.useTabsInsteadOfPopup),
			safeAppsCompatibilityModeStorageWrite('safeAppsCompatibilityMode' in settings ? settings.safeAppsCompatibilityMode : false),
			...'metamaskCompatibilityMode' in settings ? [metamaskCompatibilityModeStorageWrite(settings.metamaskCompatibilityMode)] : [],
		],
	}))
}
