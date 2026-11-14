import type { ImportSettings, ImportSettingsReply, SetRpcList } from '../../types/interceptor-messages.js'
import { ExportedSettings } from '../../types/exportedSettingsTypes.js'
import { serialize } from '../../types/wire-types.js'
import { isJSON } from '../../utils/json.js'
import { silenceChromeUnCaughtPromise } from '../../utils/requests.js'
import type { SimulationServicesOwner } from '../../simulation/serviceLifecycle.js'
import { getRpcList, setRpcList } from '../storageVariables.js'
import { exportSettingsAndAddressBook, getMetamaskCompatibilityMode, getSafeAppsCompatibilityMode, getSettings, getUseTabsInsteadOfPopup } from '../settings.js'
import { sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { importSettingsTransition, selectUpdatedPrimaryRpcTransition } from '../networkTransition.js'
import type { WebsiteTabConnections } from '../../types/user-interface-types.js'

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

export async function importSettings(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, settingsData: ImportSettings): Promise<ImportSettingsReply> {
	if (!isJSON(settingsData.data.fileContents)) {
		return { method: 'popup_initiate_export_settings_reply', data: { success: false, errorMessage: 'Failed to read the file. It is not a valid JSON file.' } }
	}
	const parsed = ExportedSettings.safeParse(JSON.parse(settingsData.data.fileContents))
	if (!parsed.success) {
		return { method: 'popup_initiate_export_settings_reply', data: { success: false, errorMessage: 'Failed to read the file. It is not a valid interceptor settings file' } }
	}
	await importSettingsTransition(simulationServicesOwner, websiteTabConnections, parsed.value)
	return { method: 'popup_initiate_export_settings_reply', data: { success: true } }
}

export async function exportSettings() {
	const exportedSettings = await exportSettingsAndAddressBook()
	await sendPopupMessageToOpenWindows({
		method: 'popup_initiate_export_settings',
		data: { fileContents: JSON.stringify(serialize(ExportedSettings, exportedSettings), undefined, 4) }
	})
}

export async function setNewRpcList(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, request: SetRpcList) {
	await setRpcList(request.data)
	await sendPopupMessageToOpenWindows({ method: 'popup_update_rpc_list', data: request.data })
	// The transition reads the active chain itself; a network switch may have finished since this popup message arrived.
	await selectUpdatedPrimaryRpcTransition(simulationServicesOwner, websiteTabConnections)
}
