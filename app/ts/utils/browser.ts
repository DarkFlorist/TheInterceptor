import { PopupMessage } from '../types/interceptor-messages.js'
import { getErrorMessage } from './caughtErrors.js'
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
		await browser.runtime.sendMessage(PopupMessage.serialize(unexpectedErrorMessage))
	} catch (reportingError: unknown) {
		// error-reporting: console-only fallback when the popup cannot reach the background reporter.
		console.error(reportingError)
	}
}

async function handleMessageAndReportFailures(handleMessage: (message: unknown) => void | Promise<void>, message: unknown) {
	try {
		await handleMessage(message)
	} catch (error: unknown) {
		await reportPopupMessageListenerError(error)
	}
}

// Registers a runtime message listener that never replies and returns the function that removes exactly that listener.
export const addNoReplyExpectingBrowserRuntimeOnMessageListener = (handleMessage: (message: unknown) => void | Promise<void>) => {
	const listener = (message: unknown) => {
		void handleMessageAndReportFailures(handleMessage, message)
		return undefined
	}
	browser.runtime.onMessage.addListener(listener)
	return () => browser.runtime.onMessage.removeListener(listener)
}
