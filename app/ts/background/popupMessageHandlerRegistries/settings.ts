import { popupMessageHandler, type PopupMessageHandlerMap } from '../popupMessageHandlerRegistry.js'
import { changeSettings, exportSettings, openNewTab, settingsOpened } from '../popupMessageHandlers.js'

import { requestRpcList } from '../rpcList.js'

export const settingsPopupMessageHandlers = {
	popup_requestSettings: popupMessageHandler('popup_requestSettings', async () => await settingsOpened()),
	popup_requestRpcList: popupMessageHandler('popup_requestRpcList', async () => await requestRpcList()),
	popup_ChangeSettings: popupMessageHandler('popup_ChangeSettings', async (context, request) => await changeSettings(context.simulationServicesOwner, context.websiteTabConnections, request, context.simulationAbortController)),
	popup_openSettings: popupMessageHandler('popup_openSettings', async () => await openNewTab('settingsView')),
	popup_get_export_settings: popupMessageHandler('popup_get_export_settings', async () => await exportSettings()),
} satisfies Partial<PopupMessageHandlerMap>
