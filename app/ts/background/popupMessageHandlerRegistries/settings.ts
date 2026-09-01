import { updateWebsiteApprovalAccesses } from '../accessManagement.js'
import { sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { popupMessageHandler, type PopupMessageHandlerMap } from '../popupMessageHandlerRegistry.js'
import { changeSettings, exportSettings, importSettings, openNewTab, popupChangeActiveRpc, setNewRpcList, settingsOpened } from '../popupMessageHandlers.js'
import { getSettings } from '../settings.js'

export const settingsPopupMessageHandlers = {
	popup_changeActiveRpc: popupMessageHandler('popup_changeActiveRpc', async (context, request) => await popupChangeActiveRpc(context.ethereum, context.tokenPriceService, context.resetSimulationServices, context.websiteTabConnections, request, context.settings)),
	popup_requestSettings: popupMessageHandler('popup_requestSettings', async () => await settingsOpened()),
	popup_ChangeSettings: popupMessageHandler('popup_ChangeSettings', async (context, request) => await changeSettings(context.ethereum, context.tokenPriceService, context.resetSimulationServices, context.websiteTabConnections, request, context.simulationAbortController)),
	popup_openSettings: popupMessageHandler('popup_openSettings', async () => await openNewTab('settingsView')),
	popup_import_settings: popupMessageHandler('popup_import_settings', async (context, request) => {
		const importSettingsReply = await importSettings(request)
		await sendPopupMessageToOpenWindows(importSettingsReply)
		if (!importSettingsReply.data.success) return
		const importedSettings = await getSettings()
		const popupRefreshGeneration = await updateWebsiteApprovalAccesses(context.ethereum, context.tokenPriceService, context.resetSimulationServices, context.websiteTabConnections, importedSettings, true)
		await sendPopupMessageToOpenWindows({ method: 'popup_settingsUpdated', data: importedSettings, popupRefreshGeneration })
	}),
	popup_get_export_settings: popupMessageHandler('popup_get_export_settings', async () => await exportSettings()),
	popup_set_rpc_list: popupMessageHandler('popup_set_rpc_list', async (context, request) => await setNewRpcList(context.resetSimulationServices, request, context.settings)),
} satisfies Partial<PopupMessageHandlerMap>
