import { requestGnosisSafeContractState } from '../gnosisSafeContractState.js'
import { popupMessageHandler, popupSnapshotMessageHandler, type PopupMessageHandlerMap } from '../popupMessageHandlerRegistry.js'
import { openNativeGnosisSafeApp } from '../gnosisSafeAppsLaunch.js'

export const gnosisSafePopupMessageHandlers = {
	popup_openGnosisSafeApp: popupMessageHandler('popup_openGnosisSafeApp', async (_context, request) => await openNativeGnosisSafeApp(request.data.sourceTabId)),
	popup_requestSafeContractState: popupSnapshotMessageHandler('popup_requestSafeContractState', async (context, request) => {
		const { ethereum } = context.services
		return await requestGnosisSafeContractState(ethereum, request)
	}),
} satisfies Partial<PopupMessageHandlerMap>
