import { registerSignerAuthorityCheck } from './signerStateOwnership.js'
import { notifyWebsiteLifecycle, observeWebsiteSessionChanges } from './websiteLifecycle.js'
import { getSocketFromPort, getWebsiteSocketConnection } from './backgroundUtils.js'
import { getNativeGnosisSafeAppsChildLaunch, getNativeGnosisSafeAppsHostLaunch } from './nativeGnosisSafeAppsHostSender.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { NATIVE_GNOSIS_SAFE_APPS_HOST_TIMING } from '../utils/nativeGnosisSafeAppsHostTiming.js'

type NativeSession = { readonly port: browser.runtime.Port, readonly origin: string }
const sessions = new WeakMap<WebsiteTabConnections, Map<number, NativeSession>>()
// Captured sessions authenticate root/child relationships; signerStateOwner owns wallet selection and generation. Private correlation and historical claims survive wallet changes without granting wallet authority.

export const nativeGnosisSafeAppsPreparationFailure = (message: string) => Object.assign(new Error(message), { code: 'native_gnosis_safe_apps_preparation_failed' as const })
export const isNativeGnosisSafeAppsPreparationError = (error: unknown): error is Error => error instanceof Error && 'code' in error && error.code === 'native_gnosis_safe_apps_preparation_failed'
export const getNativeGnosisSafeAppsSession = (connections: WebsiteTabConnections, tabId: number) => sessions.get(connections)?.get(tabId)

export function notifyNativeGnosisSafeAppsSessionConnections(connections: WebsiteTabConnections) {
	notifyWebsiteLifecycle(connections.lifecycle?.sessionChanged)
}

// Reloads may overlap old and new ports with identical URLs. The current root port, not its URL, owns the session and its signer children.
export function registerNativeGnosisSafeAppsSession(connections: WebsiteTabConnections, tabId: number, port: browser.runtime.Port, origin: string) {
	let byTab = sessions.get(connections)
	if (byTab === undefined) { byTab = new Map(); sessions.set(connections, byTab) }
	const session = { port, origin }
	byTab.set(tabId, session)
	const disconnect = () => {
		if (byTab.get(tabId) === session) byTab.delete(tabId)
		port.onDisconnect.removeListener(disconnect)
		notifyNativeGnosisSafeAppsSessionConnections(connections)
	}
	port.onDisconnect.addListener(disconnect)
	notifyNativeGnosisSafeAppsSessionConnections(connections)
}

export async function waitForNativeGnosisSafeAppsSessionCondition<T>(connections: WebsiteTabConnections, port: browser.runtime.Port, read: () => T | undefined, message: string): Promise<T> {
	const current = read()
	if (current !== undefined) return current
	return await new Promise<T>((resolve, reject) => {
		let unsubscribe: (() => void) | undefined
		const cleanup = () => { clearTimeout(timeout); unsubscribe?.(); port.onDisconnect.removeListener(disconnect) }
		const disconnect = () => { cleanup(); reject(nativeGnosisSafeAppsPreparationFailure('The app connection closed. Retry the connection.')) }
		const check = () => {
			try {
				const value = read()
				if (value !== undefined) { cleanup(); resolve(value) }
			} catch (error: unknown) { cleanup(); reject(error) }
		}
		const timeout = setTimeout(() => { cleanup(); reject(nativeGnosisSafeAppsPreparationFailure(message)) }, NATIVE_GNOSIS_SAFE_APPS_HOST_TIMING.signerStartupTimeoutMs)
		unsubscribe = observeWebsiteSessionChanges(connections, check)
		port.onDisconnect.addListener(disconnect)
		check()
	})
}

// Keep historical child claims after retirement so they cannot fall through as ordinary iframe callbacks.
const roles = new WeakMap<WebsiteTabConnections, WeakMap<browser.runtime.Port, { readonly kind: 'host' } | { readonly kind: 'signer', readonly session: NativeSession }>>()
export function registerNativeGnosisSafeAppsRole(connections: WebsiteTabConnections, port: browser.runtime.Port, role: { readonly kind: 'host' } | { readonly kind: 'signer', readonly session: NativeSession }) {
	let registry = roles.get(connections)
	if (registry === undefined) { registry = new WeakMap(); roles.set(connections, registry) }
	registry.set(port, role)
	registerSignerAuthorityCheck(port, () => {
		const authority = getNativeGnosisSafeAppsAuthority(connections, port)
		return authority.kind === 'host' || authority.kind === 'signer'
	})
}

export function getNativeGnosisSafeAppsAuthority(connections: WebsiteTabConnections, port: browser.runtime.Port) {
	const role = roles.get(connections)?.get(port)
	if (role === undefined) return { kind: 'ordinary' as const }
	const socket = getSocketFromPort(port)
	const connection = socket === undefined ? undefined : getWebsiteSocketConnection(connections, socket)
	const session = socket === undefined ? undefined : getNativeGnosisSafeAppsSession(connections, socket.tabId)
	const hostSocket = session === undefined ? undefined : getSocketFromPort(session.port)
	const host = hostSocket === undefined ? undefined : getWebsiteSocketConnection(connections, hostSocket)
	const hostLaunch = session === undefined ? undefined : getNativeGnosisSafeAppsHostLaunch(session.port.sender)
	const currentHost = host !== undefined && host.port === session?.port && roles.get(connections)?.get(host.port)?.kind === 'host'
		&& hostLaunch?.appUrl.origin === session?.origin && host.websiteOrigin === hostLaunch?.appUrl.host
	if (role.kind === 'host') return currentHost && connection === host ? { kind: 'host' as const, host } : { kind: 'staleHost' as const }
	const launch = getNativeGnosisSafeAppsChildLaunch(port.sender)
	if (!currentHost || connection?.port !== port || role.session !== session || launch === undefined
		|| launch.appUrl.origin !== session.origin || launch.appUrl.href !== hostLaunch?.appUrl.href
		|| connection.websiteOrigin !== host.websiteOrigin || socket?.tabId !== host.socket.tabId) return { kind: 'staleSigner' as const }
	return { kind: 'signer' as const, host, child: connection }
}
