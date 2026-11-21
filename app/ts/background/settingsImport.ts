import type { ExportedSettings } from '../types/exportedSettingsTypes.js'
import { getUniqueItemsByProperties } from '../utils/typed-arrays.js'
import { normalizeSettingsImport } from '../utils/settingsImport.js'
import { defaultActiveAddresses, defaultRpcs, metamaskCompatibilityModeStorageWrite, pageStorageWrite, safeAppsCompatibilityModeStorageWrite, selectedSigningAddressStorageWrite, signingAddressPreferencesStorageWrite, simulationModeStorageWrite, useSignersAddressAsActiveAddressStorageWrite, useTabsInsteadOfPopupStorageWrite, websiteAccessStorageWrite } from './settings.js'
import { getUserAddressBookEntries } from './addressBookStore.js'
import { addressBookAndSigningWalletBindingsImportWrites } from './signingAddressBookCoordinator.js'
import { runSettingsStorageTransaction } from './settingsStorageTransaction.js'

// The import composes the storage owners' writes into one settings storage transaction: it names no storage key itself, and a failed write changes nothing, so there is nothing to roll back.
export async function importSettingsAndAddressBook(exportedSettings: ExportedSettings) {
	const defaultActiveAddress = defaultActiveAddresses[0]?.address
	const defaultRpc = defaultRpcs[0]
	if (defaultActiveAddress === undefined || defaultRpc === undefined) throw new Error('Default import address or RPC was missing')
	const imported = normalizeSettingsImport(exportedSettings, defaultActiveAddress, defaultRpc)
	await runSettingsStorageTransaction(async () => {
		const addressBookEntries = imported.addressBook.mode === 'replace'
			? imported.addressBook.entries
			: getUniqueItemsByProperties([...await getUserAddressBookEntries(), ...imported.addressBook.entries], ['address'])
		return {
			result: undefined,
			writes: [
				...imported.openedPage === undefined ? [] : [pageStorageWrite(imported.openedPage)],
				...addressBookAndSigningWalletBindingsImportWrites(addressBookEntries, imported.signingWalletBindings),
				simulationModeStorageWrite({
					simulationMode: imported.simulationMode,
					rpcNetwork: imported.rpcNetwork,
					activeSimulationAddress: imported.activeSimulationAddress,
					activeSigningAddress: undefined,
					activeSigningSafeAddress: imported.activeSigningSafeAddress,
				}),
				// An explicit signing address chosen before the import may not exist in the imported address book, so the import resets it like the active signing address.
				selectedSigningAddressStorageWrite(undefined),
				signingAddressPreferencesStorageWrite(imported.signingAddressPreferences),
				useSignersAddressAsActiveAddressStorageWrite(imported.useSignersAddressAsActiveAddress),
				websiteAccessStorageWrite(imported.websiteAccess),
				useTabsInsteadOfPopupStorageWrite(imported.useTabsInsteadOfPopup),
				safeAppsCompatibilityModeStorageWrite(imported.safeAppsCompatibilityMode),
				...imported.metamaskCompatibilityMode === undefined ? [] : [metamaskCompatibilityModeStorageWrite(imported.metamaskCompatibilityMode)],
			],
		}
	})
}
