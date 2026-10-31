import { everyWebsite, getSettingsForCommittedAccessChange, updateDeclarativeNetRequestBlocks, updateWebsiteApprovalAccesses } from '../accessManagement.js'
import { sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { popupMessageHandler, popupRecoveryMessageHandler, type PopupMessageHandlerMap } from '../popupMessageHandlerRegistry.js'
import { changeSettings, exportSettings, importSettings, openNewTab, restoreDefaultRpcConfiguration, retryRpcConfiguration, setNewRpcList, settingsOpened } from '../popupMessageHandlers.js'
import { publishRpcConfigurationRecovery } from '../activeSettings.js'
import { updateContentScriptInjectionStrategy } from '../../utils/contentScriptsUpdating.js'

export const settingsPopupMessageHandlers = {
	popup_requestSettings: popupRecoveryMessageHandler('popup_requestSettings', async (context) => await settingsOpened(context.simulationServicesOwner)),
	popup_ChangeSettings: popupMessageHandler('popup_ChangeSettings', async (context, request) => await changeSettings(context.simulationServicesOwner, context.websiteTabConnections, request, context.simulationAbortController)),
	popup_openSettings: popupRecoveryMessageHandler('popup_openSettings', async () => await openNewTab('settingsView')),
	popup_import_settings: popupMessageHandler('popup_import_settings', async (context, request) => {
		const importSettingsReply = await importSettings(request)
		await sendPopupMessageToOpenWindows(importSettingsReply)
		if (!importSettingsReply.data.success) return
		await updateContentScriptInjectionStrategy()
		// Read after the content-script registration await so the reconciled and published settings include any access change made meanwhile. The import replaced every website's approvals, so all connections fail closed if settings are unreadable.
		const importedSettings = await getSettingsForCommittedAccessChange(context.websiteTabConnections, everyWebsite)
		const popupRefreshGeneration = await updateWebsiteApprovalAccesses(context.simulationServicesOwner, context.websiteTabConnections, importedSettings, true)
		await sendPopupMessageToOpenWindows({ method: 'popup_settingsUpdated', data: importedSettings, popupRefreshGeneration })
	}),
	popup_get_export_settings: popupMessageHandler('popup_get_export_settings', async () => await exportSettings()),
	popup_retryRpcConfiguration: popupRecoveryMessageHandler('popup_retryRpcConfiguration', async (context) => await retryRpcConfiguration(
		context.simulationServicesOwner,
		async () => await updateDeclarativeNetRequestBlocks(context.websiteTabConnections),
	)),
	popup_restoreDefaultRpcConfiguration: popupRecoveryMessageHandler('popup_restoreDefaultRpcConfiguration', async (context) => await restoreDefaultRpcConfiguration(context.simulationServicesOwner, context.websiteTabConnections, context.settings, publishRpcConfigurationRecovery)),
	popup_set_rpc_list: popupMessageHandler('popup_set_rpc_list', async (context, request) => await setNewRpcList(context.simulationServicesOwner, context.websiteTabConnections, request, context.settings, publishRpcConfigurationRecovery)),
} satisfies Partial<PopupMessageHandlerMap>
