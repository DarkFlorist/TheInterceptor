import { interceptorAccessMetadataRefresh } from '../windows/interceptorAccess.js'
import { popupMessageHandler, type PopupMessageHandlerMap } from '../popupMessageHandlerRegistry.js'
import { allowOrPreventAddressAccessForWebsite, blockOrAllowExternalRequests, changeInterceptorAccess, confirmRequestAccess, disableInterceptor, interceptorAccessChangeAddressOrRefresh, openNewTab, removeWebsiteAccess, removeWebsiteAddressAccess, retrieveWebsiteAccess } from '../popupMessageHandlers.js'

export const websiteAccessPopupMessageHandlers = {
	popup_interceptorAccess: popupMessageHandler('popup_interceptorAccess', async (context, request) => await confirmRequestAccess(context.ethereum, context.tokenPriceService, context.resetSimulationServices, context.websiteTabConnections, request, context.publishRpcConnectionStatus)),
	popup_changeInterceptorAccess: popupMessageHandler('popup_changeInterceptorAccess', async (context, request) => await changeInterceptorAccess(context.ethereum, context.tokenPriceService, context.resetSimulationServices, context.websiteTabConnections, request)),
	popup_refreshInterceptorAccessMetadata: popupMessageHandler('popup_refreshInterceptorAccessMetadata', async () => await interceptorAccessMetadataRefresh()),
	popup_interceptorAccessChangeAddress: popupMessageHandler('popup_interceptorAccessChangeAddress', async (context, request) => await interceptorAccessChangeAddressOrRefresh(context.websiteTabConnections, request)),
	popup_interceptorAccessRefresh: popupMessageHandler('popup_interceptorAccessRefresh', async (context, request) => await interceptorAccessChangeAddressOrRefresh(context.websiteTabConnections, request)),
	popup_setDisableInterceptor: popupMessageHandler('popup_setDisableInterceptor', async (context, request) => await disableInterceptor(context.ethereum, context.tokenPriceService, context.resetSimulationServices, context.websiteTabConnections, request)),
	popup_openWebsiteAccess: popupMessageHandler('popup_openWebsiteAccess', async () => await openNewTab('websiteAccess')),
	popup_retrieveWebsiteAccess: popupMessageHandler('popup_retrieveWebsiteAccess', async (_context, request) => await retrieveWebsiteAccess(request)),
	popup_blockOrAllowExternalRequests: popupMessageHandler('popup_blockOrAllowExternalRequests', async (context, request) => await blockOrAllowExternalRequests(context.ethereum, context.tokenPriceService, context.resetSimulationServices, context.websiteTabConnections, request)),
	popup_allowOrPreventAddressAccessForWebsite: popupMessageHandler('popup_allowOrPreventAddressAccessForWebsite', async (context, request) => await allowOrPreventAddressAccessForWebsite(context.websiteTabConnections, request)),
	popup_removeWebsiteAccess: popupMessageHandler('popup_removeWebsiteAccess', async (context, request) => await removeWebsiteAccess(context.ethereum, context.tokenPriceService, context.resetSimulationServices, context.websiteTabConnections, request)),
	popup_removeWebsiteAddressAccess: popupMessageHandler('popup_removeWebsiteAddressAccess', async (context, request) => await removeWebsiteAddressAccess(context.ethereum, context.tokenPriceService, context.resetSimulationServices, context.websiteTabConnections, request)),
} satisfies Partial<PopupMessageHandlerMap>
