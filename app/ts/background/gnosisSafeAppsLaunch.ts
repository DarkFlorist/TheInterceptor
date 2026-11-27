import { getNativeGnosisSafeAppsHostLaunch } from './nativeGnosisSafeAppsHostSender.js'
import type { OpenGnosisSafeAppReply } from '../types/interceptor-reply-messages.js'
import { isNativeGnosisSafeAppsLaunchValidationError, nativeGnosisSafeAppsHostUrl } from '../utils/nativeGnosisSafeAppsHost.js'
import { getTabIfExists } from '../utils/requests.js'
import { setGnosisSafeAppsCompatibilityMode } from './settings.js'

// Replace the website tab in place. The host starts a new app-origin connection; no original provider or signer state is copied.
export async function openNativeGnosisSafeApp(sourceTabId: number): Promise<OpenGnosisSafeAppReply> {
	const failure = (message: string): OpenGnosisSafeAppReply => ({ type: 'OpenGnosisSafeAppReply', ok: false, message })
	const source = await getTabIfExists(sourceTabId)
	if (source?.url === undefined) return failure('The website tab or URL is unavailable.')
	if (getNativeGnosisSafeAppsHostLaunch({ id: browser.runtime.id, url: source.url, tab: { ...source, id: sourceTabId } }) !== undefined) return { type: 'OpenGnosisSafeAppReply', ok: true }
	let url: string
	try { url = nativeGnosisSafeAppsHostUrl(browser.runtime.getURL(''), sourceTabId, source.url) } catch (error: unknown) {
		if (error instanceof Error && isNativeGnosisSafeAppsLaunchValidationError(error)) return failure(error.message)
		throw error
	}
	await setGnosisSafeAppsCompatibilityMode(true)
	await browser.tabs.update(sourceTabId, { url })
	return { type: 'OpenGnosisSafeAppReply', ok: true }
}
