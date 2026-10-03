import { PopupMessage } from '../types/interceptor-messages.js'
import { getErrorMessage } from './caughtErrors.js'
import { stringifyDiagnosticDetails } from './diagnosticSerialization.js'
import { createErrorDebugId, createUnexpectedErrorPopupMessage } from './unexpectedErrorPopupMessage.js'

async function reportPopupMessageListenerError(error: unknown) {
	try {
		const unexpectedErrorMessage = createUnexpectedErrorPopupMessage({
			timestamp: new Date(),
			message: getErrorMessage(error) ?? 'Unknown popup listener error',
			source: 'popup',
			code: 'popup_message_listener_failed',
			debugId: createErrorDebugId(),
		})
		await browser.runtime.sendMessage(PopupMessage.serialize({
			...unexpectedErrorMessage,
			data: { ...unexpectedErrorMessage.data, rawError: stringifyDiagnosticDetails(error) },
		}))
	} catch (reportingError: unknown) {
		// error-reporting: console-only fallback when the popup cannot reach the background reporter.
		console.error('Popup listener error:', error)
		console.error('Failed to forward popup listener error:', reportingError)
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
