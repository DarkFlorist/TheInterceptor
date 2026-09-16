import { getMissingPopupReplyErrorMessage, sendPopupMessageWithReply } from '../background/backgroundUtils.js'
import type { PopupSettingsRequestWithSharedReply } from '../types/popupSettingsRequests.js'

export async function requestPopupSettingsChange(message: PopupSettingsRequestWithSharedReply) {
	const reply = await sendPopupMessageWithReply(message)
	if (reply === undefined) throw new Error(getMissingPopupReplyErrorMessage('Updating popup settings'))
	if (!reply.ok) throw new Error(reply.message)
}
