import type { AddressBookEntries, AddressBookEntry } from '../types/addressBookTypes.js'
import type { ActiveAddress, ExportedSettings } from '../types/exportedSettingsTypes.js'
import { updateContentScriptInjectionStrategy } from '../utils/contentScriptsUpdating.js'
import { reportUnexpectedError } from '../utils/errors.js'
import { getUniqueItemsByProperties } from '../utils/typed-arrays.js'
import { browserStorageLocalSet } from '../utils/storageUtils.js'
import { sanitizeWebsiteAccess } from '../utils/websiteIcons.js'
import { defaultActiveAddresses, defaultRpcs, getSimulationModeStorageUpdate, type SimulationModeChanges } from './settings.js'
import { withSettingsStorageLock } from './settingsStorageLock.js'
import { readUserAddressBookEntriesWithoutRepairWrite } from './storageVariables.js'

async function getImportedUserAddressBookEntries(exportedSettings: ExportedSettings): Promise<AddressBookEntries> {
	if (exportedSettings.version === '1.4' || exportedSettings.version === '1.5' || exportedSettings.version === '1.6') return exportedSettings.settings.addressBookEntries
	// Pre-1.4 exports only contain active addresses and contacts, which are merged into the existing address book instead of replacing it.
	const convertActiveAddressToAddressBookEntry = (info: ActiveAddress): AddressBookEntry => ({ ...info, type: 'contact' as const, useAsActiveAddress: true, entrySource: 'User' as const })
	// A repairable or corrupt stored address book is not repaired here: the merge below is stored by the import's single write, so a failed import leaves the stored value untouched.
	const { entries: previousEntries } = await readUserAddressBookEntriesWithoutRepairWrite()
	return getUniqueItemsByProperties(previousEntries.concat(exportedSettings.settings.addressInfos.map((x) => convertActiveAddressToAddressBookEntry(x))).concat(exportedSettings.settings.contacts ?? []), ['address'])
}

function getImportedModeChanges(exportedSettings: ExportedSettings): SimulationModeChanges {
	// Pre-1.5 exports contain the legacy address shared by signing and simulation. Apply the same explicit default reset as startup rather than heuristically assigning ambiguous state to either independent mode.
	const defaultActiveAddress = defaultActiveAddresses[0]?.address
	if (defaultActiveAddress === undefined) throw new Error('Default active address was missing')
	if (exportedSettings.version === '1.0') return {
		simulationMode: exportedSettings.settings.simulationMode,
		rpcNetwork: defaultRpcs[0],
		activeSimulationAddress: defaultActiveAddress,
		activeSigningAddress: undefined,
		activeSigningSafeAddress: undefined,
	}
	return {
		simulationMode: exportedSettings.settings.simulationMode,
		rpcNetwork: exportedSettings.settings.rpcNetwork,
		activeSimulationAddress: exportedSettings.version === '1.5' || exportedSettings.version === '1.6' ? exportedSettings.settings.activeSimulationAddress : defaultActiveAddress,
		activeSigningAddress: undefined,
		activeSigningSafeAddress: exportedSettings.version === '1.5' || exportedSettings.version === '1.6' ? exportedSettings.settings.activeSigningSafeAddress : undefined,
	}
}

// The whole import is committed in one storage write, so a failed write leaves every previous setting in place rather than a mix of previous and imported ones, and Safe selection and per-signer preferences, which resolve through the address book, are never visible without their imported address book entries.
export async function importSettingsAndAddressBook(exportedSettings: ExportedSettings) {
	const modeChanges = getImportedModeChanges(exportedSettings)
	const signingAddressPreferences = exportedSettings.version === '1.5' || exportedSettings.version === '1.6' ? exportedSettings.settings.signingAddressPreferences : []
	const openedPageUpdate = exportedSettings.version === '1.0' || exportedSettings.version === '1.1' || exportedSettings.version === '1.2' ? {} : { openedPageV2: exportedSettings.settings.openedPage }
	const metamaskCompatibilityModeUpdate = exportedSettings.version === '1.0' || exportedSettings.version === '1.1' ? {} : { metamaskCompatibilityMode: exportedSettings.settings.metamaskCompatibilityMode }
	await withSettingsStorageLock(async () => {
		const userAddressBookEntriesV3 = await getImportedUserAddressBookEntries(exportedSettings)
		await browserStorageLocalSet({
			...openedPageUpdate,
			userAddressBookEntriesV3,
			...getSimulationModeStorageUpdate(modeChanges),
			signingAddressPreferences,
			useSignersAddressAsActiveAddress: exportedSettings.settings.useSignersAddressAsActiveAddress,
			websiteAccess: sanitizeWebsiteAccess(exportedSettings.settings.websiteAccess),
			useTabsInsteadOfPopup: exportedSettings.settings.useTabsInsteadOfPopup,
			...metamaskCompatibilityModeUpdate,
			safeAppsCompatibilityMode: exportedSettings.version === '1.6' ? exportedSettings.settings.safeAppsCompatibilityMode : false,
		})
	})
	// The import replaces the whole website access list and this only re-applies it, so it runs without comparing the disabled sites. The import is committed by now, so a failure is reported rather than rethrown to keep the caller's reconciliation running.
	try {
		await updateContentScriptInjectionStrategy()
	} catch (error: unknown) {
		await reportUnexpectedError(error, { code: 'settings_import_content_script_update_failed', displayMessage: 'Failed to update the website injection rules after importing settings.' })
	}
}
