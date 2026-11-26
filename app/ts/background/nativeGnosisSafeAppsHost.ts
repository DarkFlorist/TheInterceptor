import { isNativeGnosisSafeAppsSourceDisconnected } from '../../shared/ts/gnosisSafeAppsBridgeProtocol.js'
import type { NativeGnosisSafeAppsRelayReply } from '../types/interceptor-reply-messages.js'
import { GNOSIS_SAFE_APPS_NATIVE_SOURCE_REQUEST, parseNativeGnosisSafeAppsRequest, parseNativeGnosisSafeAppsResponse } from '../utils/nativeGnosisSafeAppsHost.js'
import { isMissingBrowserTargetError } from '../utils/requests.js'

type HostRelayDependencies = {
	readonly extensionId: string
	readonly hostUrls: readonly string[]
	readonly getTab: (tabId: number) => Promise<{ readonly url?: string } | undefined>
	readonly sendToSource: (tabId: number, message: unknown) => Promise<unknown>
}

// Only the extension-owned host delegates to the original website's provider. Its existing connection owns website consent, signer selection and transaction approvals.
export async function relayNativeGnosisSafeAppsRequest(message: unknown, sender: browser.runtime.MessageSender, dependencies: HostRelayDependencies): Promise<NativeGnosisSafeAppsRelayReply> {
	const failure = (message: string): NativeGnosisSafeAppsRelayReply => ({ type: 'NativeGnosisSafeAppsRelayReply', ok: false, message })
	if (sender.id !== dependencies.extensionId || sender.url === undefined || !dependencies.hostUrls.some((url) => sender.url?.split(/[?#]/)[0] === url)) return failure('Gnosis Safe App requests require the extension-owned host.')
	if (typeof message !== 'object' || message === null || !('data' in message) || typeof message.data !== 'object' || message.data === null) return failure('Invalid Gnosis Safe App host request.')
	const data = message.data
	if (!('sourceTabId' in data) || typeof data.sourceTabId !== 'number' || !Number.isSafeInteger(data.sourceTabId) || data.sourceTabId < 0 || !('origin' in data) || typeof data.origin !== 'string' || !('request' in data)) return failure('Invalid Gnosis Safe App source.')
	const request = parseNativeGnosisSafeAppsRequest(data.request)
	if (request === undefined) return failure('Invalid Gnosis Safe Apps SDK envelope.')
	let origin: URL
	try { origin = new URL(data.origin) } catch (error: unknown) {
		if (!(error instanceof TypeError)) throw error
		return failure('Invalid Gnosis Safe App origin.')
	}
	if (!['https:', 'http:'].includes(origin.protocol) || origin.origin !== data.origin) return failure('Gnosis Safe Apps require an HTTP or HTTPS website origin.')
	const source = await dependencies.getTab(data.sourceTabId)
	if (source?.url === undefined || new URL(source.url).origin !== origin.origin) return failure('The original website tab was closed or navigated to another origin. Open the Gnosis Safe App again from its website.')
	// frameId:0 at the browser boundary pins this to the source's real top-level provider, including its existing signer. The content listener checks the origin again after delivery.
	try {
		const sourceReply = await dependencies.sendToSource(data.sourceTabId, { method: GNOSIS_SAFE_APPS_NATIVE_SOURCE_REQUEST, origin: origin.origin, request })
		if (isNativeGnosisSafeAppsSourceDisconnected(sourceReply) && sourceReply.id === request.id) return failure('The original website provider disconnected. Reload the original tab and open the app again.')
		const response = parseNativeGnosisSafeAppsResponse(sourceReply)
		return response?.id === request.id ? { type: 'NativeGnosisSafeAppsRelayReply', ok: true, response } : failure('The original website provider did not return a Gnosis Safe App response. Reload the original tab and open the app again.')
	} catch (error: unknown) {
		if (isMissingBrowserTargetError(error) || (error instanceof Error && /Receiving end does not exist|message port closed/.test(error.message))) return failure('The original website provider disconnected. Reload the original tab and open the app again.')
		throw error
	}
}
