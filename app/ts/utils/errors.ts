import { sendPopupMessageToOpenWindows } from '../background/backgroundUtils.js'
import { setLatestUnexpectedError } from '../background/storageVariables.js'
import { ForwardedDiagnostics } from '../types/error.js'
import { InterceptorError, JsonRpcErrorResponse } from '../types/JsonRpc-types.js'
import { NEW_BLOCK_ABORT } from './constants.js'

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

export function isFailedToFetchError(error: Error) {
	if (error.message.includes('Fetch request timed out.') || error.message.includes('Failed to fetch') || error.message.includes('NetworkError when attempting to fetch resource')) return true
	return false
}

export const isNewBlockAbort = (error: Error) => error.message?.includes(NEW_BLOCK_ABORT)

function getForwardedDiagnostics(error: unknown): ForwardedDiagnostics | undefined {
	const maybeInterceptorError = InterceptorError.safeParse(error)
	if (!maybeInterceptorError.success) return undefined
	return maybeInterceptorError.value.params[0]
}

function formatForwardedDiagnosticsMessage(forwardedDiagnostics: ForwardedDiagnostics) {
	return [
		`${ forwardedDiagnostics.source }: ${ forwardedDiagnostics.message }`,
		`phase: ${ forwardedDiagnostics.phase }`,
		...(forwardedDiagnostics.requestMethod !== undefined ? [`requestMethod: ${ forwardedDiagnostics.requestMethod }`] : []),
		...(forwardedDiagnostics.requestId !== undefined ? [`requestId: ${ forwardedDiagnostics.requestId }`] : []),
		...(forwardedDiagnostics.name !== undefined ? [`name: ${ forwardedDiagnostics.name }`] : []),
		...(forwardedDiagnostics.code !== undefined ? [`code: ${ forwardedDiagnostics.code }`] : []),
		...(forwardedDiagnostics.data !== undefined ? [`data: ${ forwardedDiagnostics.data }`] : []),
		...(forwardedDiagnostics.cause !== undefined ? [`cause: ${ forwardedDiagnostics.cause }`] : []),
		...(forwardedDiagnostics.stack !== undefined ? [`stack:\n${ forwardedDiagnostics.stack }`] : []),
		...(forwardedDiagnostics.raw !== undefined ? [`raw:\n${ forwardedDiagnostics.raw }`] : []),
	].join('\n\n')
}

function normalizeUnexpectedError(error: unknown) {
	const forwardedDiagnostics = getForwardedDiagnostics(error)
	if (forwardedDiagnostics !== undefined) return { message: formatForwardedDiagnosticsMessage(forwardedDiagnostics) }
	if (typeof error === 'object' && error !== null && 'message' in error && error.message !== undefined && typeof error.message === 'string') {
		return { message: error.message }
	}
	return { message: 'Please see The Interceptors console for more details on the error.' }
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

export async function handleUnexpectedError(error: unknown) {
	printError(error)
	console.trace()
	const normalizedError = normalizeUnexpectedError(error)
	const errorMessage = {
		method: 'popup_UnexpectedErrorOccured' as const,
		data: {
			timestamp: new Date(),
			message: normalizedError.message,
		}
	}
	await setLatestUnexpectedError(errorMessage)
	await sendPopupMessageToOpenWindows(errorMessage)
}
