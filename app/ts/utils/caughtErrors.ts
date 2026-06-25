export type InterceptorInternalErrorCode =
	| 'fetch_aborted'
	| 'fetch_timeout'
	| 'fetch_transport_failed'

const interceptorInternalErrorCodes: readonly InterceptorInternalErrorCode[] = [
	'fetch_aborted',
	'fetch_timeout',
	'fetch_transport_failed',
]

export function getErrorMessage(error: unknown) {
	if (error instanceof Error) return error.message
	if (typeof error === 'string') return error
	if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') return error.message
	return undefined
}

export function createInterceptorInternalError(message: string, interceptorErrorCode: InterceptorInternalErrorCode) {
	return Object.assign(new Error(message), { interceptorErrorCode })
}

export function getInterceptorInternalErrorCode(error: unknown): InterceptorInternalErrorCode | undefined {
	if (typeof error !== 'object' || error === null || !('interceptorErrorCode' in error)) return undefined
	const code = error.interceptorErrorCode
	if (typeof code !== 'string') return undefined
	return interceptorInternalErrorCodes.find((knownCode) => knownCode === code)
}

export function isBrowserFetchTransportError(error: unknown) {
	const message = getErrorMessage(error)
	if (message === undefined) return false
	if (message === 'Failed to fetch') return true
	if (message === 'NetworkError when attempting to fetch resource') return true
	return false
}
