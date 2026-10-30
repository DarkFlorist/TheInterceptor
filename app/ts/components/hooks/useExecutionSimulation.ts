import { useComputed, useSignal } from '@preact/signals'
import { useEffect, useRef } from 'preact/hooks'
import { MessageToPopup, SimulateExecutionReply } from '../../types/interceptor-messages.js'
import { noReplyExpectingBrowserRuntimeOnMessageListener } from '../../utils/browser.js'
import { useAsyncState } from '../../utils/preact-utilities.js'

// Safe and governance outcomes contain address-book snapshots. Share their refresh policy so edits also refresh outcomes whose original request is pending.
export function useExecutionSimulation(identifier: bigint, request: () => Promise<SimulateExecutionReply | undefined>, missingReplyError: string) {
	const { value: requestState, waitFor, reset } = useAsyncState<SimulateExecutionReply | undefined>()
	const broadcastReply = useSignal<SimulateExecutionReply | undefined>(undefined)
	const addressBookRevision = useSignal(0)
	const requestedRevision = useRef(0)
	const started = useRef(false)
	const currentIdentifier = useRef(identifier)
	currentIdentifier.current = identifier
	const reply = useComputed(() => requestState.value.state === 'resolved' ? requestState.value.value : broadcastReply.value)
	const state = useComputed(() => broadcastReply.value !== undefined && requestState.value.state !== 'resolved' ? 'resolved' : requestState.value.state)
	const errorText = useComputed(() => requestState.value.state === 'rejected' && broadcastReply.value === undefined ? requestState.value.error.message : undefined)

	const simulate = () => {
		if (requestState.value.state === 'pending') return
		started.current = true
		requestedRevision.current = addressBookRevision.value
		broadcastReply.value = undefined
		waitFor(async () => {
			const result = await request()
			if (result === undefined) throw new Error(missingReplyError)
			if (identifier !== currentIdentifier.current || result.data.transactionOrMessageIdentifier !== identifier) return undefined
			return result
		})
	}

	useEffect(() => {
		started.current = false
		requestedRevision.current = addressBookRevision.value
		broadcastReply.value = undefined
		reset()
	}, [identifier])

	useEffect(() => {
		const listener = (msg: unknown): false => {
			const parsed = MessageToPopup.safeParse(msg)
			if (!parsed.success) return false
			if (parsed.value.method === 'popup_addressBookEntriesChanged') {
				addressBookRevision.value += 1
				return false
			}
			if (parsed.value.method !== 'popup_simulateExecutionReply') return false
			const { role: _role, ...message } = parsed.value
			const result = SimulateExecutionReply.parse(message)
			if (result.data.transactionOrMessageIdentifier !== currentIdentifier.current) return false
			started.current = true
			// Broadcasts have no request ID and can be delayed or come from another window. Show them as a fallback without cancelling an awaited direct reply; useAsyncState owns cancellation when the context changes.
			if (requestState.value.state !== 'pending') reset()
			broadcastReply.value = result
			return false
		}
		noReplyExpectingBrowserRuntimeOnMessageListener(listener)
		return () => browser.runtime.onMessage.removeListener(listener)
	}, [])

	useEffect(() => {
		if (!started.current || addressBookRevision.value === requestedRevision.current || requestState.value.state === 'pending') return
		simulate()
	}, [addressBookRevision.value, requestState.value.state])

	return { reply, state, errorText, simulate, reset: () => {
		started.current = false
		requestedRevision.current = addressBookRevision.value
		broadcastReply.value = undefined
		reset()
	} }
}
