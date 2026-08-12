const interceptorInternalErrorDefinitions = [
	{ code: 'fetch_aborted', classification: 'failedToFetch' },
	{ code: 'fetch_timeout', classification: 'failedToFetch' },
	{ code: 'fetch_transport_failed', classification: 'failedToFetch' },
	{ code: 'safe_contract_validation', classification: 'safeValidation' },
	{ code: 'safe_message_account_mismatch', classification: 'safeValidation' },
	{ code: 'safe_owner_validation', classification: 'safeValidation' },
	{ code: 'safe_signer_selection', classification: 'safeValidation' },
] as const

type InterceptorInternalErrorDefinition = typeof interceptorInternalErrorDefinitions[number]
export type InterceptorInternalErrorCode = InterceptorInternalErrorDefinition['code']
export type InterceptorInternalErrorClassification = InterceptorInternalErrorDefinition['classification']

export function getErrorMessage(error: unknown) {
	if (error instanceof Error) return error.message
	if (typeof error === 'string') return error
	if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') return error.message
	return undefined
}

export function createInterceptorInternalError(message: string, interceptorErrorCode: InterceptorInternalErrorCode) {
	return Object.assign(new Error(message), { interceptorErrorCode })
}

function getInterceptorInternalErrorDefinition(error: unknown): InterceptorInternalErrorDefinition | undefined {
	if (typeof error !== 'object' || error === null || !('interceptorErrorCode' in error)) return undefined
	const code = error.interceptorErrorCode
	if (typeof code !== 'string') return undefined
	return interceptorInternalErrorDefinitions.find((definition) => definition.code === code)
}

export function getInterceptorInternalErrorCode(error: unknown): InterceptorInternalErrorCode | undefined {
	return getInterceptorInternalErrorDefinition(error)?.code
}

export function getInterceptorInternalErrorClassification(error: unknown): InterceptorInternalErrorClassification | undefined {
	return getInterceptorInternalErrorDefinition(error)?.classification
}

export function hasInterceptorInternalErrorCode<Code extends InterceptorInternalErrorCode>(error: unknown, code: Code): error is Error & { readonly interceptorErrorCode: Code } {
	return error instanceof Error && getInterceptorInternalErrorCode(error) === code
}

export function isBrowserFetchTransportError(error: unknown) {
	const message = getErrorMessage(error)
	if (message === undefined) return false
	if (message === 'Failed to fetch') return true
	if (message === 'NetworkError when attempting to fetch resource') return true
	return false
}
