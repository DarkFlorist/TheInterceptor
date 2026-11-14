import { interceptorAccessMetadataRefresh } from '../windows/interceptorAccess.js'
import { popupMessageHandler, popupOptionalSnapshotMessageHandler, type PopupMessageHandlerMap } from '../popupMessageHandlerRegistry.js'
import { allowOrPreventAddressAccessForWebsite, blockOrAllowExternalRequests, changeInterceptorAccess, confirmRequestAccess, disableInterceptor, interceptorAccessChangeAddressOrRefresh, openNewTab, removeWebsiteAccess, removeWebsiteAddressAccess, retrieveWebsiteAccess } from '../popupMessageHandlers.js'

const noRpcServices = () => false

// A change that only withdraws consent or adds a block needs neither settings nor RPC services, so it stays possible while they are unavailable. Whatever can grant or lift protection still requires settings.
export const websiteAccessPopupMessageHandlers = {
	popup_interceptorAccess: popupOptionalSnapshotMessageHandler('popup_interceptorAccess', async (context, request) => await confirmRequestAccess(context.simulationServicesOwner, context.websiteTabConnections, request, context.publishRpcConnectionStatus), noRpcServices, (request) => request.data.userReply === 'Approved'),
	popup_changeInterceptorAccess: popupMessageHandler('popup_changeInterceptorAccess', async (context, request) => await changeInterceptorAccess(context.simulationServicesOwner, context.websiteTabConnections, request)),
	popup_refreshInterceptorAccessMetadata: popupMessageHandler('popup_refreshInterceptorAccessMetadata', async () => await interceptorAccessMetadataRefresh()),
	popup_interceptorAccessChangeAddress: popupMessageHandler('popup_interceptorAccessChangeAddress', async (context, request) => await interceptorAccessChangeAddressOrRefresh(context.websiteTabConnections, request)),
	popup_interceptorAccessRefresh: popupMessageHandler('popup_interceptorAccessRefresh', async (context, request) => await interceptorAccessChangeAddressOrRefresh(context.websiteTabConnections, request)),
	popup_setDisableInterceptor: popupMessageHandler('popup_setDisableInterceptor', async (context, request) => await disableInterceptor(context.simulationServicesOwner, context.websiteTabConnections, request)),
	popup_openWebsiteAccess: popupMessageHandler('popup_openWebsiteAccess', async () => await openNewTab('websiteAccess')),
	popup_retrieveWebsiteAccess: popupMessageHandler('popup_retrieveWebsiteAccess', async (_context, request) => await retrieveWebsiteAccess(request)),
	popup_blockOrAllowExternalRequests: popupOptionalSnapshotMessageHandler('popup_blockOrAllowExternalRequests', async (context, request) => await blockOrAllowExternalRequests(context.simulationServicesOwner, context.websiteTabConnections, request), noRpcServices, (request) => !request.data.shouldBlock),
	popup_allowOrPreventAddressAccessForWebsite: popupOptionalSnapshotMessageHandler('popup_allowOrPreventAddressAccessForWebsite', async (context, request) => await allowOrPreventAddressAccessForWebsite(context.websiteTabConnections, request), noRpcServices, (request) => request.data.allowAccess),
	popup_removeWebsiteAccess: popupMessageHandler('popup_removeWebsiteAccess', async (context, request) => await removeWebsiteAccess(context.simulationServicesOwner, context.websiteTabConnections, request)),
	popup_removeWebsiteAddressAccess: popupOptionalSnapshotMessageHandler('popup_removeWebsiteAddressAccess', async (context, request) => await removeWebsiteAddressAccess(context.simulationServicesOwner, context.websiteTabConnections, request, context.settings === undefined), noRpcServices),
} satisfies Partial<PopupMessageHandlerMap>
