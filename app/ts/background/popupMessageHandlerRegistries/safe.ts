import { prepareSafeAppTab } from '../prepareSafeApp.js'
import { requestSafeContractState } from '../safeContractState.js'
import { popupMessageHandler, popupSnapshotMessageHandler, type PopupMessageHandlerMap } from '../popupMessageHandlerRegistry.js'

export const safePopupMessageHandlers = {
	popup_prepareSafeApp: popupMessageHandler('popup_prepareSafeApp', async (_context, request) => ({ method: 'popup_prepareSafeApp', data: await prepareSafeAppTab(request.data.origin) })),
	popup_requestSafeContractState: popupSnapshotMessageHandler('popup_requestSafeContractState', async (context, request) => {
		const { ethereum } = context.services
		return await requestSafeContractState(ethereum, request)
	}),
} satisfies Partial<PopupMessageHandlerMap>
