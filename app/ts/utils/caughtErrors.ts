export type InterceptorInternalErrorClassification = 'failedToFetch' | 'handled'

type InterceptorInternalErrorDefinition = {
	readonly code: string
	readonly classification: InterceptorInternalErrorClassification
}

export function getErrorMessage(error: unknown) {
	if (error instanceof Error) return error.message
	if (typeof error === 'string') return error
	if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') return error.message
	return undefined
}

export function createInterceptorInternalError<Code extends string>(message: string, interceptorErrorCode: Code, interceptorErrorClassification: InterceptorInternalErrorClassification) {
	return Object.assign(new Error(message), { interceptorErrorCode, interceptorErrorClassification })
}

function getInterceptorInternalErrorDefinition(error: unknown): InterceptorInternalErrorDefinition | undefined {
	if (typeof error !== 'object' || error === null || !('interceptorErrorCode' in error)) return undefined
	const code = error.interceptorErrorCode
	if (typeof code !== 'string') return undefined
	if ('interceptorErrorClassification' in error) {
		const classification = error.interceptorErrorClassification
		if (classification === 'failedToFetch' || classification === 'handled') return { code, classification }
	}
	return undefined
}

export function getInterceptorInternalErrorCode(error: unknown): string | undefined {
	return getInterceptorInternalErrorDefinition(error)?.code
}

export function getInterceptorInternalErrorClassification(error: unknown): InterceptorInternalErrorClassification | undefined {
	return getInterceptorInternalErrorDefinition(error)?.classification
}

export function hasInterceptorInternalErrorCode<Code extends string>(error: unknown, code: Code): error is Error & { readonly interceptorErrorCode: Code } {
	return error instanceof Error && getInterceptorInternalErrorCode(error) === code
}

export function isBrowserFetchTransportError(error: unknown) {
	const message = getErrorMessage(error)
	if (message === undefined) return false
	if (message === 'Failed to fetch') return true
	if (message === 'NetworkError when attempting to fetch resource') return true
	return false
}
