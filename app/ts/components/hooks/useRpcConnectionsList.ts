import { type ReadonlySignal, useSignal } from '@preact/signals'
import { useEffect, useRef } from 'preact/hooks'
import type { RpcEntries } from '../../types/rpc.js'
import { getRpcList } from '../../background/storageVariables.js'
import { shouldApplyInitialRpcEntries } from '../../utils/rpcConnectionUi.js'
import { reportUnexpectedError } from '../../utils/errors.js'
import { usePopupMessage } from './usePopupMessage.js'

// Returns the configured RPC connections: loaded from storage on mount and replaced by every popup_update_rpc_list broadcast. A broadcast that arrives before the storage read finishes wins over the older stored list. This is the list the RPC settings edit, so it follows popup_update_rpc_list, which every RPC list change sends. usePopupSettingsSnapshot's rpcEntries is the copy in the settings reply, which pages that only show the networks read.
export function useRpcConnectionsList(): ReadonlySignal<RpcEntries> {
	const entries = useSignal<RpcEntries>([])
	const rpcListUpdateVersion = useRef(0)

	usePopupMessage((message) => {
		if (message.method !== 'popup_update_rpc_list') return
		rpcListUpdateVersion.current += 1
		entries.value = message.data
	})

	useEffect(() => {
		let disposed = false
		const initialUpdateVersion = rpcListUpdateVersion.current
		const initiallyLoadEntriesFromStorage = async () => {
			try {
				const initialEntries = await getRpcList()
				if (shouldApplyInitialRpcEntries(disposed, initialUpdateVersion, rpcListUpdateVersion.current)) entries.value = initialEntries
			} catch(error: unknown) {
				await reportUnexpectedError(error, {
					source: 'settingsView',
					code: 'rpc_list_initial_load_failed',
					displayMessage: 'Failed to load RPC connections.',
					suppressExpectedHandledErrors: false,
				})
			}
		}
		void initiallyLoadEntriesFromStorage()
		return () => { disposed = true }
	}, [])

	return entries
}
