import { PopupMessage, type PopupMessage as PopupMessageType } from '../types/interceptor-messages.js'

function getErrorMessage(error: unknown) {
	if (error instanceof Error) return error.message
	if (typeof error === 'string') return error
	return 'Unknown popup listener error'
}

async function reportPopupMessageListenerError(error: unknown) {
	try {
		const unexpectedErrorMessage: PopupMessageType = {
			method: 'popup_UnexpectedErrorOccured',
			data: {
				timestamp: new Date(),
				message: getErrorMessage(error),
				source: 'popup',
				code: 'popup_message_listener_failed',
				debugId: globalThis.crypto.randomUUID().slice(0, 8),
			}
		}
		await browser.runtime.sendMessage(PopupMessage.serialize(unexpectedErrorMessage))
	} catch (reportingError: unknown) {
		// error-reporting: console-only fallback when the popup cannot reach the background reporter.
		console.error(reportingError)
	}
}

export const noReplyExpectingBrowserRuntimeOnMessageListener = (callback: (msg: unknown) => false | Promise<false>) => {
	return browser.runtime.onMessage.addListener((message: unknown) => {
		void Promise.resolve(callback(message)).catch((error: unknown) => {
			void reportPopupMessageListenerError(error)
		})
		return undefined
	})
}
