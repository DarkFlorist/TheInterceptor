import { popupMessageHandler, popupSnapshotMessageHandler, type PopupMessageHandlerMap } from '../popupMessageHandlerRegistry.js'
import { changeChainDialog, confirmDialog, popupReadyAndListening, refreshPopupConfirmTransactionMetadata, refreshPopupConfirmTransactionSimulation, requestAccountsFromSigner, watchAssetDialog } from '../popupMessageHandlers/confirmation.js'

export const confirmationPopupMessageHandlers = {
	popup_confirmDialog: popupMessageHandler('popup_confirmDialog', async (context, request) => await confirmDialog(context.simulationServicesOwner, context.websiteTabConnections, request)),
	popup_requestAccountsFromSigner: popupMessageHandler('popup_requestAccountsFromSigner', async (context, request) => await requestAccountsFromSigner(context.websiteTabConnections, request)),
	popup_refreshConfirmTransactionDialogSimulation: popupSnapshotMessageHandler('popup_refreshConfirmTransactionDialogSimulation', async (context) => {
		const { ethereum, tokenPriceService } = context.services
		return await refreshPopupConfirmTransactionSimulation(ethereum, tokenPriceService)
	}),
	popup_refreshConfirmTransactionMetadata: popupSnapshotMessageHandler('popup_refreshConfirmTransactionMetadata', async (context) => {
		const { ethereum, tokenPriceService } = context.services
		return await refreshPopupConfirmTransactionMetadata(ethereum, tokenPriceService, context.confirmTransactionAbortController)
	}),
	popup_changeChainDialog: popupMessageHandler('popup_changeChainDialog', async (context, request) => await changeChainDialog(context.simulationServicesOwner, context.websiteTabConnections, request)),
	popup_watchAssetDialog: popupMessageHandler('popup_watchAssetDialog', async (context, request) => await watchAssetDialog(context.websiteTabConnections, request)),
	popup_readyAndListening: popupSnapshotMessageHandler('popup_readyAndListening', async (context, request) => {
		const { ethereum } = context.services
		return await popupReadyAndListening(ethereum, context.websiteTabConnections, request.data.page)
	}),
} satisfies Partial<PopupMessageHandlerMap>
