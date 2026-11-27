import { NATIVE_GNOSIS_SAFE_APPS_SESSION_READY } from '../types/nativeGnosisSafeAppsHostContext.js'
import { getHtmlPageUrl } from '../utils/htmlPages.js'
import { getSettings } from './settings.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { getAuthorizedNativeGnosisSafeAppsHostSenderUrl, getNativeGnosisSafeAppsChildLaunch, getNativeGnosisSafeAppsHostLaunch } from './nativeGnosisSafeAppsHostSender.js'
import { getWebsiteSocketConnection, isTopFramePort } from './backgroundUtils.js'
import { getTabIfExists } from '../utils/requests.js'

import { getConfirmedSignerStateToken } from './signerStateOwnership.js'
import { getNativeGnosisSafeAppsSession, registerNativeGnosisSafeAppsSession, notifyNativeGnosisSafeAppsSessionConnections, waitForNativeGnosisSafeAppsSessionCondition, nativeGnosisSafeAppsPreparationFailure, registerNativeGnosisSafeAppsRole, getNativeGnosisSafeAppsAuthority } from './nativeGnosisSafeAppsSessions.js'


type NativeRegistration = {
	readonly frameOrigins: { readonly websiteOrigin: string, readonly requestOrigin: string }
	readonly isSignerOwner: boolean
	readonly properties: Record<string, never>
	readonly beforeRequest?: () => Promise<void>
	readonly registered?: () => void
}
// Signer readiness belongs to this exact root session, including when old and new documents temporarily share a tab URL.
async function waitForNativeSigner(connections: WebsiteTabConnections, tabId: number, hostPort: browser.runtime.Port) {
	await waitForNativeGnosisSafeAppsSessionCondition(connections, hostPort, () => {
		if (getNativeGnosisSafeAppsSession(connections, tabId)?.port !== hostPort) throw nativeGnosisSafeAppsPreparationFailure('The app session changed. Retry the connection.')
		const signer = getConfirmedSignerStateToken(connections, tabId)
		const child = signer === undefined ? undefined : getWebsiteSocketConnection(connections, signer.socket)
		const authority = child === undefined ? undefined : getNativeGnosisSafeAppsAuthority(connections, child.port)
		return authority?.kind === 'signer' && authority.host.port === hostPort ? signer : undefined
	}, 'The app wallet bridge is unavailable. Enable Interceptor and your wallet for this embedded site, then retry or open the website directly.')
}

// Only this browser boundary assigns native host/signer roles. Website-supplied messages never choose an origin or gain tab-wide signer ownership.
export async function getNativeGnosisSafeAppsConnectionRegistration(port: browser.runtime.Port, tabId: number, connections: WebsiteTabConnections): Promise<NativeRegistration | undefined> {
	const host = isTopFramePort(port) ? getNativeGnosisSafeAppsHostLaunch(port.sender) : undefined
	if (host !== undefined) {
		registerNativeGnosisSafeAppsSession(connections, tabId, port, host.appUrl.origin)
		registerNativeGnosisSafeAppsRole(connections, port, { kind: 'host' })
		return {
			frameOrigins: { websiteOrigin: host.appUrl.host, requestOrigin: host.appUrl.origin },
			isSignerOwner: false,
			registered: () => {
				if (getNativeGnosisSafeAppsSession(connections, tabId)?.port !== port) { port.disconnect(); return }
				port.postMessage({ type: NATIVE_GNOSIS_SAFE_APPS_SESSION_READY })
			},
			beforeRequest: async () => {
				if (getNativeGnosisSafeAppsSession(connections, tabId)?.port !== port) throw nativeGnosisSafeAppsPreparationFailure('The app session changed. Retry the connection.')
				const settings = await getSettings()
				if (!settings.simulationMode || settings.useSignersAddressAsActiveAddress) await waitForNativeSigner(connections, tabId, port)
			},
			properties: {},
		}
	}

	const extensionRoot = browser.runtime.getURL('')
	const hostPages = [getHtmlPageUrl('gnosisSafeAppsHost', extensionRoot, 2), getHtmlPageUrl('gnosisSafeAppsHost', extensionRoot, 3)]
	if (getAuthorizedNativeGnosisSafeAppsHostSenderUrl(port.sender, browser.runtime.id, hostPages) !== undefined) throw nativeGnosisSafeAppsPreparationFailure('Invalid app host session. Open the website directly and launch it again from Interceptor.')
	const child = getNativeGnosisSafeAppsChildLaunch(port.sender)
	if (child === undefined || port.sender?.frameId === undefined) return undefined
	const [frame, tab] = await Promise.all([browser.webNavigation.getFrame({ tabId, frameId: port.sender.frameId }), getTabIfExists(tabId)])
	if (frame?.parentFrameId !== 0 || new URL(frame.url).origin !== child.appUrl.origin || tab?.url !== port.sender.tab?.url) return undefined
	const session = await waitForNativeGnosisSafeAppsSessionCondition(connections, port, () => {
		const current = getNativeGnosisSafeAppsSession(connections, tabId)
		return current !== undefined && current.port.sender?.url === port.sender?.tab?.url && current.origin === child.appUrl.origin ? current : undefined
	}, 'The Gnosis Safe App host did not finish connecting. Retry the connection.')
	if ('documentId' in frame && 'documentId' in port.sender && typeof frame.documentId === 'string' && typeof port.sender.documentId === 'string' && frame.documentId !== port.sender.documentId) return undefined
	registerNativeGnosisSafeAppsRole(connections, port, { kind: 'signer', session })
	return { frameOrigins: { websiteOrigin: child.appUrl.host, requestOrigin: child.appUrl.origin }, isSignerOwner: true, registered: () => notifyNativeGnosisSafeAppsSessionConnections(connections), properties: {} }
}
