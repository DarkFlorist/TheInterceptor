import { useEffect, useRef } from 'preact/hooks'
import { MessageToPopup } from '../../types/interceptor-messages.js'
import { noReplyExpectingBrowserRuntimeOnMessageListener } from '../../utils/browser.js'

export type PopupMessageHandler = (message: MessageToPopup) => void | Promise<void>

// Listens for background-to-popup messages while the component is mounted. The listener is registered once, always calls the handler from the latest render, and is removed on unmount.
export function usePopupMessage(handlePopupMessage: PopupMessageHandler) {
	const latestHandler = useRef(handlePopupMessage)
	latestHandler.current = handlePopupMessage
	useEffect(() => noReplyExpectingBrowserRuntimeOnMessageListener(async (message: unknown) => {
		const parsed = MessageToPopup.safeParse(message)
		if (!parsed.success) return
		await latestHandler.current(parsed.value)
	}), [])
}
