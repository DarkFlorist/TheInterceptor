import { requestSafeAppConnection } from '../utils/pageScripts/requestSafeAppConnection.js'
import type { PrepareSafeAppReply } from '../types/interceptor-reply-messages.js'
import { getSafeAppsCompatibilityMode, getSafeAppsHostOrigins, getSettings } from './settings.js'
import { hasAccess } from './websiteAccessPolicy.js'
import { parseSafeAppsHostOrigin } from '../utils/safeAppsHosting.js'

export async function prepareSafeAppTab(value: string): Promise<PrepareSafeAppReply['data']> {
	const origin = parseSafeAppsHostOrigin(value)
	if (browser.runtime.getManifest().manifest_version !== 3) return { success: false, errorMessage: 'Safe Apps hosting requires Chrome.' }
	if (!await getSafeAppsCompatibilityMode() || !(await getSafeAppsHostOrigins()).includes(origin)) return { success: false, errorMessage: 'Enable Safe Apps compatibility and add this website first.' }
	const settings = await getSettings()
	if (settings.simulationMode || settings.activeSigningSafeAddress === undefined) return { success: false, errorMessage: 'Select a Safe in signing mode before connecting this app.' }
	const access = hasAccess(settings.websiteAccess, new URL(origin).host)
	if (access === 'interceptorDisabled') return { success: false, errorMessage: 'Enable Interceptor on this website before connecting.' }
	if (access === 'noAccess') return { success: false, errorMessage: 'Allow this website in Website Access before connecting.' }
	const tabs = await browser.tabs.query({})
	const tab = tabs.find((tab) => tab.id !== undefined && tab.url !== undefined && new URL(tab.url).origin === origin)
	if (tab?.id === undefined) return { success: false, errorMessage: 'Open this website in a browser tab before connecting.' }
	const injection = { target: { tabId: tab.id, frameIds: [0] }, world: 'MAIN', func: requestSafeAppConnection, args: [origin] }
	// The Firefox polyfill types omit Chrome's MAIN world, args, and asynchronous functions.
	const executeScript: unknown = Reflect.get(browser.scripting, 'executeScript')
	if (typeof executeScript !== 'function') return { success: false, errorMessage: 'This browser does not support Safe Apps connection preparation.' }
	const results: unknown = await executeScript.call(browser.scripting, injection)
	const firstResult: unknown = Array.isArray(results) ? results[0] : undefined
	const result: unknown = typeof firstResult === 'object' && firstResult !== null && 'result' in firstResult ? firstResult.result : undefined
	if (typeof result !== 'object' || result === null || !('success' in result) || result.success !== true) {
		return { success: false, errorMessage: typeof result === 'object' && result !== null && 'error' in result && typeof result.error === 'string' ? result.error : 'The website did not confirm a Safe connection.' }
	}
	const connectedTab = await browser.tabs.get(tab.id)
	if (connectedTab.url === undefined || new URL(connectedTab.url).origin !== origin) return { success: false, errorMessage: 'The website navigated during connection.' }
	await browser.tabs.reload(tab.id)
	return { success: true }
}
