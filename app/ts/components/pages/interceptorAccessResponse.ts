import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import type { PendingAccessRequest } from '../../types/accessRequest.js'
import { tryFocusingTabOrWindow } from '../ui-utils.js'

export async function respondToAccessRequest(
	accessRequest: PendingAccessRequest,
	userReply: 'Approved' | 'Rejected',
	pendingRequestCount: number,
	sendMessage = sendPopupMessageToBackgroundPage,
	focusTab = tryFocusingTabOrWindow,
) {
	await sendMessage({
		method: 'popup_interceptorAccess',
		data: {
			userReply,
			requestAccessToAddress: accessRequest.requestAccessToAddress?.address,
			originalRequestAccessToAddress: accessRequest.originalRequestAccessToAddress?.address,
			accessRequestId: accessRequest.accessRequestId,
		},
	})
	if (pendingRequestCount === 1) await focusTab({ type: 'tab', id: accessRequest.socket.tabId })
}
