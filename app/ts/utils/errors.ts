import { sendPopupMessageToOpenWindows } from '../background/backgroundUtils.js'
import { setLatestUnexpectedError } from '../background/storageVariables.js'
import { JsonRpcErrorResponse } from '../types/JsonRpc-types.js'
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
		return { jsonrpc: '2.0' as const, id: this.id, error: { message: this.message, code: this.code, data: this.data } }
	}
}

export function isFailedToFetchError(error: Error) {
	if (error.message.includes('Fetch request timed out.') || error.message.includes('Failed to fetch') || error.message.includes('NetworkError when attempting to fetch resource')) return true
	return false
}

export const isNewBlockAbort = (error: Error) => error.message?.includes(NEW_BLOCK_ABORT)

export function printError(error: unknown) {
	if (error instanceof Error) {
		try {
			if ('data' in error) return console.error(`Error: ${ error.message }\n${ JSON.stringify(error.data) }\n${ error.stack !== undefined ? error.stack : ''}`)
			return console.error(`Error: ${ error.message }\n${ error.stack || ''}`)
		} catch(stringifyError) {
			console.error(stringifyError)
		}
	}
	return console.error(error)
}

export async function handleUnexpectedError(error: unknown) {
	printError(error)
	console.trace()
	const errorMessage = {
		method: 'popup_UnexpectedErrorOccured' as const,
		data: {
			timestamp: new Date(),
			message: typeof error === 'object' && error !== null && 'message' in error && error.message !== undefined && typeof error.message === 'string' ? error.message : 'Please see The Interceptors console for more details on the error.'
		}
	}
	await setLatestUnexpectedError(errorMessage)
	await sendPopupMessageToOpenWindows(errorMessage)
}
