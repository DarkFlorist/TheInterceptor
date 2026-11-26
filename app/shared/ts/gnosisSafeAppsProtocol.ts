// Canonical SDK envelope and policy for provider, native host, and original-tab relay.
export const GNOSIS_SAFE_APPS_RESPONSE_VERSION = '9.1.0'
export const GNOSIS_SAFE_APPS_NATIVE_SOURCE_REQUEST = 'interceptor_native_gnosis_safe_source_request'
export const GNOSIS_SAFE_APPS_PENDING_REQUEST_LIMIT = 32
// Eligibility discovery can wait for permissions; the already-prepared native source relay uses a shorter round-trip deadline.
export const GNOSIS_SAFE_APPS_REQUEST_TIMEOUT_MS = 5 * 60_000
export const GNOSIS_SAFE_APPS_SOURCE_DISCOVERY_TIMEOUT_MS = 30_000
export type GnosisSafeAppsRequest = { readonly id: string, readonly method: string, readonly params?: unknown, readonly env: { readonly sdkVersion: string } }
export type ParsedGnosisSafeAppsRequest = { readonly id: string, readonly request: GnosisSafeAppsRequest } | { readonly id: string, readonly error: string }
export type GnosisSafeAppsResponse = { readonly id: string, readonly success: boolean, readonly data?: unknown, readonly error?: unknown, readonly version?: string }

// Read-only startup queries. Only these may be retried, replayed after eligibility changes, or expired: every other method can reach the background, wait for user approval and still complete after any deadline.
export const isGnosisSafeAppsDiscoveryMethod = (method: string) => method === 'getSafeInfo' || method === 'getChainInfo' || method === 'getEnvironmentInfo'

export function createGnosisSafeAppsRequest(id: string, method: string): GnosisSafeAppsRequest {
	return { id, method, env: { sdkVersion: GNOSIS_SAFE_APPS_RESPONSE_VERSION } }
}

export function parseGnosisSafeAppsRequest(data: unknown): ParsedGnosisSafeAppsRequest | undefined {
	if (typeof data !== 'object' || data === null || !('id' in data) || typeof data.id !== 'string') return undefined
	// An SDK envelope distinguishes requests from unrelated page postMessage protocols.
	if (!('env' in data) || typeof data.env !== 'object' || data.env === null) return undefined
	if (!('sdkVersion' in data.env) || typeof data.env.sdkVersion !== 'string' || !/^[1-9][0-9]*\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(data.env.sdkVersion)) return { id: data.id, error: 'Gnosis Safe Apps env.sdkVersion must be a supported semantic version.' }
	if (!('method' in data) || typeof data.method !== 'string') return { id: data.id, error: 'Gnosis Safe Apps method must be a string.' }
	return { id: data.id, request: { id: data.id, method: data.method, env: { sdkVersion: data.env.sdkVersion }, ...('params' in data && data.params !== undefined ? { params: data.params } : {}) } }
}

export function isGnosisSafeAppsRequest(value: unknown): value is GnosisSafeAppsRequest {
	const parsed = parseGnosisSafeAppsRequest(value)
	return parsed !== undefined && 'request' in parsed
}

export function parseGnosisSafeAppsResponse(value: unknown): GnosisSafeAppsResponse | undefined {
	if (typeof value !== 'object' || value === null || !('id' in value) || typeof value.id !== 'string' || !('success' in value) || typeof value.success !== 'boolean') return undefined
	return { id: value.id, success: value.success, ...('data' in value ? { data: value.data } : {}), ...('error' in value ? { error: value.error } : {}), ...('version' in value && typeof value.version === 'string' ? { version: value.version } : {}) }
}

export function isGnosisSafeAppsResponse(value: unknown): value is GnosisSafeAppsResponse {
	return parseGnosisSafeAppsResponse(value) !== undefined
}

export function createGnosisSafeAppsErrorResponse(request: { readonly id: string }, error: string) {
	return { id: request.id, success: false, error, version: GNOSIS_SAFE_APPS_RESPONSE_VERSION }
}
