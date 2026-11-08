import { updateWebsiteApprovalAccesses } from '../accessManagement.js'
import { sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { popupMessageHandler, type PopupMessageHandlerMap } from '../popupMessageHandlerRegistry.js'
import { changeSettings, exportSettings, importSettings, openNewTab, setNewRpcList, settingsOpened } from '../popupMessageHandlers.js'
import { getSettings } from '../settings.js'
import { getRpcNetworkChange } from '../../utils/rpcNetworkChange.js'

export const settingsPopupMessageHandlers = {
	popup_requestSettings: popupMessageHandler('popup_requestSettings', async () => await settingsOpened()),
	popup_ChangeSettings: popupMessageHandler('popup_ChangeSettings', async (context, request) => await changeSettings(context.simulationServicesOwner, context.websiteTabConnections, request, context.simulationAbortController)),
	popup_openSettings: popupMessageHandler('popup_openSettings', async () => await openNewTab('settingsView')),
	popup_import_settings: popupMessageHandler('popup_import_settings', async (context, request) => {
		const importSettingsReply = await importSettings(request)
		await sendPopupMessageToOpenWindows(importSettingsReply)
		if (!importSettingsReply.data.success) return
		const importedSettings = await getSettings()
		// Import writes the active network straight to storage, so compare it with the installed services rather than the previously stored network.
		const importedRpcNetwork = importedSettings.activeRpcNetwork
		const installedRpcEntry = context.simulationServicesOwner.getCurrent().ethereum.getRpcEntry()
		if (importedRpcNetwork.httpsRpc !== undefined && getRpcNetworkChange(installedRpcEntry, importedRpcNetwork).endpointChanged) context.simulationServicesOwner.reset(importedRpcNetwork)
		const popupRefreshGeneration = await updateWebsiteApprovalAccesses(context.simulationServicesOwner, context.websiteTabConnections, importedSettings, true)
		await sendPopupMessageToOpenWindows({ method: 'popup_settingsUpdated', data: importedSettings, popupRefreshGeneration })
	}),
	popup_get_export_settings: popupMessageHandler('popup_get_export_settings', async () => await exportSettings()),
	popup_set_rpc_list: popupMessageHandler('popup_set_rpc_list', async (context, request) => await setNewRpcList(context.simulationServicesOwner, request, context.settings)),
} satisfies Partial<PopupMessageHandlerMap>
