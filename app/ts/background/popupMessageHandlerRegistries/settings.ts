import { updateWebsiteApprovalAccesses } from '../accessManagement.js'
import { sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { popupMessageHandler, type PopupMessageHandlerMap } from '../popupMessageHandlerRegistry.js'
import { changeSettings, exportSettings, importSettings, openNewTab, restoreDefaultRpcConfiguration, retryRpcConfiguration, setNewRpcList, settingsOpened } from '../popupMessageHandlers.js'
import { getSettings } from '../settings.js'
import { publishRpcConfigurationRecovery } from '../activeSettings.js'

export const settingsPopupMessageHandlers = {
	popup_requestSettings: popupMessageHandler('popup_requestSettings', async (context) => await settingsOpened(context.simulationServicesOwner)),
	popup_ChangeSettings: popupMessageHandler('popup_ChangeSettings', async (context, request) => await changeSettings(context.simulationServicesOwner, context.websiteTabConnections, request, context.simulationAbortController)),
	popup_openSettings: popupMessageHandler('popup_openSettings', async () => await openNewTab('settingsView')),
	popup_import_settings: popupMessageHandler('popup_import_settings', async (context, request) => {
		const importSettingsReply = await importSettings(request)
		await sendPopupMessageToOpenWindows(importSettingsReply)
		if (!importSettingsReply.data.success) return
		const importedSettings = await getSettings()
		const popupRefreshGeneration = await updateWebsiteApprovalAccesses(context.simulationServicesOwner, context.websiteTabConnections, importedSettings, true)
		await sendPopupMessageToOpenWindows({ method: 'popup_settingsUpdated', data: importedSettings, popupRefreshGeneration })
	}),
	popup_get_export_settings: popupMessageHandler('popup_get_export_settings', async () => await exportSettings()),
	popup_retryRpcConfiguration: popupMessageHandler('popup_retryRpcConfiguration', async (context) => await retryRpcConfiguration(context.simulationServicesOwner)),
	popup_restoreDefaultRpcConfiguration: popupMessageHandler('popup_restoreDefaultRpcConfiguration', async (context) => await restoreDefaultRpcConfiguration(context.simulationServicesOwner, context.websiteTabConnections, context.settings, publishRpcConfigurationRecovery)),
	popup_set_rpc_list: popupMessageHandler('popup_set_rpc_list', async (context, request) => await setNewRpcList(context.simulationServicesOwner, context.websiteTabConnections, request, context.settings, publishRpcConfigurationRecovery)),
} satisfies Partial<PopupMessageHandlerMap>
