import safeAppsPreparationMessages from '../../shared/safeAppsPreparationMessages.json'

// Canonical SDK envelope used by the provider, parent host and Settings preparation.
export const SAFE_APPS_RESPONSE_VERSION = '9.1.0'
export const SAFE_APPS_PENDING_REQUEST_LIMIT = 32
export const SAFE_APPS_REQUEST_TIMEOUT_MS = 5 * 60_000
export const SAFE_APPS_PREPARATION_TIMEOUT_MS = 30_000
export const SAFE_APPS_PREPARATION_CANCEL_EVENT = 'interceptor-cancel-safe-preparation'
export const SAFE_APPS_PREPARATION_CANCEL_MARKER = 'interceptorSafePreparationCancelled'
export const SAFE_APPS_PREPARATION_CANCEL_MESSAGE = safeAppsPreparationMessages.cancelled
export type SafeAppsRequest = { readonly id: string, readonly method: string, readonly params?: unknown, readonly env: { readonly sdkVersion: string }, readonly bridgeToken?: string }
export type ParsedSafeAppsRequest = { readonly id: string, readonly request: SafeAppsRequest } | { readonly id: string, readonly error: string }
export type SafeAppsResponse = { readonly id: string, readonly success: boolean, readonly error?: unknown, readonly bridgeToken?: string }

export function createSafeAppsRequest(id: string, method: string): SafeAppsRequest {
	return { id, method, env: { sdkVersion: SAFE_APPS_RESPONSE_VERSION } }
}

export function parseSafeAppsRequest(data: unknown): ParsedSafeAppsRequest | undefined {
	if (typeof data !== 'object' || data === null || !('id' in data) || typeof data.id !== 'string') return undefined
	// An SDK envelope distinguishes requests from unrelated page postMessage protocols.
	if (!('env' in data) || typeof data.env !== 'object' || data.env === null) return undefined
	if (!('sdkVersion' in data.env) || typeof data.env.sdkVersion !== 'string' || !/^[1-9][0-9]*\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(data.env.sdkVersion)) return { id: data.id, error: 'Safe Apps env.sdkVersion must be a supported semantic version.' }
	if (!('method' in data) || typeof data.method !== 'string') return { id: data.id, error: 'Safe Apps method must be a string.' }
	return { id: data.id, request: { id: data.id, method: data.method, env: { sdkVersion: data.env.sdkVersion }, ...('params' in data && data.params !== undefined ? { params: data.params } : {}), ...('bridgeToken' in data && typeof data.bridgeToken === 'string' ? { bridgeToken: data.bridgeToken } : {}) } }
}

export function isSafeAppsRequest(value: unknown): value is SafeAppsRequest {
	const parsed = parseSafeAppsRequest(value)
	return parsed !== undefined && 'request' in parsed
}

export function isSafeAppsResponse(value: unknown): value is SafeAppsResponse {
	return typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string' && 'success' in value && typeof value.success === 'boolean' && (!('bridgeToken' in value) || typeof value.bridgeToken === 'string')
}

export function createSafeAppsErrorResponse(request: { readonly id: string, readonly bridgeToken?: string }, error: string) {
	return { id: request.id, success: false, error, version: SAFE_APPS_RESPONSE_VERSION, ...(request.bridgeToken === undefined ? {} : { bridgeToken: request.bridgeToken }) }
}

// Internal transport cleanup, not an SDK method. The provider accepts it only from its own window/origin.
export function createSafeAppsCancellation(id: string, bridgeToken?: string) {
	return { type: 'interceptor_safe_apps_cancel', id, ...(bridgeToken === undefined ? {} : { bridgeToken }) }
}

export function isSafeAppsCancellation(value: unknown): value is { readonly type: 'interceptor_safe_apps_cancel', readonly id: string, readonly bridgeToken?: string } {
	return typeof value === 'object' && value !== null && 'type' in value && value.type === 'interceptor_safe_apps_cancel' && 'id' in value && typeof value.id === 'string' && (!('bridgeToken' in value) || typeof value.bridgeToken === 'string')
}
