import type { ExportedSettings } from '../types/exportedSettingsTypes.js'
import { refreshContentScriptInjectionAfterAccessChange } from '../utils/contentScriptsUpdating.js'
import { persistImportedSettingsAndAddressBook } from './settings.js'

// Application entry point for imports: direct and popup callers both refresh registration after persistence, while settings readers never load that orchestration.
export async function importSettingsAndAddressBook(exportedSettings: ExportedSettings) {
	const { previousWebsiteAccess, nextWebsiteAccess } = await persistImportedSettingsAndAddressBook(exportedSettings)
	await refreshContentScriptInjectionAfterAccessChange(previousWebsiteAccess, nextWebsiteAccess)
}
