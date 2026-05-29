export function isIgnorablePortLifecycleError(error: Error) {
	return error.message.includes('the message channel is closed')
		|| error.message.includes('The message port closed before a response was received')
		|| error.message.includes('Could not establish connection. Receiving end does not exist')
		|| error.message.includes('Attempting to use a disconnected port object')
		|| error.message.includes('Extension context invalidated')
}

export function tryRegisterContentScriptPortListeners(
	port: browser.runtime.Port,
	onDisconnect: () => void,
	onMessage: (payload: unknown) => void,
	checkRuntimeLastError: () => void,
) {
	try {
		port.onDisconnect.addListener(() => {
			onDisconnect()
			try {
				checkRuntimeLastError()
			} catch (error) {
				if (error instanceof Error && isIgnorablePortLifecycleError(error)) return
				throw error
			}
		})

		port.onMessage.addListener(onMessage)
		return true
	} catch (error) {
		if (error instanceof Error && isIgnorablePortLifecycleError(error)) return false
		throw error
	}
}
