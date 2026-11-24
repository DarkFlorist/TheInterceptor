import { createContext, h, type ComponentChildren } from 'preact'
import { useContext, useEffect } from 'preact/hooks'
import { type ReadonlySignal, useComputed, useSignal } from '@preact/signals'
import { MessageToPopup } from '../../types/interceptor-messages.js'
import type { RpcEntries } from '../../types/rpc.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { noReplyExpectingBrowserRuntimeOnMessageListener } from '../../utils/browser.js'

const RpcConnectionsContext = createContext<ReadonlySignal<RpcEntries | undefined> | undefined>(undefined)
const emptyRpcEntries: RpcEntries = []
export const RPC_LIST_INITIAL_RETRY_DELAY_MS = 1000
const rpcListMaxRetryDelayMs = 10_000

function useRpcConnectionsSubscription(enabled: boolean) {
	const entries = useSignal<RpcEntries | undefined>(undefined)
	useEffect(() => {
		if (!enabled) return
		let awaitedRequestId: string | undefined
		let retryTimer: ReturnType<typeof setTimeout> | undefined
		let retryDelay = RPC_LIST_INITIAL_RETRY_DELAY_MS
		const clearRequest = () => {
			clearTimeout(retryTimer)
			awaitedRequestId = undefined
		}
		const unsubscribe = noReplyExpectingBrowserRuntimeOnMessageListener((message: unknown): false => {
			const parsed = MessageToPopup.safeParse(message)
			if (!parsed.success) return false
			if (parsed.value.method === 'popup_update_rpc_list') {
				clearRequest()
				entries.value = parsed.value.data
			} else if (parsed.value.method === 'popup_requestRpcListReply' && parsed.value.data.requestId === awaitedRequestId) {
				clearRequest()
				entries.value = parsed.value.data.rpcEntries
			}
			return false
		})

		// Subscribe before sending. A correlated reply or a real list update finishes loading.
		const requestRpcList = () => {
			const requestId = crypto.randomUUID()
			awaitedRequestId = requestId
			retryTimer = setTimeout(requestRpcList, retryDelay)
			retryDelay = Math.min(retryDelay * 2, rpcListMaxRetryDelayMs)
			void sendPopupMessageToBackgroundPage({ method: 'popup_requestRpcList', data: { requestId } })
		}
		requestRpcList()
		return () => {
			clearRequest()
			unsubscribe()
		}
	}, [enabled, entries])
	return entries
}

// Settings owns one subscription for its list and editors. Standalone consumers own their own subscription.
export function RpcConnectionsProvider({ children }: { children: ComponentChildren }) {
	const entries = useRpcConnectionsSubscription(true)
	return h(RpcConnectionsContext.Provider, { value: entries, children })
}

export function useRpcConnectionsState(): ReadonlySignal<RpcEntries | undefined> {
	const provided = useContext(RpcConnectionsContext)
	const local = useRpcConnectionsSubscription(provided === undefined)
	return provided ?? local
}

export function useRpcConnectionsList(): ReadonlySignal<RpcEntries> {
	const entries = useRpcConnectionsState()
	return useComputed(() => entries.value ?? emptyRpcEntries)
}
