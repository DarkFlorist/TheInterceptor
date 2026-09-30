import { createSafeAppsRequest, isSafeAppsResponse } from './safeAppsProtocol.js'
export async function requestSafeAppConnection(origin: string): Promise<{ success: boolean, error?: string }> {
	if (window.location.origin !== origin) return { success: false, error: 'The website navigated before connecting.' }
	return await new Promise((resolve) => {
		const id = `interceptor-prepare-safe-${ crypto.getRandomValues(new Uint32Array(4)).join('-') }`
		const finish = (result: { success: boolean, error?: string }) => {
			window.removeEventListener('message', receive)
			window.clearTimeout(timeoutId)
			resolve(result)
		}
		const receive = (event: MessageEvent<unknown>) => {
			if (event.source !== window || event.origin !== origin) return
			const data = event.data
			if (!isSafeAppsResponse(data) || data.id !== id) return
			finish(data.success ? { success: true } : { success: false, error: typeof data.error === 'string' ? data.error : 'Safe connection was rejected.' })
		}
		const timeoutId = window.setTimeout(() => finish({ success: false, error: 'Safe connection timed out. Check the selected Safe and approve website access.' }), 5 * 60_000)
		window.addEventListener('message', receive)
		window.postMessage(createSafeAppsRequest(id, 'getSafeInfo'), origin)
	})
}
