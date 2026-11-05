import type { AddressBookEntries, AddressBookEntry } from '../types/addressBookTypes.js'
import type { ActiveAddress, ExportedSettings } from '../types/exportedSettingsTypes.js'
import { updateContentScriptInjectionStrategy } from '../utils/contentScriptsUpdating.js'
import { reportUnexpectedError } from '../utils/errors.js'
import { getUniqueItemsByProperties } from '../utils/typed-arrays.js'
import { commitImportedSettings, defaultActiveAddresses, defaultRpcs, type ImportedSettingsValues } from './settings.js'

function getImportedAddressBookUpdate(exportedSettings: ExportedSettings): (previousEntries: AddressBookEntries) => AddressBookEntries {
	if (exportedSettings.version === '1.4' || exportedSettings.version === '1.5' || exportedSettings.version === '1.6') {
		const { addressBookEntries } = exportedSettings.settings
		return () => addressBookEntries
	}
	// Pre-1.4 exports only contain active addresses and contacts, which are merged into the existing address book instead of replacing it.
	const convertActiveAddressToAddressBookEntry = (info: ActiveAddress): AddressBookEntry => ({ ...info, type: 'contact' as const, useAsActiveAddress: true, entrySource: 'User' as const })
	const legacyEntries = exportedSettings.settings.addressInfos.map((x) => convertActiveAddressToAddressBookEntry(x))
	const contacts = exportedSettings.settings.contacts ?? []
	return (previousEntries) => getUniqueItemsByProperties(previousEntries.concat(legacyEntries).concat(contacts), ['address'])
}

function getImportedSettingsValues(exportedSettings: ExportedSettings): ImportedSettingsValues {
	// Pre-1.5 exports contain the legacy address shared by signing and simulation. Apply the same explicit default reset as startup rather than heuristically assigning ambiguous state to either independent mode.
	const defaultActiveAddress = defaultActiveAddresses[0]?.address
	if (defaultActiveAddress === undefined) throw new Error('Default active address was missing')
	return {
		openedPage: exportedSettings.version === '1.0' || exportedSettings.version === '1.1' || exportedSettings.version === '1.2' ? undefined : exportedSettings.settings.openedPage,
		updateAddressBookEntries: getImportedAddressBookUpdate(exportedSettings),
		simulationMode: exportedSettings.settings.simulationMode,
		rpcNetwork: exportedSettings.version === '1.0' ? defaultRpcs[0] : exportedSettings.settings.rpcNetwork,
		activeSimulationAddress: exportedSettings.version === '1.5' || exportedSettings.version === '1.6' ? exportedSettings.settings.activeSimulationAddress : defaultActiveAddress,
		activeSigningSafeAddress: exportedSettings.version === '1.5' || exportedSettings.version === '1.6' ? exportedSettings.settings.activeSigningSafeAddress : undefined,
		signingAddressPreferences: exportedSettings.version === '1.5' || exportedSettings.version === '1.6' ? exportedSettings.settings.signingAddressPreferences : [],
		useSignersAddressAsActiveAddress: exportedSettings.settings.useSignersAddressAsActiveAddress,
		websiteAccess: exportedSettings.settings.websiteAccess,
		useTabsInsteadOfPopup: exportedSettings.settings.useTabsInsteadOfPopup,
		metamaskCompatibilityMode: exportedSettings.version === '1.0' || exportedSettings.version === '1.1' ? undefined : exportedSettings.settings.metamaskCompatibilityMode,
		safeAppsCompatibilityMode: exportedSettings.version === '1.6' ? exportedSettings.settings.safeAppsCompatibilityMode : false,
	}
}

export async function importSettingsAndAddressBook(exportedSettings: ExportedSettings) {
	await commitImportedSettings(getImportedSettingsValues(exportedSettings))
	// The import replaces the whole website access list and this only re-applies it, so it runs without comparing the disabled sites. The import is committed by now, so a failure is reported rather than rethrown to keep the caller's reconciliation running. This stays out of commitImportedSettings because settings.ts importing the content script updater would create an import cycle.
	try {
		await updateContentScriptInjectionStrategy()
	} catch (error: unknown) {
		await reportUnexpectedError(error, { code: 'settings_import_content_script_update_failed', displayMessage: 'Failed to update the website injection rules after importing settings.' })
	}
}
