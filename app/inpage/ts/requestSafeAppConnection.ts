import { createSafeAppsRequest, createSafeAppsCancellation, isSafeAppsResponse, SAFE_APPS_PREPARATION_TIMEOUT_MS, SAFE_APPS_PREPARATION_CANCEL_EVENT, SAFE_APPS_PREPARATION_CANCEL_MARKER } from './safeAppsProtocol.js'
import { createSafeAppsTransport } from './safeAppsTransport.js'

export async function requestSafeAppConnection(origin: string): Promise<{ success: boolean, error?: string }> {
	if (window.location.origin !== origin) return { success: false, error: 'The website navigated before connecting.' }
	// A cancellation injected before this script starts must not leave an orphaned access request.
	if (Reflect.get(window, SAFE_APPS_PREPARATION_CANCEL_MARKER) === true) return { success: false, error: 'Safe connection was cancelled.' }
	const transport = createSafeAppsTransport(window)
	return await new Promise((resolve) => {
		const id = `interceptor-prepare-safe-${ crypto.getRandomValues(new Uint32Array(4)).join('-') }`
		const finish = (result: { success: boolean, error?: string }) => {
			unsubscribe()
			window.removeEventListener(SAFE_APPS_PREPARATION_CANCEL_EVENT, cancel)
			window.clearTimeout(timeoutId)
			if (!result.success) transport.post(createSafeAppsCancellation(id), origin)
			resolve(result)
		}
		const cancel = () => finish({ success: false, error: 'Safe connection was cancelled.' })
		const unsubscribe = transport.subscribe((event) => {
			const data = event.data
			if (!isSafeAppsResponse(data) || data.id !== id) return
			finish(data.success ? { success: true } : { success: false, error: typeof data.error === 'string' ? data.error : 'Safe connection was rejected.' })
		})
		const timeoutId = window.setTimeout(() => finish({ success: false, error: 'Safe connection timed out. Check the selected Safe and approve website access.' }), SAFE_APPS_PREPARATION_TIMEOUT_MS)
		window.addEventListener(SAFE_APPS_PREPARATION_CANCEL_EVENT, cancel)
		transport.post(createSafeAppsRequest(id, 'getSafeInfo'), origin)
	})
}
