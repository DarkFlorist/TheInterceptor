export function getActiveAddress() {
	if (window.interceptor.settings === undefined) return undefined
	return window.interceptor.settings.simulationMode ? window.interceptor.settings.activeSimulationAddress : window.interceptor.settings.activeSigningAddress
}

export async function sendPopupMessageToOpenWindows(message: string, data: unknown[] | undefined = undefined) {
	try {
		await browser.runtime.sendMessage( { message: message, data: data } )
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
