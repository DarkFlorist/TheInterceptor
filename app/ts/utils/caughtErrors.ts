export type InterceptorInternalErrorClassification = 'failedToFetch' | 'handled'

type InterceptorInternalErrorDefinition = {
	readonly code: string
	readonly classification: InterceptorInternalErrorClassification
}

export function getErrorMessage(error: unknown) {
	try {
		if (error instanceof Error) return error.message
		if (typeof error === 'string') return error
		if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') return error.message
		return undefined
	} catch {
		// A broken message getter is preserved by the diagnostic snapshot instead.
		return undefined
	}
}

export function createInterceptorInternalError<Code extends string>(message: string, interceptorErrorCode: Code, interceptorErrorClassification: InterceptorInternalErrorClassification) {
	return Object.assign(new Error(message), { interceptorErrorCode, interceptorErrorClassification })
}

function getInterceptorInternalErrorDefinition(error: unknown): InterceptorInternalErrorDefinition | undefined {
	if (typeof error !== 'object' || error === null) return undefined
	try {
		const code = Object.getOwnPropertyDescriptor(error, 'interceptorErrorCode')?.value
		if (typeof code !== 'string') return undefined
		const classification = Object.getOwnPropertyDescriptor(error, 'interceptorErrorClassification')?.value
		if (classification === 'failedToFetch' || classification === 'handled') return { code, classification }
		return undefined
	} catch {
		// Unreadable classification fields leave the error reportable as unexpected.
		return undefined
	}
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
