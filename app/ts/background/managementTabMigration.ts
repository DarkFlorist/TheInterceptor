import { type IdsOfOpenedTabs, browserStorageLocalSet } from '../utils/storageUtils.js'

// Older versions tracked one tab per standalone page; the management shell replaced the settingsView tab, so only that ID carries over.
const LEGACY_OPENED_TAB_KEYS = ['settingsView', 'addressBook', 'websiteAccess', 'simulationStack'] as const

function migrateLegacyIdsOfOpenedTabs(rawIdsOfOpenedTabs: unknown): IdsOfOpenedTabs | undefined {
	if (typeof rawIdsOfOpenedTabs !== 'object' || rawIdsOfOpenedTabs === null) return undefined
	if (!LEGACY_OPENED_TAB_KEYS.some((key) => key in rawIdsOfOpenedTabs)) return undefined
	const currentTabId = 'managementTabId' in rawIdsOfOpenedTabs && typeof rawIdsOfOpenedTabs.managementTabId === 'number' ? rawIdsOfOpenedTabs.managementTabId : undefined
	const legacySettingsTabId = 'settingsView' in rawIdsOfOpenedTabs && typeof rawIdsOfOpenedTabs.settingsView === 'number' ? rawIdsOfOpenedTabs.settingsView : undefined
	const managementTabId = currentTabId ?? legacySettingsTabId
	return managementTabId === undefined ? {} : { managementTabId }
}

export async function migrateManagementTabId() {
	const storageEntries: Partial<Record<'idsOfOpenedTabs', unknown>> = await browser.storage.local.get('idsOfOpenedTabs')
	const migratedIdsOfOpenedTabs = migrateLegacyIdsOfOpenedTabs(storageEntries.idsOfOpenedTabs)
	if (migratedIdsOfOpenedTabs === undefined) return
	await browserStorageLocalSet({ idsOfOpenedTabs: migratedIdsOfOpenedTabs })
}
