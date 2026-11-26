import type { WebsiteLifecycleCallbacks } from '../types/websiteLifecycle.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { createGnosisSafeAppsCompatibilityFeature } from './gnosisSafeAppsCompatibilityCoordinator.js'
import { createSiteBehaviorFeature } from './siteBehaviorCoordinator.js'
import { getGnosisSafeSessionCompatibilityMode } from './settings.js'

// The session policy intentionally enables SDK hosting and simulated reads together; each owner publishes, retracts and invalidates only its own protocol.
export function createGnosisSafeSessionCapabilitiesFeature(connections: WebsiteTabConnections) {
	const sdk = createGnosisSafeAppsCompatibilityFeature(connections)
	const site = createSiteBehaviorFeature(connections)
	const lifecycle: WebsiteLifecycleCallbacks = {
		connectionReady: async (socket) => { await Promise.all([sdk.lifecycle.connectionReady?.(socket), site.lifecycle.connectionReady?.(socket)]) },
		approvalChanged: async (socket, approved) => { await Promise.all([sdk.lifecycle.approvalChanged?.(socket, approved), site.lifecycle.approvalChanged?.(socket, approved)]) },
		connectionRemoved: async (socket) => { await Promise.all([sdk.lifecycle.connectionRemoved?.(socket), site.lifecycle.connectionRemoved?.(socket)]) },
		signerConnected: async (socket, accountsRequested) => { await Promise.all([sdk.lifecycle.signerConnected?.(socket, accountsRequested), site.lifecycle.signerConnected?.(socket, accountsRequested)]) },
		signerAccountsChanged: async (socket) => { await Promise.all([sdk.lifecycle.signerAccountsChanged?.(socket), site.lifecycle.signerAccountsChanged?.(socket)]) },
		accessReconciled: async () => { await Promise.all([sdk.lifecycle.accessReconciled?.(), site.lifecycle.accessReconciled?.()]) },
	}
	const setEnabled = (enabled: boolean) => { sdk.setEnabled(enabled); site.setEnabled(enabled) }
	return { lifecycle, setEnabled, dispose: () => setEnabled(false) }
}

export async function initializeGnosisSafeSessionCapabilities(feature: ReturnType<typeof createGnosisSafeSessionCapabilitiesFeature>) {
	let changedDuringInitialization = false
	const onChanged = (changes: { readonly safeAppsCompatibilityMode?: browser.storage.StorageChange }, area: string) => {
		if (area !== 'local' || !('safeAppsCompatibilityMode' in changes)) return
		changedDuringInitialization = true
		feature.setEnabled(changes.safeAppsCompatibilityMode?.newValue === true)
	}
	browser.storage.onChanged.addListener(onChanged)
	try {
		const enabled = await getGnosisSafeSessionCompatibilityMode()
		if (!changedDuringInitialization) feature.setEnabled(enabled)
	} catch (error) {
		browser.storage.onChanged.removeListener(onChanged)
		feature.dispose()
		throw error
	}
	return () => { browser.storage.onChanged.removeListener(onChanged); feature.dispose() }
}
