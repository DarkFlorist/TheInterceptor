import { sendPopupMessageToOpenWindows } from '../background/backgroundUtils.js'
import { setLatestUnexpectedError } from '../background/storageVariables.js'
import { InterceptorError, type JsonRpcErrorResponse } from '../types/JsonRpc-types.js'
import { NEW_BLOCK_ABORT } from './constants.js'

export const GENERIC_UNEXPECTED_ERROR_MESSAGE = 'An internal Interceptor error occurred. Please see The Interceptor console for technical details.'

type UnexpectedErrorMetadata = {
	source?: string
	code?: string
	debugId?: string
}

export class ErrorWithData extends Error {
	public constructor(
		message: string,
		public data: unknown,
	) {
		super(message)
		Object.setPrototypeOf(this, ErrorWithData.prototype)
	}
}

export class JsonRpcResponseError extends Error {
	public readonly id: string | number
	public readonly code: number
	public readonly data: string | undefined
	public constructor(jsonRpcResponse: JsonRpcErrorResponse) {
		super(jsonRpcResponse.error.message)
		this.code = jsonRpcResponse.error.code
		this.id = jsonRpcResponse.id
		this.data = jsonRpcResponse.error.data
		Object.setPrototypeOf(this, JsonRpcResponseError.prototype)
	}
	public serialize() {
		return {
			jsonrpc: '2.0' as const,
			id: this.id,
			error: {
				message: this.message,
				code: this.code,
				...(this.data !== undefined ? { data: this.data } : {}),
			},
		}
	}
}

export function isFailedToFetchError(error: Error) {
	if (error.message.includes('Fetch request timed out.') || error.message.includes('Failed to fetch') || error.message.includes('NetworkError when attempting to fetch resource')) return true
	return false
}

export const isNewBlockAbort = (error: Error) => error.message?.includes(NEW_BLOCK_ABORT)

function summarizeUnknownData(value: unknown): string {
	if (typeof value === 'string') return `[redacted string length=${value.length}]`
	if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return `[redacted ${typeof value}]`
	if (value === undefined) return '[undefined]'
	if (value instanceof Uint8Array) return `[redacted Uint8Array length=${value.length}]`
	if (Array.isArray(value)) return `[redacted array length=${value.length}]`
	if (typeof value === 'object') {
		const keys = Object.keys(value ?? {})
		return `[redacted object keys=${keys.slice(0, 8).join(',')}${keys.length > 8 ? ',…' : ''}]`
	}
	return '[redacted]'
}

export function summarizeRequestForLogging(request: unknown) {
	if (typeof request !== 'object' || request === null) return { type: typeof request }
	const candidate = request as {
		method?: unknown
		requestId?: unknown
		interceptorRequest?: unknown
		usingInterceptorWithoutSigner?: unknown
		params?: unknown
		interceptorInternalRequest?: unknown
		internal?: unknown
	}
	return {
		method: typeof candidate.method === 'string' ? candidate.method : undefined,
		requestId: typeof candidate.requestId === 'number' ? candidate.requestId : undefined,
		interceptorRequest: candidate.interceptorRequest === true,
		usingInterceptorWithoutSigner: candidate.usingInterceptorWithoutSigner === true,
		hasParams: Array.isArray(candidate.params),
		paramCount: Array.isArray(candidate.params) ? candidate.params.length : undefined,
		internal: candidate.interceptorInternalRequest === true || candidate.internal === true,
	}
}

function getForwardedDiagnostics(error: unknown): string | undefined {
	const maybeInterceptorError = InterceptorError.safeParse(error)
	if (!maybeInterceptorError.success) return undefined
	return maybeInterceptorError.value.params[0]
}

function normalizeUnexpectedError(error: unknown) {
	if (typeof error === 'object' && error !== null && 'message' in error && error.message !== undefined && typeof error.message === 'string') {
		return { message: error.message }
	}
	return { message: GENERIC_UNEXPECTED_ERROR_MESSAGE }
}

export function printError(error: unknown) {
	console.error(error)
	const forwardedDiagnostics = getForwardedDiagnostics(error)
	if (forwardedDiagnostics !== undefined) console.error('forwarded diagnostics:', summarizeUnknownData(forwardedDiagnostics))
	if (error instanceof Error) {
		try {
			if ('data' in error) console.error('data: ', summarizeUnknownData(error.data))
			if ('code' in error) console.error('code: ', summarizeUnknownData(error.code))
		} catch (stringifyError) {
			console.error(stringifyError)
		}
	}
}

function generateDebugId() {
	return globalThis.crypto.randomUUID().slice(0, 8)
}

export async function handleUnexpectedError(error: unknown, metadata: UnexpectedErrorMetadata = {}) {
	const debugId = metadata.debugId ?? generateDebugId()
	console.error('Unexpected Interceptor error', {
		debugId,
		source: metadata.source ?? 'internal',
		code: metadata.code ?? 'unexpected_error',
	})
	printError(error)
	console.trace()
	const normalizedError = normalizeUnexpectedError(error)
	const errorMessage = {
		method: 'popup_UnexpectedErrorOccured' as const,
		data: {
			timestamp: new Date(),
			message: normalizedError.message,
			source: metadata.source ?? 'internal',
			code: metadata.code ?? 'unexpected_error',
			debugId,
		},
	}
	await setLatestUnexpectedError(errorMessage)
	await sendPopupMessageToOpenWindows(errorMessage)
}
