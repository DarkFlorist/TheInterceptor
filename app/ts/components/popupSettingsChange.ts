import { getMissingPopupReplyErrorMessage, sendPopupMessageWithReply } from '../background/backgroundUtils.js'
import type { ModifyRichTokenRequest } from '../types/richModeRequests.js'
import type { PopupRequestsReplyReturn } from '../types/interceptor-reply-messages.js'
import type { ModifyMakeMeRich, PopupSettingsRequestWithSharedReply } from '../types/popupSettingsRequests.js'

export type CoordinatedPopupSettingsRequest = PopupSettingsRequestWithSharedReply | ModifyRichTokenRequest
export type ChangeRichSettings = <Request extends ModifyMakeMeRich | ModifyRichTokenRequest>(message: Request) => Promise<PopupRequestsReplyReturn<Request> | undefined>

export async function requestPopupSettingsChange<Request extends CoordinatedPopupSettingsRequest>(message: Request) {
	const reply = await sendPopupMessageWithReply(message)
	if (reply === undefined) throw new Error(getMissingPopupReplyErrorMessage('Updating popup settings'))
	if ('ok' in reply && !reply.ok) throw new Error(reply.message)
	return reply
}
