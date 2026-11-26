import { createPublicationGenerations } from './publicationGenerations.js'
import { initializeFeaturePreference } from './featurePreference.js'
import type { WebsiteLifecycleCallbacks } from '../types/websiteLifecycle.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { WebsiteSocket } from '../utils/requests.js'
import { getConfiguredGnosisSafeAddressForMode } from '../utils/activeAddressSelection.js'
import { reportUnexpectedError } from '../utils/errors.js'
import { getWebsiteSocketConnection, isTopFramePort, websiteSocketToString } from './backgroundUtils.js'
import { isGnosisSafeAppsConnectionEligible } from './gnosisSafeAppsConnectionEligibility.js'
import { createNativeHostedSiteChildIndex } from './nativeHostedSiteChildIndex.js'
import { getNativeHostedSiteContext, getNativeHostedSiteSourceTabId } from './nativeHostedSiteContext.js'
import { publishSiteBehaviors } from './siteBehaviorContext.js'
import { getSettings, getSiteRpcInterceptionEnabled } from './settings.js'

// Site HTTP capability publication owns its generations and native-child relationships; it never publishes Gnosis Safe Apps discovery replies or grants a connection approval.
export function createSiteBehaviorFeature(connections: WebsiteTabConnections) {
	const publications = createPublicationGenerations<string>()
	const nativeChildren = createNativeHostedSiteChildIndex()
	const isRelevant = (socket: WebsiteSocket) => {
		const connection = getWebsiteSocketConnection(connections, socket)
		return connection !== undefined && (isTopFramePort(connection.port) ? connection.approved : getNativeHostedSiteSourceTabId(connections, socket) !== undefined)
	}
	const refresh = async (socket: WebsiteSocket) => {
		if (publications.getEnabled() === undefined) return
		if (!publications.getEnabled()) { retract(socket); return }
		nativeChildren.track(connections, socket)
		if (!isRelevant(socket)) { retract(socket); return }
		const current = publications.begin(websiteSocketToString(socket))
		const settings = await getSettings()
		const connection = getWebsiteSocketConnection(connections, socket)
		if (!current() || connection === undefined) return
		if (!isTopFramePort(connection.port)) {
			const context = await getNativeHostedSiteContext(connections, socket, settings)
			if (!current()) return
			const latest = await getSettings()
			const valid = context !== undefined && await context.isCurrent(latest)
			if (!current()) return
			publishSiteBehaviors(connections, socket, valid ? context.activeAddress.chainId : undefined, valid ? context.activeAddress.address : undefined)
			return
		}
		const eligible = settings.simulationMode && await isGnosisSafeAppsConnectionEligible(connections, socket, settings)
		if (!current()) return
		const latest = await getSettings()
		const latestEligible = latest.simulationMode && await isGnosisSafeAppsConnectionEligible(connections, socket, latest)
		if (!current()) return
		const address = getConfiguredGnosisSafeAddressForMode(latest)
		// Eligibility comes from the canonical predicate above; equality only prevents publishing across a selection change during those reads.
		const stable = eligible && latestEligible && settings.activeRpcNetwork.chainId === latest.activeRpcNetwork.chainId && getConfiguredGnosisSafeAddressForMode(settings) === address
		publishSiteBehaviors(connections, socket, stable ? latest.activeRpcNetwork.chainId : undefined, stable ? address : undefined)
	}
	const queueRefresh = (socket: WebsiteSocket) => { void refresh(socket).catch(async (error: unknown) => { await reportUnexpectedError(error) }) }
	const refreshChildren = (sourceTabId: number) => { for (const child of nativeChildren.getChildren(sourceTabId)) queueRefresh(child) }
	const retract = (socket: WebsiteSocket, invalidated = false) => {
		const key = websiteSocketToString(socket)
		const published = publications.retract(key)
		if (published || invalidated || isRelevant(socket)) publishSiteBehaviors(connections, socket)
	}
	const refreshAll = async () => {
		if (publications.getEnabled() !== true) return
		const refreshes: Promise<void>[] = []
		for (const tab of connections.values()) for (const connection of Object.values(tab.connections)) {
			if (connection === undefined) continue
			if (isRelevant(connection.socket)) refreshes.push(refresh(connection.socket))
			else { nativeChildren.remove(connection.socket); retract(connection.socket) }
		}
		await Promise.all(refreshes)
	}
	const lifecycle: WebsiteLifecycleCallbacks = {
		connectionReady: (socket) => queueRefresh(socket),
		approvalChanged: (socket, approved) => {
			if (approved) queueRefresh(socket)
			else retract(socket)
			refreshChildren(socket.tabId)
		},
		connectionRemoved: (socket) => {
			nativeChildren.remove(socket)
			publications.retract(websiteSocketToString(socket))
			refreshChildren(socket.tabId)
		},
		signerConnected: (socket) => { queueRefresh(socket); refreshChildren(socket.tabId) },
		signerAccountsChanged: (socket) => { queueRefresh(socket); refreshChildren(socket.tabId) },
		accessReconciled: () => { void refreshAll().catch(async (error: unknown) => { await reportUnexpectedError(error) }) },
	}
	const setEnabled = (enabled: boolean) => {
		const invalidated = publications.setEnabled(enabled)
		if (invalidated === undefined) return
		if (enabled) { void refreshAll().catch(async (error: unknown) => { await reportUnexpectedError(error) }); return }
		for (const tab of connections.values()) for (const connection of Object.values(tab.connections)) if (connection !== undefined) retract(connection.socket, invalidated.has(websiteSocketToString(connection.socket)))
		nativeChildren.clear()
	}
	return { lifecycle, setEnabled, dispose: () => setEnabled(false) }
}

export async function initializeSiteBehavior(feature: Pick<ReturnType<typeof createSiteBehaviorFeature>, 'setEnabled' | 'dispose' | 'lifecycle'>) {
	// Native children additionally depend on their SDK host context; ordinary top-level pages keep their independent HTTP preference.
	const onHostingChanged = (changes: Record<string, browser.storage.StorageChange>, area: string) => {
		if (area === 'local' && 'safeAppsCompatibilityMode' in changes) feature.lifecycle.accessReconciled?.()
	}
	browser.storage.onChanged.addListener(onHostingChanged)
	try {
		const dispose = await initializeFeaturePreference(feature, 'siteRpcInterceptionEnabled', getSiteRpcInterceptionEnabled)
		return () => { browser.storage.onChanged.removeListener(onHostingChanged); dispose() }
	} catch (error) {
		browser.storage.onChanged.removeListener(onHostingChanged)
		throw error
	}
}
