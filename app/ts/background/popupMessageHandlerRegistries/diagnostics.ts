import { setLatestUnexpectedError } from '../../utils/unexpectedErrorStorage.js'
import { popupMessageHandler, type PopupMessageHandlerMap } from '../popupMessageHandlerRegistry.js'
import { reportUnexpectedErrorInWindow, requestLatestUnexpectedError } from '../popupMessageHandlers/diagnostics.js'

export const diagnosticsPopupMessageHandlers = {
	popup_clearUnexpectedError: popupMessageHandler('popup_clearUnexpectedError', async () => await setLatestUnexpectedError(undefined)),
	popup_requestLatestUnexpectedError: popupMessageHandler('popup_requestLatestUnexpectedError', async () => await requestLatestUnexpectedError()),
	popup_UnexpectedErrorOccured: popupMessageHandler('popup_UnexpectedErrorOccured', async (_context, request) => await reportUnexpectedErrorInWindow(request)),
} satisfies Partial<PopupMessageHandlerMap>
