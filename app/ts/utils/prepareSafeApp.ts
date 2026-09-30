import { getSafeAppsCompatibilityMode, getSafeAppsHostOrigins, getSettings } from '../background/settings.js'
import { hasAccess } from '../background/websiteAccessPolicy.js'
import { parseSafeAppsHostOrigin } from './safeAppsHosting.js'

// Serialized by scripting.executeScript: keep this function independent of module variables.
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
			if (typeof data !== 'object' || data === null || !('id' in data) || data.id !== id || !('success' in data) || typeof data.success !== 'boolean') return
			finish(data.success ? { success: true } : { success: false, error: 'error' in data && typeof data.error === 'string' ? data.error : 'Safe connection was rejected.' })
		}
		const timeoutId = window.setTimeout(() => finish({ success: false, error: 'Safe connection timed out. Check the selected Safe and approve website access.' }), 5 * 60_000)
		window.addEventListener('message', receive)
		window.postMessage({ id, method: 'getSafeInfo', env: { sdkVersion: '9.1.0' } }, origin)
	})
}

export async function prepareSafeAppTab(value: string) {
	const origin = parseSafeAppsHostOrigin(value)
	if (browser.runtime.getManifest().manifest_version !== 3) throw new Error('Safe Apps hosting requires Chrome.')
	if (!await getSafeAppsCompatibilityMode() || !(await getSafeAppsHostOrigins()).includes(origin)) throw new Error('Enable Safe Apps compatibility and add this website first.')
	const settings = await getSettings()
	if (settings.simulationMode || settings.activeSigningSafeAddress === undefined) throw new Error('Select a Safe in signing mode before connecting this app.')
	const access = hasAccess(settings.websiteAccess, new URL(origin).host)
	if (access === 'interceptorDisabled') throw new Error('Enable Interceptor on this website before connecting.')
	if (access === 'noAccess') throw new Error('Allow this website in Website Access before connecting.')
	const tabs = await browser.tabs.query({})
	const tab = tabs.find((tab) => tab.id !== undefined && tab.url !== undefined && new URL(tab.url).origin === origin)
	if (tab?.id === undefined) throw new Error('Open this website in a browser tab before connecting.')
	const injection = { target: { tabId: tab.id, frameIds: [0] }, world: 'MAIN', func: requestSafeAppConnection, args: [origin] }
	// The Firefox polyfill types omit Chrome's MAIN world, args, and asynchronous functions.
	const executeScript: unknown = Reflect.get(browser.scripting, 'executeScript')
	if (typeof executeScript !== 'function') throw new Error('This browser does not support Safe Apps connection preparation.')
	const results: unknown = await executeScript.call(browser.scripting, injection)
	const firstResult: unknown = Array.isArray(results) ? results[0] : undefined
	const result: unknown = typeof firstResult === 'object' && firstResult !== null && 'result' in firstResult ? firstResult.result : undefined
	if (typeof result !== 'object' || result === null || !('success' in result) || result.success !== true) {
		throw new Error(typeof result === 'object' && result !== null && 'error' in result && typeof result.error === 'string' ? result.error : 'The website did not confirm a Safe connection.')
	}
	const connectedTab = await browser.tabs.get(tab.id)
	if (connectedTab.url === undefined || new URL(connectedTab.url).origin !== origin) throw new Error('The website navigated during connection.')
	await browser.tabs.reload(tab.id)
}
