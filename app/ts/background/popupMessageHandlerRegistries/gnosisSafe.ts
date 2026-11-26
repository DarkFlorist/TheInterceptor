import { relayNativeGnosisSafeAppsRequest } from '../nativeGnosisSafeAppsHost.js'
import { getHtmlPageUrl } from '../../utils/htmlPages.js'
import { getTabIfExists } from '../../utils/requests.js'
import { requestGnosisSafeContractState } from '../gnosisSafeContractState.js'
import { popupMessageHandler, popupSnapshotMessageHandler, type PopupMessageHandlerMap } from '../popupMessageHandlerRegistry.js'
import { openNativeGnosisSafeApp } from '../gnosisSafeAppsLaunch.js'

export const gnosisSafePopupMessageHandlers = {
	popup_nativeGnosisSafeAppsRequest: popupMessageHandler('popup_nativeGnosisSafeAppsRequest', async (context, request) => await relayNativeGnosisSafeAppsRequest(request, context.sender ?? {}, {
		extensionId: browser.runtime.id,
		hostUrls: [getHtmlPageUrl('gnosisSafeAppsHost')],
		getTab: getTabIfExists,
		sendToSource: async (tabId, message) => await browser.tabs.sendMessage(tabId, message, { frameId: 0 }),
	})),
	popup_openGnosisSafeApp: popupMessageHandler('popup_openGnosisSafeApp', async (_context, request) => await openNativeGnosisSafeApp(request.data.sourceTabId)),
	popup_requestSafeContractState: popupSnapshotMessageHandler('popup_requestSafeContractState', async (context, request) => {
		const { ethereum } = context.services
		return await requestGnosisSafeContractState(ethereum, request)
	}),
} satisfies Partial<PopupMessageHandlerMap>
