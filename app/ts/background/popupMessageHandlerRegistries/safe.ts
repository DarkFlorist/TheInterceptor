import { safeAppPreparation } from '../prepareSafeApp.js'
import { requestSafeContractState } from '../safeContractState.js'
import { popupMessageHandler, popupSnapshotMessageHandler, type PopupMessageHandlerMap } from '../popupMessageHandlerRegistry.js'

export const safePopupMessageHandlers = {
	// Preparation injects into and reloads a tab, so popupMessageProtocol marks both methods extensionPageSenderOnly.
	popup_prepareSafeApp: popupMessageHandler('popup_prepareSafeApp', async (_context, request) => ({ method: 'popup_prepareSafeApp', data: await safeAppPreparation.start(request.data.origin) })),
	popup_cancelPrepareSafeApp: popupMessageHandler('popup_cancelPrepareSafeApp', async (_context, request) => {
		await safeAppPreparation.cancel(request.data.origin)
		return { method: 'popup_cancelPrepareSafeApp', data: { success: true } }
	}),
	popup_requestSafeContractState: popupSnapshotMessageHandler('popup_requestSafeContractState', async (context, request) => {
		const { ethereum } = context.services
		return await requestSafeContractState(ethereum, request)
	}),
} satisfies Partial<PopupMessageHandlerMap>
