import { setSafeSigningAccounts } from '../safeSigningAccountHandler.js'
import { requestSafeContractState } from '../safeContractState.js'
import { popupSnapshotMessageHandler, type PopupMessageHandlerMap } from '../popupMessageHandlerRegistry.js'

export const safePopupMessageHandlers = {
	signing_setSafeAccounts: popupSnapshotMessageHandler('signing_setSafeAccounts', async (context, request) => await setSafeSigningAccounts(request, context.services.ethereum)),
	popup_requestSafeContractState: popupSnapshotMessageHandler('popup_requestSafeContractState', async (context, request) => {
		const { ethereum } = context.services
		return await requestSafeContractState(ethereum, request)
	}),
} satisfies Partial<PopupMessageHandlerMap>
