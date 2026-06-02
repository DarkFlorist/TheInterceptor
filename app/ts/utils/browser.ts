export const noReplyExpectingBrowserRuntimeOnMessageListener = (callback: (msg: unknown) => false | Promise<false>) => {
	return browser.runtime.onMessage.addListener((message: unknown) => {
		void Promise.resolve(callback(message)).catch((error: unknown) => {
			console.error(error)
		})
		return undefined
	})
}
