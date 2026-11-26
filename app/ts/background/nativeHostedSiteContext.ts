import type { AddressBookEntry } from '../types/addressBookTypes.js'
import type { Settings } from '../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { WebsiteSocket } from '../utils/requests.js'
import { getTabIfExists } from '../utils/requests.js'
import { isNativeGnosisSafeAppsLaunchValidationError, parseNativeGnosisSafeAppsLaunch } from '../utils/nativeGnosisSafeAppsHost.js'
import { getWebsiteSocketConnection, isTopFramePort } from './backgroundUtils.js'
import { isGnosisSafeAppsConnectionEligible, isGnosisSafeAppsConnectionEligibleForAdmittedAddress } from './gnosisSafeAppsConnectionEligibility.js'
import { getGnosisSafeAppsCompatibilityMode } from './settings.js'
import { getWebsiteActiveAddress } from './websiteActiveAddress.js'
import { getHtmlPageUrl } from '../utils/htmlPages.js'
import { getAuthorizedNativeGnosisSafeAppsHostSenderUrl } from './nativeGnosisSafeAppsHostSender.js'

type NativeHostedSiteDependencies = {
	readonly extensionId: string
	readonly hostUrls: readonly string[]
	readonly getTab: (tabId: number) => Promise<{ readonly url?: string } | undefined>
	readonly getEligibleSourceAddress: (connections: WebsiteTabConnections, socket: WebsiteSocket, settings: Settings) => Promise<AddressBookEntry | undefined>
}

async function getEligibleSourceAddress(connections: WebsiteTabConnections, socket: WebsiteSocket, settings: Settings) {
	if (!await getGnosisSafeAppsCompatibilityMode() || !await isGnosisSafeAppsConnectionEligible(connections, socket, settings)) return undefined
	const source = getWebsiteSocketConnection(connections, socket)
	return source === undefined ? undefined : await getWebsiteActiveAddress(connections, source.websiteOrigin, settings, socket)
}

const defaultDependencies = (): NativeHostedSiteDependencies => ({
	extensionId: browser.runtime.id,
	hostUrls: [getHtmlPageUrl('gnosisSafeAppsHost')],
	getTab: getTabIfExists,
	getEligibleSourceAddress,
})

function getHttpOrigin(value: string) {
	try {
		const url = new URL(value)
		return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === '' ? url.origin : undefined
	} catch (error: unknown) {
		if (error instanceof TypeError) return undefined
		throw error
	}
}

// This syntactic relationship scopes capability invalidations even while the source has no permission. It grants no read authority: getNativeHostedSiteContext checks live tabs and access.
export function getNativeHostedSiteSourceTabId(connections: WebsiteTabConnections, childSocket: WebsiteSocket, suppliedDependencies?: Pick<NativeHostedSiteDependencies, 'extensionId' | 'hostUrls'>) {
	const child = getWebsiteSocketConnection(connections, childSocket)
	const sender = child?.port.sender
	if (child === undefined || typeof sender?.id !== 'string' || sender.frameId === undefined || sender.frameId <= 0 || sender.tab?.id !== childSocket.tabId || sender.tab.url === undefined || sender.url === undefined || child.requestOrigin === undefined) return undefined
	const dependencies = suppliedDependencies ?? defaultDependencies()
	const hostUrl = getAuthorizedNativeGnosisSafeAppsHostSenderUrl(sender, dependencies.extensionId, dependencies.hostUrls, sender.tab.url)
	if (hostUrl === undefined || getHttpOrigin(sender.url) !== child.requestOrigin) return undefined
	let launch: ReturnType<typeof parseNativeGnosisSafeAppsLaunch>
	try { launch = parseNativeGnosisSafeAppsLaunch(new URL(hostUrl).searchParams) } catch (error: unknown) {
		if (isNativeGnosisSafeAppsLaunchValidationError(error)) return undefined
		throw error
	}
	return launch.appUrl.origin === child.requestOrigin && launch.sourceTabId !== childSocket.tabId ? launch.sourceTabId : undefined
}

// This is a read-only context, not a replacement connection or signer owner. Browser sender data and live tabs bind the actual child to its approved source website.
export async function getNativeHostedSiteContext(connections: WebsiteTabConnections, childSocket: WebsiteSocket, settings: Settings, suppliedDependencies?: NativeHostedSiteDependencies) {
	if (!settings.simulationMode) return undefined
	const dependencies = suppliedDependencies ?? defaultDependencies()
	const sourceTabId = getNativeHostedSiteSourceTabId(connections, childSocket, dependencies)
	const child = getWebsiteSocketConnection(connections, childSocket)
	const sender = child?.port.sender
	if (sourceTabId === undefined || child === undefined || sender?.tab?.url === undefined || child.requestOrigin === undefined) return undefined
	const origin = child.requestOrigin
	const hostUrl = sender.tab.url
	const source = Object.values(connections.get(sourceTabId)?.connections ?? {}).find((connection) => connection.approved && isTopFramePort(connection.port) && connection.requestOrigin === child.requestOrigin)
	if (source === undefined) return undefined
	const activeAddress = await dependencies.getEligibleSourceAddress(connections, source.socket, settings)
	if (activeAddress?.type !== 'safe' || !isGnosisSafeAppsConnectionEligibleForAdmittedAddress(connections, source.socket, settings, { activeAddress, safeSigningMode: false })) return undefined
	const connectionsAreCurrent = () => getWebsiteSocketConnection(connections, childSocket) === child
		&& getWebsiteSocketConnection(connections, source.socket) === source
		&& source.approved && isTopFramePort(source.port) && !isTopFramePort(child.port)
		&& child.requestOrigin === origin && source.requestOrigin === origin
	const matchesSettings = (currentSettings: Settings) => isGnosisSafeAppsConnectionEligibleForAdmittedAddress(connections, source.socket, currentSettings, { activeAddress, safeSigningMode: false })
	const browserBindingsAreCurrent = async () => {
		if (!connectionsAreCurrent()) return false
		// Read browser bindings after eligibility work so navigation during that work cannot leave a valid-looking stale context.
		const [host, sourceTab] = await Promise.all([dependencies.getTab(childSocket.tabId), dependencies.getTab(sourceTabId)])
		return host?.url === hostUrl && sourceTab?.url !== undefined && getHttpOrigin(sourceTab.url) === origin && connectionsAreCurrent()
	}
	if (!await browserBindingsAreCurrent()) return undefined
	// Execution revalidates this captured authority without selecting another source or rebuilding the native launch relationship.
	const isCurrent = async (currentSettings: Settings) => {
		if (!matchesSettings(currentSettings) || !connectionsAreCurrent()) return false
		const currentAddress = await dependencies.getEligibleSourceAddress(connections, source.socket, currentSettings)
		if (currentAddress?.type !== 'safe' || currentAddress.address !== activeAddress.address || currentAddress.chainId !== activeAddress.chainId) return false
		return await browserBindingsAreCurrent()
	}
	return { sourceSocket: source.socket, origin, activeAddress, isCurrent }
}
