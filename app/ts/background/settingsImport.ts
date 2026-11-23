import { classifyExportedSettings } from '../types/exportedSettingsTypes.js'
import type { ActiveAddress, ExportedSettings, ExportedSettingsFeatures } from '../types/exportedSettingsTypes.js'
import type { AddressBookEntries, AddressBookEntry } from '../types/addressBookTypes.js'
import type { EthereumAddress } from '../types/wire-types.js'
import type { RichModeState } from '../types/richMode.js'
import { getUniqueItemsByProperties } from '../utils/typed-arrays.js'
import { emptyRichModeState } from './richModeSettings.js'
import { richTokenLayout } from '../utils/richModeDerivation.js'
import { normalizeRichAccountBalances } from '../utils/richTokens.js'
import { defaultActiveAddresses, defaultRpcs, metamaskCompatibilityModeStorageWrite, pageStorageWrite, safeAppsCompatibilityModeStorageWrite, signingAddressPreferencesStorageWrite, simulationModeStorageWrite, useSignersAddressAsActiveAddressStorageWrite, useTabsInsteadOfPopupStorageWrite, websiteAccessStorageWrite } from './settings.js'
import { getUserAddressBookEntries } from './addressBookStorage.js'
import { getImportedAddressBookStorageWrites } from './addressBookCoordinator.js'
import { runSettingsStorageTransaction } from './settingsStorageTransaction.js'

function getImportedAddressBookEntries(addressBook: ExportedSettingsFeatures['addressBook'], previousEntries: AddressBookEntries) {
	if (addressBook.format === 'entries') return addressBook.entries
	const convertActiveAddressToAddressBookEntry = (info: ActiveAddress): AddressBookEntry => ({ ...info, type: 'contact' as const, useAsActiveAddress: true, entrySource: 'User' as const })
	return getUniqueItemsByProperties(previousEntries.concat(addressBook.addressInfos.map((x) => convertActiveAddressToAddressBookEntry(x))).concat(addressBook.contacts ?? []), ['address'])
}

function getImportedSimulationModeStorageWrite(simulationMode: boolean, features: ExportedSettingsFeatures, defaultActiveAddress: EthereumAddress) {
	// Exports without signing preferences contain the legacy address shared by signing and simulation. Apply the same explicit default reset as startup rather than heuristically assigning ambiguous state to either independent mode.
	const independentAddressSettings = features.independentAddresses
	return simulationModeStorageWrite({
		simulationMode,
		rpcNetwork: features.rpcNetwork ?? defaultRpcs[0],
		activeSimulationAddress: independentAddressSettings === undefined ? defaultActiveAddress : independentAddressSettings.activeSimulationAddress,
		activeSigningAddress: undefined,
		activeSigningSafeAddress: independentAddressSettings?.activeSigningSafeAddress,
	})
}

// This user-selected full settings backup is trusted configuration, including its RPC endpoint and access permissions. Restore intentional simulated balances for round trips; reconciliation checks address-book consistency, not on-chain balances. addressesBeingMadeRich excludes all funding overrides in signing mode.
function getImportedRichModeState(settings: ExportedSettingsFeatures['richFunding']): RichModeState {
	if (settings === undefined) return emptyRichModeState
	return {
		makeCurrentAddressRich: settings.makeCurrentAddressRich,
		defaultNativeAmount: settings.richNativeAmount,
		fixedAddressRichList: settings.fixedAddressRichList,
		tokenLayouts: settings.richTokens.map(richTokenLayout),
		accountBalances: normalizeRichAccountBalances(settings.richAccountBalances),
	}
}

// The import composes the storage owners' writes into one settings storage transaction: it names no storage key itself, and a failed write changes nothing, so there is nothing to roll back.
export async function importSettingsAndAddressBook(exportedSettings: ExportedSettings) {
	const defaultActiveAddress = defaultActiveAddresses[0]?.address
	if (defaultActiveAddress === undefined) throw new Error('Default active address was missing')
	const features = classifyExportedSettings(exportedSettings)
	await runSettingsStorageTransaction(async () => ({
		result: undefined,
		writes: [
			...features.openedPage === undefined ? [] : [pageStorageWrite(features.openedPage)],
			// Imported address-book entries and funding are written together, with funding reconciled against those entries.
			...await getImportedAddressBookStorageWrites(getImportedAddressBookEntries(features.addressBook, await getUserAddressBookEntries()), getImportedRichModeState(features.richFunding)),
			getImportedSimulationModeStorageWrite(exportedSettings.settings.simulationMode, features, defaultActiveAddress),
			signingAddressPreferencesStorageWrite(features.independentAddresses?.signingAddressPreferences ?? []),
			useSignersAddressAsActiveAddressStorageWrite(exportedSettings.settings.useSignersAddressAsActiveAddress),
			websiteAccessStorageWrite(exportedSettings.settings.websiteAccess),
			useTabsInsteadOfPopupStorageWrite(exportedSettings.settings.useTabsInsteadOfPopup),
			safeAppsCompatibilityModeStorageWrite(features.safeAppsCompatibilityMode ?? false),
			...features.metamaskCompatibilityMode === undefined ? [] : [metamaskCompatibilityModeStorageWrite(features.metamaskCompatibilityMode)],
		],
	}))
}
