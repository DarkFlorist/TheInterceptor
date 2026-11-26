import type { OpenGnosisSafeAppReply } from '../types/interceptor-reply-messages.js'
import { isNativeGnosisSafeAppsLaunchValidationError, nativeGnosisSafeAppsHostUrl } from '../utils/nativeGnosisSafeAppsHost.js'
import { getTabIfExists } from '../utils/requests.js'
import { openExtensionTab } from './extensionTabs.js'
import { setGnosisSafeAppsCompatibilityMode } from './settings.js'

// Launch preparation belongs to the background; the source provider still owns website consent, account eligibility and each request's admission.
export async function openNativeGnosisSafeApp(sourceTabId: number): Promise<OpenGnosisSafeAppReply> {
	const failure = (message: string): OpenGnosisSafeAppReply => ({ type: 'OpenGnosisSafeAppReply', ok: false, message })
	const source = await getTabIfExists(sourceTabId)
	if (source?.url === undefined) return failure('The original website tab or URL is unavailable.')
	let url: string
	try { url = nativeGnosisSafeAppsHostUrl(browser.runtime.getURL(''), sourceTabId, source.url) } catch (error: unknown) {
		if (error instanceof Error && isNativeGnosisSafeAppsLaunchValidationError(error)) return failure(error.message)
		throw error
	}
	await setGnosisSafeAppsCompatibilityMode(true)
	await openExtensionTab('gnosisSafeAppsHost', new URL(url).search)
	return { type: 'OpenGnosisSafeAppReply', ok: true }
}
