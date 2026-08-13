import { requestSafeContractState } from '../safeContractState.js'
import { popupMessageHandler, type PopupMessageHandlerMap } from '../popupMessageHandlerRegistry.js'

export const safePopupMessageHandlers = {
	popup_requestSafeContractState: popupMessageHandler('popup_requestSafeContractState', async (context, request) => await requestSafeContractState(context.ethereum, request)),
} satisfies Partial<PopupMessageHandlerMap>
