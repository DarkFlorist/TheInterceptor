import { useEffect } from 'preact/hooks'
import { type ReadonlySignal, useSignal } from '@preact/signals'
import { MessageToPopup } from '../../types/interceptor-messages.js'
import type { RpcEntries } from '../../types/rpc.js'
import { getRpcList } from '../../background/storageVariables.js'
import { noReplyExpectingBrowserRuntimeOnMessageListener } from '../../utils/browser.js'
import { shouldApplyInitialRpcEntries } from '../../utils/rpcConnectionUi.js'
import { reportUnexpectedError } from '../../utils/errors.js'

// The page's only RPC list source (popup_requestSettingsReply deliberately no longer carries one), seeded from the same storage read SettingsView used before this hook was shared, and the async initial storage read is dropped if a `popup_update_rpc_list` broadcast arrived while it was pending, so a stale read cannot overwrite a newer list.
export function useRpcConnectionsList(): ReadonlySignal<RpcEntries> {
	const entries = useSignal<RpcEntries>([])

	useEffect(() => {
		let disposed = false
		let updateVersion = 0
		const trackRpcListChanges = (message: unknown): false => {
			const parsedMessage = MessageToPopup.safeParse(message)
			if (parsedMessage.success === false) return false
			if (parsedMessage.value.method === 'popup_update_rpc_list') {
				updateVersion += 1
				entries.value = parsedMessage.value.data
			}
			return false
		}
		const removeRpcListListener = noReplyExpectingBrowserRuntimeOnMessageListener(trackRpcListChanges)
		const initialUpdateVersion = updateVersion
		const initiallyLoadEntriesFromStorage = async () => {
			try {
				const initialEntries = await getRpcList()
				if (shouldApplyInitialRpcEntries(disposed, initialUpdateVersion, updateVersion)) entries.value = initialEntries
			} catch(error: unknown) {
				await reportUnexpectedError(error, {
					source: 'rpcConnectionsList',
					code: 'rpc_list_initial_load_failed',
					displayMessage: 'Failed to load RPC connections.',
					suppressExpectedHandledErrors: false,
				})
			}
		}
		void initiallyLoadEntriesFromStorage()
		return () => {
			disposed = true
			removeRpcListListener()
		}
	}, [])

	return entries
}
