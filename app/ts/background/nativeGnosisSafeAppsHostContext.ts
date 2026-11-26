import { getNativeGnosisSafeAppsHostLaunch } from './nativeGnosisSafeAppsHostSender.js'
import { NATIVE_GNOSIS_SAFE_APPS_HOST_CONTEXT_PORT, NativeGnosisSafeAppsHostContextChange } from '../types/nativeGnosisSafeAppsHostContext.js'
import { isIgnorablePortLifecycleError } from './contentScriptPortLifecycle.js'
import { getNativeGnosisSafeAppsContextChanges } from './nativeGnosisSafeAppsHostContextPolicy.js'

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
	if (getNativeGnosisSafeAppsHostLaunch(port.sender) === undefined) { port.disconnect(); return true }
	let active = true
	const publish = (change: NativeGnosisSafeAppsHostContextChange) => {
		if (!active) return
		try { port.postMessage(NativeGnosisSafeAppsHostContextChange.serialize(change)) } catch (error: unknown) {
			if (error instanceof Error && isIgnorablePortLifecycleError(error)) return
			throw error
		}
	}
	const storageChanged = (changes: Record<string, browser.storage.StorageChange>, area: string) => {
		const keys = getNativeGnosisSafeAppsContextChanges(changes, area)
		if (keys.length !== 0) publish({ type: 'context-changed', keys })
	}
	browser.storage.onChanged.addListener(storageChanged)
	port.onDisconnect.addListener(() => {
		active = false
		browser.storage.onChanged.removeListener(storageChanged)
	})
	return true
}
