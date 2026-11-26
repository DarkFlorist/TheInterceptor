import type { GnosisSafeAppsRequest, GnosisSafeAppsResponse } from './gnosisSafeAppsProtocol.js'

type GnosisSafeAppsCancellation = { readonly type: 'interceptor_safe_apps_cancel', readonly id: string }
type BridgeEnvelope = GnosisSafeAppsRequest | GnosisSafeAppsResponse | GnosisSafeAppsCancellation
export type GnosisSafeAppsBridgeMessage<Envelope = BridgeEnvelope> = { readonly type: 'interceptor_gnosis_safe_apps_bridge', readonly bridgeToken: string, readonly envelope: Envelope }

// Correlation belongs only to the original tab's own-window channel. Native app boundaries exchange the nested SDK envelope, never this wrapper.
export function createGnosisSafeAppsBridgeMessage<Envelope extends BridgeEnvelope>(envelope: Envelope, bridgeToken: string): GnosisSafeAppsBridgeMessage<Envelope> {
	return { type: 'interceptor_gnosis_safe_apps_bridge', bridgeToken, envelope }
}

export function parseGnosisSafeAppsBridgeMessage(value: unknown): GnosisSafeAppsBridgeMessage<unknown> | undefined {
	if (typeof value !== 'object' || value === null || !('type' in value) || value.type !== 'interceptor_gnosis_safe_apps_bridge' || !('bridgeToken' in value) || typeof value.bridgeToken !== 'string' || !('envelope' in value)) return undefined
	return { type: 'interceptor_gnosis_safe_apps_bridge', bridgeToken: value.bridgeToken, envelope: value.envelope }
}

export function createGnosisSafeAppsCancellation(id: string): GnosisSafeAppsCancellation {
	return { type: 'interceptor_safe_apps_cancel', id }
}

export function isGnosisSafeAppsCancellation(value: unknown): value is GnosisSafeAppsCancellation {
	return typeof value === 'object' && value !== null && 'type' in value && value.type === 'interceptor_safe_apps_cancel' && 'id' in value && typeof value.id === 'string'
}

// Runtime-message result from the original tab, not an SDK response. Plain data survives both MV2/MV3 serialization; Error properties do not reliably cross that boundary.
export type NativeGnosisSafeAppsSourceDisconnected = { readonly type: 'interceptor_gnosis_safe_apps_source_disconnected', readonly id: string }
export type NativeGnosisSafeAppsSourceReply = GnosisSafeAppsResponse | NativeGnosisSafeAppsSourceDisconnected

export function createNativeGnosisSafeAppsSourceDisconnected(id: string): NativeGnosisSafeAppsSourceDisconnected {
	return { type: 'interceptor_gnosis_safe_apps_source_disconnected', id }
}

export function isNativeGnosisSafeAppsSourceDisconnected(value: unknown): value is NativeGnosisSafeAppsSourceDisconnected {
	return typeof value === 'object' && value !== null && 'type' in value && value.type === 'interceptor_gnosis_safe_apps_source_disconnected' && 'id' in value && typeof value.id === 'string'
}
