import type { Settings } from '../types/interceptor-messages.js'
import { createRpcConfigurationUnavailableError } from '../utils/rpcConfigurationError.js'
import { getSettingsSnapshot, type SettingsSnapshot } from './settings.js'

const readyRpcConfigurationMarker = Symbol('readyRpcConfiguration')
// Settings read while the RPC configuration was ready. Network-backed operations and access decisions require this projection.
export type ReadyRpcSettings = Settings & { readonly [readyRpcConfigurationMarker]: true }

// Projection for decisions that must treat every unavailable RPC configuration alike, such as granting access or choosing how tabs are blocked: settings only while the RPC configuration is ready.
export function settingsIfRpcConfigurationReady(snapshot: SettingsSnapshot): ReadyRpcSettings | undefined {
	if (snapshot.rpcConfiguration.status !== 'ready' || snapshot.status !== 'active-network-readable') return undefined
	return { ...snapshot.settings, [readyRpcConfigurationMarker]: true }
}

// Network-backed operations use this admission reader. A decoded network alone is insufficient.
export async function requireRpcReadySettings(): Promise<ReadyRpcSettings> {
	const settings = settingsIfRpcConfigurationReady(await getSettingsSnapshot())
	if (settings === undefined) throw createRpcConfigurationUnavailableError()
	return settings
}
