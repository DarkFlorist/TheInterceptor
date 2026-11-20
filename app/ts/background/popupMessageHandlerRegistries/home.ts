import { bumpPopupRefreshGeneration } from '../popupRefreshGeneration.js'
import { popupMessageHandler, popupSnapshotMessageHandler, type PopupMessageHandlerMap } from '../popupMessageHandlerRegistry.js'
import { refreshHomeData, requestActiveAddresses, requestHomePageBootstrap, requestMakeMeRichList, requestNewHomeData, requestSimulationMode } from '../popupMessageHandlers/home.js'

export const homePopupMessageHandlers = {
	popup_requestNewHomeData: popupSnapshotMessageHandler('popup_requestNewHomeData', async (context, request) => {
		const { ethereum } = context.services
		return await requestNewHomeData(ethereum, context.websiteTabConnections, request.data.refreshSignerAccounts, request.data.includeWebsiteAccessAddressMetadata, context.simulationAbortController, bumpPopupRefreshGeneration())
	}),
	popup_requestHomePageBootstrap: popupMessageHandler('popup_requestHomePageBootstrap', async (context) => await requestHomePageBootstrap(context.websiteTabConnections, bumpPopupRefreshGeneration())),
	popup_refreshHomeData: popupSnapshotMessageHandler('popup_refreshHomeData', async (context) => {
		const { ethereum, tokenPriceService } = context.services
		return await refreshHomeData(ethereum, tokenPriceService, context.websiteTabConnections, true, bumpPopupRefreshGeneration(), context.publishRpcConnectionStatus)
	}),
	popup_requestMakeMeRichData: popupSnapshotMessageHandler('popup_requestMakeMeRichData', async (context) => {
		const { ethereum } = context.services
		return await requestMakeMeRichList(ethereum, context.simulationAbortController)
	}),
	popup_requestActiveAddresses: popupMessageHandler('popup_requestActiveAddresses', async () => await requestActiveAddresses()),
	popup_requestSimulationMode: popupMessageHandler('popup_requestSimulationMode', async () => await requestSimulationMode()),
} satisfies Partial<PopupMessageHandlerMap>
