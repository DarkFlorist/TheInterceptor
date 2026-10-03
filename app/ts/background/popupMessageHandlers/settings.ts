import type { ImportSettings, ImportSettingsReply, SetRpcList, Settings } from '../../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../../types/user-interface-types.js'
import { ExportedSettings } from '../../types/exportedSettingsTypes.js'
import { serialize } from '../../types/wire-types.js'
import { isJSON } from '../../utils/json.js'
import { silenceChromeUnCaughtPromise } from '../../utils/requests.js'
import type { SimulationServicesOwner } from '../../simulation/serviceLifecycle.js'
import { getPrimaryRpcForChain, getRpcList, setRpcList } from '../storageVariables.js'
import { exportSettingsAndAddressBook, getMetamaskCompatibilityMode, getSafeAppsCompatibilityMode, getSettings, getUseTabsInsteadOfPopup, importSettingsAndAddressBook } from '../settings.js'
import { sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { updateContentScriptInjectionConfigurationAndReloadTabsIfChanged } from '../contentScriptInjectionStrategy.js'

export async function settingsOpened() {
	const useTabsInsteadOfPopupPromise = silenceChromeUnCaughtPromise(getUseTabsInsteadOfPopup())
	const metamaskCompatibilityModePromise = silenceChromeUnCaughtPromise(getMetamaskCompatibilityMode())
	const safeAppsCompatibilityModePromise = silenceChromeUnCaughtPromise(getSafeAppsCompatibilityMode())
	const rpcEntriesPromise = silenceChromeUnCaughtPromise(getRpcList())
	const settingsPromise = silenceChromeUnCaughtPromise(getSettings())

	await sendPopupMessageToOpenWindows({
		method: 'popup_requestSettingsReply' as const,
		data: {
			useTabsInsteadOfPopup: await useTabsInsteadOfPopupPromise,
			metamaskCompatibilityMode: await metamaskCompatibilityModePromise,
			safeAppsCompatibilityMode: await safeAppsCompatibilityModePromise,
			rpcEntries: await rpcEntriesPromise,
			activeRpcNetwork: (await settingsPromise).activeRpcNetwork
		}
	})
}

export async function importSettingsWithStateChangeStatus(settingsData: ImportSettings, websiteTabConnections: WebsiteTabConnections): Promise<{ readonly reply: ImportSettingsReply, readonly settingsMayHaveChanged: boolean }> {
	if (!isJSON(settingsData.data.fileContents)) {
		return { reply: { method: 'popup_initiate_export_settings_reply', data: { success: false, errorMessage: 'Failed to read the file. It is not a valid JSON file.' } }, settingsMayHaveChanged: false }
	}
	const parsed = ExportedSettings.safeParse(JSON.parse(settingsData.data.fileContents))
	if (!parsed.success) {
		return { reply: { method: 'popup_initiate_export_settings_reply', data: { success: false, errorMessage: 'Failed to read the file. It is not a valid interceptor settings file' } }, settingsMayHaveChanged: false }
	}
	try {
		await updateContentScriptInjectionConfigurationAndReloadTabsIfChanged(websiteTabConnections, async () => await importSettingsAndAddressBook(parsed.value))
	} catch (error: unknown) {
		return { reply: { method: 'popup_initiate_export_settings_reply', data: { success: false, errorMessage: error instanceof Error ? error.message : 'Failed to refresh content script registration.' } }, settingsMayHaveChanged: true }
	}
	return { reply: { method: 'popup_initiate_export_settings_reply', data: { success: true } }, settingsMayHaveChanged: true }
}

export async function importSettings(settingsData: ImportSettings, websiteTabConnections: WebsiteTabConnections): Promise<ImportSettingsReply> {
	return (await importSettingsWithStateChangeStatus(settingsData, websiteTabConnections)).reply
}

export async function exportSettings() {
	const exportedSettings = await exportSettingsAndAddressBook()
	await sendPopupMessageToOpenWindows({
		method: 'popup_initiate_export_settings',
		data: { fileContents: JSON.stringify(serialize(ExportedSettings, exportedSettings), undefined, 4) }
	})
}

export async function setNewRpcList(simulationServicesOwner: SimulationServicesOwner, request: SetRpcList, settings: Settings) {
	await setRpcList(request.data)
	await sendPopupMessageToOpenWindows({ method: 'popup_update_rpc_list', data: request.data })
	const primary = await getPrimaryRpcForChain(settings.activeRpcNetwork.chainId)
	if (primary !== undefined) simulationServicesOwner.reset(primary)
}
