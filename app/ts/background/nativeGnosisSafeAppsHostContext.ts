import { NATIVE_GNOSIS_SAFE_APPS_HOST_CONTEXT_PORT, NativeGnosisSafeAppsHostContextChange } from '../types/nativeGnosisSafeAppsHostContext.js'
import { getHtmlPageUrl } from '../utils/htmlPages.js'
import { isNativeGnosisSafeAppsLaunchValidationError, parseNativeGnosisSafeAppsLaunch } from '../utils/nativeGnosisSafeAppsHost.js'
import { getTabIfExists } from '../utils/requests.js'
import { isIgnorablePortLifecycleError } from './contentScriptPortLifecycle.js'
import { reportUnexpectedError } from '../utils/errors.js'
import { getNativeGnosisSafeAppsContextChanges } from './nativeGnosisSafeAppsHostContextPolicy.js'
import { observeNativeGnosisSafeAppsSource } from './nativeGnosisSafeAppsSourceLifecycle.js'

type HostContextPort = {
	readonly name: string
	readonly sender?: browser.runtime.MessageSender
	readonly postMessage: (message: unknown) => void
	readonly disconnect: () => void
	readonly onDisconnect: { readonly addListener: (listener: () => void) => void }
}

// The background owns context invalidation. Host pages only consume scoped notifications and never decode storage or observe tabs.
export function attachNativeGnosisSafeAppsHostContext(port: HostContextPort) {
	if (port.name !== NATIVE_GNOSIS_SAFE_APPS_HOST_CONTEXT_PORT) return false
	const sender = port.sender
	if (sender?.id !== browser.runtime.id || sender.url?.split(/[?#]/)[0] !== getHtmlPageUrl('gnosisSafeAppsHost')) { port.disconnect(); return true }
	const launch = (() => {
		try { return parseNativeGnosisSafeAppsLaunch(new URL(sender.url).searchParams) } catch (error: unknown) {
			if (isNativeGnosisSafeAppsLaunchValidationError(error)) return undefined
			throw error
		}
	})()
	if (launch === undefined) { port.disconnect(); return true }
	let active = true
	const publish = (change: NativeGnosisSafeAppsHostContextChange) => {
		if (!active) return
		try { port.postMessage(NativeGnosisSafeAppsHostContextChange.serialize(change)) } catch (error: unknown) {
			if (error instanceof Error && isIgnorablePortLifecycleError(error)) return
			throw error
		}
	}
	const disconnectSource = () => publish({ type: 'source-disconnected' })
	const storageChanged = (changes: Record<string, browser.storage.StorageChange>, area: string) => {
		const keys = getNativeGnosisSafeAppsContextChanges(changes, area)
		if (keys.length !== 0) publish({ type: 'context-changed', keys })
	}
	const stopObservingSource = observeNativeGnosisSafeAppsSource(launch.sourceTabId, launch.appUrl.origin, disconnectSource)
	browser.storage.onChanged.addListener(storageChanged)
	port.onDisconnect.addListener(() => {
		active = false
		stopObservingSource()
		browser.storage.onChanged.removeListener(storageChanged)
	})
	void getTabIfExists(launch.sourceTabId).then((source) => {
		if (source?.url === undefined || new URL(source.url).origin !== launch.appUrl.origin) disconnectSource()
	}).catch(async (error: unknown) => { await reportUnexpectedError(error) })
	return true
}
