import { useEffect } from 'preact/hooks'
import { type ReadonlySignal, useSignal } from '@preact/signals'
import { MessageToPopup } from '../../types/interceptor-messages.js'
import type { RpcEntries } from '../../types/rpc.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { noReplyExpectingBrowserRuntimeOnMessageListener } from '../../utils/browser.js'

// The page's only RPC list source (popup_requestSettingsReply deliberately carries none): popup_requestRpcList is answered with a popup_requestRpcListReply broadcast, and the background serializes those with the popup_update_rpc_list broadcast of every RPC list write (background/rpcList.ts), so the latest of either message is always the newest list. Home is the exception: it gets its list inside popup_requestHomeData together with the rest of the home data, and refetches that only on popup_update_rpc_list, a real change.
export function useRpcConnectionsList(): ReadonlySignal<RpcEntries> {
	const entries = useSignal<RpcEntries>([])

	useEffect(() => {
		const trackRpcListChanges = (message: unknown): false => {
			const parsedMessage = MessageToPopup.safeParse(message)
			if (parsedMessage.success === false) return false
			if (parsedMessage.value.method === 'popup_update_rpc_list' || parsedMessage.value.method === 'popup_requestRpcListReply') entries.value = parsedMessage.value.data
			return false
		}
		const removeRpcListListener = noReplyExpectingBrowserRuntimeOnMessageListener(trackRpcListChanges)
		sendPopupMessageToBackgroundPage({ method: 'popup_requestRpcList' })
		return removeRpcListListener
	}, [])

	return entries
}
