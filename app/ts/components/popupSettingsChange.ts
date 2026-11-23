import { getMissingPopupReplyErrorMessage, sendPopupMessageWithReply } from '../background/backgroundUtils.js'
import type { RichSettingsChangeResult, RichSettingsRequest } from '../types/richModeRequests.js'
import type { ModifyMakeMeRich, PopupSettingsRequestWithSharedReply } from '../types/popupSettingsRequests.js'

// Settings commands whose rejected replies requestPopupSettingsChange throws; the rich-funding commands go through requestRichSettingsChange instead.
export type CoordinatedPopupSettingsRequest = Exclude<PopupSettingsRequestWithSharedReply, ModifyMakeMeRich>

export async function requestRichSettingsChange(message: RichSettingsRequest): Promise<RichSettingsChangeResult> {
	if (message.method === 'popup_modifyRichToken') {
		const reply = await sendPopupMessageWithReply(message)
		if (reply === undefined) return { ok: false, error: getMissingPopupReplyErrorMessage('Updating token funding') }
		return reply.result.success ? { ok: true, richToken: reply.result.richToken, simulationRefresh: reply.result.simulationRefresh } : { ok: false, error: reply.result.error }
	}
	const reply = await sendPopupMessageWithReply(message)
	if (reply === undefined) return { ok: false, error: getMissingPopupReplyErrorMessage('Updating rich-mode settings') }
	return reply.ok ? { ok: true, richToken: undefined, simulationRefresh: undefined } : { ok: false, error: reply.message }
}

export async function requestPopupSettingsChange<Request extends CoordinatedPopupSettingsRequest>(message: Request) {
	const reply = await sendPopupMessageWithReply(message)
	if (reply === undefined) throw new Error(getMissingPopupReplyErrorMessage('Updating popup settings'))
	if ('ok' in reply && !reply.ok) throw new Error(reply.message)
	return reply
}
