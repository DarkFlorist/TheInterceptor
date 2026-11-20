import { useEffect, useRef } from 'preact/hooks'
import { noReplyExpectingBrowserRuntimeOnMessageListener } from '../../utils/browser.js'

type RuntimeMessageListener = (message: unknown) => false | Promise<false>

// The mount-scoped way for components to receive background messages: the listener is added on mount and always removed on unmount, so a hidden management panel cannot keep reacting. Components call this instead of registering browser.runtime.onMessage listeners themselves; test/tests/managementPanelListeners.test.ts enforces that for management panels.
export function useRuntimeMessageListener(onMessage: RuntimeMessageListener) {
	const latestOnMessage = useRef(onMessage)
	latestOnMessage.current = onMessage
	useEffect(() => noReplyExpectingBrowserRuntimeOnMessageListener((message) => latestOnMessage.current(message)), [])
}
