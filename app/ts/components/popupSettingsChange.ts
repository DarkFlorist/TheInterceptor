import { getMissingPopupReplyErrorMessage, sendPopupMessageWithReply } from '../background/backgroundUtils.js'
import type { ModifyRichTokenRequest } from '../types/richModeRequests.js'
import type { RichTokenSimulationRefresh } from '../types/interceptor-reply-messages.js'
import type { RichToken } from '../types/richMode.js'
import type { ModifyMakeMeRich, PopupSettingsRequestWithSharedReply } from '../types/popupSettingsRequests.js'

// Settings commands whose rejected replies requestPopupSettingsChange throws; the rich-funding commands go through requestRichSettingsChange instead.
export type CoordinatedPopupSettingsRequest = Exclude<PopupSettingsRequestWithSharedReply, ModifyMakeMeRich>
export type RichSettingsRequest = ModifyMakeMeRich | ModifyRichTokenRequest

// The one result of both rich-funding commands, which reply the same way: expected failures (a rejected change, a change saved while the simulation is unavailable, a missing reply, a refused admission) come back as ok: false and never throw. simulationRefresh says whether a token change's simulation is current or superseded; the rich setting reply carries no refresh detail, so it is undefined there.
export type RichSettingsChangeResult =
	| { readonly ok: true, readonly richToken: RichToken | undefined, readonly simulationRefresh: RichTokenSimulationRefresh | undefined }
	| { readonly ok: false, readonly error: string }
export type ChangeRichSettings = (message: RichSettingsRequest) => Promise<RichSettingsChangeResult>

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
