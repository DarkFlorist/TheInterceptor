// Shared wire contract for parent-host adaptation and Settings connection preparation.
export type SafeAppsRequest = { readonly id: string, readonly method: string, readonly env: { readonly sdkVersion: string } }
export type SafeAppsResponse = { readonly id: string, readonly success: boolean, readonly error?: unknown }

export function createSafeAppsRequest(id: string, method: string): SafeAppsRequest {
	return { id, method, env: { sdkVersion: '9.1.0' } }
}

export function isSafeAppsRequest(value: unknown): value is SafeAppsRequest {
	if (typeof value !== 'object' || value === null || !('id' in value) || typeof value.id !== 'string' || !('method' in value) || typeof value.method !== 'string') return false
	if (!('env' in value) || typeof value.env !== 'object' || value.env === null || !('sdkVersion' in value.env)) return false
	return typeof value.env.sdkVersion === 'string' && /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(value.env.sdkVersion)
}

export function isSafeAppsResponse(value: unknown): value is SafeAppsResponse {
	return typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string' && 'success' in value && typeof value.success === 'boolean'
}

export function createSafeAppsErrorResponse(request: SafeAppsRequest, error: string) {
	return { id: request.id, success: false, error, version: request.env.sdkVersion }
}
