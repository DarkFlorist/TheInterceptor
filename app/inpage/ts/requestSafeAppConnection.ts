import { createSafeAppsRequest, createSafeAppsCancellation, isSafeAppsResponse, SAFE_APPS_PREPARATION_TIMEOUT_MS, SAFE_APPS_PREPARATION_CANCEL_EVENT } from './safeAppsProtocol.js'
export async function requestSafeAppConnection(origin: string): Promise<{ success: boolean, error?: string }> {
	if (window.location.origin !== origin) return { success: false, error: 'The website navigated before connecting.' }
	return await new Promise((resolve) => {
		const id = `interceptor-prepare-safe-${ crypto.getRandomValues(new Uint32Array(4)).join('-') }`
		const finish = (result: { success: boolean, error?: string }) => {
			window.removeEventListener('message', receive)
			window.removeEventListener(SAFE_APPS_PREPARATION_CANCEL_EVENT, cancel)
			window.clearTimeout(timeoutId)
			if (!result.success) window.postMessage(createSafeAppsCancellation(id), origin)
			resolve(result)
		}
		const cancel = () => finish({ success: false, error: 'Safe connection was cancelled.' })
		const receive = (event: MessageEvent<unknown>) => {
			if (event.source !== window || event.origin !== origin) return
			const data = event.data
			if (!isSafeAppsResponse(data) || data.id !== id) return
			finish(data.success ? { success: true } : { success: false, error: typeof data.error === 'string' ? data.error : 'Safe connection was rejected.' })
		}
		const timeoutId = window.setTimeout(() => finish({ success: false, error: 'Safe connection timed out. Check the selected Safe and approve website access.' }), SAFE_APPS_PREPARATION_TIMEOUT_MS)
		window.addEventListener('message', receive)
		window.addEventListener(SAFE_APPS_PREPARATION_CANCEL_EVENT, cancel)
		window.postMessage(createSafeAppsRequest(id, 'getSafeInfo'), origin)
	})
}
