import { classifyExportedSettings } from '../types/exportedSettingsTypes.js'
import type { ActiveAddress, ExportedSettings } from '../types/exportedSettingsTypes.js'
import type { AddressBookEntries, AddressBookEntry } from '../types/addressBookTypes.js'
import type { EthereumAddress } from '../types/wire-types.js'
import type { RichModeState } from '../types/richMode.js'
import { getUniqueItemsByProperties } from '../utils/typed-arrays.js'
import { MAKE_YOU_RICH_TRANSACTION } from '../utils/constants.js'
import { normalizeRichAccountBalances } from '../utils/richTokens.js'
import { defaultActiveAddresses, defaultRpcs, metamaskCompatibilityModeStorageWrite, pageStorageWrite, safeAppsCompatibilityModeStorageWrite, signingAddressPreferencesStorageWrite, simulationModeStorageWrite, useSignersAddressAsActiveAddressStorageWrite, useTabsInsteadOfPopupStorageWrite, websiteAccessStorageWrite } from './settings.js'
import { getImportedAddressBookStorageWrites, getUserAddressBookEntries } from './addressBookStorage.js'
import { runSettingsStorageTransaction } from './settingsStorageTransaction.js'

function getImportedAddressBookEntries(exportedSettings: ExportedSettings, previousEntries: AddressBookEntries) {
	if (exportedSettings.version === '1.4' || exportedSettings.version === '1.5' || exportedSettings.version === '1.6' || exportedSettings.version === '1.7') return exportedSettings.settings.addressBookEntries
	const convertActiveAddressToAddressBookEntry = (info: ActiveAddress): AddressBookEntry => ({ ...info, type: 'contact' as const, useAsActiveAddress: true, entrySource: 'User' as const })
	return getUniqueItemsByProperties(previousEntries.concat(exportedSettings.settings.addressInfos.map((x) => convertActiveAddressToAddressBookEntry(x))).concat(exportedSettings.settings.contacts ?? []), ['address'])
}

function getImportedSimulationModeStorageWrite(exportedSettings: ExportedSettings, defaultActiveAddress: EthereumAddress, independentAddressSettings: ReturnType<typeof classifyExportedSettings>['independentAddresses']) {
	// Exports without signing preferences contain the legacy address shared by signing and simulation. Apply the same explicit default reset as startup rather than heuristically assigning ambiguous state to either independent mode.
	if (exportedSettings.version === '1.0') return simulationModeStorageWrite({ simulationMode: exportedSettings.settings.simulationMode, rpcNetwork: defaultRpcs[0], activeSimulationAddress: defaultActiveAddress, activeSigningAddress: undefined, activeSigningSafeAddress: undefined })
	return simulationModeStorageWrite({
		simulationMode: exportedSettings.settings.simulationMode,
		rpcNetwork: exportedSettings.settings.rpcNetwork,
		activeSimulationAddress: independentAddressSettings === undefined ? defaultActiveAddress : independentAddressSettings.activeSimulationAddress,
		activeSigningAddress: undefined,
		activeSigningSafeAddress: independentAddressSettings?.activeSigningSafeAddress,
	})
}

// This user-selected full settings backup is trusted configuration, including its RPC endpoint and access permissions. Restore intentional simulated balances for round trips; reconciliation checks address-book consistency, not on-chain balances. addressesBeingMadeRich excludes all funding overrides in signing mode.
function getImportedRichModeState(settings: ReturnType<typeof classifyExportedSettings>['richFunding']): RichModeState {
	if (settings === undefined) return { makeCurrentAddressRich: false, defaultNativeAmount: MAKE_YOU_RICH_TRANSACTION.transaction.value, fixedAddressRichList: [], tokenLayouts: [], accountBalances: [] }
	return {
		makeCurrentAddressRich: settings.makeCurrentAddressRich,
		defaultNativeAmount: settings.richNativeAmount,
		fixedAddressRichList: settings.fixedAddressRichList,
		tokenLayouts: settings.richTokens.map(({ amount: _amount, ...layout }) => layout),
		accountBalances: normalizeRichAccountBalances(settings.richAccountBalances),
	}
}

// The import composes the storage owners' writes into one settings storage transaction: it names no storage key itself, and a failed write changes nothing, so there is nothing to roll back.
export async function importSettingsAndAddressBook(exportedSettings: ExportedSettings) {
	const defaultActiveAddress = defaultActiveAddresses[0]?.address
	if (defaultActiveAddress === undefined) throw new Error('Default active address was missing')
	const version = exportedSettings.version
	const classified = classifyExportedSettings(exportedSettings)
	await runSettingsStorageTransaction(async () => ({
		result: undefined,
		writes: [
			...version === '1.3' || version === '1.4' || version === '1.5' || version === '1.6' || version === '1.7' ? [pageStorageWrite(exportedSettings.settings.openedPage)] : [],
			// Imported address-book entries and funding are written together, with funding reconciled against those entries.
			...await getImportedAddressBookStorageWrites(getImportedAddressBookEntries(exportedSettings, await getUserAddressBookEntries()), getImportedRichModeState(classified.richFunding)),
			getImportedSimulationModeStorageWrite(exportedSettings, defaultActiveAddress, classified.independentAddresses),
			signingAddressPreferencesStorageWrite(classified.independentAddresses?.signingAddressPreferences ?? []),
			useSignersAddressAsActiveAddressStorageWrite(exportedSettings.settings.useSignersAddressAsActiveAddress),
			websiteAccessStorageWrite(exportedSettings.settings.websiteAccess),
			useTabsInsteadOfPopupStorageWrite(exportedSettings.settings.useTabsInsteadOfPopup),
			safeAppsCompatibilityModeStorageWrite(version === '1.6' || version === '1.7' ? exportedSettings.settings.safeAppsCompatibilityMode : false),
			...version !== '1.0' && version !== '1.1' ? [metamaskCompatibilityModeStorageWrite(exportedSettings.settings.metamaskCompatibilityMode)] : [],
		],
	}))
}
