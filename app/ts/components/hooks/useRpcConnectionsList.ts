import { createContext, h, type ComponentChildren } from 'preact'
import { useContext, useEffect } from 'preact/hooks'
import { type ReadonlySignal, useComputed, useSignal } from '@preact/signals'
import { MessageToPopup } from '../../types/interceptor-messages.js'
import type { RpcEntries } from '../../types/rpc.js'
import { sendPopupMessageWithReply } from '../../background/backgroundUtils.js'
import { createBackoffRetryScheduler } from '../../utils/retryScheduler.js'
import { noReplyExpectingBrowserRuntimeOnMessageListener } from '../../utils/browser.js'

const RpcConnectionsContext = createContext<ReadonlySignal<RpcEntries | undefined> | undefined>(undefined)
const emptyRpcEntries: RpcEntries = []
export const RPC_LIST_INITIAL_RETRY_DELAY_MS = 1000

function useRpcConnectionsSubscription(enabled: boolean) {
	const entries = useSignal<RpcEntries | undefined>(undefined)
	useEffect(() => {
		if (!enabled) return
		const retry = createBackoffRetryScheduler(RPC_LIST_INITIAL_RETRY_DELAY_MS)
		let loading = true
		let attempt = 0
		const finishLoading = () => {
			loading = false
			retry.reset()
		}
		const unsubscribe = noReplyExpectingBrowserRuntimeOnMessageListener((message: unknown): false => {
			const parsed = MessageToPopup.safeParse(message)
			if (parsed.success && parsed.value.method === 'popup_update_rpc_list') {
				// Live updates own the list from here. A delayed bootstrap reply could be older.
				finishLoading()
				entries.value = parsed.value.data
			}
			return false
		})

		const requestRpcList = () => {
			const currentAttempt = ++attempt
			// Retry even if the runtime request never settles.
			retry.schedule(requestRpcList)
			void sendPopupMessageWithReply({ method: 'popup_requestRpcList' }).then((reply) => {
				if (!loading || currentAttempt !== attempt || reply === undefined) return
				finishLoading()
				entries.value = reply.rpcEntries
			})
		}
		requestRpcList()
		return () => {
			finishLoading()
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
