export const noReplyExpectingBrowserRuntimeOnMessageListener = (callback: (msg: unknown) => false) => {
	return browser.runtime.onMessage.addListener(callback)
}
