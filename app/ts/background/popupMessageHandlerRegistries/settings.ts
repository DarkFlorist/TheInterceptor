import { popupMessageHandler, type PopupMessageHandlerMap } from '../popupMessageHandlerRegistry.js'
import { setSafeAppsHostOrigins } from '../settings.js'
import { changeSettings, exportSettings, openNewTab, settingsOpened } from '../popupMessageHandlers.js'

export const settingsPopupMessageHandlers = {
	popup_requestSettings: popupMessageHandler('popup_requestSettings', async () => await settingsOpened()),
	popup_ChangeSettings: popupMessageHandler('popup_ChangeSettings', async (context, request) => await changeSettings(context.simulationServicesOwner, context.websiteTabConnections, request, context.simulationAbortController)),
	// The Safe Apps hosting allowlist registers a privileged page-world script, so popupMessageProtocol accepts this only from extension pages.
	popup_setSafeAppsHostOrigins: popupMessageHandler('popup_setSafeAppsHostOrigins', async (_context, request) => await setSafeAppsHostOrigins(request.data.origins)),
	popup_openSettings: popupMessageHandler('popup_openSettings', async () => await openNewTab('settingsView')),
	popup_get_export_settings: popupMessageHandler('popup_get_export_settings', async () => await exportSettings()),
} satisfies Partial<PopupMessageHandlerMap>
