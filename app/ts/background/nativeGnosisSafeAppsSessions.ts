import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { NATIVE_GNOSIS_SAFE_APPS_HOST_TIMING } from '../utils/nativeGnosisSafeAppsHostTiming.js'

type NativeSession = { readonly port: browser.runtime.Port, readonly origin: string }
const sessions = new WeakMap<WebsiteTabConnections, Map<number, NativeSession>>()
const listeners = new WeakMap<WebsiteTabConnections, Set<() => void>>()

export const nativeGnosisSafeAppsPreparationFailure = (message: string) => Object.assign(new Error(message), { code: 'native_gnosis_safe_apps_preparation_failed' as const })
export const isNativeGnosisSafeAppsPreparationError = (error: unknown): error is Error => error instanceof Error && 'code' in error && error.code === 'native_gnosis_safe_apps_preparation_failed'
export const getNativeGnosisSafeAppsSession = (connections: WebsiteTabConnections, tabId: number) => sessions.get(connections)?.get(tabId)

export function notifyNativeGnosisSafeAppsSessionConnections(connections: WebsiteTabConnections) {
	for (const listener of listeners.get(connections) ?? []) listener()
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
		let pending = listeners.get(connections)
		if (pending === undefined) { pending = new Set(); listeners.set(connections, pending) }
		const cleanup = () => { clearTimeout(timeout); pending.delete(check); port.onDisconnect.removeListener(disconnect) }
		const disconnect = () => { cleanup(); reject(nativeGnosisSafeAppsPreparationFailure('The app connection closed. Retry the connection.')) }
		const check = () => {
			try {
				const value = read()
				if (value !== undefined) { cleanup(); resolve(value) }
			} catch (error: unknown) { cleanup(); reject(error) }
		}
		const timeout = setTimeout(() => { cleanup(); reject(nativeGnosisSafeAppsPreparationFailure(message)) }, NATIVE_GNOSIS_SAFE_APPS_HOST_TIMING.signerStartupTimeoutMs)
		pending.add(check)
		port.onDisconnect.addListener(disconnect)
		check()
	})
}
