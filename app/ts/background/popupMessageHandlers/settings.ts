import type { ImportSettings, ImportSettingsReply, SetRpcList } from '../../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../../types/user-interface-types.js'
import { ExportedSettings } from '../../types/exportedSettingsTypes.js'
import { serialize } from '../../types/wire-types.js'
import { isJSON } from '../../utils/json.js'
import { silenceChromeUnCaughtPromise } from '../../utils/requests.js'
import type { SimulationServicesOwner } from '../../simulation/serviceLifecycle.js'
import { getRpcList, setRpcList } from '../storageVariables.js'
import { exportSettingsAndAddressBook, getMetamaskCompatibilityMode, getSafeAppsCompatibilityMode, getSettings, getUseTabsInsteadOfPopup, changeSimulationMode } from '../settings.js'
import { importSettingsAndAddressBook } from '../settingsImport.js'
import { sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { resolveRpcNetworkAfterListChange } from '../../utils/rpcNetworkChange.js'
import { runActiveSettingsTransition } from '../activeSettings.js'
import { updateAllContentScriptConfigurationAfterSettingsImport } from '../contentScriptInjectionStrategy.js'

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

export async function importSettings(settingsData: ImportSettings, websiteTabConnections: WebsiteTabConnections): Promise<ImportSettingsReply> {
	if (!isJSON(settingsData.data.fileContents)) {
		return { method: 'popup_initiate_export_settings_reply', data: { success: false, errorMessage: 'Failed to read the file. It is not a valid JSON file.' } }
	}
	const parsed = ExportedSettings.safeParse(JSON.parse(settingsData.data.fileContents))
	if (!parsed.success) {
		return { method: 'popup_initiate_export_settings_reply', data: { success: false, errorMessage: 'Failed to read the file. It is not a valid interceptor settings file' } }
	}
	try {
		await updateAllContentScriptConfigurationAfterSettingsImport(websiteTabConnections, async () => await importSettingsAndAddressBook(parsed.value))
	} catch (error: unknown) {
		return { method: 'popup_initiate_export_settings_reply', data: { success: false, errorMessage: error instanceof Error ? error.message : 'Failed to import settings.' } }
	}
	return { method: 'popup_initiate_export_settings_reply', data: { success: true } }
}

// The popup command boundary owns admission; this workflow shares the active-settings commit and post-commit effects.
export async function importSettingsAndRefresh(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, request: ImportSettings) {
	await runActiveSettingsTransition(simulationServicesOwner, websiteTabConnections, async () => {
		const reply = await importSettings(request, websiteTabConnections)
		await sendPopupMessageToOpenWindows(reply)
		return reply.data.success
	}, { refreshAlways: true })
}

export async function exportSettings() {
	const exportedSettings = await exportSettingsAndAddressBook()
	await sendPopupMessageToOpenWindows({
		method: 'popup_initiate_export_settings',
		data: { fileContents: JSON.stringify(serialize(ExportedSettings, exportedSettings), undefined, 4) }
	})
}

export async function setNewRpcList(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, request: SetRpcList) {
	await runActiveSettingsTransition(simulationServicesOwner, websiteTabConnections, async () => {
		const settings = await getSettings()
		await setRpcList(request.data)
		await sendPopupMessageToOpenWindows({ method: 'popup_update_rpc_list', data: request.data })
		const network = resolveRpcNetworkAfterListChange(settings.activeRpcNetwork, request.data)
		if (network !== undefined) await changeSimulationMode({ simulationMode: settings.simulationMode, rpcNetwork: network })
		return true
	}, { updateNetworkMetadata: true })
}
