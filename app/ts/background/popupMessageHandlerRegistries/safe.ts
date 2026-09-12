import { requestSafeContractState } from '../safeContractState.js'
import { popupSnapshotMessageHandler, type PopupMessageHandlerMap } from '../popupMessageHandlerRegistry.js'

export const safePopupMessageHandlers = {
	popup_requestSafeContractState: popupSnapshotMessageHandler('popup_requestSafeContractState', async (context, request) => {
		const { ethereum } = context.services
		return await requestSafeContractState(ethereum, request)
	}),
} satisfies Partial<PopupMessageHandlerMap>
