import { addUiPopupEventListener } from '../ui/uiPort.js'

export const noReplyExpectingBrowserRuntimeOnMessageListener = (callback: (msg: unknown) => false | Promise<false>) => {
	return addUiPopupEventListener((message: unknown) => {
		void Promise.resolve(callback(message)).catch((error: unknown) => {
			console.error(error)
		})
	})
}
