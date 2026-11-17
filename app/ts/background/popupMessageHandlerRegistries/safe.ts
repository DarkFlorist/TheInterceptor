import { popupLookupMessageHandler, type PopupMessageHandlerMap } from '../popupMessageHandlerRegistry.js'
import { requestSafeContractState } from '../safeContractState.js'

export const safePopupMessageHandlers = {
	popup_requestSafeContractState: popupLookupMessageHandler('popup_requestSafeContractState', async (context, request) => {
		const { ethereum } = context.services
		return await requestSafeContractState(ethereum, request)
	}),
} satisfies Partial<PopupMessageHandlerMap>
