export const noReplyExpectingBrowserRuntimeOnMessageListener = (callback: (msg: unknown) => void) => {
	return browser.runtime.onMessage.addListener(callback)
}
