import { useEffect } from 'preact/hooks'
import { type ReadonlySignal, signal } from '@preact/signals'
import { MessageToPopup } from '../../types/interceptor-messages.js'
import type { RpcEntries } from '../../types/rpc.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { noReplyExpectingBrowserRuntimeOnMessageListener } from '../../utils/browser.js'

// The page's only RPC list source (popup_requestSettingsReply deliberately carries none). Home is the exception: it gets its list inside popup_requestHomeData together with the rest of the home data, and refetches that only on popup_update_rpc_list, a real change. The list is one value per page: every mounted component shares pageRpcEntries, and the page keeps one runtime listener and sends one popup_requestRpcList while any of them is mounted, so mounting more components neither repeats the request nor multiplies the replies. The background answers with a popup_requestRpcListReply broadcast serialized with the popup_update_rpc_list broadcast of every RPC list write (background/rpcList.ts), so the latest accepted message is always the newest list. The reply goes to every open window, so a page applies only the reply carrying its own requestId.
const pageRpcEntries = signal<RpcEntries>([])
let mountedConsumerCount = 0
let stopListeningForRpcListMessages: (() => void) | undefined
let awaitedRequestId: string | undefined

const applyRpcListMessage = (message: unknown): false => {
	const parsedMessage = MessageToPopup.safeParse(message)
	if (parsedMessage.success === false) return false
	if (parsedMessage.value.method === 'popup_update_rpc_list') pageRpcEntries.value = parsedMessage.value.data
	if (parsedMessage.value.method === 'popup_requestRpcListReply' && parsedMessage.value.data.requestId === awaitedRequestId) {
		awaitedRequestId = undefined
		pageRpcEntries.value = parsedMessage.value.data.rpcEntries
	}
	return false
}

function addRpcListConsumer() {
	mountedConsumerCount += 1
	if (mountedConsumerCount > 1) return
	// Subscribe before requesting, so the reply cannot arrive before the page listens for it.
	stopListeningForRpcListMessages = noReplyExpectingBrowserRuntimeOnMessageListener(applyRpcListMessage)
	const requestId = crypto.randomUUID()
	awaitedRequestId = requestId
	sendPopupMessageToBackgroundPage({ method: 'popup_requestRpcList', data: { requestId } })
}

function removeRpcListConsumer() {
	mountedConsumerCount -= 1
	if (mountedConsumerCount > 0) return
	stopListeningForRpcListMessages?.()
	stopListeningForRpcListMessages = undefined
	awaitedRequestId = undefined
	// Without a listener the list can go stale, so the next first consumer starts empty and requests it again.
	pageRpcEntries.value = []
}

export function useRpcConnectionsList(): ReadonlySignal<RpcEntries> {
	useEffect(() => {
		addRpcListConsumer()
		return removeRpcListConsumer
	}, [])
	return pageRpcEntries
}
