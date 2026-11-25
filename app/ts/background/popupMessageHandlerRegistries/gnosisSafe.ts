import { requestGnosisSafeContractState } from '../gnosisSafeContractState.js'
import { popupSnapshotMessageHandler, type PopupMessageHandlerMap } from '../popupMessageHandlerRegistry.js'

export const gnosisSafePopupMessageHandlers = {
	popup_requestSafeContractState: popupSnapshotMessageHandler('popup_requestSafeContractState', async (context, request) => {
		const { ethereum } = context.services
		return await requestGnosisSafeContractState(ethereum, request)
	}),
} satisfies Partial<PopupMessageHandlerMap>
