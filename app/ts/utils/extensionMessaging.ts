import { MessageToPopup, type MessageToPopupPayload } from '../types/interceptor-messages.js'
import { serialize } from '../types/wire-types.js'
import { checkAndThrowRuntimeLastError } from './requests.js'

// Extension messaging primitives that never report errors themselves, so the unexpected-error reporter can use them without depending on background code.

export function isIgnorablePortLifecycleError(error: Error) {
	return error.message.includes('the message channel is closed')
		|| error.message.includes('The message port closed before a response was received')
		|| error.message.includes('Could not establish connection. Receiving end does not exist')
		|| error.message.includes('Attempting to use a disconnected port object')
		|| error.message.includes('Extension context invalidated')
}

export function isIgnorableExtensionMessagingError(error: Error) {
	return isIgnorablePortLifecycleError(error)
		|| error.message?.includes('A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received')
}

export async function sendPopupMessageToOpenWindowsWithoutUnexpectedErrorReport(message: MessageToPopupPayload, role: MessageToPopup['role'] = 'all') {
	try {
		await browser.runtime.sendMessage(serialize(MessageToPopup, { role, ...message }))
		checkAndThrowRuntimeLastError()
	} catch (error) {
		if (error instanceof Error) {
			if (error?.message?.includes('Could not establish connection.')) {
				// ignore this error, this error is thrown when a popup is not open to receive the message we are ignoring this error because the popup messaging is used to update a popups UI, and if a popup is not open, we don't need to update the UI
				return
			}
			if (isIgnorableExtensionMessagingError(error)) return
		}
		throw error
	}
}
