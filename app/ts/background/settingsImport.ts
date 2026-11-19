import type { ActiveAddress, ExportedSettings } from '../types/exportedSettingsTypes.js'
import type { AddressBookEntries, AddressBookEntry } from '../types/addressBookTypes.js'
import type { EthereumAddress } from '../types/wire-types.js'
import { getUniqueItemsByProperties } from '../utils/typed-arrays.js'
import { defaultActiveAddresses, defaultRpcs, metamaskCompatibilityModeStorageWrite, pageStorageWrite, safeAppsCompatibilityModeStorageWrite, signingAddressPreferencesStorageWrite, simulationModeStorageWrite, useSignersAddressAsActiveAddressStorageWrite, useTabsInsteadOfPopupStorageWrite, websiteAccessStorageWrite } from './settings.js'
import { getUserAddressBookEntries, userAddressBookEntriesStorageWrite } from './storageVariables.js'
import { runSettingsStorageTransaction } from './settingsStorageTransaction.js'

function getImportedAddressBookEntries(exportedSettings: ExportedSettings, previousEntries: AddressBookEntries) {
	if (exportedSettings.version === '1.4' || exportedSettings.version === '1.5' || exportedSettings.version === '1.6') return exportedSettings.settings.addressBookEntries
	const convertActiveAddressToAddressBookEntry = (info: ActiveAddress): AddressBookEntry => ({ ...info, type: 'contact' as const, useAsActiveAddress: true, entrySource: 'User' as const })
	return getUniqueItemsByProperties(previousEntries.concat(exportedSettings.settings.addressInfos.map((x) => convertActiveAddressToAddressBookEntry(x))).concat(exportedSettings.settings.contacts ?? []), ['address'])
}

function getImportedSimulationModeStorageWrite(exportedSettings: ExportedSettings, defaultActiveAddress: EthereumAddress) {
	// Pre-1.5 exports contain the legacy address shared by signing and simulation. Apply the same explicit default reset as startup rather than heuristically assigning ambiguous state to either independent mode.
	if (exportedSettings.version === '1.0') return simulationModeStorageWrite({ simulationMode: exportedSettings.settings.simulationMode, rpcNetwork: defaultRpcs[0], activeSimulationAddress: defaultActiveAddress, activeSigningAddress: undefined, activeSigningSafeAddress: undefined })
	const hasIndependentAddresses = exportedSettings.version === '1.5' || exportedSettings.version === '1.6'
	return simulationModeStorageWrite({
		simulationMode: exportedSettings.settings.simulationMode,
		rpcNetwork: exportedSettings.settings.rpcNetwork,
		activeSimulationAddress: hasIndependentAddresses ? exportedSettings.settings.activeSimulationAddress : defaultActiveAddress,
		activeSigningAddress: undefined,
		activeSigningSafeAddress: hasIndependentAddresses ? exportedSettings.settings.activeSigningSafeAddress : undefined,
	})
}

// The import composes the storage owners' writes into one settings storage transaction: it names no storage key itself, and a failed write changes nothing, so there is nothing to roll back.
export async function importSettingsAndAddressBook(exportedSettings: ExportedSettings) {
	const defaultActiveAddress = defaultActiveAddresses[0]?.address
	if (defaultActiveAddress === undefined) throw new Error('Default active address was missing')
	const version = exportedSettings.version
	await runSettingsStorageTransaction(async () => ({
		result: undefined,
		writes: [
			...version === '1.3' || version === '1.4' || version === '1.5' || version === '1.6' ? [pageStorageWrite(exportedSettings.settings.openedPage)] : [],
			userAddressBookEntriesStorageWrite(getImportedAddressBookEntries(exportedSettings, await getUserAddressBookEntries())),
			getImportedSimulationModeStorageWrite(exportedSettings, defaultActiveAddress),
			signingAddressPreferencesStorageWrite(version === '1.5' || version === '1.6' ? exportedSettings.settings.signingAddressPreferences : []),
			useSignersAddressAsActiveAddressStorageWrite(exportedSettings.settings.useSignersAddressAsActiveAddress),
			websiteAccessStorageWrite(exportedSettings.settings.websiteAccess),
			useTabsInsteadOfPopupStorageWrite(exportedSettings.settings.useTabsInsteadOfPopup),
			safeAppsCompatibilityModeStorageWrite(version === '1.6' ? exportedSettings.settings.safeAppsCompatibilityMode : false),
			...version !== '1.0' && version !== '1.1' ? [metamaskCompatibilityModeStorageWrite(exportedSettings.settings.metamaskCompatibilityMode)] : [],
		],
	}))
}
