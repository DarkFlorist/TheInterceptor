import { sendPopupMessageToOpenWindows } from '../background/backgroundUtils.js'
import { setLatestUnexpectedError } from '../background/storageVariables.js'
import { JsonRpcErrorResponse } from '../types/JsonRpc-types.js'
import { NEW_BLOCK_ABORT } from './constants.js'

class ErrorWithData extends Error {
	public constructor(message: string, public data: unknown) {
		super(message)
	}
}

export class JsonRpcResponseError extends ErrorWithData {
	public readonly id: string | number
	public readonly code: number
	public constructor(jsonRpcResponse: JsonRpcErrorResponse) {
		super(jsonRpcResponse.error.message, jsonRpcResponse.error.data)
		this.code = jsonRpcResponse.error.code
		this.id = jsonRpcResponse.id
	}
}

export class FetchResponseError extends ErrorWithData {
	public readonly id: string | number
	public readonly code: number
	public constructor(response: Response, id: number) {
		super(response.statusText, response)
		this.code = response.status
		this.id = id
	}
}

export function isFailedToFetchError(error: Error) {
	if (error.message.includes('Fetch request timed out.') || error.message.includes('Failed to fetch') || error.message.includes('NetworkError when attempting to fetch resource')) return true
	return false
}

export const isNewBlockAbort = (error: Error) => error.message.includes(NEW_BLOCK_ABORT)

export function printError(error: unknown) {
	if (error instanceof Error && 'data' in error) {
		return console.error(`Error: ${ error.message }\n${ JSON.stringify(error.data) }`)
	}
	return console.error(error)
}

export async function handleUnexpectedError(error: unknown) {
	printError(error)
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
