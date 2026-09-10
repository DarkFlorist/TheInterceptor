import { requestSafeContractState } from '../safeContractState.js'
import { popupMessageHandler, type PopupMessageHandlerMap } from '../popupMessageHandlerRegistry.js'

export const safePopupMessageHandlers = {
	popup_requestSafeContractState: popupMessageHandler('popup_requestSafeContractState', async (context, request) => {
		const { ethereum } = context.simulationServicesOwner.getCurrent()
		return await requestSafeContractState(ethereum, request)
	}),
} satisfies Partial<PopupMessageHandlerMap>
