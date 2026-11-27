import { isNativeGnosisSafeAppsLaunchValidationError, parseNativeGnosisSafeAppsLaunch } from '../utils/nativeGnosisSafeAppsHost.js'
import { getHtmlPageUrl } from '../utils/htmlPages.js'

type NativeHostSender = { readonly id?: string, readonly url?: string }

// SDK transports and child signer discovery share exact extension-page authorization.
export function getAuthorizedNativeGnosisSafeAppsHostSenderUrl(sender: NativeHostSender | undefined, extensionId: string, hostUrls: readonly string[], hostPageUrl = sender?.url) {
	if (sender?.id !== extensionId || hostPageUrl === undefined) return undefined
	const pageUrl = hostPageUrl.split(/[?#]/)[0]
	return pageUrl !== undefined && hostUrls.includes(pageUrl) ? hostPageUrl : undefined
}

export function getNativeGnosisSafeAppsHostLaunch(sender: browser.runtime.MessageSender | undefined, hostPageUrl = sender?.url) {
	const url = getAuthorizedNativeGnosisSafeAppsHostSenderUrl(sender, browser.runtime.id, [getHtmlPageUrl('gnosisSafeAppsHost')], hostPageUrl)
	if (url === undefined) return undefined
	try {
		const launch = parseNativeGnosisSafeAppsLaunch(new URL(url).searchParams)
		return launch.hostTabId === sender?.tab?.id ? launch : undefined
	} catch (error: unknown) {
		if (isNativeGnosisSafeAppsLaunchValidationError(error)) return undefined
		throw error
	}
}

// Browser-owned sender data only. Registration separately verifies this is a direct child using webNavigation, not an arbitrary descendant.
export function getNativeGnosisSafeAppsChildLaunch(sender: browser.runtime.MessageSender | undefined) {
	if (sender?.frameId === undefined || sender.frameId <= 0 || sender.url === undefined) return undefined
	const launch = getNativeGnosisSafeAppsHostLaunch(sender, sender.tab?.url)
	if (launch === undefined) return undefined
	try { return new URL(sender.url).origin === launch.appUrl.origin ? launch : undefined } catch (error: unknown) {
		if (error instanceof TypeError) return undefined
		throw error
	}
}
