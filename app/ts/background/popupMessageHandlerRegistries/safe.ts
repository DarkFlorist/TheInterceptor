import { requestSafeContractState } from '../safeContractState.js'
import { popupSnapshotMessageHandler, type PopupMessageHandlerMap } from '../popupMessageHandlerRegistry.js'
import { getReadServices } from '../networkTransitionLock.js'

export const safePopupMessageHandlers = {
	popup_requestSafeContractState: popupSnapshotMessageHandler('popup_requestSafeContractState', async (context, request) => {
		const { ethereum } = getReadServices(context.network)
		return await requestSafeContractState(ethereum, request)
	}),
} satisfies Partial<PopupMessageHandlerMap>
