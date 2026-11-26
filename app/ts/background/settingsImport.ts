import { normalizeImportedSettings, type ExportedSettings } from '../types/exportedSettingsTypes.js'
import type { AddressBookEntries } from '../types/addressBookTypes.js'
import { getUniqueItemsByProperties } from '../utils/typed-arrays.js'
import { defaultActiveAddresses, defaultRpcs, metamaskCompatibilityModeStorageWrite, pageStorageWrite, gnosisSafeSessionCompatibilityModeStorageWrite, signingAddressPreferencesStorageWrite, simulationModeStorageWrite, useSignersAddressAsActiveAddressStorageWrite, useTabsInsteadOfPopupStorageWrite, websiteAccessStorageWrite } from './settings.js'
import { getUserAddressBookEntries, userAddressBookEntriesStorageWrite } from './storageVariables.js'
import { runSettingsStorageTransaction } from './settingsStorageTransaction.js'

function getImportedAddressBookEntries(settings: ReturnType<typeof normalizeImportedSettings>, previousEntries: AddressBookEntries) {
	if (settings.addressBookEntries !== undefined) return settings.addressBookEntries
	return getUniqueItemsByProperties(previousEntries.concat(settings.legacyAddressBookEntries ?? []), ['address'])
}

// The import composes the storage owners' writes into one settings storage transaction: it names no storage key itself, and a failed write changes nothing, so there is nothing to roll back.
export async function importSettingsAndAddressBook(exportedSettings: ExportedSettings) {
	const defaultActiveAddress = defaultActiveAddresses[0]?.address
	const defaultRpcNetwork = defaultRpcs[0]
	if (defaultActiveAddress === undefined || defaultRpcNetwork === undefined) throw new Error('Default active address or RPC was missing')
	const settings = normalizeImportedSettings(exportedSettings, { activeSimulationAddress: defaultActiveAddress, rpcNetwork: defaultRpcNetwork })
	await runSettingsStorageTransaction(async () => ({
		result: undefined,
		writes: [
			...settings.openedPage === undefined ? [] : [pageStorageWrite(settings.openedPage)],
			userAddressBookEntriesStorageWrite(getImportedAddressBookEntries(settings, await getUserAddressBookEntries())),
			simulationModeStorageWrite({
				simulationMode: settings.simulationMode,
				rpcNetwork: settings.rpcNetwork,
				activeSimulationAddress: settings.activeSimulationAddress,
				activeSigningAddress: undefined,
				activeSigningSafeAddress: settings.activeSigningSafeAddress,
			}),
			signingAddressPreferencesStorageWrite(settings.signingAddressPreferences),
			useSignersAddressAsActiveAddressStorageWrite(settings.useSignersAddressAsActiveAddress),
			websiteAccessStorageWrite(settings.websiteAccess),
			useTabsInsteadOfPopupStorageWrite(settings.useTabsInsteadOfPopup),
			gnosisSafeSessionCompatibilityModeStorageWrite(settings.safeAppsCompatibilityMode),
			...settings.metamaskCompatibilityMode === undefined ? [] : [metamaskCompatibilityModeStorageWrite(settings.metamaskCompatibilityMode)],
		],
	}))
}
