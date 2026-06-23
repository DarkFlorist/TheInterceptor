import { sendPopupMessageToOpenWindowsWithoutUnexpectedErrorReport } from '../background/backgroundUtils.js'
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
	public constructor(message: string, public data: unknown) {
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

export function getErrorMessage(error: unknown) {
	if (error instanceof Error) return error.message
	if (typeof error === 'string') return error
	if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') return error.message
	return undefined
}

export function isFailedToFetchError(error: unknown) {
	const message = getErrorMessage(error)
	if (message === undefined) return false
	if (message.includes('Fetch request timed out.') || message.includes('Fetch request aborted.') || message.includes('Failed to fetch') || message.includes('NetworkError when attempting to fetch resource')) return true
	return false
}

export const isNewBlockAbort = (error: unknown) => getErrorMessage(error) === NEW_BLOCK_ABORT

export const isWrappedNewBlockAbort = (error: unknown) => {
	const message = getErrorMessage(error)
	return message !== undefined && message !== NEW_BLOCK_ABORT && message.includes(NEW_BLOCK_ABORT)
}

export type CaughtErrorClassification = 'newBlockAbort' | 'failedToFetch' | 'unexpected'

export function classifyCaughtError(error: unknown): CaughtErrorClassification {
	if (isNewBlockAbort(error)) return 'newBlockAbort'
	if (isFailedToFetchError(error)) return 'failedToFetch'
	return 'unexpected'
}

export const isExpectedInfrastructureError = (error: unknown) => classifyCaughtError(error) !== 'unexpected'

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
	if (forwardedDiagnostics !== undefined) console.error('forwarded diagnostics:', forwardedDiagnostics)
	if (error instanceof Error) {
		try {
			if ('data' in error) console.error('data: ', JSON.stringify(error.data))
			if ('code' in error) console.error('code: ', JSON.stringify(error.code))
		} catch(stringifyError) {
			console.error(stringifyError)
		}
	}
}

function generateDebugId() {
	return globalThis.crypto.randomUUID().slice(0, 8)
}

export async function handleUnexpectedError(error: unknown, metadata: UnexpectedErrorMetadata = {}) {
	if (isNewBlockAbort(error)) return
	const debugId = metadata.debugId ?? generateDebugId()
	const source = metadata.source ?? 'internal'
	const code = metadata.code ?? (isWrappedNewBlockAbort(error) ? 'wrapped_new_block_abort' : 'unexpected_error')
	console.error('Unexpected Interceptor error', { debugId, source, code })
	printError(error)
	console.trace()
	const normalizedError = normalizeUnexpectedError(error)
	const errorMessage = {
		method: 'popup_UnexpectedErrorOccured' as const,
		data: {
			timestamp: new Date(),
			message: normalizedError.message,
			source,
			code,
			debugId,
		}
	}
	try {
		await setLatestUnexpectedError(errorMessage)
	} catch (storageError: unknown) {
		console.error('Failed to persist unexpected error.')
		printError(storageError)
		return
	}
	try {
		await sendPopupMessageToOpenWindowsWithoutUnexpectedErrorReport(errorMessage)
	} catch (broadcastError: unknown) {
		console.error('Failed to broadcast unexpected error to open popup windows.')
		printError(broadcastError)
	}
}
