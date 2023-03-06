import { MessageToPopup, PopupMessage, WindowMessage } from '../utils/interceptor-messages.js'

export function getActiveAddress() {
	if (globalThis.interceptor.settings === undefined) return undefined
	return globalThis.interceptor.settings.simulationMode ? globalThis.interceptor.settings.activeSimulationAddress : globalThis.interceptor.settings.activeSigningAddress
}

export async function sendPopupMessageToOpenWindows(message: MessageToPopup) {
	try {
		await browser.runtime.sendMessage(MessageToPopup.serialize(message))
	} catch (error) {
		if (error instanceof Error) {
			if (error?.message?.includes('Could not establish connection.')) {
				// ignore this error, this error is thrown when a popup is not open to receive the message
				// we are ignoring this error because the popup messaging is used to update a popups UI, and if a popup is not open, we don't need to update the UI
				return
			}
			if (error) return console.error(`Popup message error: ${ error.message }`);
		}
	}
}

export async function sendPopupMessageToBackgroundPage(message: PopupMessage) {
	await browser.runtime.sendMessage(PopupMessage.serialize(message))
}

export const INTERNAL_CHANNEL_NAME = 'internalChannel'

export function sendInternalWindowMessage(message: WindowMessage) {
	new BroadcastChannel(INTERNAL_CHANNEL_NAME).postMessage(WindowMessage.serialize(message))
}

export function createInternalMessageListener(handler: (message: WindowMessage) => void) {
	return (message: MessageEvent) => {
		if (message.origin !== globalThis.location.origin) return
		handler(WindowMessage.parse(message.data))
	}
}
