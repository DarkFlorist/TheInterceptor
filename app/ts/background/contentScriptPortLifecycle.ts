import { isIgnorablePortLifecycleError } from '../utils/extensionMessaging.js'

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

export async function initializeContentScriptConnectionAfterBackgroundStartup<T>(waitForStartup: () => Promise<T>, initializeConnection: () => Promise<void>) {
	const startupResult = await waitForStartup()
	await initializeConnection()
	return startupResult
}
