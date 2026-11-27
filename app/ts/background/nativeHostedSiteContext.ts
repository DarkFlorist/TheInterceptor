import type { AddressBookEntry } from '../types/addressBookTypes.js'
import type { Settings } from '../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { WebsiteSocket } from '../utils/requests.js'
import { getTabIfExists } from '../utils/requests.js'
import { getWebsiteSocketConnection, isTopFramePort } from './backgroundUtils.js'
import { isGnosisSafeAppsConnectionEligible, isGnosisSafeAppsConnectionEligibleForAdmittedAddress } from './gnosisSafeAppsConnectionEligibility.js'
import { getNativeGnosisSafeAppsSession } from './nativeGnosisSafeAppsSessions.js'
import { getWebsiteActiveAddress } from './websiteActiveAddress.js'
import { getNativeGnosisSafeAppsChildLaunch, getNativeGnosisSafeAppsHostLaunch } from './nativeGnosisSafeAppsHostSender.js'

type NativeHostedSiteDependencies = {
	readonly getTab: (tabId: number) => Promise<{ readonly url?: string } | undefined>
	readonly getFrame: (tabId: number, frameId: number) => Promise<{ readonly url?: string, readonly parentFrameId?: number, readonly documentId?: string } | undefined>
	readonly getEligibleHostAddress: (connections: WebsiteTabConnections, socket: WebsiteSocket, settings: Settings) => Promise<AddressBookEntry | undefined>
}

async function getEligibleHostAddress(connections: WebsiteTabConnections, socket: WebsiteSocket, settings: Settings) {
	if (!await isGnosisSafeAppsConnectionEligible(connections, socket, settings)) return undefined
	const host = getWebsiteSocketConnection(connections, socket)
	return host === undefined ? undefined : await getWebsiteActiveAddress(connections, host.websiteOrigin, settings, socket)
}

const defaultDependencies = (): NativeHostedSiteDependencies => ({
	getTab: getTabIfExists,
	getFrame: async (tabId, frameId) => await browser.webNavigation.getFrame({ tabId, frameId }),
	getEligibleHostAddress,
})

function getHttpOrigin(value: string | undefined) {
	if (value === undefined) return undefined
	try {
		const url = new URL(value)
		return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === '' ? url.origin : undefined
	} catch (error: unknown) {
		if (error instanceof TypeError) return undefined
		throw error
	}
}

// Registration marks browser-verified direct children even when no signer wallet is installed. This classifies a hosted frame; it grants no read authority.
export function isNativeHostedSiteChild(connections: WebsiteTabConnections, childSocket: WebsiteSocket) {
	const child = getWebsiteSocketConnection(connections, childSocket)
	if (child?.nativeSafeRole?.kind !== 'signer' || isTopFramePort(child.port)) return false
	const launch = getNativeGnosisSafeAppsChildLaunch(child.port.sender)
	return launch !== undefined && child.requestOrigin === launch.appUrl.origin && child.websiteOrigin === launch.appUrl.host
}

// HTTP reads borrow only the authenticated host session's approved app-origin authority. They never select another tab, approve the child, or require an external wallet in simulation mode.
export async function getNativeHostedSiteContext(connections: WebsiteTabConnections, childSocket: WebsiteSocket, settings: Settings, suppliedDependencies?: NativeHostedSiteDependencies) {
	if (!settings.simulationMode || !isNativeHostedSiteChild(connections, childSocket)) return undefined
	const dependencies = suppliedDependencies ?? defaultDependencies()
	const child = getWebsiteSocketConnection(connections, childSocket)
	const sender = child?.port.sender
	const launch = getNativeGnosisSafeAppsChildLaunch(sender)
	if (child === undefined || sender?.frameId === undefined || sender.tab?.url === undefined || launch === undefined) return undefined
	const frameId = sender.frameId
	const origin = launch.appUrl.origin
	const hostUrl = sender.tab.url
	const host = Object.values(connections.get(childSocket.tabId)?.connections ?? {}).find((connection) => {
		if (connection.nativeSafeRole?.kind !== 'host' || !isTopFramePort(connection.port) || connection.port.sender?.url !== hostUrl || connection.websiteOrigin !== launch.appUrl.host || connection.requestOrigin !== origin) return false
		return getNativeGnosisSafeAppsHostLaunch(connection.port.sender)?.appUrl.href === launch.appUrl.href
	})
	if (host === undefined || !host.approved || getNativeGnosisSafeAppsSession(connections, childSocket.tabId)?.port !== host.port || (child.nativeSafeRole?.kind !== 'signer' || child.nativeSafeRole.session.port !== host.port)) return undefined
	const activeAddress = await dependencies.getEligibleHostAddress(connections, host.socket, settings)
	if (activeAddress?.type !== 'safe' || !isGnosisSafeAppsConnectionEligibleForAdmittedAddress(connections, host.socket, settings, { activeAddress, safeSigningMode: false })) return undefined
	const connectionsAreCurrent = () => getWebsiteSocketConnection(connections, childSocket) === child
		&& getWebsiteSocketConnection(connections, host.socket) === host
		&& getNativeGnosisSafeAppsSession(connections, childSocket.tabId)?.port === host.port && child.nativeSafeRole?.kind === 'signer' && child.nativeSafeRole.session.port === host.port
		&& host.nativeSafeRole?.kind === 'host' && getNativeGnosisSafeAppsSession(connections, childSocket.tabId)?.origin === origin
		&& host.approved && isTopFramePort(host.port) && !isTopFramePort(child.port)
		&& child.requestOrigin === origin && host.requestOrigin === origin
		&& child.websiteOrigin === launch.appUrl.host && host.websiteOrigin === launch.appUrl.host
	const matchesSettings = (currentSettings: Settings) => currentSettings.simulationMode && isGnosisSafeAppsConnectionEligibleForAdmittedAddress(connections, host.socket, currentSettings, { activeAddress, safeSigningMode: false })
	const browserBindingsAreCurrent = async () => {
		if (!connectionsAreCurrent()) return false
		// Validate the actual frame after eligibility work. Same-origin SPA path/hash changes preserve authority; document replacement loses its exact connection reference.
		const [tab, frame] = await Promise.all([dependencies.getTab(childSocket.tabId), dependencies.getFrame(childSocket.tabId, frameId)])
		const documentMatches = frame?.documentId === undefined || !('documentId' in sender) || typeof sender.documentId !== 'string' || frame.documentId === sender.documentId
		return documentMatches && tab?.url === hostUrl && frame?.parentFrameId === 0 && getHttpOrigin(frame.url) === origin && connectionsAreCurrent()
	}
	if (!await browserBindingsAreCurrent()) return undefined
	const isCurrent = async (currentSettings: Settings) => {
		if (!matchesSettings(currentSettings) || !connectionsAreCurrent()) return false
		const currentAddress = await dependencies.getEligibleHostAddress(connections, host.socket, currentSettings)
		if (currentAddress?.type !== 'safe' || currentAddress.address !== activeAddress.address || currentAddress.chainId !== activeAddress.chainId) return false
		return await browserBindingsAreCurrent()
	}
	return { hostSocket: host.socket, origin, activeAddress, isCurrent }
}
