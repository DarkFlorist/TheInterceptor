export const NATIVE_GNOSIS_SAFE_APPS_SIGNER_REPLY = 'interceptor_native_gnosis_safe_app_signer'
export const NATIVE_GNOSIS_SAFE_APPS_SIGNER_CALLBACK = 'request_signer_to_native_gnosis_safe_app'

type SignerParameters = readonly unknown[] | Readonly<Record<string, unknown>>
export type NativeGnosisSafeAppsSignerRequest = {
	readonly token: string
	readonly signerProviderGeneration: number
	readonly request: { readonly method: string, readonly params?: SignerParameters }
}

type SignerCandidate = { readonly token?: unknown, readonly signerProviderGeneration?: unknown, readonly request?: unknown }
type RequestCandidate = { readonly method?: unknown, readonly params?: unknown }
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isSignerCandidate = (value: unknown): value is SignerCandidate => isRecord(value)
const isRequestCandidate = (value: unknown): value is RequestCandidate => isRecord(value)

// The token correlates an approved background request; the child never supplies its host request identity.
export function parseNativeGnosisSafeAppsSignerRequest(value: unknown): NativeGnosisSafeAppsSignerRequest | undefined {
	if (!isSignerCandidate(value) || typeof value.token !== 'string' || value.token.length === 0 || typeof value.signerProviderGeneration !== 'number' || !Number.isSafeInteger(value.signerProviderGeneration) || value.signerProviderGeneration < 0 || !isRequestCandidate(value.request) || typeof value.request.method !== 'string') return undefined
	const params = value.request.params
	if (params !== undefined && !Array.isArray(params) && !isRecord(params)) return undefined
	return { token: value.token, signerProviderGeneration: value.signerProviderGeneration, request: { method: value.request.method, ...(params === undefined ? {} : { params }) } }
}

export function parseNativeGnosisSafeAppsSignerReplyToken(value: unknown) {
	return isSignerCandidate(value) && typeof value.token === 'string' ? value.token : undefined
}
