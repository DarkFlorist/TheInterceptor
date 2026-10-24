import { type ReadonlySignal, useSignal } from '@preact/signals'
import { useEffect } from 'preact/hooks'
import type { MessageToPopup } from '../../types/interceptor-messages.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { usePopupMessage } from './usePopupMessage.js'

export type PopupSettingsSnapshot = Extract<MessageToPopup, { method: 'popup_requestSettingsReply' }>['data']

// Returns the latest settings reply from the background (undefined until the first reply). Requests settings on mount and again whenever the background reports a settings change.
export function usePopupSettingsSnapshot(): ReadonlySignal<PopupSettingsSnapshot | undefined> {
	const settingsSnapshot = useSignal<PopupSettingsSnapshot | undefined>(undefined)
	usePopupMessage(async (message) => {
		if (message.method === 'popup_settingsUpdated') {
			await sendPopupMessageToBackgroundPage({ method: 'popup_requestSettings' })
			return
		}
		if (message.method === 'popup_requestSettingsReply') settingsSnapshot.value = message.data
	})
	useEffect(() => { void sendPopupMessageToBackgroundPage({ method: 'popup_requestSettings' }) }, [])
	return settingsSnapshot
}
