import type { WebsiteLifecycleCallbacks } from '../types/websiteLifecycle.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { createGnosisSafeAppsCompatibilityFeature, initializeGnosisSafeAppsCompatibility } from './gnosisSafeAppsCompatibilityCoordinator.js'
import { createSiteBehaviorFeature, initializeSiteBehavior } from './siteBehaviorCoordinator.js'

// Compose lifecycle notifications only; each capability owns its independent preference and initialization.
export function createGnosisSafeSessionCapabilitiesFeature(connections: WebsiteTabConnections) {
	const sdk = createGnosisSafeAppsCompatibilityFeature(connections)
	const site = createSiteBehaviorFeature(connections)
	// The fan-out must cover every event even though individual observers may implement only a subset.
	const lifecycle: Required<WebsiteLifecycleCallbacks> = {
		connectionReady: async (socket) => { await Promise.all([sdk.lifecycle.connectionReady?.(socket), site.lifecycle.connectionReady?.(socket)]) },
		approvalChanged: async (socket, approved) => { await Promise.all([sdk.lifecycle.approvalChanged?.(socket, approved), site.lifecycle.approvalChanged?.(socket, approved)]) },
		connectionRemoved: async (socket) => { await Promise.all([sdk.lifecycle.connectionRemoved?.(socket), site.lifecycle.connectionRemoved?.(socket)]) },
		signerConnected: async (socket, accountsRequested) => { await Promise.all([sdk.lifecycle.signerConnected?.(socket, accountsRequested), site.lifecycle.signerConnected?.(socket, accountsRequested)]) },
		signerAccountsChanged: async (socket) => { await Promise.all([sdk.lifecycle.signerAccountsChanged?.(socket), site.lifecycle.signerAccountsChanged?.(socket)]) },
		accessReconciled: async () => { await Promise.all([sdk.lifecycle.accessReconciled?.(), site.lifecycle.accessReconciled?.()]) },
	}
	return { lifecycle, sdk, site, dispose: () => { sdk.dispose(); site.dispose() } }
}

export async function initializeGnosisSafeSessionCapabilities(feature: Pick<ReturnType<typeof createGnosisSafeSessionCapabilitiesFeature>, 'sdk' | 'site'>) {
	// Wait for both reads to settle before cleanup so a late initializer cannot retain a listener after its peer fails.
	const results = await Promise.allSettled([initializeGnosisSafeAppsCompatibility(feature.sdk), initializeSiteBehavior(feature.site)])
	if (results.some((result) => result.status === 'rejected')) {
		for (const result of results) if (result.status === 'fulfilled') result.value()
		for (const result of results) if (result.status === 'rejected') throw result.reason
	}
	return () => { for (const result of results) if (result.status === 'fulfilled') result.value() }
}
