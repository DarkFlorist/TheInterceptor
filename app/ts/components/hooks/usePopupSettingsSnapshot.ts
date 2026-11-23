import { type ReadonlySignal, useSignal } from '@preact/signals'
import { useEffect } from 'preact/hooks'
import type { MessageToPopup } from '../../types/interceptor-messages.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { usePopupMessage } from './usePopupMessage.js'

export type PopupSettingsSnapshot = Omit<Extract<MessageToPopup, { method: 'popup_requestSettingsReply' }>['data'], 'rpcEntries'>

// Returns the latest settings reply from the background (undefined until the first reply). Requests settings on mount and again whenever the background reports a settings change. Configured RPC entries are owned by useRpcConnectionsList.
export function usePopupSettingsSnapshot(): ReadonlySignal<PopupSettingsSnapshot | undefined> {
	const settingsSnapshot = useSignal<PopupSettingsSnapshot | undefined>(undefined)
	usePopupMessage(async (message) => {
		if (message.method === 'popup_settingsUpdated') {
			await sendPopupMessageToBackgroundPage({ method: 'popup_requestSettings' })
			return
		}
		if (message.method === 'popup_requestSettingsReply') {
			settingsSnapshot.value = {
				useTabsInsteadOfPopup: message.data.useTabsInsteadOfPopup,
				metamaskCompatibilityMode: message.data.metamaskCompatibilityMode,
				safeAppsCompatibilityMode: message.data.safeAppsCompatibilityMode,
				activeRpcNetwork: message.data.activeRpcNetwork,
			}
		}
	})
	useEffect(() => { void sendPopupMessageToBackgroundPage({ method: 'popup_requestSettings' }) }, [])
	return settingsSnapshot
}
